'use strict';
/**
 * install-roundtrip.test.js - fake-HOME installer test.
 *
 * Seeds a statusLine in settings.json, runs install.sh, verifies:
 *   - statusLine is set to the APEX wrapper
 *   - chain file holds the old command
 *   - STATUS.md exists and says ON
 *   - apex-start.md, apex-stop.md, apex-doctor.md are installed
 * Then runs restore.sh and verifies statusLine is back to the original value.
 *
 * Requires: bash, python3 (for install.sh's settings.json update step).
 * Skips gracefully when the environment cannot run install.sh.
 */

const { describe, it, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO    = path.join(__dirname, '..', '..');
const SRC     = path.join(REPO, 'apex');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-install-test-'));
}

function runInstall(fakeHome, extraEnv) {
  return spawnSync('bash', [path.join(REPO, 'install.sh'), '--skip-tests'], {
    encoding: 'utf8',
    timeout:  30000,
    env: Object.assign({
      HOME:             fakeHome,
      CLAUDE_CONFIG_DIR: fakeHome,
      PATH:             process.env.PATH,
      SHELL:            '/bin/bash',
    }, extraEnv || {}),
  });
}

describe('installer statusLine round-trip', () => {
  let fakeHome;
  let installResult;
  const OLD_CMD = '/x/vibeyard/statusline.sh';
  const OLD_STATUS_LINE = { type: 'command', command: OLD_CMD };

  before(() => {
    fakeHome = mkTmp();

    // Seed settings.json with a statusLine the installer should back up
    const settingsPath = path.join(fakeHome, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: OLD_STATUS_LINE }, null, 2) + '\n');

    // Run the installer
    installResult = runInstall(fakeHome);
  });

  after(() => {
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('install.sh exits 0', () => {
    if (installResult.stderr && installResult.stderr.includes('command not found')) {
      // skip gracefully if bash/python3 missing in test env
      return;
    }
    assert.strictEqual(installResult.status, 0,
      'install.sh should exit 0. stderr: ' + installResult.stderr?.slice(0, 400));
  });

  it('statusLine is set to the APEX wrapper after install', () => {
    const settingsPath = path.join(fakeHome, 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // installer skipped or failed
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const sl = settings.statusLine;
    assert.ok(sl, 'statusLine should be set');
    assert.ok(
      typeof sl === 'object' && sl.command && sl.command.includes('apex-statusline.sh'),
      'statusLine should be the APEX wrapper. Got: ' + JSON.stringify(sl),
    );
  });

  it('chain file holds the old statusLine command', () => {
    const chainPath = path.join(fakeHome, 'apex', 'statusline-chain');
    if (!fs.existsSync(chainPath)) {
      // installer may not have set it if it failed; only fail if install succeeded
      if (installResult.status === 0) {
        assert.fail('chain file should exist after install');
      }
      return;
    }
    const chain = fs.readFileSync(chainPath, 'utf8').trim();
    assert.strictEqual(chain, OLD_CMD, 'chain file should hold the old command');
  });

  it('STATUS.md exists and says ON', () => {
    const statusPath = path.join(fakeHome, 'apex', 'STATUS.md');
    if (!fs.existsSync(statusPath)) {
      if (installResult.status === 0) {
        assert.fail('STATUS.md should exist after install');
      }
      return;
    }
    const txt = fs.readFileSync(statusPath, 'utf8');
    assert.ok(txt.includes('is ON'), 'STATUS.md should say ON after install');
  });

  it('apex-start.md is installed', () => {
    const f = path.join(fakeHome, 'commands', 'apex-start.md');
    if (installResult.status !== 0) return;
    assert.ok(fs.existsSync(f), 'apex-start.md should be installed');
  });

  it('apex-stop.md is installed', () => {
    const f = path.join(fakeHome, 'commands', 'apex-stop.md');
    if (installResult.status !== 0) return;
    assert.ok(fs.existsSync(f), 'apex-stop.md should be installed');
  });

  it('apex-doctor.md is installed', () => {
    const f = path.join(fakeHome, 'commands', 'apex-doctor.md');
    if (installResult.status !== 0) return;
    assert.ok(fs.existsSync(f), 'apex-doctor.md should be installed');
  });

  it('CLAUDE.md is not present so patcher is skipped without error', () => {
    // This existing test uses fakeHome where no CLAUDE.md exists.
    // The installer should still exit 0.
    assert.strictEqual(installResult.status, 0,
      'install.sh should exit 0 even when CLAUDE.md is absent');
  });

  it('restore.sh brings statusLine back deep-equal', () => {
    if (installResult.status !== 0) return;

    // Find the backup dir
    const backupsDir = path.join(fakeHome, 'backups');
    if (!fs.existsSync(backupsDir)) {
      assert.fail('backups dir should exist after install');
    }
    const backupDirs = fs.readdirSync(backupsDir).filter(d => d.startsWith('apex-install-'));
    assert.ok(backupDirs.length > 0, 'at least one backup dir should exist');

    const backupDir = path.join(backupsDir, backupDirs[0]);
    const restoreSh = path.join(backupDir, 'restore.sh');
    assert.ok(fs.existsSync(restoreSh), 'restore.sh should exist');

    // Run restore.sh
    const restoreResult = spawnSync('bash', [restoreSh], {
      encoding: 'utf8',
      timeout:  15000,
      env: {
        HOME: fakeHome,
        PATH: process.env.PATH,
        SHELL: '/bin/bash',
      },
    });
    assert.strictEqual(restoreResult.status, 0,
      'restore.sh should exit 0. stderr: ' + restoreResult.stderr?.slice(0, 300));

    // settings.json should be restored to the backed-up version
    const settingsPath = path.join(fakeHome, 'settings.json');
    const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(
      restored.statusLine,
      OLD_STATUS_LINE,
      'statusLine should be restored to the original value',
    );
  });
});

// ---------------------------------------------------------------------------
// (a) CLAUDE.md full round-trip: install, idempotent re-install, restore
// ---------------------------------------------------------------------------

// Opt-in: point APEX_TEST_CLAUDE_MD at a pre-APEX CLAUDE.md to run suites (a), (b) and (d).
const REAL_CLAUDE_MD = process.env.APEX_TEST_CLAUDE_MD || '';

describe('CLAUDE.md round-trip (a)', () => {
  let fakeHome, dotClaude, installResult, origContent;

  before(() => {
    if (!fs.existsSync(REAL_CLAUDE_MD)) return;
    fakeHome  = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-claudemd-a-'));
    dotClaude = path.join(fakeHome, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    origContent = fs.readFileSync(REAL_CLAUDE_MD, 'utf8');
    fs.writeFileSync(path.join(dotClaude, 'CLAUDE.md'), origContent);

    installResult = spawnSync('bash', [path.join(REPO, 'install.sh'), '--skip-tests'], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, { PATH: process.env.PATH, SHELL: '/bin/bash' }, {
        HOME: fakeHome, CLAUDE_CONFIG_DIR: dotClaude,
      }),
    });
  });

  after(() => {
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('install.sh exits 0', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD)) return;
    assert.strictEqual(installResult.status, 0,
      'install.sh should exit 0. stderr: ' + installResult.stderr?.slice(0, 400));
  });

  it('all 7 NEW blocks are present', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || installResult.status !== 0) return;
    const txt = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    const anchors = [
      '## Mandate zero: APEX (Ask. Perfect. EXecute.)',
      '⚡ APEX · Ask. Perfect. EXecute.\nTechnique:',
      '**Order of operations:** APEX -> plan on Opus',
      'Full ruleset: skill `/apex`',
      'Enforcement: `~/.claude/hooks/apex-gate.js`',
      '0. APEX (Ask. Perfect. EXecute.) is on by default',
      '- APEX skill: `~/.claude/skills/apex/SKILL.md`',
    ];
    for (const anchor of anchors) {
      assert.ok(txt.includes(anchor), `missing anchor: ${anchor.slice(0, 60)}`);
    }
  });

  it('@ import line equals @~/.claude/apex/STATUS.md', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || installResult.status !== 0) return;
    const txt = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.ok(txt.includes('@~/.claude/apex/STATUS.md'),
      '@ import line should be @~/.claude/apex/STATUS.md');
  });

  it('no standalone APE, thunder-skip, auto-prompt-engine, or ape-gate remain', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || installResult.status !== 0) return;
    const txt = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.ok(!/\bAPE\b/.test(txt),           'standalone APE should not remain');
    assert.ok(!txt.includes('thunder-skip'),   'thunder-skip should not remain');
    assert.ok(!txt.includes('auto-prompt-engine'), 'auto-prompt-engine should not remain');
    assert.ok(!txt.includes('ape-gate'),       'ape-gate should not remain');
  });

  it('re-running installer is idempotent (exits 0, CLAUDE.md unchanged)', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || installResult.status !== 0) return;
    const before = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    const r2 = spawnSync('bash', [path.join(REPO, 'install.sh'), '--skip-tests'], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, { PATH: process.env.PATH, SHELL: '/bin/bash' }, {
        HOME: fakeHome, CLAUDE_CONFIG_DIR: dotClaude,
      }),
    });
    assert.strictEqual(r2.status, 0, 're-install should exit 0');
    const after = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.strictEqual(after, before, 'CLAUDE.md should be unchanged on idempotent re-run');
  });

  it('restore.sh makes CLAUDE.md byte-identical to the original', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || installResult.status !== 0) return;
    // Extract the backup dir from the first install's output (avoids timestamp collision
    // when the idempotent re-run creates a second backup in the same second).
    const combined = (installResult.stdout || '') + (installResult.stderr || '');
    const m = combined.match(/To roll back everything: bash (.+\/restore\.sh)/);
    assert.ok(m, 'install output should contain restore path');
    const restoreSh = m[1];
    assert.ok(fs.existsSync(restoreSh), 'restore.sh should exist at ' + restoreSh);
    const r = spawnSync('bash', [restoreSh], {
      encoding: 'utf8', timeout: 15000,
      env: { HOME: fakeHome, CLAUDE_CONFIG_DIR: dotClaude, PATH: process.env.PATH, SHELL: '/bin/bash' },
    });
    assert.strictEqual(r.status, 0, 'restore.sh should exit 0. stderr: ' + r.stderr?.slice(0, 300));
    const restored = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.strictEqual(restored, origContent, 'CLAUDE.md should be byte-identical to original after restore');
  });
});

// ---------------------------------------------------------------------------
// (b) CLAUDE.md with R1 OLD altered: install exits 0, CLAUDE.md unchanged, warning emitted
// ---------------------------------------------------------------------------

describe('CLAUDE.md unmatched rule (b)', () => {
  let fakeHome, dotClaude, installResult, plantedContent;

  before(() => {
    fakeHome  = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-claudemd-b-'));
    dotClaude = path.join(fakeHome, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    // Altered CLAUDE.md: R1 OLD text is modified so it won't match
    plantedContent = '# Global rules\n\n## Mandate zero: Something Else (SE)\nThis is altered.\n';
    fs.writeFileSync(path.join(dotClaude, 'CLAUDE.md'), plantedContent);

    installResult = spawnSync('bash', [path.join(REPO, 'install.sh'), '--skip-tests'], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, { PATH: process.env.PATH, SHELL: '/bin/bash' }, {
        HOME: fakeHome, CLAUDE_CONFIG_DIR: dotClaude,
      }),
    });
  });

  after(() => {
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('install.sh exits 0 even when rules are unmatched', () => {
    assert.strictEqual(installResult.status, 0,
      'install.sh should exit 0. stderr: ' + installResult.stderr?.slice(0, 400));
  });

  it('CLAUDE.md is byte-identical to what was planted', () => {
    const txt = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.strictEqual(txt, plantedContent, 'CLAUDE.md should be untouched when rules do not match');
  });

  it('output contains the warning message', () => {
    const combined = (installResult.stdout || '') + (installResult.stderr || '');
    assert.ok(combined.includes('CLAUDE.md not changed'),
      'output should warn that CLAUDE.md was not changed');
  });
});

// ---------------------------------------------------------------------------
// (c) --no-claude-md leaves CLAUDE.md untouched
// ---------------------------------------------------------------------------

describe('CLAUDE.md --no-claude-md (c)', () => {
  let fakeHome, dotClaude, installResult, plantedContent;

  before(() => {
    if (!fs.existsSync(REAL_CLAUDE_MD)) return;
    fakeHome  = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-claudemd-c-'));
    dotClaude = path.join(fakeHome, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    plantedContent = fs.readFileSync(REAL_CLAUDE_MD, 'utf8');
    fs.writeFileSync(path.join(dotClaude, 'CLAUDE.md'), plantedContent);

    installResult = spawnSync('bash',
      [path.join(REPO, 'install.sh'), '--skip-tests', '--no-claude-md'], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, { PATH: process.env.PATH, SHELL: '/bin/bash' }, {
        HOME: fakeHome, CLAUDE_CONFIG_DIR: dotClaude,
      }),
    });
  });

  after(() => {
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('install.sh exits 0', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD)) return;
    assert.strictEqual(installResult.status, 0,
      'install.sh should exit 0. stderr: ' + installResult.stderr?.slice(0, 400));
  });

  it('CLAUDE.md is untouched', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || !installResult || installResult.status !== 0) return;
    const txt = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.strictEqual(txt, plantedContent, 'CLAUDE.md should be untouched with --no-claude-md');
  });
});

// ---------------------------------------------------------------------------
// (d) --dry-run prints diff, changes nothing
// ---------------------------------------------------------------------------

describe('CLAUDE.md --dry-run (d)', () => {
  let fakeHome, dotClaude, installResult, plantedContent;

  before(() => {
    if (!fs.existsSync(REAL_CLAUDE_MD)) return;
    fakeHome  = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-claudemd-d-'));
    dotClaude = path.join(fakeHome, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    plantedContent = fs.readFileSync(REAL_CLAUDE_MD, 'utf8');
    fs.writeFileSync(path.join(dotClaude, 'CLAUDE.md'), plantedContent);

    installResult = spawnSync('bash',
      [path.join(REPO, 'install.sh'), '--skip-tests', '--dry-run'], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, { PATH: process.env.PATH, SHELL: '/bin/bash' }, {
        HOME: fakeHome, CLAUDE_CONFIG_DIR: dotClaude,
      }),
    });
  });

  after(() => {
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('install.sh exits 0 under --dry-run', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD)) return;
    assert.strictEqual(installResult.status, 0,
      'install.sh --dry-run should exit 0. stderr: ' + installResult.stderr?.slice(0, 400));
  });

  it('output contains a diff', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || !installResult) return;
    const combined = (installResult.stdout || '') + (installResult.stderr || '');
    assert.ok(combined.includes('--- CLAUDE.md (before)'),
      'dry-run output should contain a unified diff header');
  });

  it('CLAUDE.md is unchanged after --dry-run', () => {
    if (!fs.existsSync(REAL_CLAUDE_MD) || !installResult || installResult.status !== 0) return;
    const txt = fs.readFileSync(path.join(dotClaude, 'CLAUDE.md'), 'utf8');
    assert.strictEqual(txt, plantedContent, 'CLAUDE.md should not be modified under --dry-run');
  });
});
