'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { initDb } = require('../src/db/database');
const { generateToken } = require('../src/middleware/auth');

test('update publication preserves data and limits patches to the exact platform and base', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-update-'));
  process.env.ADMIN_PASSWORD = require('crypto').randomBytes(20).toString('hex');
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  const db = await initDb(path.join(directory, 'test.db'));
  const admin = db.prepare("SELECT * FROM users WHERE role IN ('admin','superadmin')").get();
  const token = generateToken({ id: admin.id, email: admin.email, role: admin.role });
  const app = express(); app.use(express.json());
  app.use('/api/update', require('../src/routes/update'));
  app.use('/api/admin', require('../src/routes/admin'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const version = { version: '2026.10.30', is_latest: true, windows_x64_url: 'https://example.com/setup.exe',
    incremental_platform: 'win32-x64', incremental_base_version: '2026.10.29', incremental_url: 'https://example.com/patch.zip', incremental_sha256: 'a'.repeat(64) };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/admin/versions`, { method: 'POST', headers, body: JSON.stringify(version) })).status, 200);
  const check = async query => (await (await fetch(`${base}/api/update/check?${query}`)).json()).data.value;
  const patch = await check('version=2026.10.29&platform=win32&arch=x64');
  assert.equal(patch.incremental.platform, 'win32-x64');
  assert.equal(patch.incremental.sha256, 'a'.repeat(64));
  for (const query of ['version=2026.10.29', 'version=2026.10.28&platform=win32&arch=x64', 'version=2026.10.29&platform=darwin&arch=arm64', 'version=2026.10.29&platform=linux&arch=x64']) {
    const value = await check(query); assert.equal(value.incremental, undefined); assert.equal(value.windowsX64.url, version.windows_x64_url);
  }
  assert.equal((await fetch(`${base}/api/admin/versions/${version.version}`, { method: 'PUT', headers, body: JSON.stringify({ title: 'Updated title' }) })).status, 200);
  assert.equal((await check('version=2026.10.29&platform=win32&arch=x64')).incremental.platform, 'win32-x64');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
});
