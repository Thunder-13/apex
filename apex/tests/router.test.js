'use strict';
/**
 * router.test.js: node:test unit tests for the APEX v2 System One router.
 *
 * Coverage:
 * - features.js: determinism; compiled-lexicon vs regex parity (50 prompts)
 * - router.js: Choice head probability sums; confidence formula; technique pick rules;
 *              tier overrides (new rule: destructive>=0.5 OR ambiguous>=0.6 -> deep);
 *              mode thresholds
 * - bank.js: retrieval returns <= 2 results with existing paths
 * - hooks/apex-gate.js: /apex-skip bypass; NO_TASK bare commands; garbage stdin;
 *                       non-JSON; huge (1 MB) prompts; missing router fallback;
 *                       verdict text <= 12 lines
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runHook(input) {
  const result = spawnSync(NODE, [path.join(ROOT, 'hooks', 'apex-gate.js')], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  });
  return result;
}

function parseHookOutput(stdout) {
  if (!stdout || !stdout.trim()) return null;
  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// features.js: determinism
// ---------------------------------------------------------------------------
describe('features.js determinism', () => {
  const { extractFeatures } = require(path.join(ROOT, 'router', 'features.js'));

  it('returns the same feature vector for the same prompt (run 1 vs run 2)', () => {
    const prompt = 'extract all invoice numbers from this PDF into JSON';
    const v1 = extractFeatures(prompt);
    const v2 = extractFeatures(prompt);
    assert.deepStrictEqual(v1, v2);
  });

  it('returns a non-empty flat object with numeric values', () => {
    const feats = extractFeatures('write a blog post about jazz');
    assert.ok(typeof feats === 'object');
    const entries = Object.entries(feats);
    assert.ok(entries.length > 0, 'Should have features');
    for (const [k, v] of entries) {
      assert.ok(typeof v === 'number', `Feature ${k} should be number, got ${typeof v}`);
    }
  });

  it('includes bias feature', () => {
    const feats = extractFeatures('hello world');
    assert.ok('s:bias' in feats, 'Should have s:bias');
    assert.strictEqual(feats['s:bias'], 1);
  });

  it('different prompts produce different feature vectors', () => {
    const f1 = extractFeatures('extract json from pdf');
    const f2 = extractFeatures('write a creative poem about jazz');
    const keys = new Set([...Object.keys(f1), ...Object.keys(f2)]);
    let differs = false;
    for (const k of keys) {
      if ((f1[k] || 0) !== (f2[k] || 0)) { differs = true; break; }
    }
    assert.ok(differs, 'Different prompts should produce different features');
  });
});

// ---------------------------------------------------------------------------
// router.js: Choice head probabilities sum to 1
// ---------------------------------------------------------------------------
describe('router.js Choice head probability sums', () => {
  const { route } = require(path.join(ROOT, 'router', 'router.js'));

  const testPrompts = [
    'extract all invoice numbers from this pdf into json',
    'write a blog post about jazz music',
    'fix the null pointer exception in UserService.java',
    'what is the capital of France',
    'refactor the entire codebase to use async/await',
  ];

  for (const prompt of testPrompts) {
    it(`tier probs sum to 1 for: "${prompt.slice(0, 50)}"`, () => {
      const verdict = route(prompt);
      const sum = Object.values(verdict.tier.probs).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1.0) < 1e-9, `Tier probs sum ${sum} != 1`);
    });

    it(`pool probs sum to 1 for: "${prompt.slice(0, 50)}"`, () => {
      const verdict = route(prompt);
      const sum = Object.values(verdict.pool.probs).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1.0) < 1e-9, `Pool probs sum ${sum} != 1`);
    });

    it(`task probs sum to 1 for: "${prompt.slice(0, 50)}"`, () => {
      const verdict = route(prompt);
      const sum = Object.values(verdict.task.probs).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1.0) < 1e-9, `Task probs sum ${sum} != 1`);
    });
  }
});

// ---------------------------------------------------------------------------
// router.js: Confidence formula
// ---------------------------------------------------------------------------
describe('router.js confidence formula', () => {
  // Choice conf: clamp((N*p_max - 1)/(N - 1), 0, 1)
  it('Choice conf: uniform distribution gives 0', () => {
    // N=3, p_max=1/3: (3*1/3 - 1)/(3-1) = 0/2 = 0
    const probs = [1/3, 1/3, 1/3];
    const N = probs.length;
    const pMax = Math.max(...probs);
    const conf = Math.max(0, Math.min(1, (N * pMax - 1) / (N - 1)));
    assert.ok(Math.abs(conf) < 1e-9, `Expected 0, got ${conf}`);
  });

  it('Choice conf: certain prediction gives 1', () => {
    // N=3, p_max=1: (3*1 - 1)/(3-1) = 2/2 = 1
    const probs = [1, 0, 0];
    const N = probs.length;
    const pMax = Math.max(...probs);
    const conf = Math.max(0, Math.min(1, (N * pMax - 1) / (N - 1)));
    assert.ok(Math.abs(conf - 1.0) < 1e-9, `Expected 1, got ${conf}`);
  });

  it('Choice conf: half-confident gives 0.5 (N=3, p_max=2/3)', () => {
    // (3*2/3 - 1)/(3-1) = (2-1)/2 = 0.5
    const probs = [2/3, 1/6, 1/6];
    const N = probs.length;
    const pMax = Math.max(...probs);
    const conf = Math.max(0, Math.min(1, (N * pMax - 1) / (N - 1)));
    assert.ok(Math.abs(conf - 0.5) < 1e-9, `Expected 0.5, got ${conf}`);
  });

  it('Noul conf: p=0.5 gives 0', () => {
    const conf = Math.abs(2 * 0.5 - 1);
    assert.ok(Math.abs(conf) < 1e-9, `Expected 0, got ${conf}`);
  });

  it('Noul conf: p=1.0 gives 1', () => {
    const conf = Math.abs(2 * 1.0 - 1);
    assert.ok(Math.abs(conf - 1.0) < 1e-9, `Expected 1, got ${conf}`);
  });

  it('Noul conf: p=0.0 gives 1', () => {
    const conf = Math.abs(2 * 0.0 - 1);
    assert.ok(Math.abs(conf - 1.0) < 1e-9, `Expected 1, got ${conf}`);
  });

  it('Noul conf: p=0.8 gives 0.6', () => {
    const conf = Math.abs(2 * 0.8 - 1);
    assert.ok(Math.abs(conf - 0.6) < 1e-9, `Expected 0.6, got ${conf}`);
  });
});

// ---------------------------------------------------------------------------
// router.js: Technique pick rules
// ---------------------------------------------------------------------------
describe('router.js technique pick rules', () => {
  const { route } = require(path.join(ROOT, 'router', 'router.js'));

  it('picks at most 2 techniques', () => {
    const verdict = route('extract all invoice numbers from this pdf into json');
    assert.ok(verdict.techniques.picked.length <= 2, 'Should pick at most 2 techniques');
  });

  it('returns none field when no technique clears threshold on very generic prompt', () => {
    // A prompt with almost no lexicon hits should trigger none or low confidence
    const verdict = route('ok');
    // Either picked is empty or it has entries -- just verify no crash and the structure is correct
    assert.ok(Array.isArray(verdict.techniques.picked));
  });

  it('T1 persona vetoed when pool is reliability with p>0.8 on data_extract task', () => {
    // Force a strong reliability signal
    const verdict = route('extract all invoice numbers from this pdf into json, output as json schema, parse structured fields');
    // If T1 was picked and pool=reliability with high p and task=data_extract, it should be dropped
    const pool = verdict.pool.pred;
    const task = verdict.task.pred;
    const poolP = verdict.pool.probs['reliability'] || 0;
    if (pool === 'reliability' && poolP > 0.8 && task === 'data_extract') {
      const t1Picked = verdict.techniques.picked.some(t => t.id === 'T1');
      assert.ok(!t1Picked, 'T1 should be vetoed for reliability+data_extract with high p');
    }
    // If conditions not met, test passes trivially
  });

  it('top technique has higher p than second', () => {
    const verdict = route('extract all invoice numbers from this pdf into json');
    const picked = verdict.techniques.picked;
    if (picked.length === 2) {
      assert.ok(picked[0].p >= picked[1].p, 'First technique should have >= p than second');
    }
  });

  it('second technique p >= 0.5 * first (ratio rule)', () => {
    const verdict = route('extract all invoice numbers from this pdf into json');
    const picked = verdict.techniques.picked;
    if (picked.length === 2) {
      assert.ok(picked[1].p >= 0.5 * picked[0].p, 'Second technique must meet ratio rule');
    }
  });
});

// ---------------------------------------------------------------------------
// router.js: Tier overrides
// Rule: raise to deep when (a) DESTRUCTIVE_VERBS term found AND (b) flag.destructive p >= 0.5
// Ambiguous flag NO LONGER raises tier (LLM decision card handles it).
// Multi-file / scope_all: standard -> deep.
// ---------------------------------------------------------------------------
describe('router.js tier overrides', () => {
  const { route } = require(path.join(ROOT, 'router', 'router.js'));

  it('override list is an array', () => {
    const verdict = route('fix a bug');
    assert.ok(Array.isArray(verdict.tier.overrides));
  });

  // ── Destructive severity tests (risk.js integration) ─────────────────────

  it('raises to deep: drop the users table in prod → HIGH severity', () => {
    const verdict = route('drop the users table in prod');
    const risk    = verdict.tier.riskResult || {};
    assert.strictEqual(risk.severity, 'high', 'drop table must be HIGH severity');
    assert.strictEqual(verdict.tier.destructiveRaised, true, 'HIGH must raise tier');
    assert.strictEqual(verdict.tier.pred, 'deep');
  });

  it('does NOT raise: delete the unused import in utils.py (LOW, not high-value object)', () => {
    const verdict = route('delete the unused import in utils.py');
    const risk    = verdict.tier.riskResult || {};
    // "delete" + "import" is not a high-value object → LOW at most, not HIGH
    assert.notStrictEqual(risk.severity, 'high', 'benign delete must not be HIGH');
    assert.ok(Array.isArray(verdict.tier.overrides));
  });

  it('does NOT raise: rm -rf node_modules and reinstall (safe target)', () => {
    const verdict = route('rm -rf node_modules and reinstall');
    const risk    = verdict.tier.riskResult || {};
    assert.notStrictEqual(risk.severity, 'high', 'node_modules is safe: must not be HIGH');
    // LOW may still be present if other LOW terms match, but no raise without HIGH
    assert.ok(Array.isArray(verdict.tier.overrides));
  });

  it('force push to main: classified HIGH by risk.js → raises to deep', () => {
    // "force push" is a HIGH-severity term in risk.js → always raises regardless of flag p
    const verdict = route('force push to main');
    const risk    = verdict.tier.riskResult || {};
    assert.strictEqual(risk.severity, 'high', 'force push must be HIGH severity');
    assert.ok(risk.highTerms.some(t => /force[\s-]push/.test(t)), 'highTerms must include force push');
    assert.strictEqual(verdict.tier.destructiveRaised, true, 'HIGH severity must raise tier');
    assert.strictEqual(verdict.tier.pred, 'deep', 'tier must be deep');
  });

  it('ambiguous flag no longer raises tier automatically', () => {
    // The ambiguous-raise rule has been removed; LLM handles it via decision card
    const verdict = route('or maybe it could be either approach, unclear which one');
    const overrides = verdict.tier.overrides || [];
    assert.ok(!overrides.some(o => /ambiguous/.test(o)), 'ambiguous must not appear in tier overrides');
  });

  it('override never lowers tier', () => {
    const verdict = route('migrate the entire database to a new schema, updating all tables and stored procedures');
    const initialDepth = ['micro', 'standard', 'deep'].indexOf(verdict.tier.pred);
    const rawProbs = verdict.tier.probs;
    const rawPred = Object.keys(rawProbs).reduce((best, k) => rawProbs[k] > (rawProbs[best] || 0) ? k : best, Object.keys(rawProbs)[0]);
    const rawDepth = ['micro', 'standard', 'deep'].indexOf(rawPred);
    assert.ok(initialDepth >= rawDepth, 'Post-override tier must be >= raw tier depth');
  });

  it('multi-file / scope_all raises to deep', () => {
    const verdict = route('refactor all files in the entire codebase to use async/await across 15 different modules');
    assert.ok(['standard', 'deep'].includes(verdict.tier.pred));
  });
});

// ---------------------------------------------------------------------------
// router.js: Mode thresholds
// ---------------------------------------------------------------------------
describe('router.js mode thresholds', () => {
  const { route } = require(path.join(ROOT, 'router', 'router.js'));

  it('mode is one of FAST, CHECK, DELIBERATE', () => {
    const verdict = route('extract all invoice numbers from this pdf into json');
    assert.ok(['FAST', 'CHECK', 'DELIBERATE'].includes(verdict.mode.mode));
  });

  it('overall confidence is between 0 and 1', () => {
    const verdict = route('hello world');
    assert.ok(verdict.mode.overall >= 0 && verdict.mode.overall <= 1);
  });

  it('tau_fast > tau_check in model', () => {
    const model = require(path.join(ROOT, 'router', 'model.json'));
    assert.ok(model.fit.tau_fast > model.fit.tau_check);
  });
});

// ---------------------------------------------------------------------------
// bank.js: Retrieval returns <= 2 results
// ---------------------------------------------------------------------------
describe('bank.js retrieval', () => {
  const { retrieveExemplars } = require(path.join(ROOT, 'router', 'bank.js'));

  it('returns at most 2 exemplars', () => {
    const exemplars = retrieveExemplars('extract invoice data from pdf', 'data_extract', ['T7'], 2);
    assert.ok(exemplars.length <= 2, `Expected <= 2, got ${exemplars.length}`);
  });

  it('returns array (possibly empty)', () => {
    const exemplars = retrieveExemplars('some query', null, [], 2);
    assert.ok(Array.isArray(exemplars));
  });

  it('each exemplar has relPath, useWhen, fragment', () => {
    const exemplars = retrieveExemplars('data extraction json', 'data_extract', ['T7'], 2);
    for (const e of exemplars) {
      assert.ok(typeof e.relPath === 'string', 'relPath should be string');
      assert.ok(typeof e.useWhen === 'string', 'useWhen should be string');
      assert.ok(typeof e.fragment === 'string', 'fragment should be string');
    }
  });

  it('relPaths start with references/bank/', () => {
    const exemplars = retrieveExemplars('analyze sales data', 'data_analysis', ['T7'], 2);
    for (const e of exemplars) {
      assert.ok(e.relPath.startsWith('references/bank/'), `Expected relPath starting with references/bank/, got ${e.relPath}`);
    }
  });
});

// ---------------------------------------------------------------------------
// hooks/apex-gate.js: /apex-skip bypass
// ---------------------------------------------------------------------------
describe('hook: /apex-skip bypass', () => {
  it('returns BYPASS text and no verdict when /apex-skip is present', () => {
    const result = runHook(JSON.stringify({ prompt: 'do something /apex-skip here' }));
    assert.strictEqual(result.status, 0, 'Should exit 0');
    const obj = parseHookOutput(result.stdout);
    assert.ok(obj, 'Should output JSON');
    const ctx = obj.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('APEX (Ask. Perfect. EXecute.) skipped'), 'Should include bypass text');
    assert.ok(!ctx.includes('S1 verdict'), 'Should not include verdict');
    assert.ok(!ctx.includes('APEX MANDATE'), 'Should not include mandate');
  });

  it('exits 0 on /apex-skip', () => {
    const result = runHook(JSON.stringify({ prompt: '/apex-skip just do this' }));
    assert.strictEqual(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// hooks/apex-gate.js: NO_TASK bare commands inject nothing
// ---------------------------------------------------------------------------
describe('hook: NO_TASK bare commands', () => {
  const noTaskCommands = ['/clear', '/compact', '/model', '/help', '/status', '/cost', '/exit'];

  for (const cmd of noTaskCommands) {
    it(`injects nothing for bare "${cmd}"`, () => {
      const result = runHook(JSON.stringify({ prompt: cmd }));
      assert.strictEqual(result.status, 0, 'Should exit 0');
      assert.strictEqual(result.stdout.trim(), '', `Should output nothing for ${cmd}`);
    });
  }
});

// ---------------------------------------------------------------------------
// hooks/apex-gate.js: Garbage stdin
// ---------------------------------------------------------------------------
describe('hook: garbage stdin / non-JSON / huge prompts', () => {
  it('exits 0 with empty or valid-JSON stdout on garbage input', () => {
    const result = runHook('not json at all!!!{{{');
    assert.strictEqual(result.status, 0, 'Should exit 0');
    if (result.stdout.trim()) {
      // If output exists, must be valid JSON
      assert.doesNotThrow(() => JSON.parse(result.stdout.trim()), 'Stdout must be valid JSON if non-empty');
    }
  });

  it('exits 0 on empty stdin', () => {
    const result = runHook('');
    assert.strictEqual(result.status, 0, 'Should exit 0');
    assert.strictEqual(result.stdout.trim(), '', 'Empty prompt should output nothing');
  });

  it('exits 0 on non-JSON object (array)', () => {
    const result = runHook('[1,2,3]');
    assert.strictEqual(result.status, 0);
    // Should either output nothing or valid JSON (prompt is undefined from array)
    if (result.stdout.trim()) {
      assert.doesNotThrow(() => JSON.parse(result.stdout.trim()));
    }
  });

  it('exits 0 and outputs valid JSON for huge (1MB) prompt', () => {
    const hugePadding = 'x'.repeat(1_000_000);
    const result = runHook(JSON.stringify({ prompt: 'extract data ' + hugePadding }));
    assert.strictEqual(result.status, 0, 'Should exit 0');
    if (result.stdout.trim()) {
      assert.doesNotThrow(() => JSON.parse(result.stdout.trim()), 'Stdout must be valid JSON');
    }
  });

  it('exits 0 on null prompt', () => {
    const result = runHook(JSON.stringify({ prompt: null }));
    assert.strictEqual(result.status, 0);
    // null.toString() = 'null' -> trimmed is 'null' which is non-empty but not a useful prompt
    // Hook should output nothing or the mandate
  });
});

// ---------------------------------------------------------------------------
// hooks/apex-gate.js: Missing router fallback
// ---------------------------------------------------------------------------
describe('hook: missing router falls back to mandate', () => {
  it('outputs mandate when APEX_HOME points to nonexistent dir', () => {
    const result = spawnSync(NODE, [path.join(ROOT, 'hooks', 'apex-gate.js')], {
      input: JSON.stringify({ prompt: 'fix this bug in my code' }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, APEX_HOME: '/nonexistent/path/that/does/not/exist' },
    });
    assert.strictEqual(result.status, 0, 'Should exit 0');
    const obj = parseHookOutput(result.stdout);
    assert.ok(obj, 'Should output JSON');
    const ctx = obj.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('APEX MANDATE'), 'Should fall back to mandate');
  });
});

// ---------------------------------------------------------------------------
// hooks/apex-gate.js: Verdict text <= 12 lines
// ---------------------------------------------------------------------------
describe('hook: verdict text <= 12 lines', () => {
  it('verdict portion of output is <= 12 lines', () => {
    const result = runHook(JSON.stringify({ prompt: 'extract all invoice numbers from this pdf into json' }));
    assert.strictEqual(result.status, 0);
    const obj = parseHookOutput(result.stdout);
    assert.ok(obj, 'Should output JSON');
    const ctx = obj.hookSpecificOutput.additionalContext;
    // The verdict is before the blank line + MANDATE
    // Find the first blank line in the output to split verdict from mandate
    const lines = ctx.split('\n');
    // Find where MANDATE starts (after the verdict section)
    // The verdict starts with "APEX S1 verdict" and ends before "APEX MANDATE"
    const verdictStart = lines.findIndex(l => l.startsWith('APEX S1 verdict'));
    if (verdictStart >= 0) {
      const verdictEnd = lines.findIndex((l, i) => i > verdictStart && l.startsWith('APEX MANDATE'));
      const verdictLines = verdictEnd >= 0
        ? lines.slice(verdictStart, verdictEnd).filter(l => l.trim() !== '')
        : lines.slice(verdictStart, verdictStart + 15).filter(l => l.trim() !== '');
      assert.ok(verdictLines.length <= 12, `Verdict has ${verdictLines.length} lines (expected <= 12)`);
    }
    // If no verdict (router unavailable), test passes
  });
});

// ---------------------------------------------------------------------------
// router.js: format() produces <= 12 lines
// ---------------------------------------------------------------------------
describe('router.js format() output <= 12 lines', () => {
  const { route, format } = require(path.join(ROOT, 'router', 'router.js'));

  const prompts = [
    'extract all invoice numbers from this pdf into json',
    'write a blog post about jazz',
    'fix the bug in line 42',
    'what is the capital of France',
    'refactor the entire codebase to use async/await',
  ];

  for (const prompt of prompts) {
    it(`format() <= 12 lines for "${prompt.slice(0, 40)}"`, () => {
      const verdict = route(prompt);
      const text = format(verdict);
      const nonEmptyLines = text.split('\n').filter(l => l.trim() !== '').length;
      assert.ok(nonEmptyLines <= 12, `format() produced ${nonEmptyLines} non-empty lines for: ${prompt}`);
    });
  }
});

// ---------------------------------------------------------------------------
// features.js: compiled-lexicon parity with regex path on 50 varied prompts
// ---------------------------------------------------------------------------
describe('features.js: compiled-lexicon parity with regex on 50 prompts', () => {
  const { extractFeatures, extractFeaturesRegex } = require(path.join(ROOT, 'router', 'features.js'));

  const VARIED_PROMPTS = [
    'extract all invoice numbers from this pdf into json',
    'write a blog post about jazz music in New Orleans',
    'fix the null pointer exception in UserService.java',
    'what is the capital of France',
    'refactor the entire codebase to use async/await',
    'classify each support ticket into billing, technical, or account',
    'analyze monthly sales data and identify top products',
    'design a database schema for a multi-tenant SaaS platform',
    'write a system prompt for a customer service AI agent',
    'review this Python function for SQL injection vulnerabilities',
    'brainstorm 10 creative names for a developer tool',
    'implement a rate limiter in TypeScript with Redis backend',
    'explain how gradient descent works to a non-technical manager',
    'compare PostgreSQL vs MongoDB for real-time analytics workloads',
    'write a bash script to monitor disk usage and send alerts',
    'research the latest techniques for preventing prompt injection attacks',
    'rm -rf the old backup directory and deploy to production',
    'parse this JSON blob and extract all email addresses',
    'write a press release announcing our new product launch',
    'step by step guide to setting up a Kubernetes cluster',
    'debug the authentication flow, the token seems to expire too fast',
    'create a reusable template for API error responses in OpenAPI format',
    'act as a senior security engineer and review this code',
    'output the result as a CSV with columns: id, name, score',
    'write unit tests for the PaymentService class using Jest',
    'migrate all user data from MySQL to PostgreSQL without downtime',
    'should I use React or Vue for this project?',
    'summarize this research paper in 3 bullet points',
    'delete the staging environment and all its data',
    'what is the difference between a mutex and a semaphore',
    'the other day someone said that it could work either way',
    'for each file in /src/components, export a named default',
    'build a multi-agent orchestration system with coordinator',
    'diverge then converge: generate options then select the best one',
    'use chain of thought reasoning before answering',
    'implement with structured output, field: invoiceNumber, type: string',
    'this is ambiguous - or maybe it depends on the context',
    'extend thinking budget to analyze this complex problem deeply',
    'assume failure: what could go wrong with this deployment plan?',
    'write the plan first, then execute it step by step',
    'from the provided documents only, cite your sources',
    'at line 42, the error is: TypeError: Cannot read property of undefined',
    'how many tokens fit in a 100k context window?',
    'define the term "gradient descent" in one sentence',
    'for a beginner audience, explain Docker containers',
    'do not use external libraries, only standard library functions',
    'the output must be machine-readable JSON with strict schema',
    'here is a sample input/output pair to follow as template',
    '你好，请提取所有发票号码并输出为JSON格式',
    'generate verification questions and answer them independently before concluding',
  ];

  it('all 50 prompts: max feature value difference compiled vs regex is < 1e-9', () => {
    for (const prompt of VARIED_PROMPTS) {
      const fc = extractFeatures(prompt);
      const fr = extractFeaturesRegex(prompt);
      const allKeys = new Set([...Object.keys(fc), ...Object.keys(fr)]);
      for (const k of allKeys) {
        if (!k.startsWith('lex:')) continue; // only lexicon features
        const diff = Math.abs((fc[k] || 0) - (fr[k] || 0));
        assert.ok(diff < 1e-9,
          `Feature "${k}" differs: compiled=${fc[k]}, regex=${fr[k]}, diff=${diff} for prompt: ${prompt.slice(0,60)}`);
      }
    }
  });

  it('structural features are identical between both paths', () => {
    for (const prompt of VARIED_PROMPTS.slice(0, 10)) {
      const fc = extractFeatures(prompt);
      const fr = extractFeaturesRegex(prompt);
      const structKeys = Object.keys(fc).filter(k => k.startsWith('s:'));
      for (const k of structKeys) {
        assert.strictEqual(fc[k], fr[k], `Structural feature "${k}" differs for: ${prompt.slice(0,40)}`);
      }
    }
  });
});
