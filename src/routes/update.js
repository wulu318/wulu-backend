'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Update — Version check for the WULU desktop client.
//
// Response shape matches the client's expectation:
//   { code: 0, data: { value: { version, date, changeLog: { ch, en },
//                               macIntel: {url}, macArm: {url}, windowsX64: {url},
//                               incremental: { url, size, sha256, baseVersion } } } }
//
// The version catalog is stored in the update_versions table (managed via
// the admin dashboard). When a client requests with ?version=CURRENT,
// the API returns an incremental patch URL when one is available for that
// base version, plus the full package URL as fallback.
// ═══════════════════════════════════════════════════════════════════

function compareVersions(a, b) {
  const aParts = String(a || '').split('.').map((p) => parseInt(p.match(/^\d+/)?.[0] || '0', 10));
  const bParts = String(b || '').split('.').map((p) => parseInt(p.match(/^\d+/)?.[0] || '0', 10));
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i += 1) {
    const left = aParts[i] ?? 0;
    const right = bParts[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function getLatestVersionRow() {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM update_versions WHERE is_active = 1 ORDER BY is_latest DESC, version DESC LIMIT 1`,
  ).get() || null;
}

function getVersionRow(version) {
  if (!version) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM update_versions WHERE version = ?').get(version) || null;
}

function buildValue(row, currentVersion) {
  const value = {
    version: row.version,
    date: row.date || '',
    changeLog: {
      ch: {
        title: row.title || `WULU ${row.version}`,
        content: (row.release_notes || '').split('\n').filter((l) => l.trim()),
      },
      en: {
        title: row.title || `WULU ${row.version}`,
        content: (row.release_notes || '').split('\n').filter((l) => l.trim()),
      },
    },
  };

  // Platform-specific full package URLs
  if (row.windows_x64_url) {
    value.windowsX64 = {
      url: row.windows_x64_url,
      size: row.windows_x64_size ? Number(row.windows_x64_size) : undefined,
      sha256: row.windows_x64_sha256 || undefined,
    };
  }
  if (row.mac_arm_url) {
    value.macArm = {
      url: row.mac_arm_url,
      size: row.mac_arm_size ? Number(row.mac_arm_size) : undefined,
      sha256: row.mac_arm_sha256 || undefined,
    };
  }
  if (row.mac_intel_url) {
    value.macIntel = {
      url: row.mac_intel_url,
      size: row.mac_intel_size ? Number(row.mac_intel_size) : undefined,
      sha256: row.mac_intel_sha256 || undefined,
    };
  }
  if (row.linux_x64_url) {
    value.linuxX64 = {
      url: row.linux_x64_url,
      size: row.linux_x64_size ? Number(row.linux_x64_size) : undefined,
      sha256: row.linux_x64_sha256 || undefined,
    };
  }
  if (row.linux_arm64_url) {
    value.linuxArm64 = {
      url: row.linux_arm64_url,
      size: row.linux_arm64_size ? Number(row.linux_arm64_size) : undefined,
      sha256: row.linux_arm64_sha256 || undefined,
    };
  }

  // Incremental patch — only when this release declares a base version that
  // matches the requesting client's current version.
  if (
    row.incremental_base_version
    && row.incremental_url
    && currentVersion
    && compareVersions(currentVersion, row.incremental_base_version) === 0
  ) {
    value.incremental = {
      baseVersion: row.incremental_base_version,
      url: row.incremental_url,
      size: row.incremental_size ? Number(row.incremental_size) : undefined,
      sha256: row.incremental_sha256 || undefined,
    };
  }

  return value;
}

// ─── GET /api/update/check ───────────────────────────────────────
router.get('/check', (req, res) => {
  try {
    const currentVersion = String(req.query.version || '').trim();
    const row = getLatestVersionRow();
    if (!row) {
      return res.json({ code: 0, data: { value: null } });
    }
    const value = buildValue(row, currentVersion);
    res.json({ code: 0, data: { value } });
  } catch (err) {
    console.error('[Update] check error:', err.message);
    res.json({ code: 500, error: err.message, data: { value: null } });
  }
});

// ─── GET /api/update/check-manual ────────────────────────────────
router.get('/check-manual', (req, res) => {
  try {
    const currentVersion = String(req.query.version || '').trim();
    const row = getLatestVersionRow();
    if (!row) {
      return res.json({ code: 0, data: { value: null } });
    }
    const value = buildValue(row, currentVersion);
    // Manual checks include the version catalog (multiple versions)
    const db = getDb();
    const versions = db.prepare(
      'SELECT version, title, date, is_latest, is_active FROM update_versions ORDER BY version DESC',
    ).all();
    res.json({ code: 0, data: { value, versions } });
  } catch (err) {
    console.error('[Update] manual check error:', err.message);
    res.json({ code: 500, error: err.message, data: { value: null } });
  }
});

module.exports = router;
