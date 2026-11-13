'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

// These tests pin the contract the desktop client depends on. The client calls these
// paths directly (see wulu-superagent src/main/main.ts), so a silent shape change
// breaks the app instead of failing a test.
test('client contract endpoints: banners, model catalog and credit campaigns', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-contract-'));
  const crypto = require('crypto');
  const seedEnv = (name, bytes) => { process.env[name] = crypto.randomBytes(bytes).toString('hex'); };
  seedEnv('JWT_SECRET', 32);
  seedEnv('ADMIN_PASSWORD', 20);

  const { initDb } = require('../src/db/database');
  const db = await initDb(path.join(directory, 'test.db'));
  const { generateToken } = require('../src/middleware/auth');

  const admin = db.prepare("SELECT * FROM users WHERE role IN ('admin','superadmin')").get();
  const adminToken = generateToken({ id: admin.id, email: admin.email, role: admin.role });

  const user = { id: 'u-contract', email: 'c@example.com', role: 'user' };
  db.prepare('INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, is_active) VALUES (?, ?, ?, ?, ?, 100, 100, 1)')
    .run(user.id, user.email, 'x', 'C', 'user');
  const userToken = generateToken(user);

  const app = express();
  app.use(express.json());
  app.use('/api/client-banners', require('../src/routes/client-banners'));
  app.use('/api/models', require('../src/routes/models'));
  app.use('/api/credits-reset-campaign', require('../src/routes/credits-campaign'));
  app.use('/api/admin', require('../src/routes/admin'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

  // ─── Banners ────────────────────────────────────────────────
  let res = await fetch(`${base}/api/client-banners/active?placement=desktop_sidebar`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: 0, data: null });

  res = await fetch(`${base}/api/admin/client-banners`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ activityDescription: 'Spring promo', linkUrl: 'https://example.com/p', imageUrl: 'https://example.com/i.png', imageWidth: 320, imageHeight: 120 }),
  });
  assert.equal(res.status, 200);
  const bannerId = (await res.json()).id;

  const active = await (await fetch(`${base}/api/client-banners/active?placement=desktop_sidebar`)).json();
  assert.equal(active.code, 0);
  assert.equal(active.data.id, bannerId);
  assert.equal(active.data.activityDescription, 'Spring promo');
  assert.equal(active.data.imageWidth, 320);
  assert.ok(active.data.updatedAt);

  const list = await (await fetch(`${base}/api/client-banners/active-list?placement=desktop_sidebar`)).json();
  assert.equal(list.code, 0);
  assert.equal(list.data.length, 1);

  // A banner scheduled in the future must not show.
  await fetch(`${base}/api/admin/client-banners/${bannerId}`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ startsAt: Math.floor(Date.now() / 1000) + 3600 }),
  });
  assert.equal((await (await fetch(`${base}/api/client-banners/active`)).json()).data, null);

  // Deactivating hides it too.
  await fetch(`${base}/api/admin/client-banners/${bannerId}`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ startsAt: 0, isActive: false }) });
  assert.equal((await (await fetch(`${base}/api/client-banners/active`)).json()).data, null);

  // ─── Model catalog ──────────────────────────────────────────
  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('MODEL_CATALOG', ?)").run(JSON.stringify({
    textModels: [
      { modelId: 'gpt-4o-mini', modelName: 'GPT-4o mini', provider: 'openai', contextWindow: 128000 },
      { modelId: 'claude-3-5-sonnet', modelName: 'Claude 3.5 Sonnet', provider: 'anthropic', supportsImage: true },
    ],
    imageModels: [], videoModels: [],
  }));

  const catalog = await (await fetch(`${base}/api/models/pricing-catalog`)).json();
  assert.equal(catalog.code, 0);
  assert.equal(catalog.data.textModels.length, 2);
  assert.equal(catalog.data.textModels[0].modelId, 'gpt-4o-mini');
  assert.deepEqual(catalog.data.imageModels, []);

  const available = await (await fetch(`${base}/api/models/available`, { headers: { Authorization: `Bearer ${userToken}` } })).json();
  assert.equal(available.code, 0);
  assert.ok(Array.isArray(available.data));

  // Unauthenticated access to /available is rejected.
  assert.equal((await fetch(`${base}/api/models/available`)).status, 401);

  // ─── Credit campaign ────────────────────────────────────────
  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('CREDIT_CAMPAIGNS', ?)")
    .run(JSON.stringify({ spring: { credits: 500, active: true, endsAt: 0 } }));

  const claim = (code, token = userToken) => fetch(`${base}/api/credits-reset-campaign/free-credits/claim`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignCode: code }),
  });

  let r = await claim('spring');
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.code, 0);
  assert.equal(body.data.credits, 500);
  assert.equal(body.data.alreadyClaimed, false);
  assert.equal(db.prepare('SELECT quota_remaining AS q FROM users WHERE id = ?').get(user.id).q, 600);

  // Second claim is idempotent: no extra credits.
  r = await claim('spring');
  body = await r.json();
  assert.equal(body.data.alreadyClaimed, true);
  assert.equal(db.prepare('SELECT quota_remaining AS q FROM users WHERE id = ?').get(user.id).q, 600);

  assert.equal((await claim('does-not-exist')).status, 404);
  assert.equal((await claim('spring', '')).status, 401);
});
