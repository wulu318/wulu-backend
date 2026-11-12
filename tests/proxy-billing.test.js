'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

// End-to-end: real proxy route + real DB + a fake upstream that controls its own usage reporting.
test('proxy charges quota when upstream omits usage, and never lets a call be free', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-billing-'));
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  process.env.ADMIN_PASSWORD = require('crypto').randomBytes(20).toString('hex');
  process.env.NEWAPI_BASE_URL = '';

  let upstreamMode = 'no-usage';
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (upstreamMode === 'no-usage') {
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'hi' } }] }));
      } else {
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } }));
      }
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const { initDb, getDb } = require('../src/db/database');
  const db = await initDb(path.join(directory, 'test.db'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('NEWAPI_BASE_URL', ?)").run(upstreamBase);
  const { generateToken } = require('../src/middleware/auth');
  const user = db.prepare("SELECT * FROM users WHERE role = 'user' LIMIT 1").get()
    || (() => {
      db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, is_active) VALUES ('u-test','t@example.com','x','t','user',1000,1000,1)").run();
      return db.prepare("SELECT * FROM users WHERE id = 'u-test'").get();
    })();
  db.prepare('UPDATE users SET quota_remaining = 1000, is_active = 1 WHERE id = ?').run(user.id);
  const token = generateToken(user);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', require('../src/routes/model-proxy'));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = () => fetch(`${base}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello there' }] }),
  });

  const remaining = () => db.prepare('SELECT quota_remaining AS q FROM users WHERE id = ?').get(user.id).q;

  // 1) Upstream reports no usage: must still be charged (not free).
  let r = await call();
  assert.equal(r.status, 200);
  await r.json();
  const afterNoUsage = remaining();
  assert.ok(afterNoUsage < 1000, `no-usage call must be charged, remaining=${afterNoUsage}`);

  // 2) Upstream reports usage: charged by reported total_tokens.
  upstreamMode = 'with-usage';
  const before = remaining();
  r = await call();
  assert.equal(r.status, 200);
  await r.json();
  assert.equal(before - remaining(), 50);

  // 3) Every call writes exactly one usage_logs row with charged_tokens recorded.
  const logs = db.prepare('SELECT charged_tokens FROM usage_logs WHERE user_id = ? ORDER BY id').all(user.id);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].charged_tokens >= 1);
  assert.equal(logs[1].charged_tokens, 50);
});
