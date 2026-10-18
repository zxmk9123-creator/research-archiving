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
//   backlog.byAiStatus.failed — including a NULL ai_failure_type
//   (an application-level failure, e.g. invalid JSON from the model,
//   never got a transport-level failureType — see provider.js's
//   markFallback), reported as the explicit 'unclassified' bucket rather
//   than silently filtered out of the count entirely (a real incident:
//   this filter once hid 186 of 198 failed Drafts from the table). A
//   *successful* retry also always clears ai_failure_type back to NULL
//   (see aiDraft.js) — nothing here can double-count a resolved failure
//   as current.
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
const { kstPartsOf } = require('../lib/dailyDiscovery');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

const COLLECTION_WINDOW_DAYS = 7;
const OPS_TRIAGE_STATES = new Set(['open', 'investigating', 'retry_planned', 'resolved', 'dismissed']);
let opsTriageSchemaPromise;

// This isolated additive table is created on the first Ops triage request,
// so deployment needs no production-wide schema run. Concurrent first
// requests share one DDL call; a failure can be retried.
function ensureOpsTriageSchema() {
  if (!opsTriageSchemaPromise) {
    opsTriageSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS ops_draft_triage (
        item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('open','investigating','retry_planned','resolved','dismissed')) DEFAULT 'open',
        note TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch((err) => {
      opsTriageSchemaPromise = null;
      throw err;
    });
  }
  return opsTriageSchemaPromise;
}

// "금일 수집량": a KST calendar-day window (00:00–24:00 KST), not the
// rolling 7×24h UTC window perSource above uses — the Home status bar and
// Daily Discovery both already reason about "today" in KST (see
// dailyDiscovery.js's own isDailyDiscoveryHourKst), so the Ops dashboard's
// "today" should mean the same calendar day an operator actually means by
// it, not whatever day UTC happens to be at request time.
function todayKstBoundsUtc(now = new Date()) {
  const { date } = kstPartsOf(now);
  const start = new Date(`${date}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

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
  const { start: todayStart, end: todayEnd } = todayKstBoundsUtc(generatedAt);

  const [backlogSection, aiFailureSection, sourceErrorSection, perSourceSection, todaySection] = await Promise.all([
    settleSection(pool.query(`
      SELECT ai_status, count(*)::int AS cnt
      FROM items
      WHERE status = 'Draft'
      GROUP BY ai_status
    `)),
    settleSection(pool.query(`
      SELECT ai_failure_type, count(*)::int AS cnt
      FROM items
      WHERE status = 'Draft' AND ai_status = 'failed'
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
    settleSection(pool.query(`
      SELECT count(*)::int AS cnt
      FROM items i
      JOIN sources s ON s.id = i.source_id
      WHERE s.method IN ('rss', 'crawl', 'institution', 'structured')
        AND i.collected_at >= $1 AND i.collected_at < $2
    `, [todayStart.toISOString(), todayEnd.toISOString()])),
  ]);

  const backlogByAiStatus = Object.fromEntries(backlogSection.rows.map((r) => [r.ai_status || 'null', r.cnt]));
  const backlogTotal = backlogSection.rows.reduce((sum, r) => sum + r.cnt, 0);

  // Production incident: the failure-reasons table showed 12 while the
  // backlog showed 198 failed Drafts — ai_failure_type is only ever set
  // for a transport/provider-level failure (err.failureType, see
  // provider.js's markFallback); an application-level failure (invalid
  // JSON from the model, a downstream parsing error) leaves it NULL, and
  // the query used to filter those rows out entirely instead of counting
  // them under an explicit bucket. Normalized to 'unclassified' here so
  // the rows still sum to backlog.byAiStatus.failed exactly, and an
  // operator can tell "186 failures with no recorded reason" apart from
  // "186 failures we forgot to query" at a glance.
  const aiFailureReasons = aiFailureSection.rows.map((r) => ({
    ai_failure_type: r.ai_failure_type || 'unclassified',
    cnt: r.cnt,
  }));

  const todayCollected = todaySection.rows[0]?.cnt ?? 0;

  res.json({
    basis: {
      collectionWindow: {
        days: COLLECTION_WINDOW_DAYS,
        kind: 'rolling_24h_utc', // not a calendar day, not any local timezone
        start: windowStart.toISOString(),
        end: generatedAt.toISOString(),
      },
      todayWindow: {
        kind: 'kst_calendar_day', // 00:00–24:00 KST, not UTC — matches Daily Discovery's own "today"
        start: todayStart.toISOString(),
        end: todayEnd.toISOString(),
      },
      todayCollectedDefinition: 'items actually inserted (post relevance-filter, post dedup) with collected_at inside today\'s KST calendar day — same scope as perSourceCollectedDefinition, different window',
      backlogDefinition: "status = 'Draft'",
      backlogPartitionedBy: 'ai_status (mutually exclusive, sums to backlog.total)',
      aiFailureReasonsScope: "status = 'Draft' AND ai_status = 'failed' (sums to backlog.byAiStatus.failed; a NULL ai_failure_type — an application-level failure, never a transport/provider one — is reported as 'unclassified', not dropped)",
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
    aiFailureReasons: { rows: aiFailureReasons, ok: aiFailureSection.ok, error: aiFailureSection.ok ? null : aiFailureSection.error },
    sourceErrors: { rows: sourceErrorSection.rows, ok: sourceErrorSection.ok, error: sourceErrorSection.ok ? null : sourceErrorSection.error },
    perSource: { rows: perSourceSection.rows, ok: perSourceSection.ok, error: perSourceSection.ok ? null : perSourceSection.error },
    today: { collected: todayCollected, ok: todaySection.ok, error: todaySection.ok ? null : todaySection.error },
  });
});


// Draft failure/backlog triage is confined to the Ops workflow:
// failed, gate-held, stale pending, and Drafts waiting longer than 24h.
// GET /api/stats/ai-search-usage?days=14 — admin only. Usage of the AI search from ai_search_logs (metadata only, no question text):
// per-day requests with outcome split, latency percentiles, follow-up share, unique questions. Days are KST calendar days.
router.get('/ai-search-usage', requireAuth, async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 14, 1), 90);
  try {
    const [daily, totals, byProvider] = await Promise.all([
      pool.query(
        `SELECT to_char((created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS requests,
                COUNT(*) FILTER (WHERE outcome = 'success')::int AS success,
                COUNT(*) FILTER (WHERE outcome = 'insufficient_evidence')::int AS insufficient,
                COUNT(*) FILTER (WHERE outcome NOT IN ('success', 'insufficient_evidence'))::int AS failed
           FROM ai_search_logs WHERE created_at >= now() - ($1 || ' days')::interval AND operation = 'ai_search'
          GROUP BY 1 ORDER BY 1`, [String(days)]),
      pool.query(
        `SELECT COUNT(*)::int AS requests,
                COUNT(DISTINCT question_fingerprint)::int AS unique_questions,
                COUNT(*) FILTER (WHERE is_followup)::int AS followups,
                COUNT(*) FILTER (WHERE outcome = 'success')::int AS success,
                COUNT(*) FILTER (WHERE outcome = 'insufficient_evidence')::int AS insufficient,
                COUNT(*) FILTER (WHERE outcome NOT IN ('success', 'insufficient_evidence'))::int AS failed,
                ROUND(AVG(latency_ms))::int AS avg_latency_ms,
                ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::int AS p50_latency_ms,
                ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms,
                ROUND(AVG(ttft_ms))::int AS avg_ttft_ms
           FROM ai_search_logs WHERE created_at >= now() - ($1 || ' days')::interval AND operation = 'ai_search'`, [String(days)]),
      pool.query(
        `SELECT COALESCE(provider, '-') AS provider, COUNT(*)::int AS requests
           FROM ai_search_logs WHERE created_at >= now() - ($1 || ' days')::interval AND operation = 'ai_search'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, [String(days)]),
    ]);
    res.json({ days, daily: daily.rows, totals: totals.rows[0] || {}, providers: byProvider.rows, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('ai-search-usage failed:', err.message);
    res.status(500).json({ error: '사용량을 불러오지 못했습니다.' });
  }
});

router.get('/draft-triage', async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const offset = Math.min(100000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
  const includeClosed = req.query.includeClosed === 'true';
  try {
    await ensureOpsTriageSchema();
    const { rows } = await pool.query(`
      WITH queue AS (
        SELECT i.id, i.title, i.source_url, i.ai_status, i.ai_failure_type, i.ai_error,
          i.gate_hold_reason, i.gate_hold_rule_version, i.collected_at, i.ai_generated_at,
          s.name AS source_name,
          CASE
            WHEN i.ai_status = 'failed' THEN 'ai_failed'
            WHEN i.gate_hold_reason IS NOT NULL THEN 'gate_held'
            WHEN i.ai_status = 'pending' AND COALESCE(i.ai_generated_at, i.collected_at) < now() - interval '15 minutes' THEN 'stale_pending'
            WHEN i.collected_at < now() - interval '24 hours' THEN 'aged_draft'
            ELSE 'other'
          END AS triage_reason,
          COALESCE(t.status, 'open') AS triage_status,
          t.note AS triage_note,
          t.updated_at AS triage_updated_at
        FROM items i
        LEFT JOIN sources s ON s.id = i.source_id
        LEFT JOIN ops_draft_triage t ON t.item_id = i.id
        WHERE i.status = 'Draft' AND ($3::boolean OR COALESCE(t.status, 'open') NOT IN ('resolved','dismissed')) AND (
          i.ai_status = 'failed'
          OR i.gate_hold_reason IS NOT NULL
          OR (i.ai_status = 'pending' AND COALESCE(i.ai_generated_at, i.collected_at) < now() - interval '15 minutes')
          OR i.collected_at < now() - interval '24 hours'
        )
      )
      SELECT *, count(*) OVER()::int AS total_count
      FROM queue
      ORDER BY CASE triage_reason WHEN 'ai_failed' THEN 0 WHEN 'gate_held' THEN 1 WHEN 'stale_pending' THEN 2 ELSE 3 END,
        collected_at ASC NULLS FIRST, id ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset, includeClosed]);
    res.json({ rows, total: rows[0]?.total_count ?? 0, limit, offset, hasMore: offset + rows.length < (rows[0]?.total_count ?? 0), includeClosed });
  } catch (err) {
    console.error('GET /api/stats/draft-triage failed:', err.message);
    res.status(500).json({ error: 'Draft 트리아지 목록을 불러오는 중 오류가 발생했습니다.' });
  }
});

router.patch('/draft-triage/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { status, note } = req.body || {};
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: '올바르지 않은 자료 ID입니다.' });
  if (!OPS_TRIAGE_STATES.has(status)) return res.status(400).json({ error: '올바르지 않은 트리아지 상태입니다.' });
  if (note != null && typeof note !== 'string') return res.status(400).json({ error: '메모는 문자열이어야 합니다.' });
  const cleanNote = (note || '').trim();
  if (cleanNote.length > 2000) return res.status(400).json({ error: '메모는 2,000자 이내로 작성해주세요.' });

  try {
    await ensureOpsTriageSchema();
    const { rows } = await pool.query(`
      INSERT INTO ops_draft_triage (item_id, status, note, updated_at)
      SELECT i.id, $2, $3, now() FROM items i WHERE i.id = $1 AND i.status = 'Draft'
      ON CONFLICT (item_id) DO UPDATE
        SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()
        WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = EXCLUDED.item_id AND i.status = 'Draft')
      RETURNING item_id, status, note, updated_at
    `, [id, status, cleanNote || null]);
    if (!rows.length) return res.status(404).json({ error: '현재 Draft 상태인 자료를 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(`PATCH /api/stats/draft-triage/${id} failed:`, err.message);
    res.status(500).json({ error: '트리아지 기록 저장 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
