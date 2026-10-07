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
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL`
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

// The scheduler entry point: checked on the existing hourly interval,
// no-ops outside the 08:00 KST hour or if today's run was already claimed.
async function maybeRunDailyDiscovery(now = new Date()) {
  if (!isDailyDiscoveryHourKst(now)) return { ran: false, reason: 'not_due_hour' };
  const claimed = await claimDailyDiscoveryRunForToday(now);
  if (!claimed) return { ran: false, reason: 'already_ran_today' };
  const result = await collectDailyDiscoveryNow();
  console.log(`daily_discovery run_completed ${JSON.stringify(result.totals)}`);
  return { ran: true, ...result };
}

module.exports = {
  kstPartsOf,
  isDailyDiscoveryHourKst,
  claimDailyDiscoveryRunForToday,
  collectDailyDiscoveryNow,
  maybeRunDailyDiscovery,
  isAcademicLiteratureQuery,
  dailyDiscoverySearchOptions,
};
