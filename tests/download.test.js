'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

test('download catalog reports only platforms that actually have a package', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-dl-'));
  const crypto = require('crypto');
  const seedEnv = (name, bytes) => { process.env[name] = crypto.randomBytes(bytes).toString('hex'); };
  seedEnv('JWT_SECRET', 32);
  seedEnv('ADMIN_PASSWORD', 20);

  const { initDb } = require('../src/db/database');
  const db = await initDb(path.join(directory, 'test.db'));

  // Upgrade the seeded row to a realistic shape: Windows + macOS arm, no Intel mac.
  db.prepare(`UPDATE update_versions SET is_latest = 1, is_active = 1,
    windows_x64_url = ?, windows_x64_size = ?,
    mac_arm_url = ?, mac_arm_size = ?,
    mac_intel_url = '', mac_intel_size = '',
    linux_x64_url = '', linux_x64_size = '',
    linux_arm64_url = '', linux_arm64_size = ''
    WHERE version = (SELECT version FROM update_versions ORDER BY version DESC LIMIT 1)`)
    .run(
      'https://example.com/WULU-Setup-x64.exe', 262503108,
      'https://example.com/WULU-darwin-arm64.dmg', 334025798,
    );

  const app = express();
  app.use('/api/download', require('../src/routes/download'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let res = await fetch(`${base}/api/download/latest`);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.code, 0);

  const { platforms, contact } = body.data;
  assert.equal(platforms.windowsX64.available, true);
  assert.equal(platforms.windowsX64.size, 262503108);
  assert.equal(platforms.macArm.available, true);
  assert.equal(platforms.macIntel.available, false, 'no Intel mac package exists');
  assert.equal(platforms.macIntel.url, null);
  assert.equal(platforms.linuxX64.available, false);

  // No contact email configured: the page must not render a dead address.
  assert.equal(contact.email, null);
  assert.match(contact.issuesUrl, /github\.com\/wulu318\/wulu-superagent\/issues/);

  // Once an operator sets one, it is exposed.
  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('CONTACT_EMAIL', 'support@example.com')").run();
  body = await (await fetch(`${base}/api/download/latest`)).json();
  assert.equal(body.data.contact.email, 'support@example.com');
});
