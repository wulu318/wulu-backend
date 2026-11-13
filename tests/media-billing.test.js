'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

test('media generation charges points and refuses when the balance is too low', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-media-'));
  const crypto = require('crypto');
  const seedEnv = (name, bytes) => { process.env[name] = crypto.randomBytes(bytes).toString('hex'); };
  seedEnv('JWT_SECRET', 32);
  seedEnv('ADMIN_PASSWORD', 20);

  const { initDb } = require('../src/db/database');
  const db = await initDb(path.join(directory, 'test.db'));
  const { generateToken } = require('../src/middleware/auth');

  const user = { id: 'u-media', email: 'm@example.com', role: 'user' };
  db.prepare('INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(user.id, user.email, 'x', 'M', 'user', 100, 100);
  const token = generateToken(user);

  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('MEDIA_SERVICE_BASE_URL', 'https://media.example')").run();
  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('MEDIA_CREDIT_COSTS', ?)")
    .run(JSON.stringify({ image_generation: 20, video_generation: 100 }));

  // Stub only the upstream call; the test's own requests must reach the local server.
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  const testBase = { url: '' };
  let upstreamStatus = 200;
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (testBase.url && url.startsWith(testBase.url)) {
      return originalFetch(input, init);
    }
    upstreamCalls += 1;
    return new Response(JSON.stringify({ code: 0, data: { taskId: 't1' } }), {
      status: upstreamStatus, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const app = express();
  app.use(express.json());
  app.use('/api/media', require('../src/routes/media'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  testBase.url = base;
  const remaining = () => db.prepare('SELECT quota_remaining AS q FROM users WHERE id = ?').get(user.id).q;

  // 1) Successful generation charges the configured cost.
  let res = await fetch(`${base}/api/media/images/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat' }),
  });
  assert.equal(res.status, 200);
  assert.equal(remaining(), 80);

  const log = db.prepare("SELECT request_type, charged_tokens FROM usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);
  assert.equal(log.request_type, 'image_generation');
  assert.equal(log.charged_tokens, 20);

  // 2) A read-only call is free.
  const before = remaining();
  res = await fetch(`${base}/api/media/images/models`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(remaining(), before);

  // 3) Video costs more and is refused when the balance cannot cover it.
  res = await fetch(`${base}/api/media/videos/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a dog' }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, 40204);

  // The refused call must not have reached the upstream.
  const callsBeforeRefusal = upstreamCalls;
  assert.equal(callsBeforeRefusal, 2, 'only the two allowed calls reached upstream');
  assert.equal(remaining(), 80);

  // 4) Upstream failure does not charge.
  upstreamStatus = 500;
  res = await fetch(`${base}/api/media/images/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'fail' }),
  });
  assert.equal(res.status, 500);
  assert.equal(remaining(), 80);
});
