'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const yazl = require('yazl');

function buildZip(files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf8'), name);
    }
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

test('artifact shares: upload, code gate, access mode, status, update, deployments', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-shares-'));
  const crypto = require('crypto');
  const seedEnv = (name, bytes) => { process.env[name] = crypto.randomBytes(bytes).toString('hex'); };
  seedEnv('JWT_SECRET', 32);
  seedEnv('ADMIN_PASSWORD', 20);
  process.env.SHARE_UPLOAD_DIR = path.join(directory, 'shares');
  delete process.env.SHARE_NODE_RUNNER;

  const { initDb } = require('../src/db/database');
  const db = await initDb(path.join(directory, 'test.db'));
  const { generateToken } = require('../src/middleware/auth');

  const user = { id: 'u-share', email: 's@example.com', role: 'user' };
  db.prepare('INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, is_active) VALUES (?, ?, ?, ?, ?, 100, 100, 1)')
    .run(user.id, user.email, 'x', 'S', 'user');
  const token = generateToken(user);

  const app = express();
  app.use(express.json());
  app.use('/api/html-shares', require('../src/routes/html-shares'));
  app.use('/api/share-deployments', require('../src/routes/share-deployments'));
  app.use('/s', require('../src/routes/shares-public'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${token}` };

  const zip = await buildZip({
    'index.html': '<html><body><h1 id="t">hello share</h1></body></html>',
    'assets/app.js': 'console.log("ok")',
  });
  const sha = crypto.createHash('sha256').update(zip).digest('hex');

  const makeForm = (fields, fileField = 'archive') => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set(fileField, new Blob([zip], { type: 'application/zip' }), 'share.zip');
    return form;
  };

  // ─── Create ─────────────────────────────────────────────────
  let res = await fetch(`${base}/api/html-shares`, {
    method: 'POST', headers: auth,
    body: makeForm({ sourceType: 'html_file', clientSourceKey: 'artifact-1', title: 'Demo', entryFile: 'index.html', sourceSha256: sha }),
  });
  assert.equal(res.status, 200);
  const created = (await res.json()).data;
  assert.match(created.shareId, /^shr_/);
  assert.equal(created.accessMode, 'code');
  assert.ok(created.shareCode);
  assert.ok(created.url.endsWith(`/s/${created.shareId}/`));

  // Checksum mismatch is rejected.
  res = await fetch(`${base}/api/html-shares`, {
    method: 'POST', headers: auth,
    body: makeForm({ sourceType: 'html_file', title: 'Bad', sourceSha256: 'deadbeef' }),
  });
  assert.equal(res.status, 400);

  // ─── Code gate ──────────────────────────────────────────────
  const shareUrl = `${base}/s/${created.shareId}/`;
  assert.equal((await fetch(shareUrl)).status, 401);
  assert.equal((await fetch(`${shareUrl}?code=wrong`)).status, 401);

  res = await fetch(`${shareUrl}?code=${encodeURIComponent(created.shareCode)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /hello share/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);

  // Static asset inside the zip is served too.
  res = await fetch(`${base}/s/${created.shareId}/assets/app.js?code=${encodeURIComponent(created.shareCode)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);

  // SPA fallback: unknown path returns the entry file.
  res = await fetch(`${base}/s/${created.shareId}/some/route?code=${encodeURIComponent(created.shareCode)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /hello share/);

  // ─── Access mode ────────────────────────────────────────────
  res = await fetch(`${base}/api/html-shares/${created.shareId}/access-mode`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessMode: 'public' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await fetch(shareUrl)).status, 200);

  // ─── Status ─────────────────────────────────────────────────
  res = await fetch(`${base}/api/html-shares/${created.shareId}/status`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'disabled', reason: 'test' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await fetch(shareUrl)).status, 410);

  await fetch(`${base}/api/html-shares/${created.shareId}/status`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'live' }),
  });
  assert.equal((await fetch(shareUrl)).status, 200);

  // ─── Update content ─────────────────────────────────────────
  const zip2 = await buildZip({ 'index.html': '<html><body><h1>v2 content</h1></body></html>' });
  const sha2 = crypto.createHash('sha256').update(zip2).digest('hex');
  const form2 = new FormData();
  form2.set('sourceType', 'html_file');
  form2.set('title', 'Demo v2');
  form2.set('entryFile', 'index.html');
  form2.set('sourceSha256', sha2);
  form2.set('archive', new Blob([zip2], { type: 'application/zip' }), 'share.zip');
  res = await fetch(`${base}/api/html-shares/${created.shareId}`, { method: 'PUT', headers: auth, body: form2 });
  assert.equal(res.status, 200);
  assert.match(await (await fetch(shareUrl)).text(), /v2 content/);

  // ─── Source lookup + my list ────────────────────────────────
  res = await fetch(`${base}/api/html-shares/source?sourceType=html_file&clientSourceKey=artifact-1&includeDisabled=true`, { headers: auth });
  const found = await res.json();
  assert.equal(found.code, 0);
  assert.equal(found.data.shareId, created.shareId);

  res = await fetch(`${base}/api/html-shares/my`, { headers: auth });
  const mine = await res.json();
  assert.equal(mine.code, 0);
  assert.ok(Array.isArray(mine.data.items));
  assert.ok(mine.data.items.some((item) => item.shareId === created.shareId));

  // ─── Static deployment ──────────────────────────────────────
  const staticZip = await buildZip({ 'index.html': '<html><body>static site</body></html>' });
  const staticSha = crypto.createHash('sha256').update(staticZip).digest('hex');
  const staticForm = new FormData();
  staticForm.set('sessionId', 'sess-1');
  staticForm.set('artifactId', 'art-1');
  staticForm.set('title', 'Static');
  staticForm.set('accessMode', 'public');
  staticForm.set('clientSourceKey', 'static-key-1');
  staticForm.set('sourceSha256', staticSha);
  staticForm.set('manifest', JSON.stringify({ deploymentKind: 'static_site', entryFile: 'index.html', spaFallback: true }));
  staticForm.set('sourceArchive', new Blob([staticZip], { type: 'application/zip' }), 'deployment.zip');

  res = await fetch(`${base}/api/share-deployments/static`, { method: 'POST', headers: auth, body: staticForm });
  assert.equal(res.status, 200);
  const staticBody = (await res.json()).data;
  assert.equal(staticBody.deploymentStatus, 'live');
  assert.ok(staticBody.shareId);
  res = await fetch(`${base}/s/${staticBody.shareId}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /static site/);

  // Deployment lookup by id.
  res = await fetch(`${base}/api/share-deployments/${staticBody.deploymentId}`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.deploymentKind, 'static_site');

  // Persistence endpoints.
  res = await fetch(`${base}/api/share-deployments/${staticBody.deploymentId}/persistence`, { headers: auth });
  assert.deepEqual((await res.json()).data, null);
  assert.equal((await fetch(`${base}/api/share-deployments/${staticBody.deploymentId}/persistence/archive`, { headers: auth })).status, 204);

  // ─── Node deployment without a runner ───────────────────────
  const nodeZip = await buildZip({ 'index.js': 'require("http").createServer((q,s)=>s.end("ok")).listen(3000)' });
  const nodeForm = new FormData();
  nodeForm.set('sessionId', 'sess-2');
  nodeForm.set('artifactId', 'art-2');
  nodeForm.set('title', 'Node svc');
  nodeForm.set('accessMode', 'code');
  nodeForm.set('clientSourceKey', 'node-key-1');
  nodeForm.set('manifest', JSON.stringify({ deploymentKind: 'node_service', startCommand: 'node index.js', listenPort: 3000, runtimeVersion: '22' }));
  nodeForm.set('sourceArchive', new Blob([nodeZip], { type: 'application/zip' }), 'deployment.zip');

  res = await fetch(`${base}/api/share-deployments/node`, { method: 'POST', headers: auth, body: nodeForm });
  assert.equal(res.status, 200);
  const nodeBody = (await res.json()).data;
  assert.equal(nodeBody.status, 'failed');
  assert.equal(nodeBody.failureCode, 'runtime_unavailable');
  assert.ok(nodeBody.failureMessage.includes('SHARE_NODE_RUNNER'));

  // The share record left behind is marked failed, so the public URL refuses.
  assert.equal((await fetch(`${base}/s/${nodeBody.shareId}/`)).status, 502);

  // ─── Auth is required for the API ───────────────────────────
  assert.equal((await fetch(`${base}/api/html-shares/my`)).status, 401);
  assert.equal((await fetch(`${base}/api/share-deployments/dep_x/persistence`)).status, 401);
});
