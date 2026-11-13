'use strict';

// Media generation is priced in quota units (the same "points" the client shows).
// Costs are admin-editable through system_config so pricing can change without a deploy.
const { getDb } = require('../db/database');
const { chargeQuota } = require('./billing');

const DEFAULT_COSTS = {
  image_generation: 20,
  video_generation: 100,
  realtime_asr: 5,
  speech: 1,
  transcription: 1,
};

function readCosts() {
  try {
    const row = getDb().prepare("SELECT value FROM system_config WHERE key = 'MEDIA_CREDIT_COSTS'").get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') {
        const merged = { ...DEFAULT_COSTS };
        for (const key of Object.keys(DEFAULT_COSTS)) {
          const value = Number(parsed[key]);
          if (Number.isFinite(value) && value >= 0) merged[key] = value;
        }
        return merged;
      }
    }
  } catch {
    // Fall back to defaults on a broken config row.
  }
  return DEFAULT_COSTS;
}

function costFor(action) {
  return readCosts()[action] ?? 0;
}

/**
 * Charge one media operation. Returns the amount charged (0 when the action is free).
 * A charge of 0 is still recorded so usage stays auditable.
 */
function chargeMediaAction(db, userId, action) {
  const cost = costFor(action);
  const charged = cost > 0 ? chargeQuota(db, userId, cost) : 0;
  db.prepare(`INSERT INTO usage_logs
    (user_id, model, prompt_tokens, completion_tokens, total_tokens, request_type, latency_ms, is_stream, charged_tokens)
    VALUES (?, ?, 0, 0, 0, ?, 0, 0, ?)`)
    .run(userId, action, action, charged);
  return { cost, charged, shortfall: cost - charged };
}

module.exports = { DEFAULT_COSTS, readCosts, costFor, chargeMediaAction };
