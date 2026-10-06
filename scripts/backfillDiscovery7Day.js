// One-time 7-day historical backfill for Research Discovery. Run manually
// (node scripts/backfillDiscovery7Day.js) — NOT wired into the scheduler,
// dailyDiscovery.js, or any cron. Does not touch sources.frequency_days,
// is_daily_discovery, the query registry, or the schema; it only reads the
// current Daily Discovery Query Registry (crawl sources flagged
// is_daily_discovery=true) and runs each one once with a 7-day Brave
// Search freshness window, through the exact same per-candidate pipeline
// (collectWebDiscoverySource) every other crawl run already uses — same
// dedup, relevance filter, AI curation, classification, and autonomous
// publish gate. Safe to re-run: dedup is unaffected by this script.
const pool = require('../server/db/pool');
const { collectWebDiscoverySource } = require('../server/lib/webDiscoveryIngest');

const FRESHNESS = 'pw'; // Brave Search: past week (7 days)

async function main() {
  const { rows: sources } = await pool.query(
    `SELECT * FROM sources WHERE method = 'crawl' AND is_daily_discovery = true AND url IS NOT NULL ORDER BY id`
  );

  console.log(`backfill_7day run_started queries=${sources.length} freshness=${FRESHNESS}`);

  const perQuery = [];
  for (const source of sources) {
    const result = await collectWebDiscoverySource(source, { freshness: FRESHNESS });
    perQuery.push({ sourceId: source.id, name: source.name, query: source.url, ...result });
    console.log(
      `backfill_7day query_result source=${source.name} id=${source.id} ok=${result.ok} ` +
      (result.ok
        ? `discovered=${result.discovered} filtered=${result.filtered} archived=${result.archived} rejected=${result.rejected} failed=${result.failed}`
        : `error=${result.error}`)
    );
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

  console.log(`backfill_7day run_completed ${JSON.stringify(totals)}`);
  console.log(JSON.stringify({ perQuery, totals }, null, 2));

  await pool.end();
}

main().catch((err) => {
  console.error('backfill_7day run_failed', err);
  process.exit(1);
});
