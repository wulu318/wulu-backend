'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

test('signup works without an email provider, and can be forced to require one', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-auth-'));
  const crypto = require('crypto');
  const seedEnv = (name, bytes) => { process.env[name] = crypto.randomBytes(bytes).toString('hex'); };
  seedEnv('JWT_SECRET', 32);
  seedEnv('ADMIN_PASSWORD', 20);

  const saved = {
    resend: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    require: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
  t.after(() => {
    for (const [key, value] of Object.entries({ RESEND_API_KEY: saved.resend, EMAIL_FROM: saved.from, AUTH_REQUIRE_EMAIL_VERIFICATION: saved.require })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { initDb } = require('../src/db/database');
  const db = await initDb(path.join(directory, 'test.db'));

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const register = (email) => fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123', displayName: 'New User' }),
  });

  // No provider configured: signup must not be blocked forever.
  let res = await register('first@example.com');
  assert.ok(res.status === 200 || res.status === 201, `unexpected status ${res.status}`);
  const body = await res.json();
  assert.ok(body.token, 'a token is issued on signup');
  assert.ok(db.prepare('SELECT id FROM users WHERE email = ?').get('first@example.com'));

  // Explicitly requiring verification still rejects a code-less signup.
  process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
  res = await register('second@example.com');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /verification code/i);
  assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get('second@example.com'), undefined);
});
