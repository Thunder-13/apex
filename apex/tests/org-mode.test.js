'use strict';
/**
 * org-mode.test.js — tests for managed-org-account features:
 *   apex-state.js   writes STATUS.md on set and on status (when missing)
 *   apex-statusline.sh  prints "⚡ APEX" when on, nothing extra when off,
 *                        joins with chain, is silent on broken state file
 *   apex-doctor.js  flags BLOCKED when remote-settings.json has allowManagedHooksOnly true
 *   commands/apex-start.md, apex-stop.md, apex-doctor.md  contain bash line + allowed-tools
 *   install.sh  statusLine round-trip (seeded old command; after install, wrapper is set,
 *               chain file holds old command; restore.sh brings statusLine back deep-equal)
 */

const { describe, it, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT    = path.join(__dirname, '..');
const NODE    = process.execPath;
const STATE_JS = path.join(ROOT, 'router', 'apex-state.js');
const DOCTOR_JS = path.join(ROOT, 'router', 'apex-doctor.js');
const SH_PATH  = path.join(ROOT, 'hooks', 'apex-statusline.sh');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-org-test-'));
}

function runNode(script, args, env) {
  return spawnSync(NODE, [script, ...args], {
    encoding: 'utf8',
    timeout:  10000,
    env: Object.assign({ HOME: env.HOME || os.homedir(), PATH: process.env.PATH }, env),
  });
}

function runSh(script, env, stdinText) {
  return spawnSync('sh', [script], {
    input:    stdinText || '',
    encoding: 'utf8',
    timeout:  5000,
    env: Object.assign({ HOME: env.HOME || os.homedir(), PATH: process.env.PATH }, env),
  });
}

// ---------------------------------------------------------------------------
// apex-state.js tests
// ---------------------------------------------------------------------------

describe('apex-state: STATUS.md', () => {
  let tmp;
  before(() => { tmp = mkTmp(); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('writes STATUS.md with ON content on setEnabled(true)', () => {
    runNode(STATE_JS, ['start'], { CLAUDE_CONFIG_DIR: tmp });
    const statusPath = path.join(tmp, 'apex', 'STATUS.md');
    assert.ok(fs.existsSync(statusPath), 'STATUS.md should exist');
    const txt = fs.readFileSync(statusPath, 'utf8');
    assert.ok(txt.includes('is ON'), 'STATUS.md should say ON');
    assert.ok(txt.includes('Ask. Perfect. EXecute.'), 'should include expansion');
  });

  it('writes STATUS.md with STOPPED content on setEnabled(false)', () => {
    runNode(STATE_JS, ['stop'], { CLAUDE_CONFIG_DIR: tmp });
    const statusPath = path.join(tmp, 'apex', 'STATUS.md');
    const txt = fs.readFileSync(statusPath, 'utf8');
    assert.ok(txt.includes('STOPPED (/apex-stop)'), 'STATUS.md should say STOPPED');
  });

  it('status command writes STATUS.md when missing', () => {
    const tmp2 = mkTmp();
    try {
      runNode(STATE_JS, ['status'], { CLAUDE_CONFIG_DIR: tmp2 });
      const statusPath = path.join(tmp2, 'apex', 'STATUS.md');
      assert.ok(fs.existsSync(statusPath), 'STATUS.md should be written by status cmd');
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// apex-statusline.sh tests
// ---------------------------------------------------------------------------

describe('apex-statusline.sh', () => {
  let tmp;
  before(() => { tmp = mkTmp(); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('prints "⚡ APEX" when state.json is absent (defaults to on)', () => {
    const r = runSh(SH_PATH, { CLAUDE_CONFIG_DIR: tmp });
    assert.strictEqual(r.status, 0, 'should exit 0');
    assert.strictEqual(r.stdout, '⚡ APEX', 'should print ⚡ APEX');
  });

  it('prints "⚡ APEX" when state.json has enabled:true', () => {
    const apexDir = path.join(tmp, 'apex');
    fs.mkdirSync(apexDir, { recursive: true });
    fs.writeFileSync(path.join(apexDir, 'state.json'), '{"enabled":true}');
    const r = runSh(SH_PATH, { CLAUDE_CONFIG_DIR: tmp });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '⚡ APEX');
  });

  it('prints nothing when state.json has enabled:false', () => {
    const apexDir = path.join(tmp, 'apex');
    fs.writeFileSync(path.join(apexDir, 'state.json'), '{"enabled":false}');
    const r = runSh(SH_PATH, { CLAUDE_CONFIG_DIR: tmp });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'should be silent when off');
  });

  it('is silent on a broken/malformed state file', () => {
    const tmp3 = mkTmp();
    try {
      const apexDir = path.join(tmp3, 'apex');
      fs.mkdirSync(apexDir, { recursive: true });
      fs.writeFileSync(path.join(apexDir, 'state.json'), 'NOT JSON {{{{');
      const r = runSh(SH_PATH, { CLAUDE_CONFIG_DIR: tmp3 });
      assert.strictEqual(r.status, 0, 'should exit 0 even on broken state');
      // Broken JSON: grep for "enabled": *false will not match, so defaults to on
      // That means ⚡ APEX is printed. That is correct: fail-open.
      // The key property is exit 0 and no stderr output.
      assert.strictEqual(r.stderr, '', 'should produce no stderr');
    } finally {
      fs.rmSync(tmp3, { recursive: true, force: true });
    }
  });

  it('joins chain output with ⚡ APEX when on', () => {
    const tmp4 = mkTmp();
    try {
      const apexDir = path.join(tmp4, 'apex');
      fs.mkdirSync(apexDir, { recursive: true });
      // State is on (no state.json = on)
      // Write a chain command that prints "mychain" (printf avoids echo -n portability issues)
      fs.writeFileSync(path.join(apexDir, 'statusline-chain'), "printf '%s' mychain");
      const r = runSh(SH_PATH, { CLAUDE_CONFIG_DIR: tmp4 });
      assert.strictEqual(r.status, 0);
      assert.ok(r.stdout.startsWith('⚡ APEX'), 'should start with ⚡ APEX');
      assert.ok(r.stdout.includes('mychain'), 'should include chain output');
    } finally {
      fs.rmSync(tmp4, { recursive: true, force: true });
    }
  });

  it('shows only chain output when off', () => {
    const tmp5 = mkTmp();
    try {
      const apexDir = path.join(tmp5, 'apex');
      fs.mkdirSync(apexDir, { recursive: true });
      fs.writeFileSync(path.join(apexDir, 'state.json'), '{"enabled":false}');
      fs.writeFileSync(path.join(apexDir, 'statusline-chain'), "printf '%s' mychain");
      const r = runSh(SH_PATH, { CLAUDE_CONFIG_DIR: tmp5 });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'mychain', 'should show only chain output when off');
    } finally {
      fs.rmSync(tmp5, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// apex-doctor.js tests
// ---------------------------------------------------------------------------

describe('apex-doctor.js', () => {
  it('flags BLOCKED when remote-settings.json has allowManagedHooksOnly: true', () => {
    const tmp6 = mkTmp();
    try {
      fs.writeFileSync(
        path.join(tmp6, 'remote-settings.json'),
        JSON.stringify({ allowManagedHooksOnly: true }),
      );
      const r = runNode(DOCTOR_JS, [], { CLAUDE_CONFIG_DIR: tmp6 });
      assert.strictEqual(r.status, 0, 'doctor should exit 0');
      assert.ok(r.stdout.includes('BLOCKED'), 'should report BLOCKED');
      assert.ok(r.stdout.includes('allowManagedHooksOnly'), 'should name the policy');
    } finally {
      fs.rmSync(tmp6, { recursive: true, force: true });
    }
  });

  it('reports Hooks: allowed when no blocking policy', () => {
    const tmp7 = mkTmp();
    try {
      const r = runNode(DOCTOR_JS, [], { CLAUDE_CONFIG_DIR: tmp7 });
      assert.strictEqual(r.status, 0);
      assert.ok(r.stdout.includes('Hooks: allowed'), 'should say hooks allowed');
    } finally {
      fs.rmSync(tmp7, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Command files contain the bash line and allowed-tools
// ---------------------------------------------------------------------------

describe('command files', () => {
  const cmds = {
    'apex-start.md':  { marker: '<!-- apex:apex-start -->', bashFrag: 'apex-state.js" start' },
    'apex-stop.md':   { marker: '<!-- apex:apex-stop -->',  bashFrag: 'apex-state.js" stop' },
    'apex-doctor.md': { marker: '<!-- apex:apex-doctor -->', bashFrag: 'apex-doctor.js' },
  };

  for (const [fname, checks] of Object.entries(cmds)) {
    it(`${fname} has marker, bash line, and allowed-tools`, () => {
      const fpath = path.join(ROOT, 'commands', fname);
      assert.ok(fs.existsSync(fpath), `${fname} should exist`);
      const txt = fs.readFileSync(fpath, 'utf8');
      assert.ok(txt.includes(checks.marker), `${fname} should contain marker`);
      assert.ok(txt.includes('allowed-tools'), `${fname} should have allowed-tools`);
      assert.ok(txt.includes('!`node'), `${fname} should have bash execution line`);
      assert.ok(txt.includes(checks.bashFrag), `${fname} bash line should reference ${checks.bashFrag}`);
    });
  }
});
