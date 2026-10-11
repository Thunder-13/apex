'use strict';
/**
 * fit.js: Fit model weights + calibrate on evals/gold.jsonl.
 *
 * Usage:
 *   node router/fit.js [--data <path>] [--out <path>] [--prior-only]
 *
 * --prior-only: skip gradient descent, write model.json from prior weights alone.
 * --data: path to gold.jsonl (default: evals/gold.jsonl)
 * --out: path to write model.json (default: router/model.json)
 *
 * Gold row schema: {id, ask, tier, pool, task_type, techniques:[0-2 ids], flags:{8 bools}, rationale}
 *
 * Implements:
 * - Prior weights: +1.0 from own lexicon feature, +0.3 from related lexicons
 * - L2-to-prior logistic regression (multinomial / binary)
 * - Full-batch gradient descent
 * - 5-fold CV to choose lambda (grid 0.01..3)
 * - Per-head temperature scaling on out-of-fold predictions
 * - tau_fast / tau_check selection on out-of-fold predictions
 */

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { extractFeatures } = require('./features.js');
const { TASK_TYPES, POOLS, TIERS, FLAGS } = require('./router.js');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const DEFAULT_DATA = path.join(ROOT, 'evals', 'gold.jsonl');
const DEFAULT_OUT = path.join(__dirname, 'model.json');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let dataPath = DEFAULT_DATA;
let outPath = DEFAULT_OUT;
let priorOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data' && args[i + 1]) { dataPath = args[++i]; }
  else if (args[i] === '--out' && args[i + 1]) { outPath = args[++i]; }
  else if (args[i] === '--prior-only') { priorOnly = true; }
}

// ---------------------------------------------------------------------------
// Technique IDs: T1..T43; superseded by references/techniques.json when present
// ---------------------------------------------------------------------------
function loadTechIds() {
  try {
    const p = path.join(ROOT, 'references', 'techniques.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = raw.techniques && Array.isArray(raw.techniques) ? raw.techniques : [];
    const ids = arr.map(t => t.id).filter(id => /^T\d+$/.test(id));
    if (ids.length > 0) return ids.sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  } catch { /* fallback */ }
  return Array.from({ length: 43 }, (_, i) => `T${i + 1}`);
}
const TECH_IDS = loadTechIds();

// ---------------------------------------------------------------------------
// Prior weight construction
// ---------------------------------------------------------------------------
// Affinity map: pool -> related task types -> related techniques
const POOL_TASK_AFFINITY = {
  reliability: ['data_extract', 'classify_label', 'code_build', 'code_fix', 'ops_shell'],
  creative: ['write_prose', 'creative_ideation', 'explain_teach'],
  reasoning: ['research', 'plan_design', 'decision_advice', 'data_analysis', 'code_review'],
};

const TASK_TECH_AFFINITY = {
  data_extract: ['T7', 'T12', 'T8', 'T17'],
  classify_label: ['T7', 'T6', 'T2'],
  code_build: ['T5', 'T6', 'T39'],
  code_fix: ['T3', 'T16', 'T41'],
  code_review: ['T13', 'T31', 'T34'],
  refactor: ['T5', 'T14'],
  ops_shell: ['T6', 'T27'],
  data_analysis: ['T7', 'T3', 'T28'],
  research: ['T12', 'T3', 'T16'],
  explain_teach: ['T2', 'T38', 'T35'],
  write_prose: ['T1', 'T38', 'T6'],
  creative_ideation: ['T1', 'T24', 'T37'],
  plan_design: ['T27', 'T5', 'T35'],
  prompt_agent_design: ['T36', 'T2', 'T19', 'T40'],
  decision_advice: ['T3', 'T34', 'T28'],
  quick_fact: ['T16', 'T12'],
  plan_design: ['T27', 'T5', 'T35', 'T42'],
  creative_ideation: ['T1', 'T24', 'T37', 'T43'],
};

/**
 * Build prior weights for the model.
 * Returns weights in the model format:
 *   weights[headKey][classOrPos][featName] = value
 */
function buildPriorWeights() {
  const weights = {};
  const biases = {};

  // ---- Choice: tier ----
  weights['tier'] = {};
  biases['tier'] = {};
  for (const tier of TIERS) {
    weights['tier'][tier] = {};
    biases['tier'][tier] = 0;
    // Own lexicon feature
    weights['tier'][tier][`lex:tiers:${tier}`] = 1.0;
    // Structural signals
    if (tier === 'micro') {
      weights['tier'][tier]['s:log_words'] = -0.5;
      weights['tier'][tier]['s:ends_question'] = 0.3;
    }
    if (tier === 'deep') {
      weights['tier'][tier]['s:n_file_refs'] = 0.3;
      weights['tier'][tier]['s:scope_all_words'] = 0.3;
      weights['tier'][tier]['s:destructive_verbs'] = 0.3;
      weights['tier'][tier]['s:log_words'] = 0.3;
    }
    if (tier === 'standard') {
      weights['tier'][tier]['s:starts_imperative'] = 0.2;
    }
  }

  // ---- Choice: pool ----
  weights['pool'] = {};
  biases['pool'] = {};
  for (const pool of POOLS) {
    weights['pool'][pool] = {};
    biases['pool'][pool] = 0;
    weights['pool'][pool][`lex:pools:${pool}`] = 1.0;
    // Related task lexicons
    for (const task of (POOL_TASK_AFFINITY[pool] || [])) {
      weights['pool'][pool][`lex:task_types:${task}`] = 0.3;
    }
  }

  // ---- Choice: task ----
  weights['task'] = {};
  biases['task'] = {};
  for (const task of TASK_TYPES) {
    weights['task'][task] = {};
    biases['task'][task] = 0;
    weights['task'][task][`lex:task_types:${task}`] = 1.0;
  }
  // Structural signals
  weights['task']['code_fix']['s:has_stack_trace'] = 0.5;
  weights['task']['code_fix']['s:has_code_fence'] = 0.2;
  weights['task']['data_extract']['s:has_json_blob'] = 0.2;
  weights['task']['ops_shell']['s:has_path'] = 0.3;
  weights['task']['quick_fact']['s:log_words'] = -0.4;
  weights['task']['quick_fact']['s:ends_question'] = 0.4;

  // ---- Noul: techniques ----
  for (const tId of TECH_IDS) {
    const headKey = `tech:${tId}`;
    weights[headKey] = { pos: {} };
    biases[headKey] = { pos: -0.5 }; // slight prior toward "not needed"
    // Own lexicon
    weights[headKey]['pos'][`lex:techniques:${tId}`] = 1.0;
    // Related task affinity
    for (const [task, techs] of Object.entries(TASK_TECH_AFFINITY)) {
      if (techs.includes(tId)) {
        weights[headKey]['pos'][`lex:task_types:${task}`] = 0.3;
      }
    }
  }

  // ---- Noul: flags ----
  for (const flag of FLAGS) {
    const headKey = `flag:${flag}`;
    weights[headKey] = { pos: {} };
    biases[headKey] = { pos: -0.3 };
    weights[headKey]['pos'][`lex:flags:${flag}`] = 1.0;
    // Structural signals
    if (flag === 'output_parseability') {
      weights[headKey]['pos']['s:has_json_blob'] = 0.3;
    }
    if (flag === 'destructive') {
      weights[headKey]['pos']['s:destructive_verbs'] = 0.4;
    }
    if (flag === 'injection_defense') {
      weights[headKey]['pos']['s:has_url'] = 0.2;
    }
    if (flag === 'needs_fresh_facts') {
      weights[headKey]['pos']['s:has_url'] = 0.2;
    }
    if (flag === 'ambiguous') {
      weights[headKey]['pos']['s:n_and_clauses'] = 0.2;
    }
  }

  return { weights, biases };
}

// ---------------------------------------------------------------------------
// Build model.json from prior weights only
// ---------------------------------------------------------------------------
function buildPriorModel() {
  const { weights, biases } = buildPriorWeights();

  const heads = {
    tier: { type: 'Choice', labels: TIERS },
    pool: { type: 'Choice', labels: POOLS },
    task: { type: 'Choice', labels: TASK_TYPES },
    tech: { type: 'Noul', labels: TECH_IDS },
    flag: { type: 'Noul', labels: FLAGS },
  };

  const temperatures = {};
  for (const h of ['tier', 'pool', 'task']) temperatures[h] = 1.0;
  for (const tId of TECH_IDS) temperatures[`tech:${tId}`] = 1.0;
  for (const flag of FLAGS) temperatures[`flag:${flag}`] = 1.0;

  return {
    version: '2.0',
    heads,
    weights,
    biases,
    temperatures,
    fit: {
      date: new Date().toISOString().slice(0, 10),
      n: 0,
      lambda: null,
      priorOnly: true,
      tau_fast: 0.66,
      tau_check: 0.40,
      theta_tech: 0.35,
      temperatures,
      taus: { tau_fast: 0.66, tau_check: 0.40 },
      cv_metrics: null,
    },
  };
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
      try { rows.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }
  } catch {
    // File not found or unreadable
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ---------------------------------------------------------------------------
// NLL helpers
// ---------------------------------------------------------------------------
function nllMultinomial(probs, trueIdx) {
  return -Math.log(Math.max(probs[trueIdx], 1e-15));
}

function nllBinary(p, label) {
  return label ? -Math.log(Math.max(p, 1e-15)) : -Math.log(Math.max(1 - p, 1e-15));
}

// ---------------------------------------------------------------------------
// Gradient descent: multinomial logistic regression
// ---------------------------------------------------------------------------
/**
 * Fit a Choice head.
 * @param {Array} rows - [{featVec, trueIdx}]
 * @param {Array} labels - class labels
 * @param {Object} priorW - prior weights {label: {feat: val}}
 * @param {Object} priorB - prior biases {label: val}
 * @param {number} lambda - L2 regularization strength
 * @param {number} lr - learning rate
 * @param {number} maxIter
 */
function fitChoiceHead(rows, labels, priorW, priorB, lambda, lr, maxIter) {
  const n = rows.length;
  if (n === 0) return { W: priorW, b: priorB };

  // Collect all feature names
  const featSet = new Set();
  for (const r of rows) for (const k of Object.keys(r.featVec)) featSet.add(k);
  const featNames = Array.from(featSet);

  // Initialize weights from prior
  const W = {}; // W[label][feat]
  const b = {}; // b[label]
  for (const label of labels) {
    W[label] = {};
    b[label] = priorB[label] || 0;
    for (const feat of featNames) {
      W[label][feat] = (priorW[label] && priorW[label][feat]) || 0;
    }
  }

  // Full-batch gradient descent
  for (let iter = 0; iter < maxIter; iter++) {
    const gradW = {};
    const gradB = {};
    for (const label of labels) {
      gradW[label] = {};
      gradB[label] = 0;
      for (const feat of featNames) gradW[label][feat] = 0;
    }

    let totalLoss = 0;

    for (const row of rows) {
      const logits = labels.map(label => {
        let lg = b[label];
        for (const [feat, val] of Object.entries(row.featVec)) {
          lg += (W[label][feat] || 0) * val;
        }
        return lg;
      });
      const probs = softmax(logits);
      totalLoss += nllMultinomial(probs, row.trueIdx);

      for (let ci = 0; ci < labels.length; ci++) {
        const label = labels[ci];
        const err = probs[ci] - (ci === row.trueIdx ? 1 : 0);
        gradB[label] += err / n;
        for (const [feat, val] of Object.entries(row.featVec)) {
          gradW[label][feat] = (gradW[label][feat] || 0) + err * val / n;
        }
      }
    }

    // L2 gradient toward prior
    for (const label of labels) {
      b[label] -= lr * (gradB[label] + lambda * (b[label] - (priorB[label] || 0)));
      for (const feat of featNames) {
        const wPrior = (priorW[label] && priorW[label][feat]) || 0;
        gradW[label][feat] += lambda * (W[label][feat] - wPrior);
        W[label][feat] -= lr * gradW[label][feat];
      }
    }
  }

  return { W, b };
}

/**
 * Fit a Noul (binary) head.
 */
function fitNoulHead(rows, priorW, priorB, lambda, lr, maxIter) {
  const n = rows.length;
  if (n === 0) return { w: priorW['pos'] || {}, b: priorB['pos'] || 0 };

  const featSet = new Set();
  for (const r of rows) for (const k of Object.keys(r.featVec)) featSet.add(k);
  const featNames = Array.from(featSet);

  const w = {};
  let b = priorB['pos'] || 0;
  for (const feat of featNames) {
    w[feat] = (priorW['pos'] && priorW['pos'][feat]) || 0;
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let gradB = 0;
    const gradW = {};
    for (const feat of featNames) gradW[feat] = 0;

    for (const row of rows) {
      let logit = b;
      for (const [feat, val] of Object.entries(row.featVec)) {
        logit += (w[feat] || 0) * val;
      }
      const p = sigmoid(logit);
      const err = p - (row.label ? 1 : 0);
      gradB += err / n;
      for (const [feat, val] of Object.entries(row.featVec)) {
        gradW[feat] = (gradW[feat] || 0) + err * val / n;
      }
    }

    b -= lr * (gradB + lambda * (b - (priorB['pos'] || 0)));
    for (const feat of featNames) {
      const wPrior = (priorW['pos'] && priorW['pos'][feat]) || 0;
      gradW[feat] += lambda * (w[feat] - wPrior);
      w[feat] -= lr * gradW[feat];
    }
  }

  return { w, b };
}

// ---------------------------------------------------------------------------
// Temperature scaling
// ---------------------------------------------------------------------------
/**
 * Fit temperature T for a Choice head on out-of-fold predictions.
 * Minimize NLL by golden-section search.
 */
function fitTemperatureChoice(oofPredictions, labels) {
  // oofPredictions: [{logits, trueIdx}]
  if (oofPredictions.length === 0) return 1.0;

  function nll(T) {
    let total = 0;
    for (const { logits, trueIdx } of oofPredictions) {
      const scaled = logits.map(l => l / T);
      const probs = softmax(scaled);
      total += nllMultinomial(probs, trueIdx);
    }
    return total / oofPredictions.length;
  }

  // Golden-section search in [0.01, 5.0]
  let a = 0.01, b = 5.0;
  const gr = (Math.sqrt(5) + 1) / 2;
  let c = b - (b - a) / gr;
  let d = a + (b - a) / gr;
  for (let i = 0; i < 50; i++) {
    if (nll(c) < nll(d)) b = d;
    else a = c;
    c = b - (b - a) / gr;
    d = a + (b - a) / gr;
  }
  return (a + b) / 2;
}

/**
 * Fit temperature for a Noul head.
 */
function fitTemperatureNoul(oofPredictions) {
  // oofPredictions: [{logit, label}]
  if (oofPredictions.length === 0) return 1.0;

  function nll(T) {
    let total = 0;
    for (const { logit, label } of oofPredictions) {
      const p = sigmoid(logit / T);
      total += nllBinary(p, label);
    }
    return total / oofPredictions.length;
  }

  let a = 0.01, b = 5.0;
  const gr = (Math.sqrt(5) + 1) / 2;
  let c = b - (b - a) / gr;
  let d = a + (b - a) / gr;
  for (let i = 0; i < 50; i++) {
    if (nll(c) < nll(d)) b = d;
    else a = c;
    c = b - (b - a) / gr;
    d = a + (b - a) / gr;
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// Fold assignment (deterministic, hash of id)
// ---------------------------------------------------------------------------
function hashId(id) {
  // Simple deterministic hash
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  }
  return h;
}

function foldOf(id, nFolds) {
  return hashId(String(id)) % nFolds;
}

// ---------------------------------------------------------------------------
// 5-fold CV to choose lambda
// ---------------------------------------------------------------------------
const LAMBDA_GRID = [0.01, 0.05, 0.1, 0.3, 0.5, 1.0, 1.5, 2.0, 3.0];
const LR = 0.1;
const MAX_ITER = 200;
const N_FOLDS = 5;

/**
 * Evaluate one lambda on CV folds for the tier Choice head (as representative).
 * Returns average validation NLL.
 */
function cvLambda(rows, labels, priorW, priorB, lambda) {
  let totalNLL = 0;
  let count = 0;

  for (let fold = 0; fold < N_FOLDS; fold++) {
    const train = rows.filter(r => foldOf(r.id, N_FOLDS) !== fold);
    const val = rows.filter(r => foldOf(r.id, N_FOLDS) === fold);
    if (val.length === 0) continue;

    const { W, b } = fitChoiceHead(train, labels, priorW, priorB, lambda, LR, MAX_ITER);

    for (const row of val) {
      const logits = labels.map(label => {
        let lg = b[label] || 0;
        for (const [feat, val2] of Object.entries(row.featVec)) {
          lg += (W[label][feat] || 0) * val2;
        }
        return lg;
      });
      const probs = softmax(logits);
      totalNLL += nllMultinomial(probs, row.trueIdx);
      count++;
    }
  }

  return count > 0 ? totalNLL / count : Infinity;
}

// ---------------------------------------------------------------------------
// tau_fast / tau_check selection
// ---------------------------------------------------------------------------
function selectTaus(oofVerdicts) {
  // oofVerdicts: [{overall, tierCorrect, poolCorrect, techCorrect}]
  // tau_fast: lowest threshold with FAST-subset accuracy >= 0.90
  // tau_check: threshold where accuracy drops below 0.60
  if (oofVerdicts.length === 0) return { tau_fast: 0.66, tau_check: 0.40 };

  const sorted = [...oofVerdicts].sort((a, b) => b.overall - a.overall);
  const thresholds = sorted.map(v => v.overall);

  let tau_fast = 0.66;
  let tau_check = 0.40;

  for (const thresh of thresholds) {
    const subset = oofVerdicts.filter(v => v.overall >= thresh);
    if (subset.length === 0) continue;
    const acc = subset.filter(v => v.tierCorrect && v.poolCorrect && v.techCorrect).length / subset.length;
    if (acc >= 0.90) { tau_fast = thresh; break; }
  }

  for (const thresh of [...thresholds].reverse()) {
    const subset = oofVerdicts.filter(v => v.overall >= thresh);
    if (subset.length === 0) continue;
    const acc = subset.filter(v => v.tierCorrect && v.poolCorrect && v.techCorrect).length / subset.length;
    if (acc < 0.60) { tau_check = thresh; break; }
  }

  return { tau_fast: Math.max(0.50, tau_fast), tau_check: Math.max(0.30, tau_check) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const priorModel = buildPriorModel();

  if (priorOnly) {
    fs.writeFileSync(outPath, JSON.stringify(priorModel, null, 2));
    console.log(`Wrote prior-only model to ${outPath}`);
    return;
  }

  // Load data
  const rawRows = await loadData(dataPath);
  if (rawRows.length === 0) {
    console.warn(`No data found at ${dataPath}. Writing prior-only model.`);
    fs.writeFileSync(outPath, JSON.stringify(priorModel, null, 2));
    return;
  }

  console.log(`Loaded ${rawRows.length} rows from ${dataPath}`);

  // Build feature vectors for each row
  const { weights: priorW, biases: priorB } = buildPriorWeights();

  const tierRows = rawRows.map(r => ({
    id: r.id,
    featVec: extractFeatures(r.ask),
    trueIdx: TIERS.indexOf(r.tier),
  })).filter(r => r.trueIdx >= 0);

  const poolRows = rawRows.map(r => ({
    id: r.id,
    featVec: extractFeatures(r.ask),
    trueIdx: POOLS.indexOf(r.pool),
  })).filter(r => r.trueIdx >= 0);

  const taskRows = rawRows.map(r => ({
    id: r.id,
    featVec: extractFeatures(r.ask),
    trueIdx: TASK_TYPES.indexOf(r.task_type),
  })).filter(r => r.trueIdx >= 0);

  // 5-fold CV for lambda (using tier head as representative)
  console.log('Selecting lambda via 5-fold CV on tier head...');
  let bestLambda = 0.1;
  let bestNLL = Infinity;
  for (const lam of LAMBDA_GRID) {
    const nll = cvLambda(tierRows, TIERS, priorW['tier'], priorB['tier'], lam);
    console.log(`  lambda=${lam} -> NLL=${nll.toFixed(4)}`);
    if (nll < bestNLL) { bestNLL = nll; bestLambda = lam; }
  }
  console.log(`Selected lambda=${bestLambda}`);

  // Full fit on all data
  const { W: tierW, b: tierBias } = fitChoiceHead(tierRows, TIERS, priorW['tier'], priorB['tier'], bestLambda, LR, MAX_ITER);
  const { W: poolW, b: poolBias } = fitChoiceHead(poolRows, POOLS, priorW['pool'], priorB['pool'], bestLambda, LR, MAX_ITER);
  const { W: taskW, b: taskBias } = fitChoiceHead(taskRows, TASK_TYPES, priorW['task'], priorB['task'], bestLambda, LR, MAX_ITER);

  // Temperature scaling on out-of-fold predictions for Choice heads
  // Collect OOF logits
  const oofTier = [];
  const oofPool = [];
  const oofTask = [];

  for (let fold = 0; fold < N_FOLDS; fold++) {
    const trainTier = tierRows.filter(r => foldOf(r.id, N_FOLDS) !== fold);
    const valTier = tierRows.filter(r => foldOf(r.id, N_FOLDS) === fold);
    if (valTier.length === 0) continue;
    const { W: fW, b: fB } = fitChoiceHead(trainTier, TIERS, priorW['tier'], priorB['tier'], bestLambda, LR, MAX_ITER);
    for (const row of valTier) {
      const logits = TIERS.map(l => (fB[l] || 0) + Object.entries(row.featVec).reduce((s, [f, v]) => s + (fW[l][f] || 0) * v, 0));
      oofTier.push({ logits, trueIdx: row.trueIdx });
    }
  }

  for (let fold = 0; fold < N_FOLDS; fold++) {
    const trainPool = poolRows.filter(r => foldOf(r.id, N_FOLDS) !== fold);
    const valPool = poolRows.filter(r => foldOf(r.id, N_FOLDS) === fold);
    if (valPool.length === 0) continue;
    const { W: fW, b: fB } = fitChoiceHead(trainPool, POOLS, priorW['pool'], priorB['pool'], bestLambda, LR, MAX_ITER);
    for (const row of valPool) {
      const logits = POOLS.map(l => (fB[l] || 0) + Object.entries(row.featVec).reduce((s, [f, v]) => s + (fW[l][f] || 0) * v, 0));
      oofPool.push({ logits, trueIdx: row.trueIdx });
    }
  }

  for (let fold = 0; fold < N_FOLDS; fold++) {
    const trainTask = taskRows.filter(r => foldOf(r.id, N_FOLDS) !== fold);
    const valTask = taskRows.filter(r => foldOf(r.id, N_FOLDS) === fold);
    if (valTask.length === 0) continue;
    const { W: fW, b: fB } = fitChoiceHead(trainTask, TASK_TYPES, priorW['task'], priorB['task'], bestLambda, LR, MAX_ITER);
    for (const row of valTask) {
      const logits = TASK_TYPES.map(l => (fB[l] || 0) + Object.entries(row.featVec).reduce((s, [f, v]) => s + (fW[l][f] || 0) * v, 0));
      oofTask.push({ logits, trueIdx: row.trueIdx });
    }
  }

  const tempTier = fitTemperatureChoice(oofTier, TIERS);
  const tempPool = fitTemperatureChoice(oofPool, POOLS);
  const tempTask = fitTemperatureChoice(oofTask, TASK_TYPES);

  // Technique and flag heads: fit binary heads
  const weights = {};
  const biases = {};
  const temperatures = {
    tier: tempTier,
    pool: tempPool,
    task: tempTask,
  };

  weights['tier'] = tierW;
  biases['tier'] = tierBias;
  weights['pool'] = poolW;
  biases['pool'] = poolBias;
  weights['task'] = taskW;
  biases['task'] = taskBias;

  for (const tId of TECH_IDS) {
    const headKey = `tech:${tId}`;
    const techRows = rawRows.map(r => ({
      id: r.id,
      featVec: extractFeatures(r.ask),
      label: (r.techniques || []).includes(tId),
    }));
    const { w, b } = fitNoulHead(techRows, priorW[headKey] || { pos: {} }, priorB[headKey] || { pos: 0 }, bestLambda, LR, MAX_ITER);
    weights[headKey] = { pos: w };
    biases[headKey] = { pos: b };
    // Temperature for tech heads (OOF, simplified: just use 1.0 for now)
    temperatures[headKey] = 1.0;
  }

  for (const flag of FLAGS) {
    const headKey = `flag:${flag}`;
    const flagRows = rawRows.map(r => ({
      id: r.id,
      featVec: extractFeatures(r.ask),
      label: !!(r.flags && r.flags[flag]),
    }));
    const { w, b } = fitNoulHead(flagRows, priorW[headKey] || { pos: {} }, priorB[headKey] || { pos: 0 }, bestLambda, LR, MAX_ITER);
    weights[headKey] = { pos: w };
    biases[headKey] = { pos: b };
    temperatures[headKey] = 1.0;
  }

  // OOF verdicts for tau selection (simplified: use tier/pool/task OOF)
  const oofVerdicts = oofTier.map((row, i) => {
    const tierProbs = softmax(row.logits.map(l => l / tempTier));
    const poolRow = oofPool[i] || { logits: POOLS.map(() => 0), trueIdx: 0 };
    const poolProbs = softmax(poolRow.logits.map(l => l / tempPool));
    const confTier = choiceConfLocal(tierProbs);
    const confPool = choiceConfLocal(poolProbs);
    const overall = Math.min(confTier, confPool, 0.5); // tech conf unknown
    return {
      overall,
      tierCorrect: tierProbs.indexOf(Math.max(...tierProbs)) === row.trueIdx,
      poolCorrect: poolProbs.indexOf(Math.max(...poolProbs)) === poolRow.trueIdx,
      techCorrect: true, // conservative
    };
  });

  function choiceConfLocal(probs) {
    const N = probs.length;
    const pMax = Math.max(...probs);
    return Math.max(0, Math.min(1, (N * pMax - 1) / (N - 1)));
  }

  const { tau_fast, tau_check } = selectTaus(oofVerdicts);

  const model = {
    version: '2.0',
    heads: {
      tier: { type: 'Choice', labels: TIERS },
      pool: { type: 'Choice', labels: POOLS },
      task: { type: 'Choice', labels: TASK_TYPES },
      tech: { type: 'Noul', labels: TECH_IDS },
      flag: { type: 'Noul', labels: FLAGS },
    },
    weights,
    biases,
    temperatures,
    fit: {
      date: new Date().toISOString().slice(0, 10),
      n: rawRows.length,
      lambda: bestLambda,
      priorOnly: false,
      tau_fast,
      tau_check,
      theta_tech: 0.35,
      temperatures,
      taus: { tau_fast, tau_check },
      cv_metrics: { tier_nll: bestNLL },
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(model, null, 2));
  console.log(`Wrote fitted model to ${outPath} (n=${rawRows.length}, lambda=${bestLambda}, tau_fast=${tau_fast.toFixed(2)}, tau_check=${tau_check.toFixed(2)})`);
}

main().catch(e => { console.error(e); process.exit(1); });
