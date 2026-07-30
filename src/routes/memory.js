'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/entries', (req, res) => {
  const { layer, tag, limit = 50, offset = 0 } = req.query;
  const db = getDb();

  let sql = 'SELECT * FROM memory_entries WHERE user_id = ?';
  const params = [req.user.sub];

  if (layer) { sql += ' AND layer = ?'; params.push(layer); }
  if (tag) { sql += ' AND tags LIKE ?'; params.push(`%"${tag}"%`); }

  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const entries = db.prepare(sql).all(...params);
  res.json(entries.map(e => ({
    ...e,
    tags: JSON.parse(e.tags || '[]'),
    metadata: JSON.parse(e.metadata || '{}'),
  })));
});

router.post('/entries', (req, res) => {
  const { content, layer = 'working', tags = [], metadata = {} } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const db = getDb();
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO memory_entries (id, user_id, layer, content, tags, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.user.sub, layer, content, JSON.stringify(tags), JSON.stringify(metadata), now, now);

  res.status(201).json({ id, layer, tags, createdAt: now });
});

router.put('/entries/:id', (req, res) => {
  const { content, layer, tags, metadata } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM memory_entries WHERE id = ? AND user_id = ?').get(req.params.id, req.user.sub);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE memory_entries SET content = ?, layer = ?, tags = ?, metadata = ?, updated_at = ? WHERE id = ?`)
    .run(content || existing.content, layer || existing.layer, JSON.stringify(tags ?? JSON.parse(existing.tags || '[]')), JSON.stringify(metadata ?? JSON.parse(existing.metadata || '{}')), now, req.params.id);

  res.json({ success: true });
});

router.delete('/entries/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM memory_entries WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
  res.json({ success: true });
});

router.get('/tags', (req, res) => {
  const db = getDb();
  const entries = db.prepare('SELECT tags FROM memory_entries WHERE user_id = ?').all(req.user.sub);
  const tagSet = new Set();
  for (const e of entries) {
    try {
      const tags = JSON.parse(e.tags || '[]');
      tags.forEach(t => tagSet.add(t));
    } catch {}
  }

  const diaries = db.prepare('SELECT tags FROM diary_entries WHERE user_id = ?').all(req.user.sub);
  for (const d of diaries) {
    try {
      const tags = JSON.parse(d.tags || '[]');
      tags.forEach(t => tagSet.add(t));
    } catch {}
  }

  res.json({ tags: Array.from(tagSet) });
});

router.post('/search', (req, res) => {
  const { tags = [], depth = 2, limit = 20 } = req.body;
  if (!tags.length) return res.status(400).json({ error: 'At least one tag required' });

  const db = getDb();
  const allEntries = db.prepare('SELECT * FROM memory_entries WHERE user_id = ?').all(req.user.sub);
  const entries = allEntries.map(e => ({
    ...e,
    tags: JSON.parse(e.tags || '[]'),
    metadata: JSON.parse(e.metadata || '{}'),
  }));

  const tagIndex = new Map();
  for (const e of entries) {
    for (const t of e.tags) {
      if (!tagIndex.has(t)) tagIndex.set(t, []);
      tagIndex.get(t).push(e.id);
    }
  }

  const visited = new Set();
  const resultIds = new Set();
  const queue = [...tags];

  let currentDepth = 0;
  while (queue.length > 0 && currentDepth <= depth) {
    const currentTag = queue.shift();
    if (visited.has(currentTag)) continue;
    visited.add(currentTag);

    const associated = tagIndex.get(currentTag) || [];
    for (const id of associated) {
      resultIds.add(id);
      const entry = entries.find(e => e.id === id);
      if (entry) {
        for (const t of entry.tags) {
          if (!visited.has(t)) queue.push(t);
        }
      }
    }
    currentDepth++;
  }

  const results = entries.filter(e => resultIds.has(e.id)).slice(0, limit);
  res.json({ results, searchedTags: tags, depth });
});

router.get('/diary', (req, res) => {
  const { date, limit = 30 } = req.query;
  const db = getDb();

  let sql = 'SELECT * FROM diary_entries WHERE user_id = ?';
  const params = [req.user.sub];
  if (date) { sql += ' AND date = ?'; params.push(date); }
  sql += ' ORDER BY date DESC LIMIT ?';
  params.push(Number(limit));

  const entries = db.prepare(sql).all(...params);
  res.json(entries.map(e => ({ ...e, tags: JSON.parse(e.tags || '[]') })));
});

router.post('/diary', (req, res) => {
  const { date, title, content, tags = [], mood } = req.body;
  if (!date || !content) return res.status(400).json({ error: 'date and content required' });

  const db = getDb();
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO diary_entries (id, user_id, date, title, content, tags, mood, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.user.sub, date, title || '', content, JSON.stringify(tags), mood || '', now, now);

  if (tags.length > 0) {
    const memId = uuidv4();
    db.prepare(`INSERT INTO memory_entries (id, user_id, layer, content, tags, metadata, created_at, updated_at)
      VALUES (?, ?, 'diary-index', ?, ?, ?, ?, ?)`).run(memId, req.user.sub, `[${date}] ${title || 'Diary'}: ${content.substring(0, 200)}`, JSON.stringify(tags), JSON.stringify({ diaryId: id, date }), now, now);
  }

  res.status(201).json({ id, date });
});

router.get('/future-messages', (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const messages = db.prepare('SELECT * FROM future_messages WHERE user_id = ? AND is_delivered = 0 AND deliver_after <= ? ORDER BY deliver_after')
    .all(req.user.sub, now);
  res.json(messages);
});

router.post('/future-messages', (req, res) => {
  const { deliverAfter, content } = req.body;
  if (!deliverAfter || !content) return res.status(400).json({ error: 'deliverAfter and content required' });

  const db = getDb();
  const user = db.prepare('SELECT plan_id FROM users WHERE id = ?').get(req.user.sub);
  let maxMessages = 5;
  if (user?.plan_id) {
    const plan = db.prepare('SELECT features FROM plans WHERE id = ?').get(user.plan_id);
    if (plan) {
      const features = JSON.parse(plan.features || '{}');
      maxMessages = features.future_messages || 5;
    }
  }

  const pending = db.prepare('SELECT COUNT(*) as c FROM future_messages WHERE user_id = ? AND is_delivered = 0').get(req.user.sub).c;
  if (pending >= maxMessages) return res.status(429).json({ error: `Future message limit reached (${maxMessages}). Upgrade your plan.` });

  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO future_messages (id, user_id, deliver_after, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.sub, deliverAfter, content, now);

  res.status(201).json({ id, deliverAfter });
});

router.post('/future-messages/:id/delivered', (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE future_messages SET is_delivered = 1, delivered_at = ? WHERE id = ? AND user_id = ?')
    .run(now, req.params.id, req.user.sub);
  res.json({ success: true });
});

module.exports = router;