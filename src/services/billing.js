'use strict';

// Quota accounting for model calls. Every proxied request must end in exactly one
// charge: a provider that omits `usage` (or a broken stream) cannot make a call free.

const BYTES_PER_TOKEN_ESTIMATE = 4;
const MIN_CHARGE_TOKENS = 1;

// Prefer the provider's reported usage. When it is missing, estimate from payload size
// so the charge is never zero for a request that actually ran.
function resolveChargeTokens({ totalTokens, promptTokens, completionTokens, requestBytes = 0, responseBytes = 0 }) {
  if (Number.isFinite(totalTokens) && totalTokens > 0) return Math.ceil(totalTokens);
  const reported = (Number(promptTokens) || 0) + (Number(completionTokens) || 0);
  if (reported > 0) return Math.ceil(reported);
  const estimated = Math.ceil((Math.max(0, requestBytes) + Math.max(0, responseBytes)) / BYTES_PER_TOKEN_ESTIMATE);
  return Math.max(MIN_CHARGE_TOKENS, estimated);
}

// Single conditional UPDATE: the balance can never go negative, and concurrent requests
// cannot both spend the same remaining quota. Returns the amount actually charged.
function chargeQuota(db, userId, tokens, nowSeconds = Math.floor(Date.now() / 1000)) {
  const row = db.prepare('SELECT quota_remaining FROM users WHERE id = ?').get(userId);
  if (!row) return 0;
  const charge = Math.min(Math.max(0, tokens), Math.max(0, row.quota_remaining));
  if (charge === 0) return 0;
  const result = db.prepare(
    'UPDATE users SET quota_remaining = quota_remaining - ?, updated_at = ? WHERE id = ? AND quota_remaining >= ?'
  ).run(charge, nowSeconds, userId, charge);
  return result.changes === 1 ? charge : 0;
}

module.exports = { resolveChargeTokens, chargeQuota, BYTES_PER_TOKEN_ESTIMATE, MIN_CHARGE_TOKENS };
