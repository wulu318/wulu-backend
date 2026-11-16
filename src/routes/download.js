'use strict';

// Public download catalog. The download page renders from this instead of hard-coding
// links, so it can never point at a version or platform that does not exist.
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

const REPO = 'https://github.com/wulu318/wulu-superagent';

function readConfig(key) {
  try {
    const row = getDb().prepare('SELECT value FROM system_config WHERE key = ?').get(key);
    if (row?.value) return row.value;
  } catch {
    // Ignore: config is optional.
  }
  return process.env[key] || '';
}

function platform(url, size, label) {
  const value = String(url || '').trim();
  return {
    available: Boolean(value),
    url: value || null,
    size: Number(size) || 0,
    label,
  };
}

router.get('/latest', (_req, res) => {
  let row = null;
  try {
    row = getDb().prepare(
      'SELECT * FROM update_versions WHERE is_latest = 1 AND is_active = 1 ORDER BY version DESC LIMIT 1',
    ).get();
  } catch {
    row = null;
  }

  if (!row) {
    return res.json({ code: 0, data: { version: null, platforms: {}, contact: contactInfo() } });
  }

  res.json({
    code: 0,
    data: {
      version: row.version,
      date: row.date || null,
      platforms: {
        windowsX64: platform(row.windows_x64_url, row.windows_x64_size, 'Windows 10/11 64-bit'),
        windowsArm64: platform(row.windows_arm64_url, row.windows_arm64_size, 'Windows on ARM'),
        macArm: platform(row.mac_arm_url, row.mac_arm_size, 'Apple Silicon (M1/M2/M3/M4)'),
        macIntel: platform(row.mac_intel_url, row.mac_intel_size, 'Intel Mac'),
        linuxX64: platform(row.linux_x64_url, row.linux_x64_size, 'Linux x64'),
        linuxArm64: platform(row.linux_arm64_url, row.linux_arm64_size, 'Linux ARM64'),
      },
      contact: contactInfo(),
    },
  });
});

function contactInfo() {
  const email = String(readConfig('CONTACT_EMAIL') || '').trim();
  return {
    email: email || null,
    issuesUrl: `${REPO}/issues`,
    releasesUrl: `${REPO}/releases`,
  };
}

module.exports = router;
