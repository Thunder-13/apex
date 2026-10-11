'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { classifyDestructive, isSafeRmTarget } = require(path.join(__dirname, '..', 'router', 'risk.js'));

describe('risk.js: classifyDestructive', () => {

  // ── HIGH: force push variants ───────────────────────────────────────────
  it('force push to main → HIGH', () => {
    const r = classifyDestructive('force push to main');
    assert.strictEqual(r.severity, 'high', 'force push must be HIGH');
    assert.ok(r.highTerms.some(t => /force[\s-]push/.test(t)));
  });

  it('git push --force-with-lease origin feat → HIGH', () => {
    const r = classifyDestructive('git push --force-with-lease origin feat');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.some(t => /force/.test(t)));
  });

  it('git push -f → HIGH', () => {
    const r = classifyDestructive('git push -f origin main');
    assert.strictEqual(r.severity, 'high');
  });

  it('force-push → HIGH', () => {
    const r = classifyDestructive('force-push the changes');
    assert.strictEqual(r.severity, 'high');
  });

  // ── HIGH: reset --hard ──────────────────────────────────────────────────
  it('reset --hard → HIGH', () => {
    const r = classifyDestructive('git reset --hard HEAD~3');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.includes('reset --hard'));
  });

  // ── HIGH: rm -rf with non-safe target ──────────────────────────────────
  it('rm -rf ~/projects/old → HIGH', () => {
    const r = classifyDestructive('rm -rf ~/projects/old');
    assert.strictEqual(r.severity, 'high');
  });

  it('rm -rf /home/user/data → HIGH', () => {
    const r = classifyDestructive('rm -rf /home/user/data');
    assert.strictEqual(r.severity, 'high');
  });

  it('rm -rf node_modules and reinstall → NOT HIGH (safe target)', () => {
    const r = classifyDestructive('rm -rf node_modules and reinstall');
    assert.notStrictEqual(r.severity, 'high', 'node_modules is safe: must not be HIGH');
  });

  it('rm -rf dist → NOT HIGH (safe target)', () => {
    const r = classifyDestructive('rm -rf dist && npm run build');
    assert.notStrictEqual(r.severity, 'high', 'dist is safe: must not be HIGH');
  });

  // ── HIGH: drop (table|database|schema) ─────────────────────────────────
  it('drop the users table in prod → HIGH', () => {
    const r = classifyDestructive('drop the users table in prod');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.some(t => /drop\s+table/.test(t)));
  });

  it('drop database production → HIGH', () => {
    const r = classifyDestructive('drop database production');
    assert.strictEqual(r.severity, 'high');
  });

  // ── HIGH: terraform destroy ─────────────────────────────────────────────
  it('terraform destroy → HIGH', () => {
    const r = classifyDestructive('run terraform destroy on the staging env');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.includes('terraform destroy'));
  });

  // ── HIGH: kubectl delete ────────────────────────────────────────────────
  it('kubectl delete namespace → HIGH', () => {
    const r = classifyDestructive('kubectl delete namespace production');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.includes('kubectl delete'));
  });

  // ── HIGH: delete/remove targeting high-value objects ───────────────────
  it('delete the database → HIGH', () => {
    const r = classifyDestructive('delete the database');
    assert.strictEqual(r.severity, 'high');
  });

  it('remove all backups → HIGH', () => {
    const r = classifyDestructive('remove all backups from the bucket');
    assert.strictEqual(r.severity, 'high');
  });

  it('wipe the cluster → HIGH', () => {
    const r = classifyDestructive('wipe the cluster and rebuild');
    assert.strictEqual(r.severity, 'high');
  });

  // ── HIGH: deploy to prod ────────────────────────────────────────────────
  it('deploy to production tonight → HIGH', () => {
    const r = classifyDestructive('deploy to production tonight');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.some(t => /deploy.+prod/.test(t)));
  });

  it('deploy the preview branch → NOT HIGH (no prod)', () => {
    const r = classifyDestructive('deploy the preview branch');
    assert.notStrictEqual(r.severity, 'high', 'no prod target: must not be HIGH');
  });

  // ── HIGH: send to mass audience ─────────────────────────────────────────
  it('send the newsletter to all subscribers → HIGH', () => {
    const r = classifyDestructive('send the newsletter to all subscribers');
    assert.strictEqual(r.severity, 'high');
    assert.ok(r.highTerms.some(t => /send.+audience/.test(t)));
  });

  it('send me a summary → NOT HIGH (no mass target)', () => {
    const r = classifyDestructive('send me a summary');
    assert.notStrictEqual(r.severity, 'high', '"send me" must not be HIGH');
  });

  // ── LOW: delete (benign target) ─────────────────────────────────────────
  it('delete the unused import in utils.py → LOW (not HIGH)', () => {
    const r = classifyDestructive('delete the unused import in utils.py');
    assert.notStrictEqual(r.severity, 'high');
    // It may be LOW (delete matches LOW_DESTRUCTIVE_RE) or null
    assert.ok(['low', null].includes(r.severity));
  });

  // ── LOW: prod mentioned alone ───────────────────────────────────────────
  it('prod mentioned without deploy → LOW at most', () => {
    const r = classifyDestructive('fix the bug in prod');
    assert.notStrictEqual(r.severity, 'high');
  });

  // ── NULL: no destructive terms ──────────────────────────────────────────
  it('returns null for benign prompt', () => {
    const r = classifyDestructive('what is the capital of France');
    assert.strictEqual(r.severity, null);
    assert.strictEqual(r.highTerms.length, 0);
    assert.strictEqual(r.lowTerms.length, 0);
  });

  it('returns null for empty string', () => {
    const r = classifyDestructive('');
    assert.strictEqual(r.severity, null);
  });
});

describe('risk.js: isSafeRmTarget', () => {
  it('node_modules is safe', () => assert.ok(isSafeRmTarget('node_modules')));
  it('dist is safe', () => assert.ok(isSafeRmTarget('dist')));
  it('build is safe', () => assert.ok(isSafeRmTarget('build')));
  it('.next is safe', () => assert.ok(isSafeRmTarget('.next')));
  it('/tmp/something is safe', () => assert.ok(isSafeRmTarget('/tmp/something')));
  it('~/projects/old is not safe', () => assert.ok(!isSafeRmTarget('~/projects/old')));
  it('/home/user/data is not safe', () => assert.ok(!isSafeRmTarget('/home/user/data')));
});
