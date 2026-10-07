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

// ONE-TIME MANUAL TOOL — same shape as backfill-7day-discovery above, for a
// single historical diagnostic/collection run over 2026-09-01..2026-09-30.
// Does not touch sources.frequency_days/is_daily_discovery or the query
// registry; does not create any new scheduler. Only the Brave Search
// freshness window passed to collectWebDiscoverySource() differs — same
// pipeline, same dedup/AI screening/QA/classification/publish rules. Intended
// to be removed after the one-time backfill it was added for.
router.post('/backfill-sept2026-discovery', async (req, res) => {
  const { rows: sources } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL ORDER BY id`
  );
  const perQuery = [];
  for (const source of sources) {
    const result = await collectWebDiscoverySource(source, { freshness: '2026-09-01to2026-09-30' });
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
  console.log(`backfill_sept2026_discovery run_completed ${JSON.stringify(totals)}`);
  res.json({ totals, perQuery });
});

// ONE-TIME MANUAL TOOL — same shape as backfill-sept2026-discovery above,
// for a single historical diagnostic/collection run over 2026-01-01..
// 2026-06-30 (H1 2026). Does not touch sources.frequency_days/
// is_daily_discovery or the query registry; does not create any new
// scheduler. Passes skipStaleCheck: true because this window is itself
// more than STALE_THRESHOLD_DAYS (90d) before today — see the comment on
// collectWebDiscoverySource() in webDiscoveryIngest.js. Same pipeline,
// same dedup/AI screening/QA/classification/publish rules otherwise.
// Intended to be removed after the one-time backfill it was added for.
router.post('/backfill-2026h1-discovery', async (req, res) => {
  const { rows: sources } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL ORDER BY id`
  );
  const perQuery = [];
  for (const source of sources) {
    const result = await collectWebDiscoverySource(source, { freshness: '2026-01-01to2026-06-30', skipStaleCheck: true });
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
  console.log(`backfill_2026h1_discovery run_completed ${JSON.stringify(totals)}`);
  res.json({ totals, perQuery });
});

router.get('/', async (req, res) => {
  // Staleness only means something for a source that is actively ingested —
  // a Reference Source Library entry (is_reference=true) is never collected
  // (method stays 'manual', already excluded from every ingestion query),
  // so last_collected_at being NULL for it is expected, not a failure.
  const { rows } = await pool.query(`
    SELECT s.*,
      (s.is_reference = false AND (s.last_collected_at IS NULL OR s.last_collected_at < now() - (s.frequency_days || ' days')::interval)) AS stale
    FROM sources s ORDER BY s.name
  `);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const {
    name, publisher, url, method, frequency_days, owner, trust_grade,
    is_reference, source_type, region, commodities, coverage_note,
    access_format, update_frequency, usage_note, last_verified_at, rss_available,
    sector_links,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await pool.query(
    `INSERT INTO sources (
       name, publisher, url, method, frequency_days, owner, trust_grade,
       is_reference, source_type, region, commodities, coverage_note,
       access_format, update_frequency, usage_note, last_verified_at, rss_available, sector_links
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [
      name, publisher || null, url || null, method || 'manual', frequency_days || 1, owner || null, trust_grade || 'A',
      Boolean(is_reference), source_type || null, region || null, commodities || [], coverage_note || null,
      access_format || [], update_frequency || null, usage_note || null, last_verified_at || null, Boolean(rss_available),
      JSON.stringify(sector_links || []),
    ]
  );
  res.status(201).json(rows[0]);
});

// Edit flow for an existing source — most importantly, the only way to
// register/update a Reference Source's sector_links after creation (POST
// only covers initial registration). Partial update, same convention as
// routes/items.js's PATCH: only fields present in the body are touched.
const PATCHABLE_SOURCE_FIELDS = [
  'name', 'publisher', 'url', 'method', 'frequency_days', 'owner', 'trust_grade',
  'is_reference', 'source_type', 'region', 'commodities', 'coverage_note',
  'access_format', 'update_frequency', 'usage_note', 'last_verified_at', 'rss_available',
];
router.patch('/:id', async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT id FROM sources WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'not found' });

  const sets = [];
  const params = [];
  for (const f of PATCHABLE_SOURCE_FIELDS) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (req.body.sector_links !== undefined) {
    params.push(JSON.stringify(req.body.sector_links));
    sets.push(`sector_links = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE sources SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  res.json(rows[0]);
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
