'use strict';
/**
 * eval.js: Evaluation metrics for the APEX v2 router.
 *
 * Usage:
 *   node router/eval.js [--data <path>] [--out <path>] [--no-gate]
 *
 * Reports per head: accuracy, macro-F1, ECE (10 bins), Brier,
 * majority-class baseline, prior-only baseline, technique top-2 recall/precision,
 * FAST-subset accuracy/coverage, latency p50/p95 over 1000 in-process calls.
 *
 * Exits non-zero if any check 2/3/4 threshold fails (unless --no-gate).
 */

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { route } = require('./router.js');
const { TASK_TYPES, POOLS, TIERS, FLAGS } = require('./router.js');
const { extractFeatures } = require('./features.js');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const ROOT = path.join(__dirname, '..');
let dataPath = path.join(ROOT, 'evals', 'holdout.jsonl');
let outPath = null;
let noGate = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data' && args[i + 1]) { dataPath = args[++i]; }
  else if (args[i] === '--out' && args[i + 1]) { outPath = args[++i]; }
  else if (args[i] === '--no-gate') { noGate = true; }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData(filePath) {
  const rows = [];
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch {
    // File not found
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------
function accuracy(preds, trues) {
  if (preds.length === 0) return 0;
  return preds.filter((p, i) => p === trues[i]).length / preds.length;
}

function macroF1(preds, trues, classes) {
  let f1Sum = 0;
  let count = 0;
  for (const cls of classes) {
    const tp = preds.filter((p, i) => p === cls && trues[i] === cls).length;
    const fp = preds.filter((p, i) => p === cls && trues[i] !== cls).length;
    const fn = preds.filter((p, i) => p !== cls && trues[i] === cls).length;
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f = prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0;
    if (trues.some(t => t === cls)) { f1Sum += f; count++; }
  }
  return count > 0 ? f1Sum / count : 0;
}

/**
 * ECE (Expected Calibration Error), 10 bins.
 * @param {Array} samples - [{prob, correct}] where prob = p(predicted class)
 */
function ece(samples, nBins = 10) {
  if (samples.length === 0) return 0;
  const bins = Array.from({ length: nBins }, () => ({ total: 0, correct: 0, conf: 0 }));
  for (const { prob, correct } of samples) {
    const bi = Math.min(Math.floor(prob * nBins), nBins - 1);
    bins[bi].total++;
    bins[bi].conf += prob;
    if (correct) bins[bi].correct++;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.total === 0) continue;
    const avgConf = bin.conf / bin.total;
    const avgAcc = bin.correct / bin.total;
    ece += (bin.total / samples.length) * Math.abs(avgConf - avgAcc);
  }
  return ece;
}

/**
 * Brier score for multi-class: mean of squared errors of probabilities.
 * @param {Array} samples - [{probs: {label: p}, trueLabel}]
 */
function brierMulti(samples, classes) {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const { probs, trueLabel } of samples) {
    for (const cls of classes) {
      const p = probs[cls] || 0;
      const y = cls === trueLabel ? 1 : 0;
      total += (p - y) ** 2;
    }
  }
  return total / (samples.length * classes.length);
}

/**
 * Majority-class baseline accuracy.
 */
function majorityBaseline(trues) {
  if (trues.length === 0) return 0;
  const counts = {};
  for (const t of trues) counts[t] = (counts[t] || 0) + 1;
  const majCount = Math.max(...Object.values(counts));
  return majCount / trues.length;
}

/**
 * Prior-only baseline: accuracy from prior model.
 */
function priorBaseline(rows, classes, trueKey, modelPrior) {
  // This is a simplified baseline using the model weights before fitting
  return majorityBaseline(rows.map(r => r[trueKey]));
}

/**
 * Percentile from sorted array.
 */
function pctile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil(sortedArr.length * p / 100) - 1;
  return sortedArr[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Loading data from ${dataPath}...`);
  const rows = await loadData(dataPath);

  if (rows.length === 0) {
    console.error(`No rows found at ${dataPath}`);
    process.exit(noGate ? 0 : 1);
  }

  console.log(`Evaluating ${rows.length} rows...`);

  // --- Per-row verdicts ---
  const results = [];
  const latencies = [];

  for (const row of rows) {
    const t0 = Date.now();
    let verdict;
    try {
      verdict = route(row.ask);
    } catch (e) {
      console.error(`route() error on row ${row.id}: ${e.message}`);
      continue;
    }
    latencies.push(Date.now() - t0);
    results.push({ row, verdict });
  }

  // --- Prior-only baseline (inline, no holdout re-read) ---
  // Uses the same feature vectors already in results; applies simple prior
  // weights (lexicon feature + 1.0, log_words for micro/deep) without fitting.
  function priorOnlyAcc(results, labels, priorFeat) {
    // priorFeat(label) -> {feat: weight}: minimal prior weights per class
    let correct = 0;
    for (const { row, verdict } of results) {
      const feats = extractFeatures(row.ask);
      const scores = labels.map(l => {
        const pw = priorFeat(l);
        return Object.entries(pw).reduce((s, [f, w]) => s + (feats[f] || 0) * w, 0);
      });
      const predIdx = scores.indexOf(Math.max(...scores));
      if (labels[predIdx] === row.tier || labels[predIdx] === row.pool) correct++;
    }
    return correct / results.length;
  }
  // Tier prior: micro←short, deep←lex:tiers:deep/destructive, standard=default
  const tierPriorW = { micro: { 's:log_words': -0.5 }, standard: {}, deep: { 'lex:tiers:deep': 1.0, 's:destructive_verbs': 0.5, 's:n_and_clauses': 0.3, 's:scope_all_words': 0.3 } };
  let tierPriorCorrect = 0;
  for (const { row } of results) {
    const feats = extractFeatures(row.ask);
    const scores = TIERS.map(l => Object.entries(tierPriorW[l] || {}).reduce((s, [f, w]) => s + (feats[f] || 0) * w, 0));
    const pred = TIERS[scores.indexOf(Math.max(...scores))];
    if (pred === row.tier) tierPriorCorrect++;
  }
  const tierPriorAcc = tierPriorCorrect / results.length;
  // Pool prior: reliability←lex:pools:reliability, creative←lex:pools:creative, reasoning=default
  let poolPriorCorrect = 0;
  for (const { row } of results) {
    const feats = extractFeatures(row.ask);
    const rScore = feats['lex:pools:reliability'] || 0;
    const cScore = feats['lex:pools:creative'] || 0;
    const rgScore = feats['lex:pools:reasoning'] || 0;
    const scores = [rScore, cScore, rgScore];
    const pool = ['reliability', 'creative', 'reasoning'][scores.indexOf(Math.max(...scores))];
    if (pool === row.pool) poolPriorCorrect++;
  }
  const poolPriorAcc = poolPriorCorrect / results.length;

  // --- Tier metrics (raw model head + post-override) ---
  const tierTrues = results.map(r => r.row.tier);
  // Raw model head (before overrides)
  const tierPredsRaw = results.map(r => {
    // The raw head pred is stored in tier.probs as the argmax
    const probs = r.verdict.tier.probs;
    return Object.keys(probs).reduce((best, k) => probs[k] > (probs[best] || 0) ? k : best, Object.keys(probs)[0]);
  });
  const tierAccRaw = accuracy(tierPredsRaw, tierTrues);
  // Post-override (after tier overrides applied)
  const tierPreds = results.map(r => r.verdict.tier.pred);
  const tierAcc = accuracy(tierPreds, tierTrues);
  const tierF1 = macroF1(tierPreds, tierTrues, TIERS);
  const tierECE = ece(results.map(r => ({
    prob: r.verdict.tier.probs[tierPredsRaw[results.indexOf(r)]] || 0,
    correct: r.verdict.tier.pred === r.row.tier,
  })));
  const tierBrier = brierMulti(results.map(r => ({
    probs: r.verdict.tier.probs,
    trueLabel: r.row.tier,
  })), TIERS);
  const tierMajority = majorityBaseline(tierTrues);

  // --- Pool metrics ---
  const poolPreds = results.map(r => r.verdict.pool.pred);
  const poolTrues = results.map(r => r.row.pool);
  const poolAcc = accuracy(poolPreds, poolTrues);
  const poolF1 = macroF1(poolPreds, poolTrues, POOLS);
  const poolECE = ece(results.map(r => ({
    prob: r.verdict.pool.probs[r.verdict.pool.pred] || 0,
    correct: r.verdict.pool.pred === r.row.pool,
  })));
  const poolBrier = brierMulti(results.map(r => ({
    probs: r.verdict.pool.probs,
    trueLabel: r.row.pool,
  })), POOLS);
  const poolMajority = majorityBaseline(poolTrues);

  // --- Task metrics ---
  const taskPreds = results.map(r => r.verdict.task.pred);
  const taskTrues = results.map(r => r.row.task_type);
  const taskAcc = accuracy(taskPreds, taskTrues);
  const taskF1 = macroF1(taskPreds, taskTrues, TASK_TYPES);
  const taskMajority = majorityBaseline(taskTrues);

  // --- Technique top-2 recall and precision ---
  let techRecallTotal = 0, techPrecTotal = 0, techCount = 0;
  let noneCorrect = 0, noneTotal = 0;
  for (const { row, verdict } of results) {
    const gold = new Set(row.techniques || []);
    const picked = new Set((verdict.techniques.picked || []).map(t => t.id));
    if (gold.size === 0) {
      // (b) none-accuracy: rows with empty gold → router should pick none
      noneTotal++;
      if (picked.size === 0) noneCorrect++;
      continue;
    }
    // (a) top-2 recall and (c) precision over non-empty rows
    const tp = [...picked].filter(t => gold.has(t)).length;
    techRecallTotal += tp / gold.size;
    techPrecTotal += picked.size > 0 ? tp / picked.size : 0;
    techCount++;
  }
  const techRecall = techCount > 0 ? techRecallTotal / techCount : 0;
  const techPrec = techCount > 0 ? techPrecTotal / techCount : 0;
  const noneAcc = noneTotal > 0 ? noneCorrect / noneTotal : 1;

  // --- FAST subset accuracy and coverage ---
  const model = require('./model.json');
  const tauFast = (model.fit && model.fit.tau_fast) || 0.66;
  const fastResults = results.filter(r => {
    const { mode, overall } = r.verdict.mode;
    return mode === 'FAST';
  });
  const fastCoverage = results.length > 0 ? fastResults.length / results.length : 0;
  const fastAcc = fastResults.length > 0
    ? fastResults.filter(r =>
        r.verdict.tier.pred === r.row.tier &&
        r.verdict.pool.pred === r.row.pool &&
        (r.row.techniques || []).length === 0 ||
        (r.verdict.techniques.picked || []).some(t => (r.row.techniques || []).includes(t.id))
      ).length / fastResults.length
    : 0;

  // --- Latency p50/p95 ---
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const latP50 = pctile(sortedLat, 50);
  const latP95 = pctile(sortedLat, 95);

  // --- In-process timing over 1000 calls ---
  const testPrompt = (rows[0] && rows[0].ask) || 'extract all invoice numbers from this pdf into json';
  const inProcLatencies = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = Date.now();
    try { route(testPrompt); } catch { /* ignore */ }
    inProcLatencies.push(Date.now() - t0);
  }
  inProcLatencies.sort((a, b) => a - b);
  const inProcP50 = pctile(inProcLatencies, 50);
  const inProcP95 = pctile(inProcLatencies, 95);

  // --- Check gates ---
  const checks = [
    { name: 'tier_acc >= 0.85', pass: tierAcc >= 0.85, val: tierAcc.toFixed(3) },
    { name: 'pool_acc >= 0.90', pass: poolAcc >= 0.90, val: poolAcc.toFixed(3) },
    { name: 'tech_top2_recall >= 0.80', pass: techRecall >= 0.80, val: techRecall.toFixed(3) },
    { name: 'tier_ECE <= 0.10', pass: tierECE <= 0.10, val: tierECE.toFixed(3) },
    { name: 'pool_ECE <= 0.10', pass: poolECE <= 0.10, val: poolECE.toFixed(3) },
    { name: 'fast_acc >= 0.85', pass: fastAcc >= 0.85 || fastResults.length === 0, val: fastAcc.toFixed(3) },
    { name: 'inproc_p95 < 15ms', pass: inProcP95 < 15, val: `${inProcP95}ms` },
  ];

  // --- Build report ---
  const lines = [];
  lines.push('# APEX v2 Router Evaluation Report');
  lines.push('');
  lines.push(`Data: ${dataPath}`);
  lines.push(`Rows: ${rows.length} | Evaluated: ${results.length}`);
  lines.push('');
  lines.push('## Tier');
  lines.push(`accuracy (raw model head): ${tierAccRaw.toFixed(3)} | accuracy (post-override): ${tierAcc.toFixed(3)}`);
  lines.push(`macro-F1: ${tierF1.toFixed(3)} | ECE: ${tierECE.toFixed(3)} | Brier: ${tierBrier.toFixed(3)}`);
  lines.push(`majority baseline: ${tierMajority.toFixed(3)} | prior-only baseline: ${tierPriorAcc.toFixed(3)}`);
  lines.push('');
  lines.push('## Pool');
  lines.push(`accuracy: ${poolAcc.toFixed(3)} | macro-F1: ${poolF1.toFixed(3)} | ECE: ${poolECE.toFixed(3)} | Brier: ${poolBrier.toFixed(3)}`);
  lines.push(`majority baseline: ${poolMajority.toFixed(3)} | prior-only baseline: ${poolPriorAcc.toFixed(3)}`);
  lines.push('');
  lines.push('## Task type (top-1)');
  lines.push(`accuracy: ${taskAcc.toFixed(3)} | macro-F1: ${taskF1.toFixed(3)}`);
  lines.push(`majority baseline: ${taskMajority.toFixed(3)}`);
  lines.push('');
  lines.push('## Techniques');
  lines.push(`(a) top-2 recall (non-empty rows, n=${techCount}): ${techRecall.toFixed(3)}`);
  lines.push(`(b) none-accuracy (empty-gold rows, n=${noneTotal}): ${noneAcc.toFixed(3)}`);
  lines.push(`(c) precision of picks (non-empty rows): ${techPrec.toFixed(3)}`);
  lines.push('');
  lines.push('## FAST subset');
  lines.push(`coverage: ${(fastCoverage * 100).toFixed(1)}% | accuracy: ${fastAcc.toFixed(3)}`);
  lines.push(`tau_fast: ${tauFast.toFixed(2)}`);
  lines.push('');
  lines.push('## Latency');
  lines.push(`per-row p50: ${latP50}ms | p95: ${latP95}ms`);
  lines.push(`in-process (1000 calls) p50: ${inProcP50}ms | p95: ${inProcP95}ms`);
  lines.push('');
  lines.push('## Check gates');
  for (const c of checks) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.val}`);
  }

  const report = lines.join('\n');
  console.log(report);

  if (outPath) {
    fs.writeFileSync(outPath, report);
    console.log(`Report written to ${outPath}`);
  }

  // Exit non-zero if any gate fails (unless --no-gate)
  const failed = checks.filter(c => !c.pass);
  if (!noGate && failed.length > 0) {
    console.error(`\nFailed ${failed.length} check(s): ${failed.map(c => c.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
