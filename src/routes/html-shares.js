'use strict';

// Artifact sharing. The desktop client uploads a zip, gets back a public URL under
// /s/<shareId>/ and can later update content, toggle access mode and enable/disable.
const express = require('express');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { parseMultipart, MAX_FILE_BYTES } = require('../services/multipart');
const storage = require('../services/shareStorage');

const router = express.Router();

const SOURCE_TYPES = new Set([
  'html_file', 'image_file', 'svg_file', 'document_file', 'markdown_file',
  'mermaid_file', 'node_service_deployment', 'static_service_deployment',
]);
const ACCESS_MODES = new Set(['code', 'public']);
const CONFIGURABLE_STATUS = new Set(['live', 'disabled']);

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || process.env.SERVER_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

function shareUrl(req, shareId) {
  return `${publicBaseUrl(req)}/s/${encodeURIComponent(shareId)}/`;
}

function isOwnerOrAdmin(req, row) {
  if (!req.user) return false;
  return row.user_id === req.user.sub || req.user.role === 'admin' || req.user.role === 'superadmin';
}

// Shape returned to the desktop client. Share codes are only exposed to the owner.
function toSharePayload(req, row, { includeCode = true } = {}) {
  const payload = {
    shareId: row.id,
    url: shareUrl(req, row.id),
    accessMode: row.access_mode,
    status: row.status,
    moderationStatus: row.moderation_status,
    sourceType: row.source_type,
    clientSourceKey: row.client_source_key || undefined,
    title: row.title,
    entryFile: row.entry_file,
    updatedAt: new Date((row.updated_at || 0) * 1000).toISOString(),
    contentUpdatedAt: row.content_updated_at
      ? new Date(row.content_updated_at * 1000).toISOString()
      : undefined,
    disabledAt: row.disabled_at ? new Date(row.disabled_at * 1000).toISOString() : null,
    disabledReason: row.disabled_reason || null,
    disabledSource: row.disabled_source || null,
    source: { type: row.source_type, clientSourceKey: row.client_source_key || undefined },
  };
  if (includeCode) {
    payload.shareCode = row.share_code || undefined;
    payload.shareCodeUnavailable = row.access_mode !== 'code';
  }
  return payload;
}

function pickEntryFile(contentRoot, requested) {
  const candidates = [requested, 'index.html', 'index.htm'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const target = storage.resolveInside(contentRoot, candidate);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) return candidate;
    } catch {
      // Ignore unsafe candidates and keep looking.
    }
  }
  return requested || 'index.html';
}

async function readUpload(req) {
  const parsed = await parseMultipart(req, { maxFileBytes: MAX_FILE_BYTES });
  const file = parsed.files.archive || parsed.files.sourceArchive;
  if (!file) {
    await parsed.cleanup();
    throw Object.assign(new Error('Missing archive file'), { status: 400, code: 40002 });
  }
  if (file.truncated) {
    await parsed.cleanup();
    throw Object.assign(new Error('Archive exceeds the size limit'), { status: 413, code: 41301 });
  }
  return { ...parsed, file };
}

async function installArchive(shareId, filePath) {
  const root = storage.shareDir(shareId);
  await storage.removeTree(root);
  const contentRoot = storage.contentDir(shareId);
  await storage.ensureDir(contentRoot);
  return storage.extractZip(filePath, contentRoot);
}

router.use(authMiddleware);

router.post('/', asyncRoute(async (req, res) => {
  const { fields, file, cleanup } = await readUpload(req);
  try {
    const sourceType = String(fields.sourceType || 'html_file');
    if (!SOURCE_TYPES.has(sourceType)) {
      return res.status(400).json({ code: 40001, message: 'Unsupported source type' });
    }
    const accessMode = ACCESS_MODES.has(String(fields.accessMode)) ? String(fields.accessMode) : 'code';
    const digest = await storage.sha256File(file.path);
    if (fields.sourceSha256 && fields.sourceSha256 !== digest) {
      return res.status(400).json({ code: 40003, message: 'Archive checksum mismatch' });
    }

    const shareId = `shr_${crypto.randomBytes(12).toString('hex')}`;
    await installArchive(shareId, file.path);

    const contentUpdatedAt = Math.floor(Date.now() / 1000);
    const now = contentUpdatedAt;
    const entryFile = pickEntryFile(storage.contentDir(shareId), fields.entryFile);
    const shareCode = accessMode === 'code' ? storage.randomShareCode() : '';

    getDb().prepare(`INSERT INTO html_shares
      (id, user_id, source_type, client_source_key, session_id, artifact_id, title, entry_file,
       access_mode, share_code, status, moderation_status, source_sha256, archive_bytes,
       content_version, content_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 'approved', ?, ?, 1, ?, ?, ?)`)
      .run(
        shareId, req.user.sub, sourceType, String(fields.clientSourceKey || '').slice(0, 200),
        String(fields.sessionId || '').slice(0, 200), String(fields.artifactId || '').slice(0, 200),
        String(fields.title || '').slice(0, 200), entryFile, accessMode, shareCode,
        digest, file.bytes || 0, contentUpdatedAt, now, now,
      );

    const row = getDb().prepare('SELECT * FROM html_shares WHERE id = ?').get(shareId);
    res.json({ code: 0, data: toSharePayload(req, row) });
  } finally {
    await cleanup();
  }
}));

router.put('/:shareId', asyncRoute(async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(req.params.shareId);
  if (!row || !isOwnerOrAdmin(req, row)) {
    return res.status(404).json({ code: 40401, message: 'Share not found' });
  }
  if (row.status === 'disabled' && row.disabled_source && row.disabled_source !== 'user') {
    return res.status(403).json({ code: 49002, message: 'Share is disabled and cannot be updated' });
  }

  const { fields, file, cleanup } = await readUpload(req);
  try {
    const digest = await storage.sha256File(file.path);
    if (fields.sourceSha256 && fields.sourceSha256 !== digest) {
      return res.status(400).json({ code: 40003, message: 'Archive checksum mismatch' });
    }
    await installArchive(row.id, file.path);

    const now = Math.floor(Date.now() / 1000);
    const entryFile = pickEntryFile(storage.contentDir(row.id), fields.entryFile || row.entry_file);
    db.prepare(`UPDATE html_shares SET title = ?, entry_file = ?, source_sha256 = ?, archive_bytes = ?,
      content_version = content_version + 1, content_updated_at = ?, updated_at = ? WHERE id = ?`)
      .run(
        String(fields.title || row.title).slice(0, 200), entryFile, digest, file.bytes || 0,
        now, now, row.id,
      );

    const updated = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(row.id);
    res.json({ code: 0, data: toSharePayload(req, updated) });
  } finally {
    await cleanup();
  }
}));

router.patch('/:shareId/status', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(req.params.shareId);
  if (!row || !isOwnerOrAdmin(req, row)) {
    return res.status(404).json({ code: 40401, message: 'Share not found' });
  }
  const status = String(req.body?.status || '');
  if (!CONFIGURABLE_STATUS.has(status)) {
    return res.status(400).json({ code: 40004, message: 'Status must be live or disabled' });
  }
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE html_shares SET status = ?, disabled_at = ?, disabled_reason = ?,
    disabled_source = ?, updated_at = ? WHERE id = ?`)
    .run(
      status,
      status === 'disabled' ? now : null,
      status === 'disabled' ? String(req.body?.reason || '').slice(0, 300) : null,
      status === 'disabled' ? 'user' : null,
      now, row.id,
    );
  const updated = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(row.id);
  res.json({ code: 0, data: toSharePayload(req, updated) });
});

router.put('/:shareId/access-mode', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(req.params.shareId);
  if (!row || !isOwnerOrAdmin(req, row)) {
    return res.status(404).json({ code: 40401, message: 'Share not found' });
  }
  const accessMode = String(req.body?.accessMode || '');
  if (!ACCESS_MODES.has(accessMode)) {
    return res.status(400).json({ code: 41310, message: 'Invalid access mode' });
  }
  const now = Math.floor(Date.now() / 1000);
  const shareCode = accessMode === 'code' ? (row.share_code || storage.randomShareCode()) : '';
  db.prepare('UPDATE html_shares SET access_mode = ?, share_code = ?, updated_at = ? WHERE id = ?')
    .run(accessMode, shareCode, now, row.id);
  const updated = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(row.id);
  res.json({ code: 0, data: toSharePayload(req, updated) });
});

router.get('/source', (req, res) => {
  const sourceType = String(req.query.sourceType || '');
  const clientSourceKey = String(req.query.clientSourceKey || '');
  if (!sourceType || !clientSourceKey) {
    return res.status(400).json({ code: 40005, message: 'sourceType and clientSourceKey are required' });
  }
  const includeDisabled = String(req.query.includeDisabled || '') === 'true';
  const row = getDb().prepare(`SELECT * FROM html_shares
    WHERE user_id = ? AND source_type = ? AND client_source_key = ?
    ${includeDisabled ? '' : "AND status = 'live'"}
    ORDER BY updated_at DESC LIMIT 1`).get(req.user.sub, sourceType, clientSourceKey);
  res.json({ code: 0, data: row ? toSharePayload(req, row) : null });
});

router.get('/my', (req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM html_shares WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200',
  ).all(req.user.sub);
  res.json({ code: 0, data: { items: rows.map((row) => toSharePayload(req, row)) } });
});

router.get('/:shareId/deployment', (req, res) => {
  const db = getDb();
  const share = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(req.params.shareId);
  if (!share || !isOwnerOrAdmin(req, share)) {
    return res.status(404).json({ code: 40401, message: 'Share not found' });
  }
  const deployment = db.prepare(
    'SELECT * FROM share_deployments WHERE share_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(share.id);
  if (!deployment) {
    return res.status(404).json({ code: 40402, message: 'Deployment not found' });
  }
  res.json({ code: 0, data: require('../services/shareDeploymentMapper').toDeploymentPayload(deployment) });
});

router.get('/:shareId', (req, res) => {
  const row = getDb().prepare('SELECT * FROM html_shares WHERE id = ?').get(req.params.shareId);
  if (!row || !isOwnerOrAdmin(req, row)) {
    return res.status(404).json({ code: 40401, message: 'Share not found' });
  }
  res.json({ code: 0, data: toSharePayload(req, row) });
});

module.exports = router;
