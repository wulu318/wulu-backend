'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

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

module.exports = router;
