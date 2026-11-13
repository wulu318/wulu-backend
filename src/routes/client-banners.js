'use strict';

// Sidebar banners for the desktop client. Public endpoints: the renderer fetches these
// with plain net.fetch, before or without an access token.
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();
const DEFAULT_PLACEMENT = 'desktop_sidebar';

const toBanner = (row) => ({
  id: row.id,
  placement: row.placement,
  activityDescription: row.activity_description,
  linkUrl: row.link_url,
  imageUrl: row.image_url,
  imageWidth: row.image_width || undefined,
  imageHeight: row.image_height || undefined,
  updatedAt: row.updated_at ? new Date(row.updated_at * 1000).toISOString() : undefined,
});

function listActive(placement, limit) {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT * FROM client_banners
    WHERE placement = ? AND is_active = 1
      AND (starts_at = 0 OR starts_at <= ?)
      AND (ends_at = 0 OR ends_at >= ?)
    ORDER BY sort_order ASC, id DESC
    LIMIT ?
  `).all(placement, now, now, limit).map(toBanner);
}

router.get('/active', (req, res) => {
  const placement = String(req.query.placement || DEFAULT_PLACEMENT);
  const banners = listActive(placement, 1);
  res.json({ code: 0, data: banners[0] || null });
});

router.get('/active-list', (req, res) => {
  const placement = String(req.query.placement || DEFAULT_PLACEMENT);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  res.json({ code: 0, data: listActive(placement, limit) });
});

module.exports = router;
