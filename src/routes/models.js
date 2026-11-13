'use strict';

// Model catalog for the desktop client.
// The catalog is admin-editable through system_config (MODEL_CATALOG) so the client
// never depends on a hard-coded list. When it is empty we derive it from the plans'
// model_access so a fresh install still shows something usable.
const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const toTextModel = (raw) => {
  const modelId = String(raw.modelId || raw.id || '').trim();
  if (!modelId) return null;
  const model = {
    modelId,
    modelName: String(raw.modelName || raw.name || modelId),
    provider: String(raw.provider || 'wulu'),
    providerLabel: String(raw.providerLabel || raw.provider || 'WULU'),
    apiFormat: String(raw.apiFormat || 'openai'),
    supportsImage: Boolean(raw.supportsImage),
    supportsThinking: Boolean(raw.supportsThinking),
    explicitContextCache: Boolean(raw.explicitContextCache),
  };
  if (Number.isFinite(raw.contextWindow) && raw.contextWindow > 0) model.contextWindow = raw.contextWindow;
  if (Number.isFinite(raw.costMultiplier) && raw.costMultiplier > 0) model.costMultiplier = raw.costMultiplier;
  if (raw.description) model.description = String(raw.description);
  return model;
};

function readCatalog() {
  const row = getDb().prepare("SELECT value FROM system_config WHERE key = 'MODEL_CATALOG'").get();
  if (row && row.value) {
    try {
      const parsed = JSON.parse(row.value);
      const text = Array.isArray(parsed.textModels) ? parsed.textModels.map(toTextModel).filter(Boolean) : [];
      if (text.length > 0) {
        return {
          textModels: text,
          imageModels: Array.isArray(parsed.imageModels) ? parsed.imageModels : [],
          videoModels: Array.isArray(parsed.videoModels) ? parsed.videoModels : [],
        };
      }
    } catch {
      // Fall through to the plan-derived catalog rather than serving a broken payload.
    }
  }

  const ids = new Set();
  for (const plan of getDb().prepare('SELECT model_access FROM plans WHERE is_active = 1').all()) {
    try {
      for (const id of JSON.parse(plan.model_access || '[]')) {
        if (typeof id === 'string' && id && id !== '*') ids.add(id);
      }
    } catch {
      // Ignore a malformed plan row; other plans still contribute.
    }
  }
  return {
    textModels: [...ids].map((id) => toTextModel({ modelId: id })).filter(Boolean),
    imageModels: [],
    videoModels: [],
  };
}

router.get('/pricing-catalog', (_req, res) => {
  res.json({ code: 0, data: readCatalog() });
});

router.get('/available', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT plan_id FROM users WHERE id = ?').get(req.user.sub);
  const catalog = readCatalog();

  let allowed = null;
  if (user?.plan_id) {
    const plan = db.prepare('SELECT model_access FROM plans WHERE id = ?').get(user.plan_id);
    if (plan) {
      try {
        const list = JSON.parse(plan.model_access || '[]');
        allowed = Array.isArray(list) && list.length > 0 ? list : null;
      } catch {
        allowed = null;
      }
    }
  }

  const data = catalog.textModels.filter((model) => (
    !allowed || allowed.includes('*') || allowed.includes(model.modelId)
  ));
  res.json({ code: 0, data });
});

module.exports = router;
