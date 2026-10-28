'use strict';

const { getDb } = require('../db/database');
const Kind = Object.freeze({ Skill: 'skill', Connector: 'connector', Expert: 'expert' });
const Status = Object.freeze({ Pending: 'pending', Approved: 'approved', Rejected: 'rejected', Withdrawn: 'withdrawn' });

function initCommunity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS community_uploads (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, sha256 TEXT NOT NULL,
    size INTEGER NOT NULL, inspection TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS community_submissions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL, upload_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending', published_payload TEXT, published_upload_id TEXT,
    review_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS community_owner ON community_submissions(owner_id, updated_at);
  CREATE INDEX IF NOT EXISTS community_review ON community_submissions(status, updated_at);
  CREATE TABLE IF NOT EXISTS community_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL, revision INTEGER NOT NULL,
    reviewer_id TEXT NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL
  );`);
}

function text(value, name, max, required = false) {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${name} must be text`);
  const result = (value || '').trim();
  if ((required && !result) || result.length > max) throw new Error(`Invalid ${name}`);
  return result;
}

function normalizeSubmission(body) {
  if (!Object.values(Kind).includes(body.kind)) throw new Error('Invalid content type');
  const payload = {
    name: text(body.name, 'name', 80, true),
    description: text(body.description, 'description', 4000, true),
    version: text(body.version, 'version', 40, true),
    tags: Array.isArray(body.tags) ? body.tags.map(tag => text(tag, 'tag', 30, true)).slice(0, 12) : [],
    license: text(body.license, 'license', 80, true),
  };
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(payload.version)) throw new Error('Use a semantic version such as 1.0.0');
  if (body.kind === Kind.Connector) {
    const c = body.connector;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Connector configuration is required');
    if (!['stdio', 'sse', 'http'].includes(c.transportType)) throw new Error('Invalid connector transport');
    if (c.env || c.headers || c.apiKey || c.token) throw new Error('Do not publish credentials; use requiredEnvKeys');
    payload.connector = {
      transportType: c.transportType,
      category: ['search', 'browser', 'developer', 'productivity'].includes(c.category) ? c.category : 'productivity',
      requiredEnvKeys: Array.isArray(c.requiredEnvKeys) ? c.requiredEnvKeys.map(key => {
        if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(key)) throw new Error('Invalid environment key name');
        return key;
      }).slice(0, 20) : [],
    };
    if (c.transportType === 'stdio') {
      payload.connector.command = text(c.command, 'command', 100, true);
      if (!Array.isArray(c.defaultArgs) || c.defaultArgs.length > 40) throw new Error('Invalid connector arguments');
      payload.connector.defaultArgs = c.defaultArgs.map(arg => text(arg, 'argument', 500));
    } else {
      const url = new URL(text(c.url, 'URL', 1000, true));
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS URL without credentials or query parameters');
      payload.connector.url = url.href;
    }
  }
  if (body.kind === Kind.Expert) {
    if (!Array.isArray(body.skills) || !body.skills.length || body.skills.length > 30) throw new Error('Expert kits require a list of bundled skills');
    payload.skills = body.skills.map(skill => ({
      id: text(skill.id, 'skill ID', 80, true),
      name: text(skill.name, 'skill name', 80, true),
      description: text(skill.description, 'skill description', 1000),
    }));
    for (const skill of payload.skills) if (!/^[a-zA-Z0-9_-]+$/.test(skill.id)) throw new Error('Invalid bundled skill ID');
    if (new Set(payload.skills.map(skill => skill.id)).size !== payload.skills.length) throw new Error('Duplicate bundled skill IDs');
  }
  return payload;
}

function assetUrl(id) { return new URL(`/api/community/assets/${id}.zip`, process.env.SERVER_BASE_URL || 'https://ai.005656.xyz').href; }

function published(kind) {
  return getDb().prepare(`SELECT s.*, u.display_name AS author, a.sha256, a.size FROM community_submissions s
    JOIN users u ON s.owner_id = u.id LEFT JOIN community_uploads a ON a.id = s.published_upload_id
    WHERE s.kind = ? AND s.published_payload IS NOT NULL AND u.is_active = 1
    ORDER BY s.updated_at DESC`).all(kind).map(row => ({
      ...JSON.parse(row.published_payload), id: row.id, author: row.author || 'Community',
      bundleUrl: row.published_upload_id ? assetUrl(row.published_upload_id) : '',
      bundleSha256: row.sha256, bundleSize: row.size,
    }));
}

module.exports = { Kind, Status, initCommunity, normalizeSubmission, published };
