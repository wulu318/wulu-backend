'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Secrets: no fallback, minimum length ──────────────────────────
test('getJwtSecret refuses to run without JWT_SECRET', () => {
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const { getJwtSecret } = require('../src/config/secrets');
    assert.throws(() => getJwtSecret(), /JWT_SECRET is not set/);
  } finally {
    if (saved !== undefined) process.env.JWT_SECRET = saved;
  }
});

test('getJwtSecret rejects short secrets', () => {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'short';
  try {
    const { getJwtSecret } = require('../src/config/secrets');
    assert.throws(() => getJwtSecret(), /at least 32 characters/);
  } finally {
    if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
  }
});

test('no source file falls back to the hard-coded dev secret', () => {
  const srcRoot = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('dev-secret')) offenders.push(full);
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, []);
});

// ─── Billing: never free, never negative, atomic ───────────────────
const { resolveChargeTokens, chargeQuota } = require('../src/services/billing');

test('reported total_tokens is charged as-is', () => {
  assert.equal(resolveChargeTokens({ totalTokens: 120 }), 120);
});

test('missing usage is estimated from payload size, never zero', () => {
  const charged = resolveChargeTokens({ totalTokens: 0, requestBytes: 40, responseBytes: 0 });
  assert.equal(charged, 10);
});

test('a tiny request with no usage still costs at least one token', () => {
  assert.equal(resolveChargeTokens({ requestBytes: 0, responseBytes: 0 }), 1);
});

test('charge is capped at remaining quota and never goes negative', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, quota_remaining INTEGER, updated_at INTEGER)');
  db.prepare('INSERT INTO users VALUES (?, ?, 0)').run('u1', 50);
  assert.equal(chargeQuota(db, 'u1', 200), 50);
  assert.equal(db.prepare('SELECT quota_remaining AS q FROM users').get().q, 0);
  assert.equal(chargeQuota(db, 'u1', 10), 0);
  assert.equal(db.prepare('SELECT quota_remaining AS q FROM users').get().q, 0);
});

test('billing is wired into model-proxy and removes the old unguarded deduction', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'model-proxy.js'), 'utf8');
  assert.ok(src.includes("require('../services/billing')"));
  assert.ok(!src.includes('MAX(0, quota_remaining - ?)'), 'old non-atomic deduction must be removed');
  assert.ok(!/if \(totalTokens > 0\)/.test(src), 'zero-usage responses must not skip charging');
});
