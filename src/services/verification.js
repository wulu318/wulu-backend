'use strict';

const crypto = require('crypto');
const { getDb } = require('../db/database');

function hashCode(email, code) {
  return crypto.createHash('sha256').update(`${email}:${code}:${process.env.JWT_SECRET || 'dev-secret'}`).digest('hex');
}

function consumeVerificationCode(email, code) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM email_verification_codes WHERE email = ?').get(email);
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_at < now || row.attempts >= 5 || !/^\d{6}$/.test(code)) {
    if (row && (row.expires_at < now || row.attempts >= 5)) db.prepare('DELETE FROM email_verification_codes WHERE email = ?').run(email);
    return false;
  }
  const actual = Buffer.from(hashCode(email, code), 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    db.prepare('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    return false;
  }
  db.prepare('DELETE FROM email_verification_codes WHERE email = ?').run(email);
  return true;
}

module.exports = { consumeVerificationCode };
