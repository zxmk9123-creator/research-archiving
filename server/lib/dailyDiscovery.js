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
async function collectDailyDiscoveryNow() {
  const { rows: sources } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL AND is_active = true`
  );
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
  return { totals, results };
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
  await pool.query(
    `INSERT INTO scheduler_jobs (job_name, last_completed_at, last_totals, last_failed_sources)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (job_name) DO UPDATE SET last_completed_at = now(), last_totals = $2, last_failed_sources = $3`,
    [JOB_NAME, JSON.stringify(result.totals), JSON.stringify(failedSources)]
  );
  return failedSources;
}

async function maybeRunDailyDiscovery(now = new Date()) {
  if (!isDailyDiscoveryHourKst(now)) return { ran: false, reason: 'not_due_hour' };
  const claimed = await claimDailyDiscoveryRunForToday(now);
  if (!claimed) return { ran: false, reason: 'already_ran_today' };
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
async function getDailyDiscoveryStatus(now = new Date()) {
  const today = kstPartsOf(now).date;
  const { rows } = await pool.query(
    `SELECT last_run_date, last_completed_at, last_totals, last_failed_sources FROM scheduler_jobs WHERE job_name = $1`,
    [JOB_NAME]
  );
  const row = rows[0];
  if (!row) return { completedToday: false, totals: null, failedSources: [], completedAt: null };
  const completedToday = Boolean(row.last_completed_at) && kstPartsOf(row.last_completed_at).date === today;
  return {
    completedToday: Boolean(completedToday),
    totals: completedToday ? row.last_totals : null,
    failedSources: completedToday ? (row.last_failed_sources || []) : [],
    completedAt: completedToday ? row.last_completed_at : null,
  };
}

module.exports = {
  kstPartsOf,
  isDailyDiscoveryHourKst,
  claimDailyDiscoveryRunForToday,
  collectDailyDiscoveryNow,
  recordDailyDiscoveryCompletion,
  maybeRunDailyDiscovery,
  getDailyDiscoveryStatus,
  isAcademicLiteratureQuery,
  dailyDiscoverySearchOptions,
};
