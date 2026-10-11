#!/usr/bin/env node
'use strict';
/**
 * run-kit.js -- Automated PIF kit runner.
 *
 * Pushes every kit file, typed query, paste payload, and multi-turn session
 * through the real hooks (apex-gate.js for prompts, apex-scan.js for tool
 * results), scores each row against expected.json / queries.json / sessions.json
 * and the paste/ directory, then prints a summary.
 *
 * Usage:
 *   node run-kit.js [--label <name>] [--json] [--md]
 *
 * Flags:
 *   --label <name>   Results file stem (default: ISO timestamp)
 *   --json           Write KIT/results/<label>.json
 *   --md             Write KIT/results/<label>.md
 *
 * Exit 0 if every row passes; exit 1 otherwise.
 *
 * Environment for each hook spawn:
 *   APEX_HOME = ROOT
 *   HOME     = fresh temp dir (isolates session state and logs from real home)
 *   APEX_FW_LOG  = 1
 */

const path        = require('path');
const fs          = require('fs');
const os          = require('os');
const { spawnSync } = require('child_process');
const crypto      = require('crypto');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const KIT     = path.resolve(__dirname);
const ROOT    = path.resolve(KIT, '..', '..', '..');
const GATE    = path.join(ROOT, 'hooks', 'apex-gate.js');
const SCAN    = path.join(ROOT, 'hooks', 'apex-scan.js');
const CLI     = path.join(ROOT, 'router', 'pif-cli.js');
const RESULTS = path.join(KIT, 'results');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let label  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let jsonOut = false;
let mdOut   = false;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--label' && argv[i + 1]) { label = argv[++i]; }
  else if (argv[i] === '--json')  { jsonOut = true; }
  else if (argv[i] === '--md')    { mdOut   = true; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a disposable temp dir for one hook invocation or session. */
function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pif-kit-home-'));
}

/** Generate a unique session ID. */
function newSessionId(prefix) {
  return prefix + '-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Spawn a hook process with JSON on stdin.
 * Returns { stdout, stderr, elapsed_ms }.
 */
function spawnHook(hookPath, stdinObj, tempHome) {
  const env = Object.assign({}, process.env, {
    APEX_HOME: ROOT,
    HOME: tempHome,
    APEX_FW_LOG: '1',
    APEX_LOG: '',
  });
  const t0 = Date.now();
  const res = spawnSync('node', [hookPath], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  return {
    stdout:     res.stdout  || '',
    stderr:     res.stderr  || '',
    elapsed_ms: Date.now() - t0,
  };
}

/**
 * Run pif-cli scan --json on an absolute file path.
 * Returns the parsed JSON or a safe default.
 */
function cliScan(absPath) {
  const env = Object.assign({}, process.env, { APEX_HOME: ROOT });
  const res = spawnSync('node', [CLI, 'scan', absPath, '--json'], {
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  try {
    return JSON.parse(res.stdout);
  } catch (_) {
    return { neutralize_immediately: false, tier: 'none', risk: 0, attack_types: [] };
  }
}

// ---------------------------------------------------------------------------
// Parse hook outputs
// ---------------------------------------------------------------------------

/**
 * Parse apex-scan.js (PostToolUse) stdout.
 * Returns { fired, ids, risk, tier, neutralize_now, raw }.
 */
function parseScanOut(stdout) {
  if (!stdout.trim()) {
    return { fired: false, ids: [], risk: 0, tier: 'none', neutralize_now: false };
  }
  let obj;
  try { obj = JSON.parse(stdout); } catch (_) {
    return { fired: true, ids: [], risk: 0, tier: 'none', neutralize_now: false };
  }
  const sysMsg = obj.systemMessage || '';
  // systemMessage: "APEX Firewall: Read foo.pdf (pdf) risk 0.80 [id1, id2] -> sonnet"
  const idMatch   = sysMsg.match(/\[([^\]]+)\]/);
  const ids       = idMatch
    ? idMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const riskMatch = sysMsg.match(/risk\s+([\d.]+)/);
  const risk      = riskMatch ? parseFloat(riskMatch[1]) : 0;
  const tierMatch = sysMsg.match(/(?:->|→)\s*(\w+)/);
  const tier      = tierMatch ? tierMatch[1] : 'none';
  return { fired: true, ids, risk, tier, neutralize_now: false, raw: obj };
}

/**
 * Parse apex-gate.js (UserPromptSubmit) stdout.
 * Returns { fired, ids, risk, tier, session_escalated, fw_line }.
 */
function parseGateOut(stdout) {
  if (!stdout.trim()) {
    return { fired: false, ids: [], risk: 0, tier: 'none', session_escalated: false };
  }
  let obj;
  try { obj = JSON.parse(stdout); } catch (_) {
    return { fired: false, ids: [], risk: 0, tier: 'none', session_escalated: false };
  }
  const ctx    = (obj.hookSpecificOutput && obj.hookSpecificOutput.additionalContext) || '';
  const sysMsg = obj.systemMessage || '';

  // Firewall line in additionalContext: "firewall  risk X.XX [id1, id2] -> tier"
  // (double space; arrow may be -> or →)
  const lines  = ctx.split('\n');
  const fwLine = lines.find(l => /^firewall\s+risk\s+[\d.]/.test(l.trim()));

  if (!fwLine) {
    return { fired: false, ids: [], risk: 0, tier: 'none', session_escalated: false };
  }

  const idMatch   = fwLine.match(/\[([^\]]+)\]/);
  const ids       = idMatch
    ? idMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const riskMatch = fwLine.match(/risk\s+([\d.]+)/);
  const risk      = riskMatch ? parseFloat(riskMatch[1]) : 0;
  const tierMatch = fwLine.match(/(?:->|→)\s*(\w+)/);
  const tier      = tierMatch ? tierMatch[1] : 'none';
  const session_escalated = sysMsg.includes('(session escalation)');

  return { fired: true, ids, risk, tier, session_escalated, fw_line: fwLine.trim() };
}

// ---------------------------------------------------------------------------
// Determine whether a file should be treated as text or binary for tool_response
// ---------------------------------------------------------------------------
const BINARY_EXTS = new Set(['.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg', '.gif', '.bmp']);

function isBinary(filePath) {
  return BINARY_EXTS.has(path.extname(filePath).toLowerCase());
}

function readFileContent(absPath) {
  if (isBinary(absPath)) return '';
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------

function allExpectedPresent(detected, expected) {
  return expected.every(id => detected.includes(id));
}

/** Return p50 and p95 of an array of numbers. */
function percentiles(arr) {
  if (!arr.length) return { p50: 0, p95: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const idx50 = Math.floor(s.length * 0.5);
  const idx95 = Math.floor(s.length * 0.95);
  return { p50: s[Math.min(idx50, s.length - 1)], p95: s[Math.min(idx95, s.length - 1)] };
}

// ---------------------------------------------------------------------------
// Section 1: File tests (expected.json)
// ---------------------------------------------------------------------------

function runFiles() {
  const rows    = JSON.parse(fs.readFileSync(path.join(KIT, 'expected.json'), 'utf8'));
  const results = [];

  console.log('\n=== FILES (expected.json) ===');
  console.log(pad('ID', 22) + pad('Label', 16) + pad('Source', 16) + pad('PASS', 6) +
    pad('Risk', 7) + pad('Tier', 10) + pad('CLITier', 10) + pad('Wall(ms)', 10) +
    'Missing IDs');

  for (const row of rows) {
    const absPath  = path.resolve(KIT, row.file);
    const isWeb    = row.file.startsWith('web/');
    const fileName = path.basename(row.file);
    const tempHome = makeTempHome();

    let scanInput;
    if (isWeb) {
      // Simulate Bash+curl for web files
      const content = readFileContent(absPath);
      scanInput = {
        hook_event_name: 'PostToolUse',
        session_id:      newSessionId('file'),
        tool_name:       'Bash',
        tool_input:      { command: `curl -s http://127.0.0.1:8765/${fileName}` },
        tool_response:   { stdout: content, stderr: '', interrupted: false, isImage: false },
      };
    } else {
      // Simulate Read for all other files
      const content = readFileContent(absPath);
      scanInput = {
        hook_event_name: 'PostToolUse',
        session_id:      newSessionId('file'),
        tool_name:       'Read',
        tool_input:      { file_path: absPath },
        tool_response:   { type: 'text', file: { filePath: absPath, content } },
      };
    }

    const { stdout, elapsed_ms } = spawnHook(SCAN, scanInput, tempHome);
    const parsed = parseScanOut(stdout);

    // pif-cli scan for cli_tier (all rows) and neutralize_immediately (quoted_discussion)
    let cliResult = { tier: 'n/a', neutralize_immediately: false };
    if (!isWeb && fs.existsSync(absPath) && !absPath.endsWith('.png') && !absPath.endsWith('.jpg')) {
      // CLI scan works best on accessible text-extractable files
      cliResult = cliScan(absPath);
    } else if (isWeb) {
      // For web files, run cli scan on the local file
      cliResult = cliScan(absPath);
    } else {
      cliResult = cliScan(absPath);
    }

    const cliTier = cliResult.tier || 'none';

    let pass = false;
    let failReason = '';

    if (row.label === 'attack') {
      if (!parsed.fired) {
        pass = false;
        failReason = 'hook did not fire';
      } else {
        const missing = (row.expected_attacks || []).filter(id => !parsed.ids.includes(id));
        if (missing.length > 0) {
          pass = false;
          failReason = 'missing ids: ' + missing.join(', ');
        } else {
          pass = true;
        }
      }
    } else if (row.label === 'benign') {
      pass = !parsed.fired;
      if (!pass) failReason = 'hook fired unexpectedly (ids: ' + parsed.ids.join(', ') + ')';
    } else if (row.label === 'quoted_discussion') {
      // Allowed to fire, but neutralize_immediately must be false
      const neutralize = cliResult.neutralize_immediately === true;
      pass = !neutralize;
      if (!pass) failReason = 'cli reports neutralize_immediately=true';
    }

    const missing = row.label === 'attack'
      ? (row.expected_attacks || []).filter(id => !parsed.ids.includes(id))
      : [];

    results.push({
      id:               row.id,
      label:            row.label,
      source:           row.source,
      pass,
      fail_reason:      failReason,
      detected_ids:     parsed.ids,
      expected_ids:     row.expected_attacks || [],
      risk:             parsed.risk,
      tier:             parsed.tier,
      cli_tier:         cliTier,
      cli_neutralize:   cliResult.neutralize_immediately,
      elapsed_ms,
      file:             row.file,
      notes:            row.notes || '',
    });

    const passStr = pass ? 'PASS' : 'FAIL';
    console.log(
      pad(row.id, 22) + pad(row.label, 16) + pad(row.source, 16) + pad(passStr, 6) +
      pad(parsed.risk.toFixed(2), 7) + pad(parsed.tier, 10) + pad(cliTier, 10) +
      pad(String(elapsed_ms), 10) +
      (missing.length ? missing.join(',') : (failReason || '-'))
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Section 2: Queries (queries.json)
// ---------------------------------------------------------------------------

function runQueries() {
  const rows    = JSON.parse(fs.readFileSync(path.join(KIT, 'queries.json'), 'utf8'));
  const results = [];

  console.log('\n=== QUERIES (queries.json) ===');
  console.log(pad('ID', 14) + pad('Label', 10) + pad('PASS', 6) +
    pad('Risk', 7) + pad('Tier', 10) + pad('Wall(ms)', 10) + 'Missing IDs / fail reason');

  for (const row of rows) {
    const tempHome  = makeTempHome();
    const sessionId = newSessionId('query');
    const { stdout, elapsed_ms } = spawnHook(GATE, { prompt: row.prompt, session_id: sessionId }, tempHome);
    const parsed = parseGateOut(stdout);

    let pass = false;
    let failReason = '';

    if (row.label === 'attack') {
      if (!parsed.fired) {
        pass = false;
        failReason = 'firewall did not fire';
      } else {
        const missing = (row.expected_attacks || []).filter(id => !parsed.ids.includes(id));
        if (missing.length > 0) {
          pass = false;
          failReason = 'missing ids: ' + missing.join(', ');
        } else {
          pass = true;
        }
      }
    } else if (row.label === 'benign') {
      pass = !parsed.fired;
      if (!pass) failReason = 'firewall fired (ids: ' + parsed.ids.join(', ') + ')';
    }

    const missing = row.label === 'attack'
      ? (row.expected_attacks || []).filter(id => !parsed.ids.includes(id))
      : [];

    results.push({
      id:           row.id,
      label:        row.label,
      pass,
      fail_reason:  failReason,
      detected_ids: parsed.ids,
      expected_ids: row.expected_attacks || [],
      risk:         parsed.risk,
      tier:         parsed.tier,
      elapsed_ms,
    });

    const passStr = pass ? 'PASS' : 'FAIL';
    console.log(
      pad(row.id, 14) + pad(row.label, 10) + pad(passStr, 6) +
      pad(parsed.risk.toFixed(2), 7) + pad(parsed.tier, 10) +
      pad(String(elapsed_ms), 10) +
      (missing.length ? missing.join(',') : (failReason || '-'))
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Section 3: Paste payloads
// ---------------------------------------------------------------------------

function runPaste() {
  const PASTE_DIR = path.join(KIT, 'paste');
  let files;
  try {
    files = fs.readdirSync(PASTE_DIR).filter(f => f.endsWith('.txt')).sort();
  } catch (_) {
    console.log('\n=== PASTE FILES === (directory absent -- run build-kit.py first)');
    return [];
  }

  const results = [];
  console.log('\n=== PASTE FILES (paste/) ===');
  console.log(pad('File', 26) + pad('Label', 10) + pad('PASS', 6) +
    pad('Risk', 7) + pad('Tier', 10) + pad('Wall(ms)', 10) + 'Missing IDs / fail reason');

  for (const fileName of files) {
    const absPath = path.join(PASTE_DIR, fileName);
    let prompt;
    try {
      prompt = fs.readFileSync(absPath, 'utf8');
    } catch (_) {
      continue;
    }

    // Derive label and expected IDs from file name
    let label;
    let expectedIds;
    if (fileName.startsWith('attack-')) {
      label       = 'attack';
      expectedIds = ['instruction_override', 'encoded_instructions'];
    } else if (fileName.startsWith('benign-')) {
      label       = 'benign';
      expectedIds = [];
    } else {
      // Unknown -- treat as benign
      label       = 'benign';
      expectedIds = [];
    }

    const tempHome  = makeTempHome();
    const sessionId = newSessionId('paste');
    const { stdout, elapsed_ms } = spawnHook(GATE, { prompt, session_id: sessionId }, tempHome);
    const parsed = parseGateOut(stdout);

    let pass = false;
    let failReason = '';

    if (label === 'attack') {
      if (!parsed.fired) {
        pass = false;
        failReason = 'firewall did not fire';
      } else {
        const missing = expectedIds.filter(id => !parsed.ids.includes(id));
        if (missing.length > 0) {
          pass = false;
          failReason = 'missing ids: ' + missing.join(', ');
        } else {
          pass = true;
        }
      }
    } else {
      pass = !parsed.fired;
      if (!pass) failReason = 'firewall fired (ids: ' + parsed.ids.join(', ') + ')';
    }

    const missing = label === 'attack'
      ? expectedIds.filter(id => !parsed.ids.includes(id))
      : [];

    results.push({
      id:           fileName,
      label,
      pass,
      fail_reason:  failReason,
      detected_ids: parsed.ids,
      expected_ids: expectedIds,
      risk:         parsed.risk,
      tier:         parsed.tier,
      elapsed_ms,
    });

    const passStr = pass ? 'PASS' : 'FAIL';
    console.log(
      pad(fileName, 26) + pad(label, 10) + pad(passStr, 6) +
      pad(parsed.risk.toFixed(2), 7) + pad(parsed.tier, 10) +
      pad(String(elapsed_ms), 10) +
      (missing.length ? missing.join(',') : (failReason || '-'))
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Section 4: Sessions (sessions.json)
// ---------------------------------------------------------------------------

function runSessions() {
  const rows    = JSON.parse(fs.readFileSync(path.join(KIT, 'sessions.json'), 'utf8'));
  const results = [];

  console.log('\n=== SESSIONS (sessions.json) ===');
  console.log(pad('ID', 14) + pad('Label', 10) + pad('PASS', 6) +
    pad('FlagTurn', 10) + pad('Expect', 8) + pad('Wall(ms)', 10) + 'Fail reason');

  for (const session of rows) {
    const tempHome  = makeTempHome();
    const sessionId = newSessionId('sess');

    let firstFlagTurn  = null;   // 1-indexed
    let allTurnResults = [];
    let totalMs        = 0;
    let msj_present    = false;  // multi_step_jailbreak detected

    for (let i = 0; i < session.turns.length; i++) {
      const turnNum = i + 1;
      const { stdout, elapsed_ms } = spawnHook(
        GATE,
        { prompt: session.turns[i], session_id: sessionId },
        tempHome
      );
      const parsed = parseGateOut(stdout);
      totalMs += elapsed_ms;

      if (parsed.fired && firstFlagTurn === null) {
        firstFlagTurn = turnNum;
      }

      if (parsed.ids.includes('multi_step_jailbreak') || parsed.session_escalated) {
        msj_present = true;
      }

      allTurnResults.push({
        turn:    turnNum,
        fired:   parsed.fired,
        ids:     parsed.ids,
        risk:    parsed.risk,
        tier:    parsed.tier,
        session_escalated: parsed.session_escalated,
        elapsed_ms,
      });
    }

    let pass = false;
    let failReason = '';

    if (session.label === 'attack') {
      const expectTurn = session.expect_flag_from_turn;
      if (firstFlagTurn === null) {
        pass = false;
        failReason = 'no turn fired';
      } else if (firstFlagTurn !== expectTurn) {
        pass = false;
        failReason = `first flag at turn ${firstFlagTurn}, expected turn ${expectTurn}`;
      } else {
        // Check multi_step_jailbreak requirement
        const needsMsj = (session.expected_attacks || []).includes('multi_step_jailbreak');
        if (needsMsj && !msj_present) {
          pass = false;
          failReason = 'multi_step_jailbreak or session_escalation not found in any turn';
        } else {
          pass = true;
        }
      }
    } else if (session.label === 'benign') {
      pass = (firstFlagTurn === null);
      if (!pass) failReason = `firewall fired at turn ${firstFlagTurn}`;
    }

    results.push({
      id:                session.id,
      label:             session.label,
      pass,
      fail_reason:       failReason,
      first_flag_turn:   firstFlagTurn,
      expect_flag_turn:  session.expect_flag_from_turn,
      expected_attacks:  session.expected_attacks || [],
      turn_results:      allTurnResults,
      elapsed_ms:        totalMs,
    });

    const passStr = pass ? 'PASS' : 'FAIL';
    console.log(
      pad(session.id, 14) + pad(session.label, 10) + pad(passStr, 6) +
      pad(firstFlagTurn === null ? 'none' : String(firstFlagTurn), 10) +
      pad(session.expect_flag_from_turn === null ? 'none' : String(session.expect_flag_from_turn), 8) +
      pad(String(totalMs), 10) +
      (failReason || '-')
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(fileResults, queryResults, pasteResults, sessionResults) {
  const allRows = [
    ...fileResults.map(r => Object.assign({ section: 'files' }, r)),
    ...queryResults.map(r => Object.assign({ section: 'queries' }, r)),
    ...pasteResults.map(r => Object.assign({ section: 'paste' }, r)),
  ];

  // Attack recall by source (files only)
  const attackBySrc = {};
  for (const r of fileResults) {
    if (r.label !== 'attack') continue;
    if (!attackBySrc[r.source]) attackBySrc[r.source] = { pass: 0, total: 0 };
    attackBySrc[r.source].total++;
    if (r.pass) attackBySrc[r.source].pass++;
  }

  // Attack recall by ID (all sections)
  const attackById = {};
  for (const r of allRows) {
    if (r.label !== 'attack') continue;
    for (const id of (r.expected_ids || [])) {
      if (!attackById[id]) attackById[id] = { pass: 0, total: 0 };
      attackById[id].total++;
      if (r.detected_ids.includes(id)) attackById[id].pass++;
    }
  }

  // Benign flag rate by source (files only)
  const benignBySrc = {};
  for (const r of fileResults) {
    if (r.label !== 'benign') continue;
    if (!benignBySrc[r.source]) benignBySrc[r.source] = { fired: 0, total: 0 };
    benignBySrc[r.source].total++;
    if (!r.pass) benignBySrc[r.source].fired++;
  }

  // Quoted discussion results
  const qdResults = fileResults.filter(r => r.label === 'quoted_discussion');

  // Latency p50/p95 per source (files)
  const latBySrc = {};
  for (const r of fileResults) {
    if (!latBySrc[r.source]) latBySrc[r.source] = [];
    latBySrc[r.source].push(r.elapsed_ms);
  }
  const latPercs = {};
  for (const src of Object.keys(latBySrc)) {
    latPercs[src] = percentiles(latBySrc[src]);
  }

  // Overall pass/fail
  const allPass = [
    ...fileResults.map(r => r.pass),
    ...queryResults.map(r => r.pass),
    ...pasteResults.map(r => r.pass),
    ...sessionResults.map(r => r.pass),
  ];
  const totalPass  = allPass.filter(Boolean).length;
  const totalTotal = allPass.length;

  return {
    attack_recall_by_source: attackBySrc,
    attack_recall_by_id:     attackById,
    benign_flag_rate:        benignBySrc,
    quoted_discussion:       qdResults.map(r => ({ id: r.id, pass: r.pass, cli_neutralize: r.cli_neutralize })),
    sessions:                sessionResults.map(r => ({ id: r.id, pass: r.pass, fail_reason: r.fail_reason, first_flag_turn: r.first_flag_turn, expect_flag_turn: r.expect_flag_turn })),
    latency_ms_by_source:    latPercs,
    total_pass:              totalPass,
    total_rows:              totalTotal,
  };
}

function printSummary(s) {
  console.log('\n=== SUMMARY ===');

  console.log('\nAttack recall by source (files):');
  for (const src of Object.keys(s.attack_recall_by_source).sort()) {
    const { pass, total } = s.attack_recall_by_source[src];
    const pct = total ? Math.round(100 * pass / total) : 0;
    console.log(`  ${src}: ${pass}/${total} = ${pct}%`);
  }

  console.log('\nAttack recall by attack ID (all sections):');
  for (const id of Object.keys(s.attack_recall_by_id).sort()) {
    const { pass, total } = s.attack_recall_by_id[id];
    const pct = total ? Math.round(100 * pass / total) : 0;
    console.log(`  ${id}: ${pass}/${total} = ${pct}%`);
  }

  console.log('\nBenign flag rate by source (files):');
  for (const src of Object.keys(s.benign_flag_rate).sort()) {
    const { fired, total } = s.benign_flag_rate[src];
    const pct = total ? Math.round(100 * fired / total) : 0;
    const status = pct === 0 ? '(good)' : '(false positives!)';
    console.log(`  ${src}: ${fired}/${total} = ${pct}% ${status}`);
  }

  console.log('\nQuoted discussion:');
  for (const r of s.quoted_discussion) {
    const pass = r.pass ? 'PASS' : 'FAIL';
    console.log(`  ${r.id}: ${pass}  cli_neutralize=${r.cli_neutralize}`);
  }

  console.log('\nSessions:');
  for (const r of s.sessions) {
    const pass = r.pass ? 'PASS' : 'FAIL';
    const flag = r.first_flag_turn === null ? 'none' : String(r.first_flag_turn);
    console.log(`  ${r.id}: ${pass}  first_flag=${flag} expected=${r.expect_flag_turn}${r.fail_reason ? '  reason: ' + r.fail_reason : ''}`);
  }

  console.log('\nLatency p50/p95 by source (ms, files):');
  for (const src of Object.keys(s.latency_ms_by_source).sort()) {
    const { p50, p95 } = s.latency_ms_by_source[src];
    console.log(`  ${src}: p50=${p50}ms p95=${p95}ms`);
  }

  console.log(`\nTotal: ${s.total_pass}/${s.total_rows} PASS`);
}

// ---------------------------------------------------------------------------
// Failing row list
// ---------------------------------------------------------------------------

function printFailingRows(fileResults, queryResults, pasteResults, sessionResults) {
  const allFail = [
    ...fileResults.filter(r => !r.pass).map(r => ({ section: 'files', id: r.id, reason: r.fail_reason })),
    ...queryResults.filter(r => !r.pass).map(r => ({ section: 'queries', id: r.id, reason: r.fail_reason })),
    ...pasteResults.filter(r => !r.pass).map(r => ({ section: 'paste', id: r.id, reason: r.fail_reason })),
    ...sessionResults.filter(r => !r.pass).map(r => ({ section: 'sessions', id: r.id, reason: r.fail_reason })),
  ];

  if (allFail.length === 0) {
    console.log('\nAll rows passed.');
    return;
  }

  console.log('\n--- Failing rows ---');
  for (const f of allFail) {
    console.log(`  [${f.section}] ${f.id}: ${f.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function buildMarkdown(fileResults, queryResults, pasteResults, sessionResults, summary) {
  const lines = [];
  lines.push('# PIF kit baseline run: ' + label);
  lines.push('');
  lines.push('Generated by run-kit.js. This is the BEFORE baseline (detector still being fixed).');
  lines.push('');

  lines.push('## Files (expected.json)');
  lines.push('');
  lines.push('| ID | Label | Source | Pass | Risk | Tier | CLI tier | Wall ms | Notes |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of fileResults) {
    lines.push(`| ${r.id} | ${r.label} | ${r.source} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.risk.toFixed(2)} | ${r.tier} | ${r.cli_tier} | ${r.elapsed_ms} | ${r.fail_reason || '-'} |`);
  }

  lines.push('');
  lines.push('## Queries (queries.json)');
  lines.push('');
  lines.push('| ID | Label | Pass | Risk | Tier | Wall ms | Notes |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of queryResults) {
    lines.push(`| ${r.id} | ${r.label} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.risk.toFixed(2)} | ${r.tier} | ${r.elapsed_ms} | ${r.fail_reason || '-'} |`);
  }

  lines.push('');
  lines.push('## Paste payloads');
  lines.push('');
  lines.push('| File | Label | Pass | Risk | Tier | Wall ms | Notes |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of pasteResults) {
    lines.push(`| ${r.id} | ${r.label} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.risk.toFixed(2)} | ${r.tier} | ${r.elapsed_ms} | ${r.fail_reason || '-'} |`);
  }

  lines.push('');
  lines.push('## Sessions');
  lines.push('');
  lines.push('| ID | Label | Pass | First flag turn | Expected turn | Wall ms | Notes |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of sessionResults) {
    lines.push(`| ${r.id} | ${r.label} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.first_flag_turn === null ? 'none' : r.first_flag_turn} | ${r.expect_flag_turn === null ? 'none' : r.expect_flag_turn} | ${r.elapsed_ms} | ${r.fail_reason || '-'} |`);
  }

  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('### Attack recall by source (files)');
  lines.push('');
  lines.push('| Source | Pass | Total | % |');
  lines.push('|---|---|---|---|');
  for (const src of Object.keys(summary.attack_recall_by_source).sort()) {
    const { pass, total } = summary.attack_recall_by_source[src];
    const pct = total ? Math.round(100 * pass / total) : 0;
    lines.push(`| ${src} | ${pass} | ${total} | ${pct}% |`);
  }

  lines.push('');
  lines.push('### Attack recall by ID (all sections)');
  lines.push('');
  lines.push('| Attack ID | Pass | Total | % |');
  lines.push('|---|---|---|---|');
  for (const id of Object.keys(summary.attack_recall_by_id).sort()) {
    const { pass, total } = summary.attack_recall_by_id[id];
    const pct = total ? Math.round(100 * pass / total) : 0;
    lines.push(`| ${id} | ${pass} | ${total} | ${pct}% |`);
  }

  lines.push('');
  lines.push('### Benign flag rate (files)');
  lines.push('');
  lines.push('| Source | Fired | Total | Rate |');
  lines.push('|---|---|---|---|');
  for (const src of Object.keys(summary.benign_flag_rate).sort()) {
    const { fired, total } = summary.benign_flag_rate[src];
    const pct = total ? Math.round(100 * fired / total) : 0;
    lines.push(`| ${src} | ${fired} | ${total} | ${pct}% |`);
  }

  lines.push('');
  lines.push(`**Total: ${summary.total_pass}/${summary.total_rows} PASS**`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// String padding helper
// ---------------------------------------------------------------------------
function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width - 1) + ' ' : s + ' '.repeat(width - s.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log('APEX PIF kit runner  label=' + label);
  console.log('ROOT: ' + ROOT);
  console.log('KIT:  ' + KIT);

  // Ensure results dir exists
  fs.mkdirSync(RESULTS, { recursive: true });

  const fileResults    = runFiles();
  const queryResults   = runQueries();
  const pasteResults   = runPaste();
  const sessionResults = runSessions();

  const summary = buildSummary(fileResults, queryResults, pasteResults, sessionResults);
  printSummary(summary);
  printFailingRows(fileResults, queryResults, pasteResults, sessionResults);

  // Write JSON output
  if (jsonOut) {
    const outPath = path.join(RESULTS, label + '.json');
    const data = {
      label,
      generated: new Date().toISOString(),
      files:    fileResults,
      queries:  queryResults,
      paste:    pasteResults,
      sessions: sessionResults,
      summary,
    };
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log('\nJSON results: ' + outPath);
  }

  // Write Markdown output
  if (mdOut) {
    const outPath = path.join(RESULTS, label + '.md');
    const md = buildMarkdown(fileResults, queryResults, pasteResults, sessionResults, summary);
    fs.writeFileSync(outPath, md);
    console.log('MD results:   ' + outPath);
  }

  const allPass = summary.total_pass === summary.total_rows;
  process.exit(allPass ? 0 : 1);
}

main();
