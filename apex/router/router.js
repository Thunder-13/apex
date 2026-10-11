'use strict';
/**
 * router.js: System One router.
 * route(prompt) -> verdict
 * format(verdict) -> string (<= 12 lines of verdict text)
 * explain(verdict) -> human-readable table string
 *
 * CLI:
 *   node router/router.js --explain "<ask>"  -> human-readable table
 *   node router/router.js --json "<ask>"     -> raw verdict JSON
 */

const path = require('node:path');
const fs = require('node:fs');
const { extractFeatures } = require('./features.js');
const { retrieveExemplars } = require('./bank.js');
const { extractLiterals, extractInjectionPhrases, buildPreserveLine } = require('./literals.js');
const { classifyDestructive } = require('./risk.js');
const pifDetect = require('./pif-detect.js');
const pifRoute = require('./pif-route.js');

// ---------------------------------------------------------------------------
// Constants & vocab
// ---------------------------------------------------------------------------
const TASK_TYPES = [
  'code_build','code_fix','code_review','refactor','ops_shell',
  'data_extract','classify_label','data_analysis','research','explain_teach',
  'write_prose','creative_ideation','plan_design','prompt_agent_design',
  'decision_advice','quick_fact',
];
const POOLS = ['creative', 'reliability', 'reasoning'];
const TIERS = ['micro', 'standard', 'deep'];
const FLAGS = [
  'persona_fit','critique_loop','iteration_readiness','output_parseability',
  'injection_defense','destructive','ambiguous','needs_fresh_facts',
];

// Built-in technique IDs (T1..T43). Superseded by references/techniques.json when present.
const BUILTIN_TECH_IDS = Array.from({ length: 43 }, (_, i) => `T${i + 1}`);

const ROUTER_VERSION = '2.1';

// ---------------------------------------------------------------------------
// Module-level cache (load once)
// ---------------------------------------------------------------------------
let _model = null;
let _bank = null;
let _techniquesRegistry = null;

function getModel() {
  if (_model) return _model;
  const p = path.join(__dirname, 'model.json');
  _model = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _model;
}

function getBank() {
  if (_bank !== null) return _bank;
  try {
    const p = path.join(__dirname, '..', 'references', 'bank-index.json');
    _bank = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    _bank = { docs: [], df: {}, avgdl: 0 };
  }
  return _bank;
}

function getTechniquesRegistry() {
  if (_techniquesRegistry) return _techniquesRegistry;
  try {
    const p = path.join(__dirname, '..', 'references', 'techniques.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Normalize: build a {id -> entry} map from the techniques array
    if (raw.techniques && Array.isArray(raw.techniques)) {
      const map = {};
      for (const t of raw.techniques) map[t.id] = t;
      _techniquesRegistry = map;
    } else {
      _techniquesRegistry = raw; // already {id -> entry} format
    }
  } catch {
    _techniquesRegistry = {};
  }
  return _techniquesRegistry;
}

/**
 * Get technique IDs from references/techniques.json if present; else built-in T1..T43.
 * Also pull names, conflicts, and vetoes from the registry.
 */
function getTechIds() {
  const reg = getTechniquesRegistry();
  const ids = Object.keys(reg).filter(k => /^T\d+$/.test(k));
  if (ids.length > 0) {
    // Sort numerically
    return ids.sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  }
  return BUILTIN_TECH_IDS;
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

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Jev Choice confidence: clamp((N*p_max - 1)/(N-1), 0, 1)
function choiceConf(probs) {
  const N = probs.length;
  if (N <= 1) return 1;
  const pMax = Math.max(...probs);
  return clamp((N * pMax - 1) / (N - 1), 0, 1);
}

// Jev Noul confidence: |2p - 1|
function noulConf(p) {
  return Math.abs(2 * p - 1);
}

// ---------------------------------------------------------------------------
// Linear model evaluation
// ---------------------------------------------------------------------------
/**
 * Evaluate a Choice head.
 * W[label][featName] = weight; b[label] = bias override (optional)
 * Returns {probs: {label: p}, pred: label, conf: number}
 */
function evalChoice(head, featVec, model) {
  const W = model.weights[head] || {};
  const T = (model.temperatures && model.temperatures[head]) || 1.0;
  const labels = model.heads[head].labels;

  const logits = labels.map(label => {
    const w = W[label] || {};
    let logit = (model.biases && model.biases[head] && model.biases[head][label]) || 0;
    for (const [feat, val] of Object.entries(featVec)) {
      logit += (w[feat] || 0) * val;
    }
    return logit / T;
  });

  const probs = softmax(logits);
  const maxIdx = probs.indexOf(Math.max(...probs));
  return {
    probs: Object.fromEntries(labels.map((l, i) => [l, probs[i]])),
    pred: labels[maxIdx],
    conf: choiceConf(probs),
  };
}

/**
 * Evaluate a Noul head (binary).
 * Returns {p: number, pred: boolean, conf: number}
 */
function evalNoul(head, featVec, model) {
  const W = model.weights[head] || {};
  const T = (model.temperatures && model.temperatures[head]) || 1.0;
  const w = W['pos'] || {};
  let logit = (model.biases && model.biases[head] && model.biases[head]['pos']) || 0;
  for (const [feat, val] of Object.entries(featVec)) {
    logit += (w[feat] || 0) * val;
  }
  const p = sigmoid(logit / T);
  return { p, pred: p >= 0.5, conf: noulConf(p) };
}

// ---------------------------------------------------------------------------
// Technique selection logic (deterministic code-in-control)
// ---------------------------------------------------------------------------
const THETA_TECH_DEFAULT = 0.35;

function pickTechniques(techResults, topTierPred, poolPred, modelJson) {
  const theta = (modelJson.fit && modelJson.fit.theta_tech) || THETA_TECH_DEFAULT;
  const registry = getTechniquesRegistry();

  // Sort techniques by p descending
  const ranked = Object.entries(techResults)
    .map(([id, r]) => ({ id, p: r.p, conf: r.conf }))
    .sort((a, b) => b.p - a.p);

  const cleared = ranked.filter(t => t.p >= theta);
  if (cleared.length === 0) {
    return { picked: [], strongest: ranked[0] || null };
  }

  let pick = [cleared[0]];

  if (cleared.length >= 2) {
    const second = cleared[1];
    // Drop second if it's a conflict of first (from techniques.json or built-in)
    const firstEntry = registry[pick[0].id] || {};
    const conflicts = firstEntry.conflicts || [];
    const isConflict = conflicts.includes(second.id);

    // Drop second if p < 0.5 * p_first
    const ratioOk = second.p >= 0.5 * pick[0].p;

    if (!isConflict && ratioOk) {
      pick.push(second);
    }
  }

  return { picked: pick, strongest: cleared[0] };
}

/**
 * Apply per-technique vetoes from techniques.json registry.
 * Each veto entry: {if_pool, if_pool_p_gte, if_task_in, reason}
 */
function applyVetoes(pick, poolPred, poolProbs, taskPred, registry) {
  return pick.filter(t => {
    const entry = registry[t.id] || {};
    const vetoes = entry.vetoes || [];

    // Built-in: T1 persona vetoed when pool=reliability p>0.8 + data_extract/classify_label
    if (t.id === 'T1') {
      const poolP = (poolProbs && poolProbs['reliability']) || 0;
      if (poolP > 0.8 && (taskPred === 'data_extract' || taskPred === 'classify_label')) {
        return false;
      }
    }

    // Registry vetoes
    for (const veto of vetoes) {
      const poolMatch = !veto.if_pool || (veto.if_pool === poolPred);
      const poolPMin = veto.if_pool_p_gte || 0;
      const poolPActual = (poolProbs && veto.if_pool && poolProbs[veto.if_pool]) || 0;
      const poolPOk = !veto.if_pool || poolPActual >= poolPMin;
      const taskMatch = !veto.if_task_in || (veto.if_task_in.includes(taskPred));
      if (poolMatch && poolPOk && taskMatch) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Tier override logic
// ---------------------------------------------------------------------------

/**
 * Tier override rules (in priority order):
 *
 *  1. Destructive HIGH (risk.js): always raises to deep regardless of flag.destructive p.
 *  2. Destructive LOW (risk.js): raises to deep when flag.destructive p >= 0.5.
 *  3. Multi-file: >= 3 distinct file-path literals in the preserve inventory
 *     raises standard -> deep. (scope_all raise removed: too many false positives.)
 *
 * Ambiguous flag no longer raises tier: LLM decision card handles ambiguity.
 *
 * Returns {tier, overrides, riskResult, destructiveRaised, destP}
 */
function applyTierOverrides(tierPred, featVec, flagResults, prompt, literals) {
  let tier = tierPred;
  const overrides = [];

  const riskResult = classifyDestructive(prompt || '');
  const destP      = (flagResults['destructive'] && flagResults['destructive'].p) || 0;
  let destructiveRaised = false;

  if (riskResult.severity === 'high' && tier !== 'deep') {
    tier = 'deep';
    destructiveRaised = true;
    overrides.push(`destructive high raised to deep (${riskResult.highTerms.slice(0, 3).join(', ')})`);
  } else if (riskResult.severity === 'low' && destP >= 0.5 && tier !== 'deep') {
    tier = 'deep';
    destructiveRaised = true;
    overrides.push(`destructive low raised to deep (${riskResult.lowTerms.slice(0, 3).join(', ')})`);
  }

  // Multi-file: >= 3 distinct file-path literals in preserve inventory
  const filePathCount = (literals && literals.filePaths && literals.filePaths.length) || 0;
  if (filePathCount >= 3 && tier === 'standard') {
    tier = 'deep';
    overrides.push('file refs raised standard->deep');
  }

  return { tier, overrides, riskResult, destructiveRaised, destP };
}

// ---------------------------------------------------------------------------
// Mode determination
// ---------------------------------------------------------------------------
function determineMode(confTier, confPool, confTech, modelJson) {
  const tauFast = (modelJson.fit && modelJson.fit.tau_fast) || 0.66;
  const tauCheck = (modelJson.fit && modelJson.fit.tau_check) || 0.40;

  const overall = Math.min(confTier, confPool, confTech);
  let mode;
  if (overall >= tauFast) mode = 'FAST';
  else if (overall >= tauCheck) mode = 'CHECK';
  else mode = 'DELIBERATE';

  return { mode, overall, tauFast, tauCheck };
}

// ---------------------------------------------------------------------------
// Main route function
// ---------------------------------------------------------------------------
/**
 * route(prompt) -> verdict
 * All heads answered from same feature vector in one pass.
 */
function route(prompt) {
  const t0 = Date.now();

  // Defense in depth: route on at most the first 24 KB + last 4 KB.
  // This keeps every downstream regex O(n) on normal inputs and prevents
  // superlinear blowup on pasted minified JS, base64, or single-line JSON.
  const MAX_LEAD = 24000;
  const MAX_TAIL = 4000;
  let routePrompt = prompt;
  let truncated = false;
  if (typeof prompt === 'string' && prompt.length > MAX_LEAD + MAX_TAIL) {
    routePrompt = prompt.slice(0, MAX_LEAD) + '\n…\n' + prompt.slice(-MAX_TAIL);
    truncated = true;
  }

  const model = getModel();
  const featVec = extractFeatures(routePrompt);

  // --- Choice heads ---
  const tierResult = evalChoice('tier', featVec, model);
  const poolResult = evalChoice('pool', featVec, model);
  const taskResult = evalChoice('task', featVec, model);

  // --- Noul: techniques ---
  const techResults = {};
  // Prefer: techniques.json IDs, then model head labels, then built-in list
  const techLabels = getTechIds().length > 0
    ? getTechIds()
    : ((model.heads['tech'] || {}).labels || BUILTIN_TECH_IDS);

  for (const tId of techLabels) {
    const headKey = `tech:${tId}`;
    techResults[tId] = evalNoul(headKey, featVec, model);
  }

  // --- Noul: flags ---
  const flagResults = {};
  for (const flag of FLAGS) {
    const headKey = `flag:${flag}`;
    flagResults[flag] = evalNoul(headKey, featVec, model);
  }

  // --- Technique selection (code in control) ---
  const { picked: pickedTechs, strongest: strongestTech } =
    pickTechniques(techResults, tierResult.pred, poolResult.pred, model);

  // Apply vetoes (from techniques.json registry + built-in rules)
  const registry = getTechniquesRegistry();
  let finalTechs = applyVetoes(pickedTechs, poolResult.pred, poolResult.probs, taskResult.pred, registry);

  // --- Deterministic: literal inventory (needed by tier overrides) ---
  const literals = extractLiterals(routePrompt);

  // --- Tier overrides ---
  const {
    tier: finalTier, overrides: tierOverrides,
    riskResult, destructiveRaised, destP: tierDestructiveP,
  } = applyTierOverrides(tierResult.pred, featVec, flagResults, routePrompt, literals);

  // --- Tech confidence for mode ---
  const confTech = finalTechs.length > 0
    ? finalTechs[0].conf
    : (strongestTech ? strongestTech.conf : 0);

  // --- Mode ---
  const { mode, overall, tauFast, tauCheck } =
    determineMode(tierResult.conf, poolResult.conf, confTech, model);

  // --- Exemplars (BM25 with relevance gate) ---
  const promptWordCount = routePrompt.trim().split(/\s+/).length;
  const thetaEx = (model.fit && model.fit.theta_ex) || 0;
  const exemplars = retrieveExemplars(
    routePrompt,
    taskResult.pred,
    finalTechs.map(t => t.id),
    2,
    { thetaEx, wordCount: promptWordCount }
  );

  // --- Deterministic: signals (all run on routePrompt, the truncated window) ---
  const pastedSize = Math.max(0, routePrompt.length - 200) + (literals.fencedCount > 0 ? routePrompt.replace(/^[^`]{0,200}/,'').length : 0);
  const hasStackTrace = /(?:at\s+\w+\s*\(|Traceback|Error:|Exception:|^\s+at\s)/m.test(routePrompt);
  // Linear JSON-blob check: two indexOf calls, no backtracking.
  const _jlo = routePrompt.indexOf('{');
  const hasJsonBlob = _jlo >= 0 && routePrompt.indexOf('}', _jlo + 21) > 0;
  const injectionPhrases = extractInjectionPhrases(routePrompt);
  const hasNonEnglish = /[\u0080-￿]/.test(routePrompt);

  const signals = {
    riskResult,
    destructiveRaised,
    destructiveP: tierDestructiveP,
    pastedChars: pastedSize,
    stackTrace: hasStackTrace,
    jsonBlob: hasJsonBlob,
    injectionPhrases,
    nonEnglishScript: hasNonEnglish,
  };

  const elapsed = Date.now() - t0;

  const verdict = {
    tier: {
      pred: finalTier, probs: tierResult.probs, conf: tierResult.conf,
      overrides: tierOverrides,
      riskResult,
      destructiveRaised,
      destructiveP: tierDestructiveP,
    },
    pool: { pred: poolResult.pred, probs: poolResult.probs, conf: poolResult.conf },
    task: { pred: taskResult.pred, probs: taskResult.probs, conf: taskResult.conf },
    techniques: {
      picked: finalTechs,
      techResults,
      strongest: strongestTech,
    },
    flags: flagResults,
    mode: { mode, overall, tauFast, tauCheck },
    exemplars,
    literals,
    signals,
    elapsedMs: elapsed,
    modelDate: (model.fit && model.fit.date) || 'prior-only',
    routerVersion: ROUTER_VERSION,
    truncated,
    _prompt: prompt,
  };

  // --- Prompt Injection Firewall (Tier 0 + routing recommendation) ---
  let pif = null;
  try {
    const detectResult = pifDetect.detect(prompt, { source: 'user_message' });
    const routeResult = pifRoute.route(detectResult);
    pif = {
      risk: detectResult.risk,
      confidence: detectResult.confidence,
      attack_types: detectResult.attack_types.map(a => ({ id: a.id, confidence: a.confidence, severity: a.severity })),
      tier: routeResult.tier,
      neutralize_hint: detectResult.neutralize_hint,
      neutralize_immediately: routeResult.neutralize_immediately,
      reason: routeResult.reason,
      tier0_fault: !!(detectResult.tier0_fault || routeResult.tier0_fault),
      scanner_latency_ms: detectResult.scanner_latency_ms,
      signals: detectResult.signals || [],
    };
  } catch (e) {
    pif = { risk: 0, confidence: 0, attack_types: [], tier: 'none', neutralize_hint: '', neutralize_immediately: false, reason: 'pif_integration_fault: ' + (e.message || 'unknown'), tier0_fault: true, scanner_latency_ms: 0 };
  }
  verdict.pif = pif;

  return verdict;
}

// ---------------------------------------------------------------------------
// Exemplar path resolution
// ---------------------------------------------------------------------------
const os = require('node:os');

/**
 * Resolve an exemplar relPath to an absolute path the LLM can open.
 * If the plugin root is under ~/.claude/skills, use that prefix.
 * Otherwise use the absolute path relative to the router directory.
 */
function resolveExemplarPath(relPath) {
  // relPath is e.g. "references/bank/foo.txt"
  // __dirname is .../apex/router
  const pluginRoot = path.join(__dirname, '..');
  const skillsDir = path.join(os.homedir(), '.claude', 'skills', 'apex');
  // Check if pluginRoot is under ~/.claude/skills/apex
  const canonical = fs.realpathSync ? (() => { try { return fs.realpathSync(pluginRoot); } catch { return pluginRoot; } })() : pluginRoot;
  const skillsCanon = (() => { try { return fs.realpathSync(skillsDir); } catch { return skillsDir; } })();
  if (canonical === skillsCanon) {
    return `~/.claude/skills/apex/${relPath}`;
  }
  return path.join(pluginRoot, relPath);
}

// ---------------------------------------------------------------------------
// Format verdict as text (<= 12 lines, router 2.1 layout)
// Hints (tier/pool/task/mode + technique hints) are OFF by default.
// Set env APEX_HINTS=1 to show them. --explain and --json always show them.
// ---------------------------------------------------------------------------
function format(verdict, { showHints = false } = {}) {
  const hintsOn = showHints || process.env.APEX_HINTS === '1';
  const lines = [];
  const elapsed = verdict.elapsedMs || 0;
  const model = getModel();

  // ── Line 1: header ────────────────────────────────────────────────────────
  const h = model.holdout;
  if (h) {
    const ac = h.annotator_ceiling || {};
    if (hintsOn) {
      lines.push(
        `APEX S1 verdict (router ${verdict.routerVersion}, ${elapsed} ms; ` +
        `holdout tier ${h.tier.toFixed(2)} pool ${h.pool.toFixed(2)} ` +
        `vs annotator ceiling tier ${(ac.tier || 0).toFixed(2)} pool ${(ac.pool || 0).toFixed(2)}: hints shown)`
      );
    } else {
      lines.push(
        `APEX S1 verdict (router ${verdict.routerVersion}, ${elapsed} ms; ` +
        `classification hints off; holdout tier ${h.tier.toFixed(2)} pool ${h.pool.toFixed(2)} ` +
        `vs annotator ceiling ${(ac.tier || 0).toFixed(2)}/${(ac.pool || 0).toFixed(2)})`
      );
    }
  } else {
    lines.push(`APEX S1 verdict (router ${verdict.routerVersion}, ${elapsed} ms, model fit ${verdict.modelDate})`);
  }

  // ── Line 2: preserve (literals) ───────────────────────────────────────────
  const lits = verdict.literals;
  if (lits) {
    let preserveLine = buildPreserveLine(lits);
    if (preserveLine) {
      if (verdict.truncated) {
        preserveLine += '  (scanned first 24 KB + last 4 KB)';
      }
      lines.push(preserveLine);
    } else if (verdict.truncated) {
      lines.push('preserve  (scanned first 24 KB + last 4 KB)');
    }
  }

  // ── Line 3: signals ───────────────────────────────────────────────────────
  const sigs = verdict.signals;
  const tierOverrides = verdict.tier.overrides || [];
  {
    const sigParts = [];
    const risk      = verdict.tier.riskResult || {};
    const destRaised = verdict.tier.destructiveRaised;
    const destP      = verdict.tier.destructiveP || 0;

    // Destructive: show severity + terms
    if (risk.severity === 'high') {
      const terms = risk.highTerms.slice(0, 3).join(', ');
      sigParts.push(`tier raised: destructive high (${terms})`);
    } else if (risk.severity === 'low') {
      const terms = risk.lowTerms.slice(0, 3).join(', ');
      if (destRaised) {
        sigParts.push(`tier raised: destructive low (${terms})`);
      } else {
        sigParts.push(`destructive terms: ${terms} (low, not raised)`);
      }
    }

    // Multi-file raise
    if (tierOverrides.some(o => o.startsWith('file refs'))) {
      sigParts.push('tier raised: file refs');
    }

    if (sigs) {
      if (sigs.pastedChars > 200) {
        sigParts.push(`pasted ${(sigs.pastedChars / 1024).toFixed(1)} KB`);
      }
      if (sigs.stackTrace) sigParts.push('stack trace');
      if (sigs.jsonBlob) sigParts.push('JSON blob');
      if (sigs.injectionPhrases && sigs.injectionPhrases.length > 0) {
        sigParts.push(`injection phrases: "${sigs.injectionPhrases[0]}"`);
      }
      if (sigs.nonEnglishScript) sigParts.push('non-English script');
    }
    if (sigParts.length > 0) lines.push(`signals   ${sigParts.join(' | ')}`);
  }

  if (hintsOn) {
    // ── Line 4: hints (tier/pool/task/mode) ─────────────────────────────────
    const tierConf = verdict.tier.conf;
    const poolConf = verdict.pool.conf;
    const { mode, overall } = verdict.mode;
    const tierStr = verdict.tier.pred +
      (tierOverrides.some(o => o.includes('destructive')) ? ' (raised: destructive)' : '');
    const taskP = (verdict.task.probs[verdict.task.pred] || 0);
    lines.push(
      `hints     tier ${tierStr} ${tierConf.toFixed(2)} | pool ${verdict.pool.pred} ${poolConf.toFixed(2)} | task ${verdict.task.pred} ${taskP.toFixed(2)} | mode ${mode} (conf ${overall.toFixed(2)})`
    );

    // ── Line 5: technique hints ──────────────────────────────────────────────
    const techResults = verdict.techniques.techResults || {};
    const allTechSorted = Object.entries(techResults)
      .map(([id, r]) => ({ id, p: r.p }))
      .sort((a, b) => b.p - a.p);
    const top3 = allTechSorted.slice(0, 3);
    if (top3.length > 0) {
      const techParts = top3.map(t => `${t.id} ${getTechName(t.id)} ${t.p.toFixed(2)}`).join(', ');
      lines.push(`technique hints  ${techParts}`);
    } else {
      lines.push('technique hints  none');
    }
  }

  // ── Firewall line (only when pif.risk >= 0.3 OR pif.tier0_fault) ─────────
  if (verdict.pif && (verdict.pif.risk >= 0.3 || verdict.pif.tier0_fault)) {
    const attacks = verdict.pif.attack_types.slice(0, 4).map(a => a.id).join(', ') || 'none';
    const faultTag = verdict.pif.tier0_fault ? ' (fault)' : '';
    const neutralizeTag = verdict.pif.neutralize_immediately ? ' NEUTRALIZE NOW' : '';
    const tierTag = verdict.pif.tier !== 'none' ? ' → ' + verdict.pif.tier : '';
    lines.push('firewall  risk ' + verdict.pif.risk.toFixed(2) + ' [' + attacks + ']' + tierTag + faultTag + neutralizeTag);
  }

  // ── Lines N..N+1: exemplars ───────────────────────────────────────────────
  // Omit line entirely when nothing passes the relevance gate.
  const exemplars = verdict.exemplars || [];
  for (const e of exemplars) {
    const absPath = resolveExemplarPath(e.relPath);
    const maxUw = Math.max(20, 150 - absPath.length - 3);
    const uw = (e.useWhen || '').slice(0, maxUw);
    lines.push(`exemplars ${absPath} - ${uw}`);
  }

  // Enforce <= 12 lines
  return lines.slice(0, 12).join('\n');
}

// ---------------------------------------------------------------------------
// explain(): human-readable table for --explain CLI mode
// ---------------------------------------------------------------------------
function getTechName(id) {
  const reg = getTechniquesRegistry();
  const entry = reg[id];
  if (entry && entry.name) return entry.name;
  // Built-in name map (abbreviated)
  const NAMES = {
    T1:'Persona/role',T2:'Few-shot examples',T3:'Chain-of-thought',T4:'Extended thinking',
    T5:'Decomposition',T6:'Constraints',T7:'Structured output',T8:'Delimiters',
    T9:'Prefill',T10:'Stop sequences',T11:'Sampling controls',T12:'Grounding/citation',
    T13:'Self-critique',T14:'Iterative refinement',T15:'Evals/golden dataset',
    T16:'Hallucination guardrails',T17:'Injection defense',T18:'Silent refusal detection',
    T19:'System prompt placement',T20:'Output chaining',T21:'CREATE framework',
    T22:'Instruction placement',T23:'Token budget awareness',T24:'Self-consistency',
    T25:'Tree of thoughts',T26:'ReAct/tool loop',T27:'Plan-and-execute',
    T28:'Step-back prompting',T29:'Least-to-most',T30:'Clarification strategy',
    T31:'Rubric/LLM-as-judge',T32:'Context engineering',T33:'Reasoning-model prompting',
    T34:'Pre-mortem/red team',T35:'Outline-first',T36:'Meta-prompting',
    T37:'Contrastive examples',T38:'Audience specification',T39:'Definition of done first',
    T40:'Tool and schema design',T41:'Chain-of-verification',
    T42:'Multi-agent orchestration',T43:'Diverge then converge',
  };
  return NAMES[id] || id;
}

function explain(verdict) {
  const lines = [];
  const hr = '─'.repeat(60);

  lines.push(hr);
  lines.push(`APEX S1 EXPLAIN  (router ${verdict.routerVersion}, ${verdict.elapsedMs} ms)`);
  lines.push(hr);

  // Firewall summary (if risk >= 0.3 or tier0_fault)
  if (verdict.pif && (verdict.pif.risk >= 0.3 || verdict.pif.tier0_fault)) {
    const attacks = verdict.pif.attack_types.slice(0, 4).map(a => a.id).join(', ') || 'none';
    const faultTag = verdict.pif.tier0_fault ? ' (fault)' : '';
    const neutralizeTag = verdict.pif.neutralize_immediately ? ' NEUTRALIZE NOW' : '';
    const tierTag = verdict.pif.tier !== 'none' ? ' → ' + verdict.pif.tier : '';
    lines.push('firewall  risk ' + verdict.pif.risk.toFixed(2) + ' [' + attacks + ']' + tierTag + faultTag + neutralizeTag);
  }

  // Tier: top 3 classes
  lines.push('\nTIER (top 3):');
  const tierSorted = Object.entries(verdict.tier.probs).sort((a,b) => b[1]-a[1]).slice(0,3);
  for (const [cls, p] of tierSorted) {
    const mark = cls === verdict.tier.pred ? '>' : ' ';
    lines.push(`  ${mark} ${cls.padEnd(12)} ${(p*100).toFixed(1).padStart(5)}%`);
  }
  lines.push(`  conf: ${verdict.tier.conf.toFixed(3)}`);
  if (verdict.tier.overrides.length > 0) lines.push(`  overrides: ${verdict.tier.overrides.join('; ')}`);

  // Pool: top 3 classes
  lines.push('\nPOOL (top 3):');
  const poolSorted = Object.entries(verdict.pool.probs).sort((a,b) => b[1]-a[1]).slice(0,3);
  for (const [cls, p] of poolSorted) {
    const mark = cls === verdict.pool.pred ? '>' : ' ';
    lines.push(`  ${mark} ${cls.padEnd(12)} ${(p*100).toFixed(1).padStart(5)}%`);
  }
  lines.push(`  conf: ${verdict.pool.conf.toFixed(3)}`);

  // Task: top 3 classes
  lines.push('\nTASK (top 3):');
  const taskSorted = Object.entries(verdict.task.probs).sort((a,b) => b[1]-a[1]).slice(0,3);
  for (const [cls, p] of taskSorted) {
    const mark = cls === verdict.task.pred ? '>' : ' ';
    lines.push(`  ${mark} ${cls.padEnd(22)} ${(p*100).toFixed(1).padStart(5)}%`);
  }
  lines.push(`  conf: ${verdict.task.conf.toFixed(3)}`);

  // Techniques: top 8 with p and confidence
  lines.push('\nTECHNIQUES (top 8):');
  const techResults = verdict.techniques.techResults || {};
  const pickedSet = new Set((verdict.techniques.picked || []).map(t => t.id));
  const techSorted = Object.entries(techResults)
    .map(([id, r]) => ({ id, p: r.p, conf: r.conf }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 8);
  for (const t of techSorted) {
    const mark = pickedSet.has(t.id) ? '>' : ' ';
    const name = getTechName(t.id);
    lines.push(`  ${mark} ${t.id.padEnd(4)} ${name.padEnd(28)} p=${t.p.toFixed(3)} conf=${t.conf.toFixed(3)}`);
  }

  // Flags: all 8
  lines.push('\nFLAGS (all 8):');
  const flagResults = verdict.flags || {};
  for (const flag of FLAGS) {
    const r = flagResults[flag] || { p: 0, conf: 0 };
    const mark = r.p >= 0.5 ? '>' : ' ';
    lines.push(`  ${mark} ${flag.padEnd(24)} p=${r.p.toFixed(3)} conf=${r.conf.toFixed(3)}`);
  }

  // Mode
  lines.push('');
  const { mode, overall, tauFast, tauCheck } = verdict.mode;
  // Determine which head was the minimum
  const confTier = verdict.tier.conf;
  const confPool = verdict.pool.conf;
  const confTech = (verdict.techniques.picked && verdict.techniques.picked.length > 0)
    ? verdict.techniques.picked[0].conf
    : (verdict.techniques.strongest ? verdict.techniques.strongest.conf : 0);
  const minHead = confTier <= confPool && confTier <= confTech ? 'tier'
    : confPool <= confTier && confPool <= confTech ? 'pool' : 'tech';
  lines.push(`MODE: ${mode}  overall=${overall.toFixed(3)}  (min head: ${minHead})`);
  lines.push(`  tau_fast=${tauFast.toFixed(2)}  tau_check=${tauCheck.toFixed(2)}`);
  lines.push(`  tier.conf=${confTier.toFixed(3)}  pool.conf=${confPool.toFixed(3)}  tech.conf=${confTech.toFixed(3)}`);

  // Exemplars: top 3 (no gate in explain mode: show all for debugging)
  lines.push('\nEXEMPLARS (top 3):');
  const top3 = retrieveExemplars(
    verdict._prompt || '', verdict.task.pred,
    (verdict.techniques.picked || []).map(t => t.id), 3,
    { thetaEx: 0 }   // no gate in explain mode
  );
  if (top3.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of top3) {
      lines.push(`  score=${e.score.toFixed(3)}  ${e.relPath}`);
      lines.push(`    ${e.useWhen.slice(0, 80)}`);
    }
  }

  lines.push(hr);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  // --exemplars "<ask>" [--task <task_type>] [--techniques T7,T12] [-k 3]
  if (args[0] === '--exemplars') {
    const ask = args[1];
    if (!ask) {
      console.error('Usage: node router.js --exemplars "<ask>" [--task <task_type>] [--techniques T7,T12] [-k 3]');
      process.exit(1);
    }
    let taskType = null;
    let techniqueIds = [];
    let k = 3;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--task' && args[i + 1]) { taskType = args[++i]; }
      else if (args[i] === '--techniques' && args[i + 1]) {
        techniqueIds = args[++i].split(',').map(s => s.trim());
      }
      else if (args[i] === '-k' && args[i + 1]) { k = parseInt(args[++i], 10) || 3; }
    }
    // No gate: show top-k by adjScore regardless of threshold
    const results = retrieveExemplars(ask, taskType, techniqueIds, k, { thetaEx: 0 });
    if (results.length === 0) {
      console.log('(no exemplars found in bank)');
    } else {
      for (const e of results) {
        const absPath = resolveExemplarPath(e.relPath);
        console.log(`score=${e.score.toFixed(3)}  ${absPath}`);
        console.log(`  use_when: ${e.useWhen}`);
        console.log(`  fragment: ${e.fragment}`);
        console.log();
      }
    }
    process.exit(0);
  }

  const modeFlag = args[0];
  const ask = args[1];

  if (!ask || !modeFlag) {
    console.error('Usage: node router.js --explain "<ask>" | --json "<ask>" | --exemplars "<ask>" [opts]');
    process.exit(1);
  }

  const verdict = route(ask);

  if (modeFlag === '--json') {
    console.log(JSON.stringify(verdict, null, 2));
  } else if (modeFlag === '--explain') {
    console.log(explain(verdict));
  } else {
    console.error(`Unknown flag: ${modeFlag}`);
    process.exit(1);
  }
}

module.exports = { route, format, explain, TASK_TYPES, POOLS, TIERS, FLAGS, BUILTIN_TECH_IDS };
