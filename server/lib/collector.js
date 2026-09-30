const pool = require('../db/pool');
const { parseFeed, toDateOnly } = require('./feedParser');
const { matchCompanies } = require('./companyMatch');
const { titleSimilarity } = require('./similarity');
const { generateAiDraftForItem } = require('./aiDraft');
const { isRelevantToOilFatsScope } = require('./relevanceFilter');

const MAX_ITEMS_PER_RUN = 20;
const TITLE_SIMILARITY_THRESHOLD = 0.82;
const RECENT_TITLES_LIMIT = 500;

async function fetchFeedItems(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml).slice(0, MAX_ITEMS_PER_RUN);
}

// Dedup an incoming (title, url) against exact URL matches and near-duplicate
// titles (Dice bigram similarity) among recently collected items.
function isDuplicate(fi, existingUrls, recentTitles) {
  if (existingUrls.has(fi.link)) return true;
  return recentTitles.some((t) => titleSimilarity(fi.title, t) >= TITLE_SIMILARITY_THRESHOLD);
}

// Collect one source: fetch its feed, skip items already archived by URL or
// near-duplicate title, insert the rest as Draft, then record source status.
async function collectSource(source) {
  try {
    const feedItems = await fetchFeedItems(source.url);

    const { rows: urlRows } = await pool.query(
      'SELECT source_url FROM items WHERE source_url = ANY($1)',
      [feedItems.map((fi) => fi.link)]
    );
    const existingUrls = new Set(urlRows.map((r) => r.source_url));

    const { rows: titleRows } = await pool.query(
      'SELECT title FROM items ORDER BY collected_at DESC LIMIT $1',
      [RECENT_TITLES_LIMIT]
    );
    const recentTitles = titleRows.map((r) => r.title);

    let inserted = 0;
    let filtered = 0;
    for (const fi of feedItems) {
      if (isDuplicate(fi, existingUrls, recentTitles)) continue;

      // Topic pre-filter: skip entirely (no row, no AI call) for anything
      // outside the Oil & Fats scope — separate from ai_eligible, which
      // only ever runs on items that already passed this check.
      if (!isRelevantToOilFatsScope(fi.title, fi.description)) {
        filtered++;
        continue;
      }

      const { rows } = await pool.query(
        `INSERT INTO items (title, source_url, published_at, source_id, type, summary)
         VALUES ($1,$2,$3,$4,'뉴스',$5) RETURNING id`,
        [fi.title, fi.link, toDateOnly(fi.pubDate), source.id, fi.description]
      );
      await matchCompanies(rows[0].id, `${fi.title} ${fi.description || ''}`);

      // Fire-and-forget: AI drafting must never block or fail RSS collection.
      // generateAiDraftForItem never throws (it resolves { ok: false, ... }
      // on failure and records it on the item), so this .catch is only a
      // last-resort safety net.
      generateAiDraftForItem(rows[0].id).catch((err) => {
        console.error(`AI draft generation errored for item ${rows[0].id}: ${err.message}`);
      });

      existingUrls.add(fi.link);
      recentTitles.push(fi.title);
      inserted++;
    }
    await pool.query(
      'UPDATE sources SET last_collected_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1',
      [source.id]
    );
    return { sourceId: source.id, ok: true, count: inserted, fetched: feedItems.length, filtered };
  } catch (err) {
    await pool.query(
      'UPDATE sources SET last_error = $1, last_error_at = now() WHERE id = $2',
      [err.message, source.id]
    );
    return { sourceId: source.id, ok: false, error: err.message };
  }
}

// A source that just failed is backed off for this long before the
// scheduler will consider it "due" again — reuses the existing
// last_error_at field rather than adding a failure-count column. Without
// this, a source with a permanently broken feed (dead 404/403 URL) never
// gets last_collected_at set on success, so the frequency_days due-check
// alone would select it again on every single hourly tick forever.
// collectSource() already clears last_error/last_error_at on success (see
// its UPDATE above), so a recovered source's backoff resets automatically
// — no separate reset logic needed here.
const FAILURE_BACKOFF_INTERVAL = '1 day';

// Sources due for collection: RSS sources past their frequency window,
// excluding ones currently in their post-failure backoff window. Manual
// collect-all (collectAllSourcesNow, below) intentionally does not apply
// this — "지금 수집" always attempts every source regardless of backoff.
async function getDueSources() {
  const { rows } = await pool.query(`
    SELECT * FROM sources
    WHERE method = 'rss' AND url IS NOT NULL
      AND (last_collected_at IS NULL OR last_collected_at < now() - (frequency_days || ' days')::interval)
      AND (last_error_at IS NULL OR last_error_at < now() - $1::interval)
  `, [FAILURE_BACKOFF_INTERVAL]);
  return rows;
}

async function runDueCollections() {
  const sources = await getDueSources();
  console.log(`scheduled_collection run_started due_sources=${sources.length}`);
  const results = [];
  for (const source of sources) {
    const result = await collectSource(source);
    results.push(result);
    console.log(
      `scheduled_collection source_result source=${source.name} id=${source.id} ` +
      (result.ok
        ? `ok=true fetched=${result.fetched} filtered=${result.filtered} new=${result.count}`
        : `ok=false error=${result.error}`)
    );
  }
  console.log(`scheduled_collection run_completed due_sources=${sources.length} succeeded=${results.filter((r) => r.ok).length} failed=${results.filter((r) => !r.ok).length}`);
  return results;
}

// Collect every active RSS source now, regardless of frequency_days/
// last_collected_at — used by the "전체 자료 지금 수집" bulk action.
// collectSource() already catches its own errors and returns
// { ok: false, ... } rather than throwing, so one source's failure never
// stops the rest.
async function collectAllSourcesNow() {
  const { rows: sources } = await pool.query(
    `SELECT * FROM sources WHERE method = 'rss' AND url IS NOT NULL`
  );
  const results = [];
  for (const source of sources) {
    results.push(await collectSource(source));
  }
  const totals = results.reduce(
    (acc, r) => ({
      fetched: acc.fetched + (r.fetched || 0),
      duplicates: acc.duplicates + (r.ok ? (r.fetched || 0) - (r.count || 0) - (r.filtered || 0) : 0),
      filtered: acc.filtered + (r.filtered || 0),
      newItems: acc.newItems + (r.count || 0),
      failedSources: acc.failedSources + (r.ok ? 0 : 1),
    }),
    { fetched: 0, duplicates: 0, filtered: 0, newItems: 0, failedSources: 0 }
  );
  return { totals, results };
}

module.exports = { collectSource, getDueSources, runDueCollections, collectAllSourcesNow };
