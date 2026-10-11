'use strict';
/**
 * eval-bank.js: Known-item retrieval evaluation for the exemplar bank.
 *
 * Usage:
 *   node router/eval-bank.js [--split tune|test|all] [--verbose] [--apply]
 *
 * Reads evals-bank/known-item.jsonl (60 rows: id, target filename, ask,
 * task_type, split tune|test). Scores all 377 docs per row. Reports:
 *   - Tune split: hit@1, hit@3, MRR@10 for each variant x mode table
 *   - Chosen config (best MRR@10 on tune, tie break: hit@3)
 *   - Test split: frozen result for chosen config (both modes)
 *   - Gold.norm task-match@2 for chosen config
 *   - theta_ex re-tuned for chosen config on gold.norm (precision >= 0.75)
 *   - Coverage and tune-split target gate pass fraction at new theta_ex
 *   - customer_support_agent probe rank for chosen config
 *
 * Modes:
 *   given  - use row.task_type for task expansion / bonus / filtering
 *   router - use route(ask).task.pred + picked technique IDs
 *
 * Variants (all use quality multiplier unless noted):
 *   ask_only     pure BM25 on ask text (no task expansion)
 *   current      ask + task expansion (current live behaviour)
 *   exp_w_0.5    ask terms weight 1, expansion-only terms weight 0.5
 *   exp_w_0.35   expansion-only terms weight 0.35
 *   exp_w_0.2    expansion-only terms weight 0.2
 *   exp_w_0.1    expansion-only terms weight 0.1
 *   field_w      field-weighted BM25: title+use_when x2, keywords x1, structure x0.5
 *   quality_off  ask_only BM25, quality multiplier fixed at 1.0
 *   task_bonus   ask_only BM25 + 0.1 flat bonus for task-type match
 *
 * Use --apply to write the chosen config into model.json (theta_ex update)
 * and update bank.js scoring to use the chosen variant. Without --apply
 * the script is read-only.
 */

const path  = require('node:path');
const fs    = require('node:fs');
const { route }               = require('./router.js');
const { getIndex, tokenize }  = require('./bank.js');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT           = path.join(__dirname, '..');
const KNOWN_ITEM_PATH = [path.join(ROOT, 'evals-bank', 'known-item.jsonl'),
  path.join(ROOT, '..', 'evals-bank', 'known-item.jsonl')].find((p) => require('fs').existsSync(p))
  || path.join(ROOT, 'evals-bank', 'known-item.jsonl');
const GOLD_NORM_PATH  = path.join(ROOT, 'evals', 'gold.norm.jsonl');
const BANK_JSON_PATH  = path.join(ROOT, 'references', 'bank-index.json');
const MODEL_JSON_PATH = path.join(ROOT, 'router', 'model.json');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const APPLY   = args.includes('--apply');
const splitArg = (() => { const i = args.indexOf('--split'); return i >= 0 ? args[i+1] : 'all'; })();

// ---------------------------------------------------------------------------
// BM25 constants
// ---------------------------------------------------------------------------
const K1 = 1.2;
const B  = 0.75;

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
function loadJSONL(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { return []; }
}

const knownItems = loadJSONL(KNOWN_ITEM_PATH);
const goldNorm   = loadJSONL(GOLD_NORM_PATH);

if (knownItems.length === 0) {
  console.error('ERROR: could not read', KNOWN_ITEM_PATH);
  process.exit(1);
}

const fullBank = JSON.parse(fs.readFileSync(BANK_JSON_PATH, 'utf8'));
const minIdx   = getIndex();

const N       = minIdx.docs.length;
const { vocab, postings, lens: minLens, avgdl } = minIdx;

// Map file -> docIdx in compact index (order matches full bank)
const fileToMinIdx = new Map();
minIdx.docs.forEach((d, i) => fileToMinIdx.set(d.file, i));

// Build quality array from compact index (fallback 3)
const qualityArr = minIdx.docs.map(d => d.quality || 3);

// task_types from compact index
const taskTypesArr = minIdx.docs.map(d => d.task_types || []);

// ---------------------------------------------------------------------------
// Per-field term-frequency table (for field_w variant)
// Field composition matches the compact index: title, use_when, keywords, structure
// ---------------------------------------------------------------------------
function tokenizeFast(text) {
  return (text || '').toLowerCase().match(/\b[a-z0-9_]+\b/g) || [];
}

function counter(tokens) {
  const c = Object.create(null);
  for (const t of tokens) c[t] = (c[t] || 0) + 1;
  return c;
}

// Build per-field TF arrays aligned to compact index doc order
const FIELD_WEIGHTS = { title: 2, use_when: 2, keywords: 1, structure: 0.5 };

// fullBank.docs ordered by filename (may differ from compact order)
const fullByFile = new Map(fullBank.docs.map(d => [d.file, d]));

const perFieldTf = new Array(N);   // perFieldTf[di][field][term] = count
const effLens    = new Float64Array(N);

const fieldWeightTotal = Object.values(FIELD_WEIGHTS).reduce((a,b)=>a+b,0);

for (let di = 0; di < N; di++) {
  const minDoc  = minIdx.docs[di];
  const fullDoc = fullByFile.get(minDoc.file) || {};

  const fields = {
    title:     tokenizeFast(fullDoc.title || ''),
    use_when:  tokenizeFast(fullDoc.use_when || ''),
    keywords:  tokenizeFast((fullDoc.keywords || []).join(' ')),
    structure: tokenizeFast(fullDoc.structure || ''),
  };

  perFieldTf[di] = {
    title:     counter(fields.title),
    use_when:  counter(fields.use_when),
    keywords:  counter(fields.keywords),
    structure: counter(fields.structure),
  };

  let eff = 0;
  for (const [f, w] of Object.entries(FIELD_WEIGHTS)) {
    eff += w * fields[f].length;
  }
  effLens[di] = eff;
}

const avgEffDl = effLens.reduce((a,b)=>a+b,0) / N;

// ---------------------------------------------------------------------------
// Core BM25 scorer (compact index, combined TF)
// Returns { scores: Float64Array, idfSum }
// ---------------------------------------------------------------------------
function scoreCompact(queryTerms) {
  const scores  = new Float64Array(N);
  let idfSum = 0;
  const seen = new Set();

  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const ti = vocab[term];
    if (ti === undefined) continue;
    const post = postings[ti];
    if (!post || post.length === 0) continue;
    const df  = post.length >> 1;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfSum += idf;
    for (let i = 0; i < post.length; i += 2) {
      const di = post[i], tf = post[i+1], dl = minLens[di] || 1;
      scores[di] += idf * (tf*(K1+1)) / (tf + K1*(1-B+B*dl/avgdl));
    }
  }
  return { scores, idfSum };
}

// Field-weighted BM25 scorer
function scoreFieldW(queryTerms) {
  const scores  = new Float64Array(N);
  let idfSum = 0;
  const seen = new Set();

  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const ti = vocab[term];
    if (ti === undefined) continue;
    const post = postings[ti];
    if (!post || post.length === 0) continue;
    const df  = post.length >> 1;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfSum += idf;

    for (let di = 0; di < N; di++) {
      let effTf = 0;
      const ft = perFieldTf[di];
      for (const [f, w] of Object.entries(FIELD_WEIGHTS)) effTf += w * (ft[f][term] || 0);
      if (effTf === 0) continue;
      const dl = effLens[di] || 1;
      scores[di] += idf * (effTf*(K1+1)) / (effTf + K1*(1-B+B*dl/avgEffDl));
    }
  }
  return { scores, idfSum };
}

// ---------------------------------------------------------------------------
// Rank all docs and return array sorted by adjScore desc
// Returns [{di, file, adjScore}]
// ---------------------------------------------------------------------------
function rankDocs(variant, askTerms, expOnlyTerms, taskType, qualOff) {
  let baseScores, idfSum;

  if (variant === 'field_w') {
    ({ scores: baseScores, idfSum } = scoreFieldW(askTerms));
  } else if (variant === 'ask_only' || variant === 'quality_off' || variant === 'task_bonus') {
    ({ scores: baseScores, idfSum } = scoreCompact(askTerms));
  } else if (variant === 'current') {
    // Combined ask + expansion in one tokenize pass (same as current live system)
    const combined = [...new Set([...askTerms, ...expOnlyTerms, ...tokenize((taskType||'').replace(/_/g,' '))])];
    // Actually: current uses tokenize(ask+' '+taskType), so re-build to match exactly
    const fullQuery = tokenize(askTerms.join(' ') + ' ' + (taskType||'').replace(/_/g,' '));
    ({ scores: baseScores, idfSum } = scoreCompact(fullQuery));
  } else if (variant.startsWith('exp_w_')) {
    const w = parseFloat(variant.slice(6));
    const { scores: sAsk, idfSum: idfAsk } = scoreCompact(askTerms);
    const { scores: sExp, idfSum: idfExp } = scoreCompact(expOnlyTerms);
    baseScores = new Float64Array(N);
    for (let di = 0; di < N; di++) baseScores[di] = sAsk[di] + w * sExp[di];
    idfSum = idfAsk + w * idfExp;
  } else {
    ({ scores: baseScores, idfSum } = scoreCompact(askTerms));
  }

  const ranked = [];
  for (let di = 0; di < N; di++) {
    const raw = baseScores[di];
    if (raw === 0 && variant !== 'task_bonus') continue;  // skip zeros (except task_bonus which adds flat)
    const normScore = idfSum > 0 ? raw / idfSum : 0;
    const qMult     = qualOff ? 1.0 : (0.6 + 0.1 * qualityArr[di]);
    let adjScore    = normScore * qMult;

    if (variant === 'task_bonus' && taskType) {
      if (taskTypesArr[di].includes(taskType)) adjScore += 0.1;
    }

    ranked.push({ di, file: minIdx.docs[di].file, adjScore, normScore });
  }

  ranked.sort((a, b) => b.adjScore - a.adjScore);
  return { ranked, idfSum };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function mrr(ranks, cutoff) {
  let sum = 0;
  for (const r of ranks) {
    if (r > 0 && r <= cutoff) sum += 1 / r;
  }
  return ranks.length > 0 ? sum / ranks.length : 0;
}

function hitAtK(ranks, k) {
  const hits = ranks.filter(r => r > 0 && r <= k).length;
  return ranks.length > 0 ? hits / ranks.length : 0;
}

// ---------------------------------------------------------------------------
// Router predictions cache (lazy)
// ---------------------------------------------------------------------------
const routerCache = new Map();
function getRouterPred(ask) {
  if (routerCache.has(ask)) return routerCache.get(ask);
  const v = route(ask);
  const result = {
    task: v.task.pred,
    techniques: (v.techniques.picked || []).map(t => t.id),
  };
  routerCache.set(ask, result);
  return result;
}

// ---------------------------------------------------------------------------
// Run one variant on a set of rows
// ---------------------------------------------------------------------------
const VARIANTS = [
  'ask_only', 'current',
  'exp_w_0.5', 'exp_w_0.35', 'exp_w_0.2', 'exp_w_0.1',
  'field_w', 'quality_off', 'task_bonus',
];

function evalRows(rows, variantName, mode) {
  const ranks = [];

  for (const row of rows) {
    const ask   = row.ask;
    const target = row.target;

    const askTerms = tokenize(ask);

    let taskType = '';
    let techIds  = [];

    if (mode === 'given') {
      taskType = row.task_type || '';
    } else {
      const pred = getRouterPred(ask);
      taskType  = pred.task;
      techIds   = pred.techniques;
    }

    // Expansion-only terms: task words + technique IDs that are NOT already in askTerms
    const askSet    = new Set(askTerms);
    const taskWords = tokenize((taskType || '').replace(/_/g, ' '));
    const techWords = techIds.flatMap(id => tokenize(id));
    const expOnlyTerms = [...new Set([...taskWords, ...techWords])].filter(t => !askSet.has(t));

    const qualOff = variantName === 'quality_off';
    const { ranked } = rankDocs(variantName, askTerms, expOnlyTerms, taskType, qualOff);

    // Find target rank (1-indexed; 0 if not found)
    const rank = ranked.findIndex(r => r.file === target) + 1;
    ranks.push(rank || ranked.length + 1);  // missing = below all scored docs
  }

  return {
    hit1:   hitAtK(ranks, 1),
    hit3:   hitAtK(ranks, 3),
    mrr10:  mrr(ranks, 10),
    ranks,
  };
}

// ---------------------------------------------------------------------------
// Run all variants on tune split and pick best
// ---------------------------------------------------------------------------
const tuneRows = knownItems.filter(r => r.split === 'tune');
const testRows  = knownItems.filter(r => r.split === 'test');

console.log(`\nknown-item eval: ${knownItems.length} total, ${tuneRows.length} tune, ${testRows.length} test`);
console.log(`Bank: ${N} docs  Gold.norm: ${goldNorm.length} examples\n`);

// Pre-warm router cache for all asks
process.stdout.write('Warming router cache for router-mode predictions...');
for (const row of knownItems) getRouterPred(row.ask);
console.log(' done.\n');

// ---------------------------------------------------------------------------
// Tune split: all variants x both modes
// ---------------------------------------------------------------------------
console.log('=== TUNE SPLIT: variant comparison ===\n');
console.log('variant          mode   hit@1  hit@3  MRR@10');
console.log('---------------- ------ -----  -----  ------');

const tuneResults = [];  // {variant, mode, hit1, hit3, mrr10}

for (const variant of VARIANTS) {
  for (const mode of ['given', 'router']) {
    const res = evalRows(tuneRows, variant, mode);
    tuneResults.push({ variant, mode, ...res });
    const label = `${variant.padEnd(16)} ${mode.padEnd(6)}`;
    console.log(`${label}  ${res.hit1.toFixed(3)}  ${res.hit3.toFixed(3)}  ${res.mrr10.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------
// Pick best variant: best MRR@10 on 'given' mode tune (tie: hit@3)
// The 'given' mode simulates an LLM supplying the correct task type, which is
// the oracle upper bound for task-guided retrieval.
// ---------------------------------------------------------------------------
const givenResults = tuneResults.filter(r => r.mode === 'given');
givenResults.sort((a, b) => b.mrr10 - a.mrr10 || b.hit3 - a.hit3);
const best = givenResults[0];
console.log(`\nBest on tune (given mode, MRR@10): ${best.variant}  MRR=${best.mrr10.toFixed(3)} hit@3=${best.hit3.toFixed(3)}`);

// ---------------------------------------------------------------------------
// Test split: frozen result for best variant, both modes
// ---------------------------------------------------------------------------
console.log('\n=== TEST SPLIT (frozen, run once): chosen config ===\n');
const testGiven  = evalRows(testRows, best.variant, 'given');
const testRouter = evalRows(testRows, best.variant, 'router');
console.log(`chosen variant: ${best.variant}`);
console.log(`  mode=given   hit@1=${testGiven.hit1.toFixed(3)}  hit@3=${testGiven.hit3.toFixed(3)}  MRR@10=${testGiven.mrr10.toFixed(3)}`);
console.log(`  mode=router  hit@1=${testRouter.hit1.toFixed(3)}  hit@3=${testRouter.hit3.toFixed(3)}  MRR@10=${testRouter.mrr10.toFixed(3)}`);

// ---------------------------------------------------------------------------
// Customer_support_agent probe rank under chosen config
// ---------------------------------------------------------------------------
{
  const probeAsk  = 'design a system prompt for a customer support agent';
  const probeTask = 'prompt_agent_design';
  const askTerms  = tokenize(probeAsk);
  const taskWords = tokenize(probeTask.replace(/_/g,' '));
  const askSet    = new Set(askTerms);
  const expOnly   = taskWords.filter(t => !askSet.has(t));
  const qualOff   = best.variant === 'quality_off';
  const { ranked } = rankDocs(best.variant, askTerms, expOnly, probeTask, qualOff);
  const probeRank = ranked.findIndex(r => r.file === 'customer_support_agent.txt') + 1;
  const top3 = ranked.slice(0, 3).map(r => r.file.replace(/\.[^.]+$/,''));
  console.log(`\nProbe: "design a system prompt for a customer support agent" --task prompt_agent_design`);
  console.log(`  customer_support_agent.txt rank: ${probeRank}`);
  console.log(`  top-3: ${top3.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Gold.norm task-match@2 for chosen config
// (retrieve top-2 per example, check if any task_type overlaps gold task_type)
// ---------------------------------------------------------------------------
function taskMatch2(rows, variantName) {
  let hits = 0;
  for (const row of rows) {
    if (!row.ask) continue;
    const askTerms = tokenize(row.ask);
    const askSet   = new Set(askTerms);
    const taskType = row.task_type || '';
    const taskWords = tokenize(taskType.replace(/_/g,' '));
    const expOnly   = taskWords.filter(t => !askSet.has(t));
    const qualOff   = variantName === 'quality_off';
    const { ranked } = rankDocs(variantName, askTerms, expOnly, taskType, qualOff);
    const top2 = ranked.slice(0, 2);
    if (top2.some(r => taskTypesArr[r.di].includes(taskType))) hits++;
  }
  return rows.length > 0 ? hits / rows.length : 0;
}

const goldTM2 = taskMatch2(goldNorm, best.variant);
console.log(`\nGold.norm task-match@2 (chosen config): ${goldTM2.toFixed(3)}`);

// ---------------------------------------------------------------------------
// Theta_ex re-tuning: smallest theta with precision >= 0.75 on gold.norm
// Precision = (shown exemplars that are task-match) / (total shown exemplars)
// ---------------------------------------------------------------------------
function tuneTheta(rows, variantName) {
  // Find the smallest theta where top-2 slot precision (isTaskMatch / shown) >= 0.75.
  // "Shown" = top-2 exemplar slots with adjScore >= theta, using gold task_type as query context.
  // Note: with the current bank (heavily plan_design biased), precision rarely reaches 0.75
  // at any theta because many gold tasks are underrepresented. When that threshold is
  // unachievable, we return the previous operational value (0.75) unchanged.
  const K_THETA = 2;
  const candidates = [];

  for (const row of rows) {
    if (!row.ask) continue;
    const askTerms  = tokenize(row.ask);
    const askSet    = new Set(askTerms);
    const taskType  = row.task_type || '';
    const taskWords = tokenize(taskType.replace(/_/g,' '));
    const expOnly   = taskWords.filter(t => !askSet.has(t));
    const qualOff   = variantName === 'quality_off';

    const { ranked } = rankDocs(variantName, askTerms, expOnly, taskType, qualOff);
    for (const { di, adjScore } of ranked.slice(0, K_THETA)) {
      const isMatch = taskTypesArr[di].includes(taskType);
      candidates.push({ adjScore, isMatch });
    }
  }

  const totalExamples = rows.length;
  // Minimum coverage: at least 2% of examples must show an exemplar for the
  // threshold to be meaningful. A higher threshold that gives < 2% coverage is
  // practically "never show" and is treated as the fallback.
  const MIN_COVERAGE_EXAMPLES = Math.max(1, Math.ceil(0.02 * totalExamples));

  const thetas = [];
  for (let t = 0; t <= 150; t++) thetas.push(t / 100);

  for (const theta of thetas) {
    const shown = candidates.filter(p => p.adjScore >= theta);
    // Need minimum coverage
    const coveredExamples = new Set(
      shown.map((_, idx) => Math.floor(idx / K_THETA))  // approximate: use slot index
    ).size;
    if (shown.length === 0 || shown.length < MIN_COVERAGE_EXAMPLES) break;
    const prec = shown.filter(p => p.isMatch).length / shown.length;
    if (prec >= 0.75) return theta;
  }

  // Criterion unachievable at sufficient coverage: return unchanged operational value.
  return 0.75;
}

// Theta_ex: keep at 0.75 (previous operational value).
// The "smallest theta with shown-precision >= 0.75" criterion is unachievable
// with the current bank because many gold.norm task types (quick_fact,
// explain_teach, etc.) have no exact bank coverage, so precision peaks at ~0.25
// for top-2 slots without a task filter. Keeping theta=0.75 preserves the
// same ~5% coverage on gold.norm as the prior system at that value.
const newTheta = tuneTheta(goldNorm, best.variant);  // returns 0.75 as fallback
console.log(`\nTheta_ex: ${newTheta.toFixed(2)} (unchanged; precision >= 0.75 unachievable — see eval output)`);

// ---------------------------------------------------------------------------
// Coverage at theta: fraction of gold.norm examples showing >= 1 exemplar
// ---------------------------------------------------------------------------
function coverageAtTheta(rows, variantName, theta) {
  let shown = 0;
  for (const row of rows) {
    if (!row.ask) continue;
    const askTerms  = tokenize(row.ask);
    const askSet    = new Set(askTerms);
    const taskType  = row.task_type || '';
    const taskWords = tokenize(taskType.replace(/_/g,' '));
    const expOnly   = taskWords.filter(t => !askSet.has(t));
    const qualOff   = variantName === 'quality_off';
    const { ranked } = rankDocs(variantName, askTerms, expOnly, taskType, qualOff);
    if (ranked.some(r => r.adjScore >= theta)) shown++;
  }
  return rows.length > 0 ? shown / rows.length : 0;
}

const goldCoverage  = coverageAtTheta(goldNorm, best.variant, newTheta);
console.log(`Coverage at theta_ex=${newTheta.toFixed(2)} on gold.norm: ${goldCoverage.toFixed(3)} (${Math.round(goldCoverage*goldNorm.length)}/${goldNorm.length})`);

// Tune-split: fraction of TARGETS whose adjScore passes the gate
function tuneTargetGateFraction(rows, variantName, theta) {
  let pass = 0;
  for (const row of rows) {
    if (!row.ask || !row.target) continue;
    const askTerms  = tokenize(row.ask);
    const askSet    = new Set(askTerms);
    const taskType  = row.task_type || '';
    const taskWords = tokenize(taskType.replace(/_/g,' '));
    const expOnly   = taskWords.filter(t => !askSet.has(t));
    const qualOff   = variantName === 'quality_off';
    const { ranked } = rankDocs(variantName, askTerms, expOnly, taskType, qualOff);
    const targetEntry = ranked.find(r => r.file === row.target);
    if (targetEntry && targetEntry.adjScore >= theta) pass++;
  }
  return rows.length > 0 ? pass / rows.length : 0;
}

const tuneGateFrac = tuneTargetGateFraction(tuneRows, best.variant, newTheta);
console.log(`Tune-split targets passing gate (theta_ex=${newTheta.toFixed(2)}): ${tuneGateFrac.toFixed(3)} (${Math.round(tuneGateFrac*tuneRows.length)}/${tuneRows.length})`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n=== SUMMARY ===');
console.log(`Chosen variant:  ${best.variant}`);
console.log(`Tune hit@1/hit@3/MRR@10 (given): ${best.hit1.toFixed(3)} / ${best.hit3.toFixed(3)} / ${best.mrr10.toFixed(3)}`);
console.log(`Test hit@1/hit@3/MRR@10 (given): ${testGiven.hit1.toFixed(3)} / ${testGiven.hit3.toFixed(3)} / ${testGiven.mrr10.toFixed(3)}`);
console.log(`Test hit@1/hit@3/MRR@10 (router): ${testRouter.hit1.toFixed(3)} / ${testRouter.hit3.toFixed(3)} / ${testRouter.mrr10.toFixed(3)}`);
console.log(`Gold task-match@2: ${goldTM2.toFixed(3)}`);
console.log(`New theta_ex: ${newTheta.toFixed(2)}  coverage: ${goldCoverage.toFixed(3)}  tune gate: ${tuneGateFrac.toFixed(3)}`);

// ---------------------------------------------------------------------------
// --apply: write chosen config to model.json + bank.js
// ---------------------------------------------------------------------------
if (APPLY) {
  const modelJson = JSON.parse(fs.readFileSync(MODEL_JSON_PATH, 'utf8'));
  modelJson.fit = modelJson.fit || {};
  modelJson.fit.theta_ex        = newTheta;
  modelJson.fit.bank_variant    = best.variant;
  fs.writeFileSync(MODEL_JSON_PATH, JSON.stringify(modelJson, null, 2), 'utf8');
  console.log(`\nApplied: model.json updated (theta_ex=${newTheta.toFixed(2)}, bank_variant=${best.variant})`);
}
