'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

// GitHub releases API for wulu-superagent
const GITHUB_REPO = 'wulu318/wulu-superagent';
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

// ─── GET /api/update/check ──────────────────────────────────────
router.get('/check', async (_req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': 'WULU-SuperAgent-UpdateCheck' },
    });

    if (!response.ok) {
      return res.json({ updateFound: false, error: 'Failed to check updates' });
    }

    const releases = await response.json();
    if (!releases || !releases.length) {
      return res.json({ updateFound: false });
    }

    const latest = releases[0];
    const version = latest.tag_name?.replace(/^v/, '') || latest.name || '';
    const assets = (latest.assets || []).map(a => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    }));

    res.json({
      updateFound: true,
      version,
      releaseNotes: latest.body || '',
      publishedAt: latest.published_at,
      downloadUrl: latest.html_url,
      assets,
    });
  } catch (err) {
    console.error('[Update] Check error:', err.message);
    res.json({ updateFound: false, error: err.message });
  }
});

// ─── GET /api/update/check-manual ──────────────────────────────
router.get('/check-manual', async (_req, res) => {
  // Same as /check but returns more detail for manual checks
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': 'WULU-SuperAgent-UpdateCheck' },
    });

    if (!response.ok) {
      return res.json({ updateFound: false, error: 'Failed to check updates' });
    }

    const releases = await response.json();
    if (!releases || !releases.length) {
      return res.json({ updateFound: false });
    }

    const latest = releases[0];
    const version = latest.tag_name?.replace(/^v/, '') || latest.name || '';
    const assets = (latest.assets || []).map(a => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    }));

    // Platform-specific download URLs
    const windowsX64 = assets.find(a => a.name.includes('win') && a.name.endsWith('.exe'))?.url;
    const macArm = assets.find(a => a.name.includes('mac') && (a.name.includes('arm') || a.name.includes('darwin-arm')))?.url;
    const macIntel = assets.find(a => a.name.includes('mac') && !a.name.includes('arm') && !a.name.includes('darwin-arm'))?.url;

    res.json({
      updateFound: true,
      version,
      releaseNotes: latest.body || '',
      publishedAt: latest.published_at,
      downloadUrl: latest.html_url,
      windowsX64,
      macArm,
      macIntel,
      assets,
    });
  } catch (err) {
    console.error('[Update] Manual check error:', err.message);
    res.json({ updateFound: false, error: err.message });
  }
});

module.exports = router;
