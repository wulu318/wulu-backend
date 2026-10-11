'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const NEWAPI_BASE = () => {
  // Priority: DB system_config > env var
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'NEWAPI_BASE_URL'").get();
    if (row && row.value) return row.value;
  } catch (_) {}
  return process.env.NEWAPI_BASE_URL || '';
};

const NEWAPI_KEY = () => {
  // Priority: DB system_config > env var
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'NEWAPI_API_KEY'").get();
    if (row && row.value) return row.value;
  } catch (_) {}
  return process.env.NEWAPI_API_KEY || '';
};

// Models that are proxied through this endpoint
const PROXY_PATHS = [
  '/chat/completions',
  '/completions',
  '/images/generations',
  '/embeddings',
  '/models',
  '/audio/speech',
  '/audio/transcriptions',
];

const MULTIPART_PATHS = new Set(['/audio/transcriptions']);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// ─── Universal proxy handler ─────────────────────────────────────
async function proxyRequest(req, res) {
  const basePath = NEWAPI_BASE();
  const apiKey = NEWAPI_KEY();
  if (!basePath) return res.status(503).json({ error: 'NewAPI not configured on backend' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user || !user.is_active) return res.status(403).json({ error: 'Account inactive' });

  // Check quota
  if (user.quota_remaining <= 0) {
    return res.status(429).json({ error: 'Quota exhausted. Please upgrade your plan.' });
  }

  // Check model access
  let reqModel = req.body?.model;
  if (reqModel && user.plan_id) {
    const plan = db.prepare('SELECT model_access FROM plans WHERE id = ?').get(user.plan_id);
    if (plan) {
      const allowed = JSON.parse(plan.model_access || '[]');
      // If allowed list is non-empty and model not in it
      if (allowed.length > 0 && !allowed.includes(reqModel) && !allowed.includes('*')) {
        return res.status(403).json({ error: `Model '${reqModel}' not available in your plan. Available: ${allowed.join(', ')}` });
      }
    }
  }

  const startTime = Date.now();
  const path = req.path; // e.g. /chat/completions
  const targetUrl = `${basePath}/v1${path}`;

  // Build request to NewAPI
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  // If user has their own NewAPI token, use that instead (per-user key)
  if (user.newapi_token) {
    headers['Authorization'] = `Bearer ${user.newapi_token}`;
  }

  const isStream = req.body?.stream === true;

  try {
    const fetch = (await import('node-fetch')).default;
    const isMultipart = MULTIPART_PATHS.has(path) && req.is('multipart/form-data');
    const upstreamHeaders = { ...headers };
    let upstreamBody;
    if (isMultipart) {
      const contentLength = Number(req.headers['content-length'] || 0);
      if (contentLength > MAX_AUDIO_BYTES + 2 * 1024 * 1024) {
        return res.status(413).json({ error: 'Audio upload exceeds the allowed size limit' });
      }
      const inputForm = await new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type'] },
        body: req,
        duplex: 'half',
      }).formData();
      reqModel = inputForm.get('model')?.toString();
      if (reqModel && user.plan_id) {
        const plan = db.prepare('SELECT model_access FROM plans WHERE id = ?').get(user.plan_id);
        const allowed = plan ? JSON.parse(plan.model_access || '[]') : [];
        if (allowed.length > 0 && !allowed.includes(reqModel) && !allowed.includes('*')) {
          return res.status(403).json({ error: `Model '${reqModel}' not available in your plan. Available: ${allowed.join(', ')}` });
        }
      }
      if (inputForm.get('stream')?.toString() === 'true') {
        return res.status(400).json({ error: 'Streaming audio transcription is not supported' });
      }
      const form = new FormData();
      for (const [key, value] of inputForm.entries()) {
        form.append(key, value);
      }
      const file = inputForm.get('file');
      if (!file) return res.status(400).json({ error: 'Audio file is required' });
      if (!(file instanceof Blob) || file.size === 0) return res.status(400).json({ error: 'Audio file is empty or invalid' });
      if (file.size > MAX_AUDIO_BYTES) return res.status(413).json({ error: 'Audio file exceeds the 25 MB limit' });
      upstreamBody = form;
      reqModel = inputForm.get('model')?.toString();
      delete upstreamHeaders['Content-Type'];
    } else {
      upstreamBody = JSON.stringify(req.body);
    }
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: upstreamBody,
    });
    const model = reqModel || 'unknown';

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(response.status).json({ error: 'Upstream error', detail: errorBody });
    }

    // Handle streaming response
    if (isStream && response.headers.get('content-type')?.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let totalContent = '';
      response.body.on('data', (chunk) => {
        const str = chunk.toString();
        totalContent += str;
        res.write(chunk);
      });

      response.body.on('end', () => {
        res.end();
        // Parse token usage from stream
        const usageMatch = totalContent.match(/"usage":\s*\{[^}]*"prompt_tokens":\s*(\d+)[^}]*"completion_tokens":\s*(\d+)[^}]*"total_tokens":\s*(\d+)/);
        if (usageMatch) {
          const pt = parseInt(usageMatch[1], 10);
          const ct = parseInt(usageMatch[2], 10);
          const tt = parseInt(usageMatch[3], 10);
          recordUsage(db, user.id, reqModel || 'unknown', pt, ct, tt, Date.now() - startTime, true, requestType(path));
        }
      });

      response.body.on('error', (err) => {
        console.error('[Proxy] Stream error:', err.message);
        res.end();
      });

      return;
    }

    // Non-streaming response
    const isBinaryAudio = path === '/audio/speech' && response.headers.get('content-type')?.startsWith('audio/');
    if (isBinaryAudio) {
      res.setHeader('Content-Type', response.headers.get('content-type'));
      const audio = Buffer.from(await response.arrayBuffer());
      res.send(audio);
      recordUsage(db, user.id, model, 0, 0, 0, Date.now() - startTime, false, requestType(path));
      return;
    }
    const data = await response.json();
    res.json(data);

    // Record usage
    const usage = data.usage;
    recordUsage(db, user.id, reqModel || data.model || 'unknown',
      usage?.prompt_tokens || 0, usage?.completion_tokens || 0, usage?.total_tokens || 0,
      Date.now() - startTime, false, requestType(path));
  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    res.status(502).json({ error: 'Failed to connect to model provider', detail: err.message });
  }
}

function requestType(path) {
  if (path === '/images/generations') return 'image_generation';
  if (path === '/audio/speech') return 'audio_speech';
  if (path === '/audio/transcriptions') return 'audio_transcription';
  if (path === '/embeddings') return 'embedding';
  if (path === '/completions') return 'completion';
  return 'chat';
}

function recordUsage(db, userId, model, promptTokens, completionTokens, totalTokens, latencyMs, isStream, type = 'chat') {
  // Log
  db.prepare(`INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, request_type, latency_ms, is_stream)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, model, promptTokens, completionTokens, totalTokens, type, latencyMs, isStream ? 1 : 0);

  // Deduct quota (use total_tokens)
  if (totalTokens > 0) {
    db.prepare('UPDATE users SET quota_remaining = MAX(0, quota_remaining - ?), updated_at = ? WHERE id = ?')
      .run(totalTokens, Math.floor(Date.now() / 1000), userId);
  }
}

// ─── Register proxy routes ───────────────────────────────────────
for (const p of PROXY_PATHS) {
  if (p === '/audio/transcriptions') {
    router.post(p, proxyRequest);
  } else {
    router.post(p, proxyRequest);
  }
  // GET for /models
  if (p === '/models') {
    router.get(p, proxyRequest);
  }
}

module.exports = router;
