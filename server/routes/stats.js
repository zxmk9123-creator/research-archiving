// Operational visibility: one aggregated snapshot of pipeline health —
// failure reasons, per-source collection volume/quality, and the unreviewed
// (Draft) backlog — for the Ops dashboard. Read-only, so no requireAuth,
// same convention as every other GET route (see auth.js's own comment on
// why read routes are left off that middleware).
//
// COLLECTION_WINDOW_DAYS governs the per-source volume/quality numbers
// below; the response always echoes it back under `basis` so the
// dashboard can show what it's actually counting instead of a bare
// number with no stated scope.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const COLLECTION_WINDOW_DAYS = 7;

router.get('/overview', async (req, res) => {
  const [backlogResult, aiFailureResult, sourceErrorResult, perSourceResult] = await Promise.all([
    pool.query(`
      SELECT ai_status, count(*)::int AS cnt
      FROM items
      WHERE status = 'Draft'
      GROUP BY ai_status
    `),
    pool.query(`
      SELECT ai_failure_type, count(*)::int AS cnt
      FROM items
      WHERE ai_status = 'failed' AND ai_failure_type IS NOT NULL
      GROUP BY ai_failure_type
      ORDER BY cnt DESC
    `),
    pool.query(`
      SELECT id, name, method, last_error, last_error_at
      FROM sources
      WHERE last_error IS NOT NULL
      ORDER BY last_error_at DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT
        s.id, s.name, s.method,
        count(i.id)::int AS collected,
        count(i.id) FILTER (WHERE i.status = 'Published')::int AS published,
        count(i.id) FILTER (WHERE i.ai_status = 'failed')::int AS ai_failed
      FROM sources s
      LEFT JOIN items i
        ON i.source_id = s.id AND i.collected_at >= now() - ($1 || ' days')::interval
      WHERE s.method IN ('rss', 'crawl', 'institution', 'structured')
      GROUP BY s.id, s.name, s.method
      ORDER BY collected DESC, s.name ASC
    `, [COLLECTION_WINDOW_DAYS]),
  ]);

  const backlogByAiStatus = Object.fromEntries(backlogResult.rows.map((r) => [r.ai_status || 'null', r.cnt]));
  const backlogTotal = backlogResult.rows.reduce((sum, r) => sum + r.cnt, 0);

  res.json({
    basis: {
      collectionWindowDays: COLLECTION_WINDOW_DAYS,
      backlogDefinition: "status = 'Draft'",
      generatedAt: new Date().toISOString(),
    },
    backlog: { total: backlogTotal, byAiStatus: backlogByAiStatus },
    aiFailureReasons: aiFailureResult.rows,
    sourceErrors: sourceErrorResult.rows,
    perSource: perSourceResult.rows,
  });
});

module.exports = router;
