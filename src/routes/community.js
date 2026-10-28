'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { Kind, Status, normalizeSubmission } = require('../services/community');
const { inspectArchive } = require('../services/communityArchive');
const { normalizeSkillArchive } = require('../services/communityPackage');
const router = express.Router();
const uploadRoot = () => process.env.COMMUNITY_UPLOAD_DIR || path.resolve(path.dirname(process.env.DATABASE_PATH || './data/wulu.db'), 'community-uploads');
const uploadPath = id => path.join(uploadRoot(), `${id}.zip`);
const validId = id => /^[a-f0-9-]{36}$/.test(id);
const now = () => Math.floor(Date.now() / 1000);

function activeUser(req, res, next) {
  const user = getDb().prepare('SELECT id, role FROM users WHERE id = ? AND is_active = 1').get(req.user.sub);
  if (!user) return res.status(403).json({ error: 'Account unavailable' });
  req.account = user;
  next();
}
function reviewer(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.account.role)) return res.status(403).json({ error: 'Reviewer access required' });
  next();
}
const auth = [authMiddleware, activeUser];
const uploadLimit = rateLimit({ windowMs: 3600000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.get('/capabilities', (_req, res) => res.json({ available: true, kinds: Object.values(Kind), reviewRequired: true }));

router.post('/uploads', ...auth, uploadLimit, async (req, res) => {
  if (!req.is('application/zip') && !req.is('application/octet-stream')) return res.status(415).json({ error: 'Upload a ZIP file' });
  const id = crypto.randomUUID();
  const used = getDb().prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM community_uploads WHERE owner_id = ?').get(req.account.id).bytes;
  if (used >= 200 * 1024 * 1024) return res.status(413).json({ error: 'Creator upload quota reached (200 MiB). Contact an administrator.' });
  const target = uploadPath(id);
  fs.mkdirSync(uploadRoot(), { recursive: true, mode: 0o700 });
  let size = 0;
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) return callback(new Error('Upload must be below 20 MiB'));
      hash.update(chunk); callback(null, chunk);
    } }), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    const inspection = await inspectArchive(target);
    if (!inspection.files.some(f => /(^|\/)SKILL\.md$/.test(f.name))) throw new Error('Bundle must contain SKILL.md');
    getDb().prepare('INSERT INTO community_uploads VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.account.id, hash.digest('hex'), size, JSON.stringify(inspection), now());
    res.status(201).json({ id, size, inspection });
  } catch (error) {
    fs.rmSync(target, { force: true });
    if (!res.destroyed) res.status(400).json({ error: error.message });
  }
});

function validateUpload(kind, uploadId, ownerId, payload) {
  if (kind === Kind.Connector) return null;
  if (!validId(uploadId || '')) throw new Error('Upload a skill ZIP first');
  const upload = getDb().prepare('SELECT * FROM community_uploads WHERE id = ? AND owner_id = ?').get(uploadId, ownerId);
  if (!upload || !fs.existsSync(uploadPath(uploadId))) throw new Error('Bundle not found');
  if (kind === Kind.Skill && JSON.parse(upload.inspection).files.filter(file => /(^|\/)SKILL\.md$/.test(file.name)).length !== 1) throw new Error('Submit one SKILL.md per skill; use an expert kit for multiple skills');
  if (kind === Kind.Expert) {
    const { files } = JSON.parse(upload.inspection);
    const paths = new Set(files.map(file => file.name));
    const topDirectories = [...new Set(files.filter(file => file.name.includes('/')).map(file => file.name.split('/')[0]))];
    const sourceRoot = topDirectories.length === 1 ? `${topDirectories[0]}/` : '';
    let available = [];
    if (paths.has(`${sourceRoot}SKILL.md`)) available = [sourceRoot.slice(0, -1)];
    else {
      for (const prefix of [`${sourceRoot}skills/`, `${sourceRoot}SKILLs/`, sourceRoot]) {
        available = files.map(file => file.name.startsWith(prefix) ? file.name.slice(prefix.length) : '')
          .filter(name => /^[^/]+\/SKILL\.md$/.test(name)).map(name => name.split('/')[0]);
        if (available.length) break;
      }
    }
    if (!available.length || available.length !== payload.skills.length) throw new Error('Bundle layout must match the complete expert skill list');
    for (const skill of payload.skills) {
      if (!available.includes(skill.id)) throw new Error(`Missing ${skill.id}/SKILL.md in bundle`);
    }
  }
  return uploadId;
}

router.get('/mine', ...auth, (req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM community_submissions WHERE owner_id = ? ORDER BY updated_at DESC').all(req.account.id)
    .map(row => ({ ...row, payload: JSON.parse(row.payload), published: !!row.published_payload })) });
});

router.post('/submissions', ...auth, (req, res) => {
  try {
    const payload = normalizeSubmission(req.body);
    const uploadId = validateUpload(req.body.kind, req.body.uploadId, req.account.id, payload);
    const id = crypto.randomUUID();
    getDb().prepare(`INSERT INTO community_submissions (id, owner_id, kind, payload, upload_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.account.id, req.body.kind, JSON.stringify(payload), uploadId, Status.Pending, now(), now());
    res.status(201).json({ id, status: Status.Pending, revision: 1 });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.put('/submissions/:id', ...auth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM community_submissions WHERE id = ? AND owner_id = ?').get(req.params.id, req.account.id);
  if (!row) return res.status(404).json({ error: 'Submission not found' });
  if (req.body.revision !== row.revision) return res.status(409).json({ error: 'Submission changed. Refresh before editing.' });
  try {
    if (req.body.kind !== row.kind) throw new Error('Content type cannot change');
    const payload = normalizeSubmission(req.body);
    if (row.published_payload && JSON.parse(row.published_payload).version === payload.version) throw new Error('Increase the version before updating published content');
    const uploadId = validateUpload(row.kind, req.body.uploadId, req.account.id, payload);
    const result = db.prepare(`UPDATE community_submissions SET payload = ?, upload_id = ?, revision = revision + 1,
      status = ?, review_note = '', updated_at = ? WHERE id = ? AND revision = ?`)
      .run(JSON.stringify(payload), uploadId, Status.Pending, now(), row.id, row.revision);
    if (!result.changes) return res.status(409).json({ error: 'Submission changed' });
    res.json({ id: row.id, revision: row.revision + 1, status: Status.Pending });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/review', ...auth, reviewer, (req, res) => {
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const status = Object.values(Status).includes(req.query.status) ? req.query.status : '';
  const where = status ? 'WHERE s.status = ?' : '';
  const args = status ? [status] : [];
  const total = getDb().prepare(`SELECT COUNT(*) AS count FROM community_submissions s ${where}`).get(...args).count;
  const rows = getDb().prepare(`SELECT s.*, u.email AS author_email, a.inspection FROM community_submissions s
    JOIN users u ON u.id = s.owner_id LEFT JOIN community_uploads a ON a.id = s.upload_id
    ${where} ORDER BY CASE WHEN s.status = 'pending' THEN 0 ELSE 1 END, s.updated_at DESC LIMIT 20 OFFSET ?`).all(...args, (page - 1) * 20);
  res.json({ page, total, items: rows.map(row => ({ ...row, payload: JSON.parse(row.payload), inspection: JSON.parse(row.inspection || 'null'), published: !!row.published_payload })) });
});

router.get('/review/uploads/:id', ...auth, reviewer, (req, res) => {
  if (!validId(req.params.id)) return res.sendStatus(404);
  const row = getDb().prepare('SELECT id FROM community_uploads WHERE id = ?').get(req.params.id);
  if (!row) return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.download(uploadPath(row.id), `review-${row.id}.zip`);
});

router.get('/submissions/:id/history', ...auth, (req, res) => {
  const row = getDb().prepare('SELECT owner_id FROM community_submissions WHERE id = ?').get(req.params.id);
  if (!row || (row.owner_id !== req.account.id && !['admin', 'superadmin'].includes(req.account.role))) return res.sendStatus(404);
  res.json({ reviews: getDb().prepare('SELECT revision, decision, note, created_at FROM community_reviews WHERE submission_id = ? ORDER BY id DESC').all(req.params.id) });
});

router.delete('/submissions/:id', ...auth, (req, res) => {
  const result = getDb().prepare(`UPDATE community_submissions SET status = ?, published_payload = NULL,
    published_upload_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ?`)
    .run(Status.Withdrawn, now(), req.params.id, req.account.id);
  if (!result.changes) return res.sendStatus(404);
  res.json({ success: true });
});

router.post('/review/:id', ...auth, reviewer, async (req, res) => {
  const { decision, note, revision } = req.body;
  if (!['approve', 'reject', 'unpublish'].includes(decision) || typeof note !== 'string' || !note.trim() || note.length > 2000) {
    return res.status(400).json({ error: 'A decision and review reason are required' });
  }
  let normalized = null;
  let normalizedId = null;
  try {
    const candidate = getDb().prepare('SELECT * FROM community_submissions WHERE id = ?').get(req.params.id);
    if (candidate && candidate.owner_id !== req.account.id && candidate.revision === revision
      && candidate.status === Status.Pending && decision === 'approve' && candidate.kind === Kind.Skill) {
      const id = crypto.randomUUID();
      normalizedId = id;
      normalized = { id, ...await normalizeSkillArchive(uploadPath(candidate.upload_id), uploadPath(id), `community-${candidate.id}`, JSON.parse(candidate.payload)) };
    }
    getDb().transaction(() => {
      const db = getDb();
      const row = db.prepare('SELECT * FROM community_submissions WHERE id = ?').get(req.params.id);
      if (!row) throw Object.assign(new Error('Submission not found'), { status: 404 });
      if (row.owner_id === req.account.id) throw Object.assign(new Error('Another reviewer must review your submission'), { status: 403 });
      if (revision !== row.revision || (decision !== 'unpublish' && row.status !== Status.Pending)) throw Object.assign(new Error('Review is stale. Refresh the queue.'), { status: 409 });
      if (decision === 'approve') validateUpload(row.kind, row.upload_id, row.owner_id, JSON.parse(row.payload));
      if (normalized) db.prepare('INSERT INTO community_uploads VALUES (?, ?, ?, ?, ?, ?)')
        .run(normalized.id, row.owner_id, normalized.sha256, normalized.size, JSON.stringify(normalized.inspection), now());
      const status = decision === 'approve' ? Status.Approved : decision === 'reject' ? Status.Rejected : Status.Withdrawn;
      db.prepare(`UPDATE community_submissions SET status = ?, review_note = ?, updated_at = ?, published_payload = ?, published_upload_id = ? WHERE id = ?`)
        .run(status, note.trim(), now(), decision === 'approve' ? row.payload : decision === 'unpublish' ? null : row.published_payload,
          decision === 'approve' ? normalized?.id || row.upload_id : decision === 'unpublish' ? null : row.published_upload_id, row.id);
      db.prepare('INSERT INTO community_reviews (submission_id, revision, reviewer_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, revision, req.account.id, decision, note.trim(), now());
    })();
    res.json({ success: true });
  } catch (error) {
    if (normalizedId) fs.rmSync(uploadPath(normalizedId), { force: true });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get('/assets/:id', (req, res) => {
  const id = req.params.id.replace(/\.zip$/, '');
  if (!validId(id)) return res.sendStatus(404);
  const row = getDb().prepare(`SELECT a.* FROM community_uploads a JOIN community_submissions s ON a.id = s.published_upload_id
    JOIN users u ON u.id = s.owner_id WHERE a.id = ? AND s.published_payload IS NOT NULL AND u.is_active = 1`).get(id);
  if (!row) return res.sendStatus(404);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-cache');
  res.download(uploadPath(row.id), `${row.id}.zip`);
});
module.exports = router;
