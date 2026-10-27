// Daily Discovery: a separate, fixed-time (08:00 Asia/Seoul) job that runs
// every crawl-method source flagged is_daily_discovery=true through the
// exact same Web Research Discovery pipeline (webDiscoveryIngest.js) the
// hourly Research Sources scheduler already uses for method='crawl' —
// same Brave Search adapter, dedup, relevance filter, AI curation,
// classification, and autonomous publish. This module only decides WHEN
// and WHICH sources to run; it adds no new ingestion logic.
//
// Deliberately independent of collector.js's getDueSources()/
// frequency_days due-check (the existing hourly Research Sources
// scheduler) — Daily Discovery has its own once-per-KST-day cadence, and
// must never change when or how often the hourly scheduler's own sources
// run.
const pool = require('../db/pool');
const { collectWebDiscoverySource } = require('./webDiscoveryIngest');

const JOB_NAME = 'daily_discovery';

// "Newly published" as a first-class Daily Discovery criterion: news/
// market/regulatory/company-IR queries get a Brave `freshness: 'pw'`
// (past-week) bias plus webDiscoveryIngest's isClearlyStale() backstop,
// so a daily run surfaces what's actually new rather than re-surfacing
// the same old pages every day. Academic/peer-reviewed literature queries
// are intentionally exempt — a working paper or journal study is still
// useful well past a week old, and the task is explicitly not meant to
// become a strict date-only crawler. Classified by the query text itself
// (no new schema column) — a simple, generous heuristic: when in doubt,
// it exempts (skips the extra staleness check) rather than risks
// rejecting a possibly-fresh item.
const ACADEMIC_LITERATURE_QUERY_RE = /journal|peer-reviewed|working paper|academic research/i;
function isAcademicLiteratureQuery(queryText) {
  return ACADEMIC_LITERATURE_QUERY_RE.test(queryText || '');
}

// Archive Discovery Registry queries (sources.is_archive_discovery=true):
// reports/papers/institutional research/long-shelf-life structural
// material, as opposed to day-to-day news. Two consequences, both keyed
// off that one column so no query-text parsing is needed:
//   - itemType '보고서' instead of the default '뉴스', so
//     classification.js's deriveContentCategory() files the eventual
//     Published item under 'archive' rather than 'daily_report' — see the
//     comment in webDiscoveryIngest.js's INSERT for why this matters.
//   - no freshness:'pw' bias, same exemption academic-literature queries
//     already get: a report or paper is still useful well past a week
//     old, and Archive discovery is explicitly not meant to be a
//     recency-only crawler (unlike the rest of Daily Discovery).
function dailyDiscoverySearchOptions(source) {
  if (source.is_archive_discovery) return { itemType: '보고서' };
  if (isAcademicLiteratureQuery(source.url)) return {};
  return { freshness: 'pw' };
}

// Current date/hour in Asia/Seoul, independent of the container's own
// timezone (Railway runs UTC). `now` is injectable for tests.
function kstPartsOf(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  // en-CA gives YYYY-MM-DD ordering; hour '24' means midnight — normalize to '00'.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(hour) };
}

// True only during the 08:00–08:59 KST hour — checked on the same 1-hour
// interval the existing scheduler uses, so this window is never missed
// regardless of the container's own clock/timezone.
function isDailyDiscoveryHourKst(now = new Date()) {
  return kstPartsOf(now).hour === 8;
}

// Atomically claims today's (KST) run: succeeds (returns true) at most
// once per KST calendar date, even across concurrent/overlapping checks,
// since the UPDATE...WHERE's row-changed condition is evaluated by
// Postgres itself, not read-then-write from this process.
async function claimDailyDiscoveryRunForToday(now = new Date()) {
  const today = kstPartsOf(now).date;
  const { rowCount } = await pool.query(
    `INSERT INTO scheduler_jobs (job_name, last_run_date) VALUES ($1, $2)
     ON CONFLICT (job_name) DO UPDATE SET last_run_date = $2
     WHERE scheduler_jobs.last_run_date IS DISTINCT FROM $2`,
    [JOB_NAME, today]
  );
  return rowCount > 0;
}

// Runs every Daily Discovery Query Registry source now, regardless of its
// own frequency_days/last_collected_at — same aggregation shape as
// collectAllSourcesNow() in collector.js.
// offset / limit let a hosted function (with a hard time limit) run the sources in slices: the same ordered list, so slices never overlap.
async function collectDailyDiscoveryNow({ offset = 0, limit = null } = {}) {
  const { rows: all } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL AND is_active = true ORDER BY id`
  );
  const sources = limit ? all.slice(offset, offset + limit) : all.slice(offset);
  const results = [];
  for (const source of sources) {
    results.push(await collectWebDiscoverySource(source, dailyDiscoverySearchOptions(source)));
  }
  const totals = results.reduce(
    (acc, r) => ({
      discovered: acc.discovered + (r.discovered || 0),
      archived: acc.archived + (r.archived || 0),
      filtered: acc.filtered + (r.filtered || 0),
      failed: acc.failed + (r.failed || 0),
      failedSources: acc.failedSources + (r.ok ? 0 : 1),
    }),
    { discovered: 0, archived: 0, filtered: 0, failed: 0, failedSources: 0 }
  );
  return { totals, results, total: all.length, nextOffset: limit && offset + limit < all.length ? offset + limit : null };
}

// The scheduler entry point: checked on the existing hourly interval (and
// now also by the Railway-native cron hitting POST /sources/run-scheduled-
// daily-discovery, see sources.js) — no-ops outside the 08:00 KST hour or
// if today's run was already claimed. claimDailyDiscoveryRunForToday()'s
// atomic UPDATE...WHERE is what actually prevents a double run when BOTH
// callers reach this function around the same time: only one of them gets
// `claimed === true`; the other sees already_ran_today and returns
// immediately without starting a second collection. A caller that wants
// to force a run regardless of this once-per-day gate (the "크롤링 지금
// 해줘" ad-hoc case) uses collectDailyDiscoveryNow() directly instead —
// that path intentionally bypasses this claim and is never wired to the
// scheduled cron.
// Shared by the scheduled path and the ad-hoc manual-trigger route (see
// sources.js) — whichever path actually ran collectDailyDiscoveryNow(),
// the Home status bar should reflect it the same way. Writing to
// scheduler_jobs here (job_name's row already exists — it's upserted by
// claimDailyDiscoveryRunForToday on the scheduled path, and seeded by the
// schema's own INSERT/UPDATE guard otherwise) is an UPSERT, not a bare
// UPDATE, so a manual run on a day the scheduled claim hasn't touched yet
// still records completion instead of silently no-oping.
async function recordDailyDiscoveryCompletion(result) {
  const failedSources = result.results.filter((r) => !r.ok).map((r) => ({ sourceId: r.sourceId, error: r.error }));
  // a result assembled from slices carries no totals: derive them from the per-source results
  const totals = result.totals || result.results.reduce(
    (acc, r) => ({ discovered: acc.discovered + (r.discovered || 0), archived: acc.archived + (r.archived || 0), filtered: acc.filtered + (r.filtered || 0), failed: acc.failed + (r.failed || 0), failedSources: acc.failedSources + (r.ok ? 0 : 1) }),
    { discovered: 0, archived: 0, filtered: 0, failed: 0, failedSources: 0 }
  );
  await pool.query(
    `INSERT INTO scheduler_jobs (job_name, last_completed_at, last_totals, last_failed_sources)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (job_name) DO UPDATE SET last_completed_at = now(), last_totals = $2, last_failed_sources = $3`,
    [JOB_NAME, JSON.stringify(totals), JSON.stringify(failedSources)]
  );
  // The daily headline is a separate, durable read model. Start it only
  // after the collection completion record has been written; never let an
  // LLM outage turn a successful collection into a failed scheduler run.
  const dailyBriefModule = require('./dailyBrief');
  require('./background').track(dailyBriefModule.queueDailyBriefGeneration().catch((err) => {
    console.error(`daily_brief enqueue failed: ${err.message}`);
  }));
  return failedSources;
}

// Production incident: a routine redeploy landed at 08:35 KST, SIGTERM-ing
// the process mid-collectDailyDiscoveryNow() — claimDailyDiscoveryRunForToday()
// had already set last_run_date to today (it runs BEFORE collection starts),
// but the process died before recordDailyDiscoveryCompletion() ever ran, so
// last_completed_at stayed unset. Every later check that KST day saw
// already_ran_today and skipped — the Home status bar stayed "미완료" for
// the rest of the day even though most sources had, in fact, already been
// collected. A claim with no matching completion, for TODAY specifically,
// is recognized as orphaned and retried once rather than trusted as done.
async function isTodaysClaimOrphaned(now = new Date()) {
  const today = kstPartsOf(now).date;
  const { rows } = await pool.query(
    `SELECT last_run_date, last_completed_at FROM scheduler_jobs WHERE job_name = $1`,
    [JOB_NAME]
  );
  const row = rows[0];
  if (!row || !row.last_run_date) return false;
  const runDate = new Date(row.last_run_date).toISOString().slice(0, 10);
  if (runDate !== today) return false;
  if (!row.last_completed_at) return true;
  return kstPartsOf(row.last_completed_at).date !== today;
}

async function maybeRunDailyDiscovery(now = new Date()) {
  const orphaned = await isTodaysClaimOrphaned(now);
  if (orphaned) {
    console.log('daily_discovery resuming_orphaned_claim');
  } else {
    if (!isDailyDiscoveryHourKst(now)) return { ran: false, reason: 'not_due_hour' };
    const claimed = await claimDailyDiscoveryRunForToday(now);
    if (!claimed) return { ran: false, reason: 'already_ran_today' };
  }
  // run_started logged as its own line, separate from run_completed, so a
  // run that crashes/times out partway still leaves a trace distinguishing
  // "never started" from "started but never finished" — previously only
  // run_completed was logged, so an incomplete run was invisible.
  console.log('daily_discovery run_started');
  const result = await collectDailyDiscoveryNow();
  console.log(`daily_discovery run_completed ${JSON.stringify(result.totals)}`);
  const failedSources = await recordDailyDiscoveryCompletion(result);
  if (failedSources.length) {
    console.log(`daily_discovery failed_sources ${JSON.stringify(failedSources)}`);
  }
  return { ran: true, ...result };
}

// Home status-bar read model: today's (KST) completion state for the
// green/red light, without exposing claimDailyDiscoveryRunForToday()'s
// internal claim mechanics to the route layer.
// state: completed | running (a slice holds the lease) | waiting (before the 08:00 KST hour, nothing started yet) |
// stalled (started but no progress for STALL_MS, or nothing started by 08:00 KST) — the home light shows each differently.
const STALL_MS = 45 * 60 * 1000;
async function getDailyDiscoveryStatus(now = new Date()) {
  const { date: today, hour } = kstPartsOf(now);
  const { rows } = await pool.query(
    `SELECT job_name, last_run_date, last_completed_at, last_totals, last_failed_sources FROM scheduler_jobs WHERE job_name = ANY($1)`,
    [[JOB_NAME, CURSOR_JOB]]
  );
  const row = rows.find((r) => r.job_name === JOB_NAME);
  const cursorRow = rows.find((r) => r.job_name === CURSOR_JOB);
  const completedToday = Boolean(row && row.last_completed_at) && kstPartsOf(row.last_completed_at).date === today;
  const cursor = cursorRow && cursorRow.last_run_date && new Date(cursorRow.last_run_date).toISOString().slice(0, 10) === today ? cursorRow.last_totals || {} : null;
  const total = (cursor && cursor.total) || null;
  const done = cursor ? Number(cursor.offset) || 0 : 0;
  let state = 'waiting';
  if (completedToday) state = 'completed';
  else if (cursor && cursor.leaseUntil && cursor.leaseUntil > now.getTime()) state = 'running';
  else if (cursor) state = cursor.savedAt && now.getTime() - cursor.savedAt <= STALL_MS ? 'running' : 'stalled';
  else if (hour >= 8) state = 'stalled';
  return {
    completedToday,
    state,
    progress: total ? { done, total } : null,
    totals: completedToday ? row.last_totals : null,
    failedSources: completedToday ? (row.last_failed_sources || []) : [],
    completedAt: completedToday ? row.last_completed_at : null,
  };
}

// ---- Sliced scheduled run (hosts whose functions have a hard time limit) ----------------------------------------------------
// The whole list of ~66 sources takes over an hour, far beyond one function call. Each call advances a persisted cursor by as many
// sources as fit in its time budget (a few at a time, in parallel); the call that reaches the end records the completion exactly like
// the single-process run does. Resuming never starts over: the cursor lives in scheduler_jobs (job 'daily_discovery_cursor').
const CURSOR_JOB = 'daily_discovery_cursor';
const SOURCE_TIMEOUT_MS = 90000;
const slimResult = (r) => ({ sourceId: r.sourceId, ok: r.ok, error: r.error, discovered: r.discovered, archived: r.archived, filtered: r.filtered, failed: r.failed });

// Pure step function (tested without a database): runs sources [offset, total) in groups until the budget is spent.
async function advanceDiscovery(cursor, total, runOne, { budgetMs = 200000, concurrency = 3, now = () => Date.now(), onGroup = null } = {}) {
  const started = now();
  const next = { offset: cursor.offset || 0, results: [...(cursor.results || [])] };
  while (next.offset < total && now() - started < budgetMs) {
    const group = [];
    for (let i = 0; i < concurrency && next.offset + i < total; i++) group.push(next.offset + i);
    const done = await Promise.all(group.map((idx) => runOne(idx).then((r) => slimResult(r), (err) => ({ sourceId: null, ok: false, error: String(err && err.message).slice(0, 160) }))));
    next.results.push(...done);
    next.offset += group.length;
    // progress is saved after EVERY group: a function killed by the host's time limit loses at most the group in flight
    if (onGroup) await onGroup({ offset: next.offset, results: next.results });
  }
  return { ...next, done: next.offset >= total };
}

async function runDailyDiscoverySliced({ now = new Date(), budgetMs = 200000 } = {}) {
  const parts = kstPartsOf(now);
  const today = parts.date;
  if ((await getDailyDiscoveryStatus(now)).completedToday) return { ran: false, reason: 'already_ran_today' };
  if (Number(parts.hour) < 7) return { ran: false, reason: 'not_due_hour' }; // starts in the 07:00-08:00 KST window
  const { rows } = await pool.query(`SELECT last_run_date, last_totals FROM scheduler_jobs WHERE job_name = $1`, [CURSOR_JOB]);
  const saved = rows[0] && rows[0].last_run_date && new Date(rows[0].last_run_date).toISOString().slice(0, 10) === today ? rows[0].last_totals || {} : {};
  if (saved.leaseUntil && saved.leaseUntil > Date.now()) return { ran: false, reason: 'in_progress', offset: saved.offset || 0 };
  const { rows: srcRows } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL AND is_active = true ORDER BY id`
  );
  const save = (state) => pool.query(
    `INSERT INTO scheduler_jobs (job_name, last_run_date, last_totals) VALUES ($1, $2::date, $3)
     ON CONFLICT (job_name) DO UPDATE SET last_run_date = $2::date, last_totals = $3`,
    [CURSOR_JOB, today, JSON.stringify(state)]
  );
  await save({ ...saved, total: srcRows.length, savedAt: Date.now(), leaseUntil: Date.now() + budgetMs + 60000 });
  console.log(`daily_discovery sliced start offset=${saved.offset || 0}/${srcRows.length}`);
  // one slow source must not outlive the function: the budget is only checked between groups, so a group that ran past the host's
  // hard limit killed the call before it could save its result or chain the next hop (2026-10-28 07:22 KST stall)
  const runOne = (idx) => Promise.race([
    collectWebDiscoverySource(srcRows[idx], dailyDiscoverySearchOptions(srcRows[idx])),
    new Promise((resolve) => setTimeout(() => resolve({ sourceId: srcRows[idx].id, ok: false, error: 'source_timeout' }), SOURCE_TIMEOUT_MS).unref()),
  ]);
  const leaseMs = budgetMs + 60000;
  const step = await advanceDiscovery(saved, srcRows.length, runOne, {
    budgetMs,
    onGroup: (state) => save({ offset: state.offset, results: state.results, total: srcRows.length, savedAt: Date.now(), leaseUntil: Date.now() + leaseMs }),
  });
  await save({ offset: step.offset, results: step.results, total: srcRows.length, savedAt: Date.now(), leaseUntil: 0 });
  if (!step.done) return { ran: true, done: false, progress: `${step.offset}/${srcRows.length}` };
  const failedSources = await recordDailyDiscoveryCompletion({ results: step.results });
  console.log(`daily_discovery sliced completed sources=${step.results.length} failed=${failedSources.length}`);
  return { ran: true, done: true, progress: `${step.offset}/${srcRows.length}`, failedSources: failedSources.length };
}

module.exports = {
  advanceDiscovery,
  runDailyDiscoverySliced,
  kstPartsOf,
  isDailyDiscoveryHourKst,
  claimDailyDiscoveryRunForToday,
  isTodaysClaimOrphaned,
  collectDailyDiscoveryNow,
  recordDailyDiscoveryCompletion,
  maybeRunDailyDiscovery,
  getDailyDiscoveryStatus,
  isAcademicLiteratureQuery,
  dailyDiscoverySearchOptions,
};
