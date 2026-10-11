'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();
const readSecretConfig = (key) => {
  try {
    const row = getDb().prepare('SELECT value FROM system_config WHERE key = ?').get(key);
    if (row?.value) return row.value;
  } catch (_) {}
  return process.env[key] || '';
};

// ═══════════════════════════════════════════════════════════════════
// Public Client Config — read by the WULU desktop client at startup.
// Every value here is overridable from the admin dashboard
// (PUT /api/admin/config). The client falls back to its built-in
// defaults when a key is absent.
//
// Supported keys (admin-configurable):
//   RUNTIME_COMPUTER_USE_URL        — Computer Use runtime zip URL
//   RUNTIME_COMPUTER_USE_SHA256     — Computer Use runtime zip sha256
//   RUNTIME_COMPUTER_USE_SIZE       — Computer Use runtime zip size (bytes)
//   KIT_BUNDLE_COMPUTER_USE_URL     — Computer Use kit bundle URL
//   KIT_BUNDLE_COMPUTER_USE_SHA256  — Computer Use kit bundle sha256
//   KIT_BUNDLE_COMPUTER_USE_SIZE    — Computer Use kit bundle size (bytes)
//   KIT_ICON_COMPUTER_USE_URL       — Computer Use kit icon URL
//   SKIN_KIT_ICON_URL               — Skin pack kit icon URL
// ═══════════════════════════════════════════════════════════════════

const CONFIG_KEYS = [
  'RUNTIME_COMPUTER_USE_URL',
  'RUNTIME_COMPUTER_USE_SHA256',
  'RUNTIME_COMPUTER_USE_SIZE',
  'KIT_BUNDLE_COMPUTER_USE_URL',
  'KIT_BUNDLE_COMPUTER_USE_SHA256',
  'KIT_BUNDLE_COMPUTER_USE_SIZE',
  'KIT_ICON_COMPUTER_USE_URL',
  'SKIN_KIT_ICON_URL',
];

// GET /api/config — public, no auth
router.get('/', (_req, res) => {
  let config = {};
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM system_config').all();
    for (const row of rows) {
      if (CONFIG_KEYS.includes(row.key)) {
        config[row.key] = row.value;
      }
    }
  } catch (_err) {
    // DB unavailable; return empty config so clients keep their defaults.
  }
  res.json({ code: 0, data: { config } });
});

// Reports feature readiness without exposing provider URLs or credentials.
router.get('/features', (_req, res) => {
  const mediaBase = readSecretConfig('MEDIA_SERVICE_BASE_URL');
  const asrUrl = readSecretConfig('ASR_REALTIME_SESSION_URL');
  const asrKey = readSecretConfig('ASR_REALTIME_API_KEY');
  res.json({
    code: 0,
    data: {
      imageGeneration: { configured: Boolean(mediaBase) },
      videoGeneration: { configured: Boolean(mediaBase) },
      realtimeAsr: { configured: Boolean(asrUrl && asrKey) },
      speech: { configured: Boolean(readSecretConfig('NEWAPI_BASE_URL') && readSecretConfig('NEWAPI_API_KEY')) },
      transcription: { configured: Boolean(readSecretConfig('NEWAPI_BASE_URL') && readSecretConfig('NEWAPI_API_KEY')) },
    },
  });
});

module.exports = router;
