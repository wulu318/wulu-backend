'use strict';

const express = require('express');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Analytics — Receives client usage/analytics events (GET with query
// params, matching the legacy client reporter contract).
// Events are persisted to the analytics_events table so operators can
// inspect usage without sending data to any third party.
// ═══════════════════════════════════════════════════════════════════

// GET /api/analytics/events?action=...&app_version=...&...
router.get('/events', (req, res) => {
  const { getDb } = require('../db/database');
  const db = getDb();
  const params = req.query || {};
  const action = String(params.action || '').slice(0, 200);
  const appVersion = String(params.app_version || '').slice(0, 64);
  const osPlatform = String(params.os_platform || '').slice(0, 32);
  const osArch = String(params.os_arch || '').slice(0, 32);
  const language = String(params.language || '').slice(0, 16);
  const uuid = String(params.uuid || '').slice(0, 128);
  const userId = String(params.log_Usid || '').slice(0, 128);

  try {
    db.prepare(
      `INSERT INTO analytics_events (action, app_version, os_platform, os_arch, language, uuid, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      action,
      appVersion,
      osPlatform,
      osArch,
      language,
      uuid,
      userId,
      Date.now(),
    );
  } catch (err) {
    // Analytics must never break the client; best-effort only.
    console.warn('[Analytics] failed to store event:', err.message);
  }

  res.json({ code: 0 });
});

module.exports = router;
