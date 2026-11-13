'use strict';

// Credit campaigns. A campaign grants a fixed amount of credits once per user.
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Configured through system_config so campaigns can be changed without a deploy.
// Shape: { "<campaignCode>": { "credits": 500, "active": true, "endsAt": 0 } }
function readCampaigns() {
  const row = getDb().prepare("SELECT value FROM system_config WHERE key = 'CREDIT_CAMPAIGNS'").get();
  if (!row || !row.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

router.post('/free-credits/claim', authMiddleware, (req, res) => {
  const campaignCode = String(req.body?.campaignCode || '').trim();
  if (!campaignCode) return res.status(400).json({ code: 40001, message: 'Missing campaign code' });

  const campaign = readCampaigns()[campaignCode];
  if (!campaign || campaign.active !== true) {
    return res.status(404).json({ code: 40401, message: 'Campaign not available' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (campaign.endsAt && now > campaign.endsAt) {
    return res.status(410).json({ code: 41001, message: 'Campaign has ended' });
  }

  const credits = Math.max(0, parseInt(campaign.credits, 10) || 0);
  if (credits === 0) return res.status(409).json({ code: 40901, message: 'Campaign grants no credits' });

  const db = getDb();
  const already = db.prepare('SELECT credits, claimed_at FROM credit_claims WHERE user_id = ? AND campaign_code = ?')
    .get(req.user.sub, campaignCode);
  if (already) {
    return res.json({
      code: 0,
      data: { campaignCode, credits: already.credits, alreadyClaimed: true, claimedAt: already.claimed_at },
    });
  }

  // Claim and grant in one transaction so a retry can never double-credit.
  const grant = db.transaction(() => {
    db.prepare('INSERT INTO credit_claims (user_id, campaign_code, credits, claimed_at) VALUES (?, ?, ?, ?)')
      .run(req.user.sub, campaignCode, credits, now);
    db.prepare('UPDATE users SET quota_remaining = quota_remaining + ?, quota_total = quota_total + ?, updated_at = ? WHERE id = ?')
      .run(credits, credits, now, req.user.sub);
    return db.prepare('SELECT quota_remaining FROM users WHERE id = ?').get(req.user.sub).quota_remaining;
  });

  const remaining = grant();
  res.json({
    code: 0,
    data: { campaignCode, credits, alreadyClaimed: false, claimedAt: now, quotaRemaining: remaining },
  });
});

module.exports = router;
