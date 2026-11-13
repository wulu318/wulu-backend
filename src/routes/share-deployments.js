'use strict';

// Service deployments (node services and static sites).
// Static sites are extracted and served from /s/<shareId>/ like other shares.
// Node services need a process runtime; when none is configured they are recorded
// and marked deploy_failed with a machine-readable code instead of hanging.
const express = require('express');
const crypto = require('crypto');

const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { parseMultipart, MAX_FILE_BYTES } = require('../services/multipart');
const storage = require('../services/shareStorage');
const { toDeploymentPayload } = require('../services/shareDeploymentMapper');

const router = express.Router();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const DEPLOYMENT_KINDS = new Set(['node_service', 'static_site']);

function nodeRunnerEnabled() {
  return String(process.env.SHARE_NODE_RUNNER || 'none').toLowerCase() !== 'none';
}

function recordEvent(db, deploymentId, type, message) {
  db.prepare('INSERT INTO share_deployment_events (deployment_id, type, message, created_at) VALUES (?, ?, ?, ?)')
    .run(deploymentId, type, String(message || '').slice(0, 500), Math.floor(Date.now() / 1000));
}

function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || process.env.SERVER_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

function parseManifest(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function createDeployment(req, res, forcedKind) {
  const parsed = await parseMultipart(req, { maxFileBytes: MAX_FILE_BYTES });
  const { fields, files, cleanup } = parsed;
  try {
    const archive = files.sourceArchive || files.archive;
    if (!archive) {
      return res.status(400).json({ code: 40002, message: 'Missing source archive' });
    }
    if (archive.truncated) {
      return res.status(413).json({ code: 41301, message: 'Source archive exceeds the size limit' });
    }

    const manifest = parseManifest(fields.manifest);
    const kind = forcedKind || (manifest.deploymentKind === 'static_site' ? 'static_site' : 'node_service');
    if (!DEPLOYMENT_KINDS.has(kind)) {
      return res.status(400).json({ code: 40006, message: 'Unsupported deployment kind' });
    }

    const digest = await storage.sha256File(archive.path);
    if (fields.sourceSha256 && fields.sourceSha256 !== digest) {
      return res.status(400).json({ code: 40003, message: 'Archive checksum mismatch' });
    }

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const shareId = `shr_${crypto.randomBytes(12).toString('hex')}`;
    const deploymentId = `dep_${crypto.randomBytes(12).toString('hex')}`;
    const accessMode = fields.accessMode === 'public' ? 'public' : 'code';
    const shareCode = accessMode === 'code' ? storage.randomShareCode() : '';

    await storage.ensureDir(storage.contentDir(shareId));
    await storage.extractZip(archive.path, storage.contentDir(shareId));

    const entryFile = String(
      manifest.entryFile || fields.entryFile || (kind === 'static_site' ? 'index.html' : ''),
    );
    const sourceType = kind === 'static_site' ? 'static_service_deployment' : 'node_service_deployment';
    const isStatic = kind === 'static_site';

    // A share row always exists so the public URL and source lookups work.
    db.prepare(`INSERT INTO html_shares
      (id, user_id, source_type, client_source_key, session_id, artifact_id, title, entry_file,
       access_mode, share_code, status, moderation_status, source_sha256, archive_bytes,
       content_version, content_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, 1, ?, ?, ?)`)
      .run(
        shareId, req.user.sub, sourceType,
        String(fields.clientSourceKey || '').slice(0, 200),
        String(fields.sessionId || '').slice(0, 200),
        String(fields.artifactId || '').slice(0, 200),
        String(fields.title || '').slice(0, 200),
        entryFile, accessMode, shareCode,
        isStatic ? 'live' : 'failed',
        digest, archive.bytes || 0, now, now, now,
      );

    const failureCode = isStatic || nodeRunnerEnabled() ? null : 'runtime_unavailable';
    const failureMessage = failureCode
      ? 'Node service hosting is not enabled on this server. Static sites and artifact shares work; enable SHARE_NODE_RUNNER to host node services.'
      : null;

    db.prepare(`INSERT INTO share_deployments
      (id, share_id, user_id, deployment_kind, runtime_language, runtime_version, package_manager,
       install_command, build_command, start_command, listen_port, status, failure_code, failure_message,
       provider, region, provider_resource_id, runtime_url_masked, persistence_json, expires_at,
       source_sha256, source_archive_bytes, manifest_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        deploymentId, shareId, req.user.sub, kind,
        isStatic ? 'static' : 'node',
        String(manifest.runtimeVersion || ''),
        String(manifest.packageManager || ''),
        String(manifest.installCommand || ''),
        String(manifest.buildCommand || ''),
        isStatic ? '' : String(manifest.startCommand || ''),
        isStatic ? 0 : Number(manifest.listenPort) || 0,
        isStatic ? 'live' : (failureCode ? 'deploy_failed' : 'queued'),
        failureCode, failureMessage,
        isStatic ? 'wulu-static' : 'wulu-node',
        '',
        '',
        `${publicBaseUrl(req)}/s/${shareId}/`,
        JSON.stringify(null),
        null,
        digest, archive.bytes || 0,
        JSON.stringify(manifest).slice(0, 20000),
        now, now,
      );

    recordEvent(db, deploymentId, 'created', `${kind} deployment created`);
    if (failureCode) recordEvent(db, deploymentId, 'failed', failureMessage);

    const row = db.prepare('SELECT * FROM share_deployments WHERE id = ?').get(deploymentId);
    const events = db.prepare('SELECT * FROM share_deployment_events WHERE deployment_id = ? ORDER BY id').all(deploymentId);
    const payload = toDeploymentPayload(row, events);
    payload.url = `${publicBaseUrl(req)}/s/${encodeURIComponent(shareId)}/`;
    payload.shareId = shareId;
    payload.accessMode = accessMode;
    payload.shareCode = shareCode || undefined;
    payload.shareCodeUnavailable = accessMode !== 'code';
    payload.status = isStatic ? 'live' : 'failed';
    res.json({ code: 0, data: payload });
  } finally {
    await cleanup();
  }
}

router.use(authMiddleware);

router.post('/node', asyncRoute((req, res) => createDeployment(req, res, 'node_service')));
router.post('/static', asyncRoute((req, res) => createDeployment(req, res, 'static_site')));

router.get('/:deploymentId', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM share_deployments WHERE id = ?').get(req.params.deploymentId);
  if (!row || (row.user_id !== req.user.sub && !['admin', 'superadmin'].includes(req.user.role))) {
    return res.status(404).json({ code: 40402, message: 'Deployment not found' });
  }
  const events = db.prepare('SELECT * FROM share_deployment_events WHERE deployment_id = ? ORDER BY id').all(row.id);
  const payload = toDeploymentPayload(row, events);
  payload.url = `${publicBaseUrl(req)}/s/${encodeURIComponent(row.share_id)}/`;
  payload.status = row.status === 'live' ? 'live' : (row.status === 'deploy_failed' ? 'failed' : row.status);
  res.json({ code: 0, data: payload });
});

router.get('/:deploymentId/persistence', (req, res) => {
  // No persistent volume is attached to deployments on this host.
  res.json({ code: 0, data: null });
});

router.get('/:deploymentId/persistence/archive', (req, res) => {
  // 204 tells the client there is no cloud data to download.
  res.status(204).end();
});

module.exports = router;
