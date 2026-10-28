'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ZipFile } = require('yazl');
const { initDb } = require('../src/db/database');
const { generateToken } = require('../src/middleware/auth');
const { normalizeSubmission } = require('../src/services/community');
const { inspectArchive } = require('../src/services/communityArchive');

async function zip(entries) {
  const file = new ZipFile();
  for (const entry of entries) file.addBuffer(Buffer.from(entry.content || '# Sample skill'), entry.name, entry.options || {});
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    file.outputStream.on('data', chunk => chunks.push(chunk));
    file.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    file.outputStream.on('error', reject);
  });
  file.end(); return result;
}

test('creator submission, private upload, independent review, immutable publication and withdrawal', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-community-test-'));
  process.env.COMMUNITY_UPLOAD_DIR = path.join(directory, 'uploads');
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  process.env.ADMIN_PASSWORD = require('crypto').randomBytes(20).toString('hex');
  const db = await initDb(path.join(directory, 'test.db'));
  for (const [id, role] of [['author', 'user'], ['other', 'user'], ['reviewer', 'admin']]) {
    db.prepare('INSERT INTO users (id,email,password_hash,role,is_active) VALUES (?,?,?,?,1)').run(id, `${id}@example.com`, 'unused', role);
  }
  const tokens = Object.fromEntries(['author', 'other', 'reviewer'].map(id => [id, generateToken({ id, email: `${id}@example.com`, role: id === 'reviewer' ? 'admin' : 'user' })]));
  const app = express(); app.use(express.json());
  app.use('/api/community', require('../src/routes/community'));
  app.use('/api/skill-store', require('../src/routes/skill-store'));
  app.use('/api/kit-store', require('../src/routes/kit-store'));
  app.use('/api/mcp-store', require('../src/routes/mcp-store'));
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/user', require('../src/routes/user'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, who, method = 'GET', body) {
    return fetch(base + route, { method, headers: {
      ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
      ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' } : {}),
    }, body: body ? Buffer.isBuffer(body) ? body : JSON.stringify(body) : undefined });
  }
  const common = { name: 'Sample', description: 'A reviewed skill', version: '1.0.0', license: 'MIT', tags: ['productivity'] };
  const uploaded = await call('/api/community/uploads', 'author', 'POST', await zip([{ name: 'my-skill/SKILL.md' }]));
  assert.equal(uploaded.status, 201); const upload = await uploaded.json();
  assert.equal((await call(`/api/community/assets/${upload.id}`)).status, 404);
  assert.equal((await call('/api/community/review', 'author')).status, 403);
  assert.equal((await call(`/api/community/review/uploads/${upload.id}`, 'author')).status, 403);
  assert.equal((await call('/api/community/submissions', 'other', 'POST', { ...common, kind: 'skill', uploadId: upload.id })).status, 400);
  const created = await call('/api/community/submissions', 'author', 'POST', { ...common, kind: 'skill', uploadId: upload.id });
  assert.equal(created.status, 201); const item = await created.json();
  const approve = revision => ({ decision: 'approve', revision, note: 'Inspected files and permissions' });
  assert.equal((await call(`/api/community/review/${item.id}`, 'author', 'POST', approve(1))).status, 403);
  assert.equal((await call(`/api/community/review/${item.id}`, 'reviewer', 'POST', approve(0))).status, 409);
  assert.equal((await call(`/api/community/review/${item.id}`, 'reviewer', 'POST', approve(1))).status, 200);
  const skills = async () => (await (await call('/api/skill-store')).json()).data.value.marketplace;
  assert.equal((await skills()).find(s => s.id === `community-${item.id}`).version, '1.0.0');
  const publishedUrl = new URL((await skills()).find(s => s.id === `community-${item.id}`).url);
  assert.match(publishedUrl.pathname, /\.zip$/);
  assert.equal((await call(publishedUrl.pathname)).status, 200);
  assert.equal((await call(`/api/community/assets/${upload.id}.zip`)).status, 404);
  const normalizedId = path.basename(publishedUrl.pathname, '.zip');
  const normalized = await inspectArchive(path.join(process.env.COMMUNITY_UPLOAD_DIR, `${normalizedId}.zip`));
  assert.ok(normalized.documents[`community-${item.id}/SKILL.md`].includes('version: "1.0.0"'));
  assert.equal((await call(`/api/community/submissions/${item.id}`, 'author', 'PUT', { ...common, kind: 'skill', uploadId: upload.id, revision: 1 })).status, 400);
  assert.equal((await call(`/api/community/submissions/${item.id}`, 'author', 'PUT', { ...common, version: '1.1.0', kind: 'skill', uploadId: upload.id, revision: 1 })).status, 200);
  assert.equal((await skills()).find(s => s.id === `community-${item.id}`).version, '1.0.0');
  assert.equal((await call(`/api/community/review/${item.id}`, 'reviewer', 'POST', approve(1))).status, 409);
  assert.equal((await call(`/api/community/review/${item.id}`, 'reviewer', 'POST', { decision: 'reject', revision: 2, note: 'Please document tool access' })).status, 200);
  assert.equal((await skills()).find(s => s.id === `community-${item.id}`).version, '1.0.0');
  assert.equal((await call(`/api/community/submissions/${item.id}`, 'other', 'DELETE')).status, 404);
  assert.equal((await call(`/api/community/submissions/${item.id}`, 'author', 'DELETE')).status, 200);
  assert.equal((await call(`/api/community/assets/${upload.id}`)).status, 404);
  assert.equal((await call(publishedUrl.pathname)).status, 404);
  assert.equal((await skills()).some(s => s.id === `community-${item.id}`), false);
  const history = await (await call(`/api/community/submissions/${item.id}/history`, 'author')).json();
  assert.equal(history.reviews.length, 2);

  const connector = { ...common, kind: 'connector', connector: { transportType: 'http', url: 'https://example.com/mcp', requiredEnvKeys: ['SERVICE_KEY'] } };
  const c = await (await call('/api/community/submissions', 'author', 'POST', connector)).json();
  assert.equal((await call(`/api/community/review/${c.id}`, 'reviewer', 'POST', approve(1))).status, 200);
  const registry = (await (await call('/api/mcp-store')).json()).data.value.servers;
  assert.equal(registry.find(s => s.id === `community-${c.id}`).url, 'https://example.com/mcp');
  const expert = await (await call('/api/community/submissions', 'author', 'POST', { ...common, kind: 'expert', uploadId: upload.id, skills: [{ id: 'my-skill', name: 'Sample' }] })).json();
  assert.equal((await call(`/api/community/review/${expert.id}`, 'reviewer', 'POST', approve(1))).status, 200);
  const kits = (await (await call('/api/kit-store')).json()).data.value.kits;
  assert.equal(kits.find(s => s.id === `community-${expert.id}`).skills.list[0].id, 'my-skill');
  db.prepare("UPDATE users SET role = 'user' WHERE id = 'reviewer'").run();
  assert.equal((await call('/api/community/review', 'reviewer')).status, 403);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(require('bcryptjs').hashSync('Testpass123', 4), 'author');
  const webLogin = await (await call('/api/auth/portal-login', null, 'POST', { email: 'author@example.com', password: 'Testpass123' })).json();
  assert.ok(webLogin.token, 'web login must issue a persistent browser session');
  const exchange = await (await call('/api/auth/exchange', null, 'POST', { authCode: webLogin.code })).json();
  assert.equal(exchange.data.user.yid, 'author');
  assert.equal((await call('/api/auth/exchange', null, 'POST', { authCode: webLogin.code })).status, 400);
  const profile = await (await call('/api/user/profile', 'author')).json();
  assert.equal(profile.data.nickname, 'author@example.com');
  const summary = await (await call('/api/user/profile-summary', 'author')).json();
  assert.ok(Array.isArray(summary.data.creditItems));
  assert.equal(typeof summary.data.totalCreditsRemaining, 'number');
  assert.equal((await call('/api/auth/portal-login', null, 'POST', { email: 'author@example.com', password: 'Testpass123', redirect_uri: 'https://attacker.example/callback' })).status, 400);
  const desktopLogin = await (await call('/api/auth/portal-login', null, 'POST', { email: 'author@example.com', password: 'Testpass123', redirect_uri: 'http://127.0.0.1:4567/auth/callback', state: 'test-state' })).json();
  assert.match(desktopLogin.redirectUrl, /^http:\/\/127\.0\.0\.1:4567\/auth\/callback\?code=/);
});

test('rejects connector secrets and invalid versions', () => {
  const body = { kind: 'connector', name: 'Example', description: 'Test', version: '1.0.0', license: 'MIT', connector: { transportType: 'http', url: 'https://example.com' } };
  assert.throws(() => normalizeSubmission({ ...body, connector: { ...body.connector, headers: { Authorization: 'secret' } } }), /credentials/);
  assert.throws(() => normalizeSubmission({ ...body, connector: { ...body.connector, url: 'https://user:pass@example.com' } }), /credentials/);
  assert.throws(() => normalizeSubmission({ ...body, version: '../../bad' }), /semantic/);
});

test('archive inspection rejects private keys, links, path traversal and case collisions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-archive-test-'));
  try {
    const file = path.join(directory, 'upload.zip');
    for (const entries of [[{ name: '.env' }], [{ name: 'skill/id_ed25519' }], [{ name: 'linked', options: { mode: 0o120777 } }], [{ name: 'SKILL.md' }, { name: 'skill.md' }]]) {
      fs.writeFileSync(file, await zip(entries)); await assert.rejects(inspectArchive(file));
    }
    const buffer = await zip([{ name: 'xx/file' }]);
    for (let index = buffer.indexOf(Buffer.from('xx/file')); index >= 0; index = buffer.indexOf(Buffer.from('xx/file'))) Buffer.from('../file').copy(buffer, index);
    fs.writeFileSync(file, buffer); await assert.rejects(inspectArchive(file));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
