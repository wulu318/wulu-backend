'use strict';

const express = require('express');
const { URL } = require('url');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const readConfig = (key) => {
  try {
    const row = getDb().prepare('SELECT value FROM system_config WHERE key = ?').get(key);
    if (row?.value) return row.value;
  } catch (_) {}
  return process.env[key] || '';
};

const readUrlConfig = (key, allowPath = true) => {
  const value = readConfig(key);
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!allowPath && (url.pathname !== '/' || url.search || url.hash)) return '';
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return '';
    return value;
  } catch (_) {
    return '';
  }
};

const mediaConfig = () => ({
  baseUrl: readUrlConfig('MEDIA_SERVICE_BASE_URL', false).replace(/\/+$/, ''),
  apiKey: readConfig('MEDIA_SERVICE_API_KEY'),
});

const asrConfig = () => ({
  sessionUrl: readUrlConfig('ASR_REALTIME_SESSION_URL'),
  apiKey: readConfig('ASR_REALTIME_API_KEY'),
});

router.get('/status', asyncRoute((_req, res) => {
  const media = mediaConfig();
  const asr = asrConfig();
  const newApiBase = readUrlConfig('NEWAPI_BASE_URL', false);
  const newApiKey = readConfig('NEWAPI_API_KEY');
  res.json({
    code: 0,
    data: {
      image: { configured: Boolean(media.baseUrl), missing: media.baseUrl ? [] : ['MEDIA_SERVICE_BASE_URL'] },
      video: { configured: Boolean(media.baseUrl), missing: media.baseUrl ? [] : ['MEDIA_SERVICE_BASE_URL'] },
      realtimeAsr: {
        configured: Boolean(asr.sessionUrl && asr.apiKey),
        missing: [!asr.sessionUrl && 'ASR_REALTIME_SESSION_URL', !asr.apiKey && 'ASR_REALTIME_API_KEY'].filter(Boolean),
      },
      speech: { configured: Boolean(newApiBase && newApiKey), missing: [!newApiBase && 'NEWAPI_BASE_URL', !newApiKey && 'NEWAPI_API_KEY'].filter(Boolean) },
      transcription: { configured: Boolean(newApiBase && newApiKey), missing: [!newApiBase && 'NEWAPI_BASE_URL', !newApiKey && 'NEWAPI_API_KEY'].filter(Boolean) },
    },
  });
}));

const proxyMedia = async (req, res) => {
  const { baseUrl, apiKey } = mediaConfig();
  if (!baseUrl) {
    return res.status(503).json({ code: 50301, message: 'Media service is not configured. Set MEDIA_SERVICE_BASE_URL in backend system config.' });
  }
  let target;
  try {
    const configured = new URL(baseUrl);
    if (!['https:', 'http:'].includes(configured.protocol) || (configured.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(configured.hostname))) {
      return res.status(503).json({ code: 50303, message: 'Media service URL must use HTTPS, except for localhost development.' });
    }
    target = `${baseUrl}${req.originalUrl}`;
  } catch (_) {
    return res.status(503).json({ code: 50303, message: 'MEDIA_SERVICE_BASE_URL must be a valid HTTPS URL.' });
  }
  try {
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (req.method !== 'GET') headers['Content-Type'] = 'application/json';
    const response = await fetch(target, {
      method: req.method,
      headers,
      ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body || {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.send(body);
  } catch (error) {
    return res.status(502).json({ code: 50201, message: 'Failed to connect to media service', detail: error.message });
  }
};

router.get('/images/models', asyncRoute(proxyMedia));
router.get('/videos/models', asyncRoute(proxyMedia));
router.post('/images/generate', asyncRoute(proxyMedia));
router.post('/videos/generate', asyncRoute(proxyMedia));
router.get('/images/tasks/:taskId', asyncRoute(proxyMedia));
router.get('/videos/tasks/:taskId', asyncRoute(proxyMedia));
router.post('/videos/tasks/:taskId/cancel', asyncRoute(proxyMedia));

router.post('/realtime/sessions', asyncRoute(async (req, res) => {
  const { sessionUrl, apiKey } = asrConfig();
  if (!sessionUrl || !apiKey) {
    return res.status(503).json({ code: 50302, message: 'Realtime ASR is not configured. Set ASR_REALTIME_SESSION_URL and ASR_REALTIME_API_KEY in backend system config.' });
  }
  try {
    const configured = new URL(sessionUrl);
    if (!['https:', 'http:'].includes(configured.protocol) || (configured.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(configured.hostname))) {
      return res.status(503).json({ code: 50303, message: 'Realtime ASR session URL must use HTTPS, except for localhost development.' });
    }
  } catch (_) {
    return res.status(503).json({ code: 50303, message: 'ASR_REALTIME_SESSION_URL must be a valid HTTPS URL.' });
  }
  try {
    const user = getDb().prepare('SELECT is_active, quota_remaining FROM users WHERE id = ?').get(req.user.sub);
    if (!user?.is_active) return res.status(403).json({ code: 40301, message: 'Account inactive' });
    if (user.quota_remaining <= 0) return res.status(429).json({ code: 40204, message: 'Quota exhausted' });
  } catch (error) {
    return res.status(500).json({ code: 50001, message: 'Unable to verify account quota', detail: error.message });
  }
  try {
    const response = await fetch(sessionUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(req.body || {}).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.send(body);
  } catch (error) {
    return res.status(502).json({ code: 50202, message: 'Failed to connect to realtime ASR service', detail: error.message });
  }
}));

module.exports = router;
