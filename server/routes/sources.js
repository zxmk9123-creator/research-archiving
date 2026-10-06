const express = require('express');
const pool = require('../db/pool');
const { collectBySource, runDueCollections, collectAllSourcesNow } = require('../lib/collector');
const { collectWebDiscoverySource } = require('../lib/webDiscoveryIngest');

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
  if (!['rss', 'institution', 'structured', 'crawl'].includes(rows[0].method) || !rows[0].url) {
    return res.status(400).json({ error: 'source must have method=rss, method=institution, method=structured, or method=crawl and a url' });
  }
  const result = await collectBySource(rows[0]);
  // Minimal observability: the HTTP response body isn't visible in platform
  // request logs, only the status code — log the actual outcome so
  // collection results (fetched/new/failure) can be verified from logs.
  console.log(`collect source ${rows[0].id} (${rows[0].name}): ${JSON.stringify(result)}`);
  res.json(result);
});

// ONE-TIME MANUAL TOOL — not scheduled, not the recurring Daily Discovery
// job, does not touch sources.frequency_days/is_daily_discovery or the
// query registry. Runs every existing is_daily_discovery=true crawl source
// once with a 7-day Brave Search freshness window, through the exact same
// collectWebDiscoverySource() pipeline (dedup, relevance, AI curation,
// classification, autonomous publish) every other crawl run already uses —
// only the search step's date window differs. Safe to call more than once;
// dedup makes a repeat run a no-op for anything already archived. Intended
// to be removed after the one-time backfill it was added for.
router.post('/backfill-7day-discovery', async (req, res) => {
  const { rows: sources } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL ORDER BY id`
  );
  const perQuery = [];
  for (const source of sources) {
    const result = await collectWebDiscoverySource(source, { freshness: 'pw' });
    perQuery.push({ sourceId: source.id, name: source.name, query: source.url, ...result });
  }
  const totals = perQuery.reduce(
    (acc, r) => ({
      discovered: acc.discovered + (r.discovered || 0),
      filtered: acc.filtered + (r.filtered || 0),
      archived: acc.archived + (r.archived || 0),
      rejected: acc.rejected + (r.rejected || 0),
      failed: acc.failed + (r.failed || 0),
      failedQueries: acc.failedQueries + (r.ok ? 0 : 1),
    }),
    { discovered: 0, filtered: 0, archived: 0, rejected: 0, failed: 0, failedQueries: 0 }
  );
  console.log(`backfill_7day_discovery run_completed ${JSON.stringify(totals)}`);
  res.json({ totals, perQuery });
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
