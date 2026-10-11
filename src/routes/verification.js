'use strict';

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { consumeVerificationCode } = require('../services/verification');

const router = express.Router();
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const CODE_TTL_SECONDS = 10 * 60;
const SEND_INTERVAL_SECONDS = 60;

function hashCode(email, code) {
  return crypto.createHash('sha256').update(`${email}:${code}:${process.env.JWT_SECRET || 'dev-secret'}`).digest('hex');
}

router.post('/send', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'This email is already registered' });
  }

  const now = Math.floor(Date.now() / 1000);
  const previous = db.prepare('SELECT created_at FROM email_verification_codes WHERE email = ?').get(email);
  if (previous && now - previous.created_at < SEND_INTERVAL_SECONDS) {
    return res.status(429).json({ error: 'Please wait before requesting another verification code' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`INSERT INTO email_verification_codes (email, code_hash, expires_at, attempts, created_at)
    VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`)
    .run(email, hashCode(email, code), now + CODE_TTL_SECONDS, now);

  if (process.env.NODE_ENV !== 'production' && process.env.VERIFICATION_CODE_RETURN === '1') {
    return res.json({ success: true, expiresIn: CODE_TTL_SECONDS, code });
  }

  const { sendVerificationEmail } = require('../services/email');
  sendVerificationEmail(email, code).then(() => {
    res.json({ success: true, expiresIn: CODE_TTL_SECONDS });
  }).catch((err) => {
    console.error('[Auth] verification email delivery failed:', err.message);
    db.prepare('DELETE FROM email_verification_codes WHERE email = ?').run(email);
    if (!res.headersSent) res.status(503).json({ error: 'Could not send verification email. Please try again later.' });
  });
});


module.exports = router;
