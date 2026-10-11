#!/usr/bin/env node
'use strict';
/**
 * apex-doctor.js - APEX environment diagnostics.
 *
 * Prints config dir, version, state, skill path, hook wiring, commands,
 * status line, policy flags, and external tools. Ends with a verdict.
 * Exit 0 always.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config dir
// ---------------------------------------------------------------------------
const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------
let version = 'unknown';
try {
  const pluginJson = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
  const pj = JSON.parse(fs.readFileSync(pluginJson, 'utf8'));
  version = pj.version || 'unknown';
} catch { /* no plugin.json reachable */ }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let stateEnabled = true;
let stateBy = null;
let stateAt = null;
try {
  const stateM = require(path.join(__dirname, 'apex-state.js'));
  const s = stateM.readState();
  stateEnabled = s.enabled;
  stateBy = s.by;
  stateAt = s.updatedAt;
} catch { /* defaults */ }

// ---------------------------------------------------------------------------
// Skill path
// ---------------------------------------------------------------------------
const skillPath = path.join(cfgDir, 'skills', 'apex');
const skillPresent = fs.existsSync(skillPath);

// ---------------------------------------------------------------------------
// Hook wiring in settings.json
// ---------------------------------------------------------------------------
const settingsFile = path.join(cfgDir, 'settings.json');
let gateWired = false;
let scanWired = false;
try {
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks || {};

  function checkHooks(groups, pattern) {
    for (const g of (groups || [])) {
      for (const h of (g.hooks || [])) {
        if (h.command && h.command.includes(pattern)) return true;
      }
    }
    return false;
  }

  gateWired = checkHooks(hooks.UserPromptSubmit, 'apex-gate.js');
  scanWired =
    checkHooks(hooks.PostToolUse, 'apex-scan.js') ||
    checkHooks(hooks.PostToolUseFailure, 'apex-scan.js');
} catch { /* settings absent or invalid */ }

// ---------------------------------------------------------------------------
// Commands present
// ---------------------------------------------------------------------------
const cmdDir = path.join(cfgDir, 'commands');
const commandsToCheck = ['apex', 'apex-skip', 'apex-scan', 'apex-start', 'apex-stop', 'apex-doctor'];
const commandStatus = {};
for (const c of commandsToCheck) {
  commandStatus[c] = fs.existsSync(path.join(cmdDir, c + '.md'));
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------
const statusLineFile = path.join(cfgDir, 'settings.json');
let statusLine = null;
let isApexWrapper = false;
let chainCmd = null;
try {
  const settings = JSON.parse(fs.readFileSync(statusLineFile, 'utf8'));
  statusLine = settings.statusLine || null;
  if (statusLine && typeof statusLine === 'object' && statusLine.command) {
    isApexWrapper = statusLine.command.includes('apex-statusline.sh');
  }
} catch { /* settings absent */ }

const chainFile = path.join(cfgDir, 'apex', 'statusline-chain');
try {
  chainCmd = fs.readFileSync(chainFile, 'utf8').trim();
} catch { /* no chain */ }

// ---------------------------------------------------------------------------
// Policy - read from multiple locations
// ---------------------------------------------------------------------------
const policyFiles = [
  path.join(cfgDir, 'remote-settings.json'),
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  '/etc/claude-code/managed-settings.json',
];

const policy = {
  allowManagedHooksOnly: false,
  disableAllHooks: false,
  strictKnownMarketplaces: false,
  sources: [],
};

for (const pf of policyFiles) {
  try {
    const raw = JSON.parse(fs.readFileSync(pf, 'utf8'));
    policy.sources.push(pf);
    if (raw.allowManagedHooksOnly === true) policy.allowManagedHooksOnly = true;
    if (raw.disableAllHooks === true) policy.disableAllHooks = true;
    if (raw.strictKnownMarketplaces === true) policy.strictKnownMarketplaces = true;
  } catch { /* absent or unreadable */ }
}

// ---------------------------------------------------------------------------
// External tools
// ---------------------------------------------------------------------------
function toolPresent(name) {
  try { execFileSync('which', [name], { stdio: 'pipe' }); return true; } catch { return false; }
}
const tools = {
  pdftotext: toolPresent('pdftotext'),
  unzip:     toolPresent('unzip'),
  tesseract: toolPresent('tesseract'),
};

// ---------------------------------------------------------------------------
// Print report
// ---------------------------------------------------------------------------
function row(label, value) {
  console.log('  ' + label.padEnd(30) + value);
}

console.log('\nAPEX environment doctor\n');

row('config dir',        cfgDir);
row('APEX version',      version);
row('state',             stateEnabled ? 'ON' : 'OFF' + (stateBy ? ' (by: ' + stateBy + ')' : ''));
if (stateAt) row('state last changed', stateAt);

console.log('');
row('skill path',        skillPath + (skillPresent ? '  [present]' : '  [MISSING]'));

console.log('');
row('apex-gate.js',      gateWired ? 'wired in settings.json' : 'NOT wired');
row('apex-scan.js',      scanWired ? 'wired in settings.json' : 'NOT wired');

console.log('');
console.log('  Commands:');
for (const c of commandsToCheck) {
  row('    /' + c, commandStatus[c] ? 'present' : 'MISSING');
}

console.log('');
if (isApexWrapper) {
  row('statusLine',       'APEX wrapper');
  row('chained command',  chainCmd || '(none)');
} else if (statusLine) {
  row('statusLine',       JSON.stringify(statusLine) + '  [not the APEX wrapper]');
} else {
  row('statusLine',       '(not set)');
}

console.log('');
console.log('  Organization policy:');
if (policy.sources.length === 0) {
  row('    policy files', '(none found)');
} else {
  for (const s of policy.sources) row('    read from', s);
}
row('    allowManagedHooksOnly',    String(policy.allowManagedHooksOnly));
row('    disableAllHooks',          String(policy.disableAllHooks));
row('    strictKnownMarketplaces',  String(policy.strictKnownMarketplaces));

console.log('');
console.log('  External tools:');
row('    pdftotext', tools.pdftotext ? 'present' : 'missing (PDF extraction limited)');
row('    unzip',     tools.unzip     ? 'present' : 'missing (DOCX extraction limited)');
row('    tesseract', tools.tesseract ? 'present' : 'missing (OCR disabled)');

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log('');
const hooksBlocked = policy.allowManagedHooksOnly || policy.disableAllHooks;
if (hooksBlocked) {
  console.log('Hooks: BLOCKED by organization policy (allowManagedHooksOnly). ' +
    'Use the commands-only track in tests/pif/kit/QUERIES.md.');
} else {
  console.log('Hooks: allowed. Use the full track.');
}
console.log('');
