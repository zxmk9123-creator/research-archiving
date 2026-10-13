// Operational visibility: one aggregated snapshot of pipeline health —
// failure reasons, per-source collection volume/quality, and the unreviewed
// (Draft) backlog — for the Ops dashboard. Read-only, so no requireAuth,
// same convention as every other GET route (see auth.js's own comment on
// why read routes are left off that middleware).
//
// Every number here is deliberately scoped and documented rather than
// left to "looks about right":
//
// - backlog.byAiStatus is a GROUP BY ai_status over the exact same
//   `status = 'Draft'` row set backlog.total sums from — a single-column
//   group-by is mechanically a partition, so the buckets are mutually
//   exclusive and always sum to backlog.total by construction, not by
//   convention. There is no separate "미검수" bucket; "미검수" IS this
//   whole population, split by how far AI processing got.
// - aiFailureReasons is scoped to the SAME population
//   (`status = 'Draft' AND ai_status = 'failed'`), not "every item that
//   ever failed" — a human can manually publish a Draft whose last AI
//   attempt failed (routes/items.js's PATCH only requires classification,
//   not ai_status='completed') without ever clearing ai_failure_type, so
//   counting failures with no status filter would have mixed in items
//   that are no longer actually sitting in the backlog. This way,
//   aiFailureReasons' counts always sum to exactly
//   backlog.byAiStatus.failed. A *successful* retry also always clears
//   ai_failure_type back to NULL (see aiDraft.js) — nothing here can
//   double-count a resolved failure as current.
// - perSource's `collected` is the count of items actually inserted for
//   that source (i.e. already past the relevance pre-filter and exact-
//   URL/near-duplicate-title dedup every ingestion path applies before
//   insert) — not a raw "candidates found" count, which isn't persisted
//   anywhere past the collection run's own logs. `published` is the
//   subset of `collected` with status='Published'; the gap between them
//   is everything still sitting in Draft (ineligible, QA-held, or simply
//   not yet reviewed) for that source.
// - sourceErrors reflects only each source's MOST RECENT run: every
//   ingestion path clears last_error/last_error_at back to NULL on its
//   next successful run (collector.js, webDiscoveryIngest.js,
//   institutionalIngest.js, structuredDataIngest.js all do this), so this
//   list can never show a stale failure a later success has already
//   overwritten.
// - the 7-day window is a rolling 7×24h window in UTC ending at this
//   request's own generatedAt — never a calendar-day or local-timezone
//   boundary — and windowStart/windowEnd are both echoed explicitly so a
//   client never has to guess the edges.
//
// Each of the four aggregations is queried independently (Promise.allSettled,
// not Promise.all) so one failing query degrades that one section instead
// of taking the whole dashboard down — see the per-section `ok`/`error`
// shape below.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const COLLECTION_WINDOW_DAYS = 7;

async function settleSection(promise) {
  try {
    const { rows } = await promise;
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
}

router.get('/overview', async (req, res) => {
  const generatedAt = new Date();
  const windowStart = new Date(generatedAt.getTime() - COLLECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [backlogSection, aiFailureSection, sourceErrorSection, perSourceSection] = await Promise.all([
    settleSection(pool.query(`
      SELECT ai_status, count(*)::int AS cnt
      FROM items
      WHERE status = 'Draft'
      GROUP BY ai_status
    `)),
    settleSection(pool.query(`
      SELECT ai_failure_type, count(*)::int AS cnt
      FROM items
      WHERE status = 'Draft' AND ai_status = 'failed' AND ai_failure_type IS NOT NULL
      GROUP BY ai_failure_type
      ORDER BY cnt DESC
    `)),
    settleSection(pool.query(`
      SELECT id, name, method, last_error, last_error_at
      FROM sources
      WHERE last_error IS NOT NULL
      ORDER BY last_error_at DESC
      LIMIT 20
    `)),
    settleSection(pool.query(`
      SELECT
        s.id, s.name, s.method,
        count(i.id)::int AS collected,
        count(i.id) FILTER (WHERE i.status = 'Published')::int AS published,
        count(i.id) FILTER (WHERE i.ai_status = 'failed')::int AS ai_failed
      FROM sources s
      LEFT JOIN items i
        ON i.source_id = s.id AND i.collected_at >= $1 AND i.collected_at <= $2
      WHERE s.method IN ('rss', 'crawl', 'institution', 'structured')
      GROUP BY s.id, s.name, s.method
      ORDER BY collected DESC, s.name ASC
    `, [windowStart.toISOString(), generatedAt.toISOString()])),
  ]);

  const backlogByAiStatus = Object.fromEntries(backlogSection.rows.map((r) => [r.ai_status || 'null', r.cnt]));
  const backlogTotal = backlogSection.rows.reduce((sum, r) => sum + r.cnt, 0);

  res.json({
    basis: {
      collectionWindow: {
        days: COLLECTION_WINDOW_DAYS,
        kind: 'rolling_24h_utc', // not a calendar day, not any local timezone
        start: windowStart.toISOString(),
        end: generatedAt.toISOString(),
      },
      backlogDefinition: "status = 'Draft'",
      backlogPartitionedBy: 'ai_status (mutually exclusive, sums to backlog.total)',
      aiFailureReasonsScope: "status = 'Draft' AND ai_status = 'failed' (sums to backlog.byAiStatus.failed)",
      perSourceCollectedDefinition: 'items actually inserted (post relevance-filter, post dedup) — not raw candidates found',
      sourceErrorsDefinition: "each source's most recent run only — cleared to NULL on that source's next successful run",
      generatedAt: generatedAt.toISOString(),
    },
    backlog: {
      total: backlogTotal,
      byAiStatus: backlogByAiStatus,
      ok: backlogSection.ok,
      error: backlogSection.ok ? null : backlogSection.error,
    },
    aiFailureReasons: { rows: aiFailureSection.rows, ok: aiFailureSection.ok, error: aiFailureSection.ok ? null : aiFailureSection.error },
    sourceErrors: { rows: sourceErrorSection.rows, ok: sourceErrorSection.ok, error: sourceErrorSection.ok ? null : sourceErrorSection.error },
    perSource: { rows: perSourceSection.rows, ok: perSourceSection.ok, error: perSourceSection.ok ? null : perSourceSection.error },
  });
});

module.exports = router;
