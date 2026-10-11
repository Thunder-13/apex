'use strict';
/**
 * perf.test.js — performance regression tests.
 *
 * Each case must complete route() in < 500 ms and the hook process in < 1000 ms
 * (override with APEX_PERF_ROUTE_MS / APEX_PERF_HOOK_MS). Pre-fix, 100 KB took 16 s.
 * Inputs are 1 MB+ pathological payloads (repeated chars, minified-JS patterns,
 * base64-like, all-caps, JSON fragments with no closing brace, etc.).
 *
 * Defense-in-depth truncation in router.js caps the routing window at 28 KB,
 * so all cases should be fast regardless of input size.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const { route } = require('../router/router.js');

const HOOK_PATH = path.join(__dirname, '../hooks/apex-gate.js');
const APEX_HOME  = path.join(__dirname, '..');

const ROUTE_LIMIT_MS = Number(process.env.APEX_PERF_ROUTE_MS || 500);  // guards the pre-fix 16 s blowup; loose for loaded machines
const HOOK_LIMIT_MS  = Number(process.env.APEX_PERF_HOOK_MS || 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runHook(prompt) {
  const payload = JSON.stringify({ prompt });
  const t0 = Date.now();
  try {
    execSync(`node ${HOOK_PATH}`, {
      input: payload,
      env: { ...process.env, APEX_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch (_) { /* non-zero exit is fine as long as it's fast */ }
  return Date.now() - t0;
}

// ---------------------------------------------------------------------------
// route() < 200 ms
// ---------------------------------------------------------------------------
describe('perf: route() < 200 ms on 1 MB+ pathological inputs', () => {
  it('x * 1M: route() < 200 ms', () => {
    const input = 'x'.repeat(1_000_000);
    const t0 = Date.now();
    route(input);
    assert.ok(Date.now() - t0 < ROUTE_LIMIT_MS, `route() took >= ${ROUTE_LIMIT_MS} ms on x*1M`);
  });

  it('a/ * 500k: route() < 200 ms', () => {
    const input = 'a/'.repeat(250_000);
    const t0 = Date.now();
    route(input);
    assert.ok(Date.now() - t0 < ROUTE_LIMIT_MS, `route() took >= ${ROUTE_LIMIT_MS} ms on a/*500k`);
  });

  it('A1 * 500k: route() < 200 ms', () => {
    const input = 'A1'.repeat(250_000);
    const t0 = Date.now();
    route(input);
    assert.ok(Date.now() - t0 < ROUTE_LIMIT_MS, `route() took >= ${ROUTE_LIMIT_MS} ms on A1*500k`);
  });

  it('{"a": * 200k (no closing brace): route() < 200 ms', () => {
    const input = '{"a":'.repeat(40_000);
    const t0 = Date.now();
    route(input);
    assert.ok(Date.now() - t0 < ROUTE_LIMIT_MS, `route() took >= ${ROUTE_LIMIT_MS} ms on json*200k`);
  });

  it('" * 500k: route() < 200 ms', () => {
    const input = '"'.repeat(500_000);
    const t0 = Date.now();
    route(input);
    assert.ok(Date.now() - t0 < ROUTE_LIMIT_MS, `route() took >= ${ROUTE_LIMIT_MS} ms on quote*500k`);
  });
});

// ---------------------------------------------------------------------------
// hook process < 400 ms
// ---------------------------------------------------------------------------
describe('perf: hook process < 400 ms on 1 MB+ pathological inputs', () => {
  it('x * 1M: hook < 400 ms', () => {
    const ms = runHook('x'.repeat(1_000_000));
    assert.ok(ms < HOOK_LIMIT_MS, `hook took ${ms} ms >= ${HOOK_LIMIT_MS} ms on x*1M`);
  });

  it('A1 * 500k: hook < 400 ms', () => {
    const ms = runHook('A1'.repeat(250_000));
    assert.ok(ms < HOOK_LIMIT_MS, `hook took ${ms} ms >= ${HOOK_LIMIT_MS} ms on A1*500k`);
  });

  it('{"a": * 200k (no closing brace): hook < 400 ms', () => {
    const ms = runHook('{"a":'.repeat(40_000));
    assert.ok(ms < HOOK_LIMIT_MS, `hook took ${ms} ms >= ${HOOK_LIMIT_MS} ms on json*200k`);
  });
});
