// Web Research Discovery ingestion: Source (method='crawl', whose `url`
// column holds a fixed, hand-written search query rather than a listing
// page or file) -> Web Search -> Candidate URLs -> Acquisition ->
// Extraction -> AI Research Screening -> AI Classification -> AI
// Summary/Insight -> Automatic Archive.
//
// Deliberately the smallest possible shape: exact-URL dedup only (no
// title-similarity pass), one metadata-extraction call per candidate via
// the existing extractMetadata() helper, then the exact same
// relevance-filter / AI-draft / auto-archive calls every other
// acquisition method already uses unmodified. No link-following, no
// sitemap discovery, no query generation — see adapters/webSearch.js.
const pool = require('../db/pool');
// Required as module objects (not destructured) so tests can swap
// searchWeb/extractMetadata for a synthetic result without a real
// network call — same convention structuredDataIngest.js uses for
// fetchAndParse.
const webSearchAdapter = require('./adapters/webSearch');
const extractMetadataModule = require('./extractMetadata');
const { isRelevantToOilFatsScope } = require('./relevanceFilter');
const { generateAiDraftForItem, applyAiDraftIfEligible } = require('./aiDraft');

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/;
const FALLBACK_CANDIDATES_TO_TRY = 3;

// "Newly published" as a first-class criterion, without inventing dates:
// only acts when (a) the caller explicitly asked for a freshness-biased
// run (searchOptions.freshness set — Daily Discovery's news/market-type
// queries, never the hourly scheduler or a research-literature query, see
// dailyDiscovery.js) AND (b) the page's own extracted metadata gives a
// real published_at. No metadata -> never rejected for staleness; this is
// a defense-in-depth check on top of Brave's own `freshness` search
// param, for the case where the engine still returns something clearly
// old despite the date filter.
const STALE_THRESHOLD_DAYS = 90;
function isClearlyStale(publishedAt, now = new Date()) {
  if (!publishedAt) return false;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return false;
  const ageDays = (now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > STALE_THRESHOLD_DAYS;
}

// 403 acquisition fallback: the original URL is blocked, so this searches
// for the SAME article at an alternate, accessible location and runs the
// exact same extractMetadata() on that page — never on title/snippet text
// alone, so a candidate that never yields a real fetched page can never
// reach AI screening or publish (see the loop below: returning null here
// is indistinguishable from the original 403, same acquisition_failed
// path). No proxy, no header spoofing, no site-specific scraping — just
// another ordinary search + an ordinary fetch of whatever it returns.
async function attemptAcquisitionFallback(candidate) {
  const doiMatch = DOI_RE.exec(candidate.link) || DOI_RE.exec(candidate.title);
  const query = doiMatch ? `${candidate.title} ${doiMatch[0]}` : candidate.title;

  let results;
  try {
    results = await webSearchAdapter.searchWeb(query);
  } catch {
    return null;
  }

  for (const result of results.slice(0, FALLBACK_CANDIDATES_TO_TRY)) {
    if (!result.link || result.link === candidate.link) continue;
    try {
      const meta = await extractMetadataModule.extractMetadata(result.link);
      return { url: result.link, meta };
    } catch {
      // Try the next alternate; only exhausting all of them is a failure.
    }
  }
  return null;
}

// searchOptions is an optional pass-through to searchWeb() (e.g.
// { freshness: 'pw' } for a date-bounded backfill run) — omitted by every
// existing caller (collector.js's hourly scheduler, dailyDiscovery.js),
// which keeps searching with no date constraint, unchanged.
//
// searchOptions.skipStaleCheck: bypasses isClearlyStale() below. Needed for
// a historical backfill whose target window is itself older than
// STALE_THRESHOLD_DAYS from today (e.g. a months-old custom freshness
// range) — that staleness check is relative to "now", not to the requested
// freshness window, so without this a historical run would filter out
// everything it was asked to find. Omitted (falsy) by every existing
// caller, so Daily Discovery's own recency behavior is unchanged.
async function collectWebDiscoverySource(source, searchOptions = {}) {
  try {
    const candidates = (await webSearchAdapter.searchWeb(source.url, searchOptions)).slice(0, webSearchAdapter.MAX_RESULTS);

    let filtered = 0;
    let archived = 0;
    let rejected = 0;
    let failed = 0;
    const details = [];

    for (const candidate of candidates) {
      const { rows: existing } = await pool.query('SELECT id FROM items WHERE source_url = $1', [candidate.link]);
      if (existing.length) {
        details.push({ title: candidate.title, link: candidate.link, stage: 'already_ingested', itemId: existing[0].id });
        continue;
      }

      // Acquisition/extraction failures are isolated per candidate — one
      // bad URL never stops the rest, same failure-isolation contract as
      // collectSource()/collectInstitutionSource().
      let meta;
      let fallbackUrl = null;
      try {
        meta = await extractMetadataModule.extractMetadata(candidate.link);
      } catch (err) {
        const statusMatch = /fetch failed: (\d+)/.exec(err.message);
        const status = statusMatch ? Number(statusMatch[1]) : null;
        const fallback = status === 403 ? await attemptAcquisitionFallback(candidate) : null;
        if (!fallback) {
          failed++;
          details.push({ title: candidate.title, link: candidate.link, stage: 'acquisition_failed', error: err.message });
          continue;
        }
        meta = fallback.meta;
        fallbackUrl = fallback.url;
      }

      if (searchOptions.freshness && !searchOptions.skipStaleCheck && isClearlyStale(meta.published_at)) {
        filtered++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'stale_for_daily_discovery', published_at: meta.published_at });
        continue;
      }

      const extractedText = meta.summary || candidate.title;
      // The relevance pre-filter above keeps using the short og:description
      // (cheap, keeps the filter's calibration unchanged); the AI draft call
      // below gets the fuller <p> body text when extractMetadata() found
      // one — og:description alone is often a one-line teaser that omits a
      // deeper point the article actually makes (e.g. an economic argument
      // buried a few paragraphs in), which was starving ai_summary/ai_insight
      // of real material to work from.
      const aiDraftText = meta.body_text || extractedText;
      if (!isRelevantToOilFatsScope(candidate.title, extractedText)) {
        filtered++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'filtered' });
        continue;
      }

      let itemId;
      try {
        // searchOptions.itemType lets a caller route a candidate to a type
        // other than the '뉴스' default — needed so Archive-oriented
        // Discovery Registry queries (reports/papers/institutional
        // research, long-shelf-life material) land in deriveContentCategory
        // as 'archive' rather than always being counted as 'daily_report'
        // (see classification.js: content_category is derived purely from
        // `type`, and every Web Discovery item previously hardcoded '뉴스'
        // here regardless of the query's own intent — the Archive view
        // could structurally never receive anything from this pipeline).
        // Defaults to '뉴스' so every existing caller is unaffected.
        const itemType = searchOptions.itemType || '뉴스';
        const { rows: inserted } = await pool.query(
          `INSERT INTO items (title, source_url, published_at, source_id, type, thumbnail_url, acquisition_fallback_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [meta.title || candidate.title, candidate.link, meta.published_at, source.id, itemType, meta.thumbnail_url, fallbackUrl]
        );
        itemId = inserted[0].id;
      } catch (err) {
        // 23505 = unique_violation on items.source_url — a different
        // candidate (same or another query, this run or an overlapping
        // one) already inserted this exact URL between our dedup SELECT
        // above and this INSERT. Confirmed in production: two candidates
        // for the identical URL from the same query's own result set,
        // ~2ms apart. Not a real failure — same outcome as the
        // already_ingested check above.
        if (err.code === '23505') {
          details.push({ title: candidate.title, link: candidate.link, stage: 'already_ingested' });
          continue;
        }
        failed++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'insert_failed', error: err.message });
        continue;
      }
      if (fallbackUrl) {
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'acquisition_fallback_used', fallbackUrl });
      }

      const draftResult = await generateAiDraftForItem(itemId, undefined, aiDraftText);
      if (!draftResult.ok) {
        failed++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'ai_screening_failed', error: draftResult.error });
        continue;
      }

      const { archived: wasArchived } = await applyAiDraftIfEligible(itemId);
      if (wasArchived) {
        archived++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'archived' });
      } else {
        rejected++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'not_archived' });
      }
    }

    await pool.query(
      'UPDATE sources SET last_collected_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1',
      [source.id]
    );
    return {
      sourceId: source.id, ok: true,
      discovered: candidates.length, filtered, archived, rejected, failed,
      details,
      // fetched/count aliases so this result shape stays drop-in
      // compatible with collectAllSourcesNow()'s existing totals reducer.
      fetched: candidates.length,
      count: archived,
    };
  } catch (err) {
    await pool.query('UPDATE sources SET last_error = $1, last_error_at = now() WHERE id = $2', [err.message, source.id]);
    return { sourceId: source.id, ok: false, error: err.message };
  }
}

module.exports = { collectWebDiscoverySource, attemptAcquisitionFallback, isClearlyStale, STALE_THRESHOLD_DAYS };
