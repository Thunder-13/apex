#!/usr/bin/env node
'use strict';
/**
 * apex-state.js - APEX start/stop state management.
 *
 * Reads and writes <configDir>/apex/state.json atomically.
 * configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
 *
 * Contract:
 *   readState()   -> { enabled: bool, updatedAt: string|null, by: string|null }
 *   isEnabled()   -> bool  (missing / unreadable / invalid JSON means true)
 *   setEnabled(bool, by)  writes state.json and STATUS.md atomically (tmp + rename)
 *
 * CLI: node apex-state.js start | stop | status
 *   start   -> setEnabled(true,  'cli')
 *   stop    -> setEnabled(false, 'cli')
 *   status  -> prints current state; ensures STATUS.md is written; exit 0
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function stateDir() {
  return path.join(configDir(), 'apex');
}

function stateFile() {
  return path.join(stateDir(), 'state.json');
}

function statusFile() {
  return path.join(stateDir(), 'STATUS.md');
}

const STATUS_ON =
  'APEX (Ask. Perfect. EXecute.) is ON. ' +
  'Run the APEX loop from CLAUDE.md and start each reply with the ' +
  '⚡ APEX · Ask. Perfect. EXecute. block.';

const STATUS_OFF =
  'APEX (Ask. Perfect. EXecute.) is STOPPED (/apex-stop). ' +
  'Skip the APEX loop, print no ⚡ and no APEX block, and treat the APEX Firewall as paused. ' +
  '/apex-start turns APEX back on.';

function writeStatusMd(enabled) {
  const dir  = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = statusFile();
  const tmp  = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, (enabled ? STATUS_ON : STATUS_OFF) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.enabled !== 'boolean') throw new Error('invalid');
    return { enabled: obj.enabled, updatedAt: obj.updatedAt || null, by: obj.by || null };
  } catch {
    return { enabled: true, updatedAt: null, by: null };
  }
}

function isEnabled() {
  return readState().enabled;
}

function setEnabled(enabled, by) {
  const dir   = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file  = stateFile();
  const tmp   = file + '.tmp.' + process.pid;
  const state = {
    enabled:   Boolean(enabled),
    updatedAt: new Date().toISOString(),
    by:        by || 'unknown',
  };
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  writeStatusMd(Boolean(enabled));
}

module.exports = { readState, isEnabled, setEnabled, stateFile, stateDir, configDir, writeStatusMd };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'start') {
    setEnabled(true, 'cli');
    const s = readState();
    console.log('APEX started. state:', JSON.stringify(s));
  } else if (cmd === 'stop') {
    setEnabled(false, 'cli');
    const s = readState();
    console.log('APEX stopped. state:', JSON.stringify(s));
  } else if (cmd === 'status') {
    const s = readState();
    // Ensure STATUS.md is present even when no set has run yet
    try { writeStatusMd(s.enabled); } catch { /* best effort */ }
    console.log('APEX state:', JSON.stringify(s));
  } else {
    console.error('usage: node apex-state.js start | stop | status');
    process.exit(1);
  }
  process.exit(0);
}
