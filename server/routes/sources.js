const express = require('express');
const pool = require('../db/pool');
const { collectSource, runDueCollections, collectAllSourcesNow } = require('../lib/collector');

const router = express.Router();

// Manual trigger: run all due RSS sources now.
router.post('/collect', async (req, res) => {
  const results = await runDueCollections();
  res.json({ results });
});

// Manual trigger: collect every active RSS source right now, regardless of
// schedule/frequency_days. Aggregates per-source results — one source
// failing never stops the others.
router.post('/collect-all', async (req, res) => {
  const { totals, results } = await collectAllSourcesNow();
  console.log(`collect-all: ${JSON.stringify(totals)}`);
  res.json({ totals, results });
});

// Manual trigger: collect one source right now, regardless of schedule.
router.post('/:id/collect', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sources WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  if (rows[0].method !== 'rss' || !rows[0].url) {
    return res.status(400).json({ error: 'source must have method=rss and a url' });
  }
  const result = await collectSource(rows[0]);
  // Minimal observability: the HTTP response body isn't visible in platform
  // request logs, only the status code — log the actual outcome so
  // collection results (fetched/new/failure) can be verified from logs.
  console.log(`collect source ${rows[0].id} (${rows[0].name}): ${JSON.stringify(result)}`);
  res.json(result);
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*,
      (s.last_collected_at IS NULL OR s.last_collected_at < now() - (s.frequency_days || ' days')::interval) AS stale
    FROM sources s ORDER BY s.name
  `);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, publisher, url, method, frequency_days, owner, trust_grade } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await pool.query(
    `INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, publisher || null, url || null, method || 'manual', frequency_days || 1, owner || null, trust_grade || 'A']
  );
  res.status(201).json(rows[0]);
});

// items.source_id is ON DELETE SET NULL (see schema.sql) — deleting a
// source never cascades to or removes previously collected items, it only
// detaches them from this source.
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM sources WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
