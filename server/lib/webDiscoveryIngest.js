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

async function collectWebDiscoverySource(source) {
  try {
    const candidates = (await webSearchAdapter.searchWeb(source.url)).slice(0, webSearchAdapter.MAX_RESULTS);

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
      try {
        meta = await extractMetadataModule.extractMetadata(candidate.link);
      } catch (err) {
        failed++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'acquisition_failed', error: err.message });
        continue;
      }

      const extractedText = meta.summary || candidate.title;
      if (!isRelevantToOilFatsScope(candidate.title, extractedText)) {
        filtered++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'filtered' });
        continue;
      }

      let itemId;
      try {
        const { rows: inserted } = await pool.query(
          `INSERT INTO items (title, source_url, published_at, source_id, type, thumbnail_url)
           VALUES ($1, $2, $3, $4, '뉴스', $5) RETURNING id`,
          [meta.title || candidate.title, candidate.link, meta.published_at, source.id, meta.thumbnail_url]
        );
        itemId = inserted[0].id;
      } catch (err) {
        failed++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'insert_failed', error: err.message });
        continue;
      }

      const draftResult = await generateAiDraftForItem(itemId, undefined, extractedText);
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

module.exports = { collectWebDiscoverySource };
