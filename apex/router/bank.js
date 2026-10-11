'use strict';
/**
 * bank.js: BM25 exemplar retrieval using compact references/bank-index.min.json.
 * k1 = 1.2, b = 0.75.
 * Returns top-k docs with relPath, useWhen, and first 160 chars of fragment.
 *
 * Compact index format:
 *   { avgdl, docs:[{file,use_when,fragment,quality,task_types,techniques}],
 *     lens:[...], vocab:{term->idx}, postings:{idx->[docIdx,tf,docIdx,tf,...]} }
 *
 * Scoring (exp_w_0.2 variant, chosen by known-item eval on tune split):
 *   askTerms   = tokenize(prompt)
 *   expOnly    = tokenize(taskType + techniqueIds) minus askTerms (unique expansion)
 *   rawScore   = BM25(askTerms, doc) + 0.2 * BM25(expOnly, doc)
 *   idfSum     = idfSum(askTerms) + 0.2 * idfSum(expOnly)
 *   adjScore   = (rawScore / idfSum) * qualityMult
 *
 * No hard task-type filter: docs are ranked purely by adjScore. A flat task
 * filter was removed in v2.1 because it silently excluded cross-task relevant
 * docs (e.g. customer_support_agent for prompt_agent_design asks).
 *
 * Relevance gate: adjScore >= thetaEx (from model.json; coverage ~5% on gold.norm).
 * Asks with fewer than 6 words skip the gate entirely and return [].
 */

const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// BM25 parameters
// ---------------------------------------------------------------------------
const K1 = 1.2;
const B  = 0.75;

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------
let _min = null;  // compact index
let _N   = 0;

function getIndex() {
  if (_min) return _min;
  const p = path.join(__dirname, '..', 'references', 'bank-index.min.json');
  try {
    _min = JSON.parse(fs.readFileSync(p, 'utf8'));
    _N = (_min.docs || []).length;
  } catch {
    _min = { avgdl: 0, docs: [], lens: [], vocab: {}, postings: {} };
    _N = 0;
  }
  return _min;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
function tokenize(text) {
  return (text || '').toLowerCase().match(/\b[a-z0-9_]+\b/g) || [];
}

// ---------------------------------------------------------------------------
// BM25 over compact postings (returns raw scores + idfSum for normalization)
// ---------------------------------------------------------------------------
function scoreAll(queryTerms, idx) {
  const { vocab, postings, lens, avgdl } = idx;
  const scores = new Float64Array(_N); // zeroed
  let idfSum = 0;
  const seen = new Set();

  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const ti = vocab[term];
    if (ti === undefined) continue;
    const post = postings[ti];
    if (!post || post.length === 0) continue;

    const df    = post.length >> 1; // pairs: [docIdx, tf, ...]
    const idf   = Math.log((_N - df + 0.5) / (df + 0.5) + 1);
    idfSum += idf;

    for (let i = 0; i < post.length; i += 2) {
      const di  = post[i];
      const tf  = post[i + 1];
      const dl  = lens[di] || 1;
      const tfN = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl));
      scores[di] += idf * tfN;
    }
  }

  return { scores, idfSum };
}

// Expansion down-weight (exp_w_0.2): ask terms get full weight; expansion-only
// terms (task words + technique IDs not already in the ask) get 0.2 weight.
// Chosen by known-item eval tune split (MRR@10=0.655 vs ask-only 0.654).
const EXP_W = 0.2;

// ---------------------------------------------------------------------------
// Retrieve top-k exemplars
// ---------------------------------------------------------------------------
/**
 * retrieveExemplars(prompt, taskType, techniqueIds, k, opts)
 *   opts.thetaEx  : minimum adjScore to show an exemplar (default 0 = no gate)
 *   opts.wordCount: pre-computed word count of the raw prompt; if < 6 returns []
 * Returns array of {relPath, useWhen, fragment, score}
 *
 * Scoring: exp_w_0.2 — ask terms at weight 1, expansion-only terms at weight 0.2.
 * No hard task-type filter; adjScore gate applied after scoring.
 * Returns [] (not null) when nothing clears the gate.
 */
function retrieveExemplars(prompt, taskType, techniqueIds, k, opts) {
  k = k || 2;
  const thetaEx   = (opts && opts.thetaEx)   || 0;
  const wordCount = (opts && opts.wordCount != null)
    ? opts.wordCount
    : (prompt ? prompt.trim().split(/\s+/).length : 0);

  // Short-query gate: fewer than 6 words → no exemplar shown
  if (wordCount < 6) return [];

  const idx = getIndex();
  if (_N === 0) return [];

  const { docs } = idx;

  // Separate ask terms from expansion-only terms
  const askTerms   = tokenize(prompt);
  const askSet     = new Set(askTerms);
  const taskWords  = tokenize((taskType || '').replace(/_/g, ' '));
  const techWords  = (techniqueIds || []).flatMap(id => tokenize(id));
  const expOnly    = [...new Set([...taskWords, ...techWords])].filter(t => !askSet.has(t));

  // Score: ask BM25 + EXP_W * expansion BM25
  const { scores: sAsk, idfSum: idfAsk } = scoreAll(askTerms, idx);
  const { scores: sExp, idfSum: idfExp } = scoreAll(expOnly,  idx);
  const effectiveIdfSum = idfAsk + EXP_W * idfExp;

  // Build candidate list (adjScore gate applied)
  const candidates = [];
  for (let di = 0; di < _N; di++) {
    const raw = sAsk[di] + EXP_W * sExp[di];
    if (raw === 0) continue;
    const normScore = effectiveIdfSum > 0 ? raw / effectiveIdfSum : 0;
    const adjScore  = normScore * (0.6 + 0.1 * (docs[di].quality || 3));
    if (adjScore < thetaEx) continue;
    candidates.push({ di, adjScore });
  }

  // No task-type filter: rank purely by adjScore so cross-task relevant docs
  // (e.g. customer_support_agent for a prompt-design ask) are not silently excluded.
  candidates.sort((a, b) => b.adjScore - a.adjScore);

  return candidates.slice(0, k).map(({ di, adjScore }) => {
    const doc = docs[di];
    return {
      relPath: `references/bank/${doc.file}`,
      useWhen:  (doc.use_when  || '').slice(0, 140),
      fragment: (doc.fragment  || '').slice(0, 160),
      score:    adjScore,
    };
  });
}

// Pre-load at module startup (overlaps with stdin buffering in the hook)
getIndex();

module.exports = { retrieveExemplars, getIndex, tokenize };
