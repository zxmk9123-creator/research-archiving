// Institutional research ingestion: Source (method='institution') ->
// Discovery -> Acquisition -> Extraction -> AI Research Screening ->
// AI Classification -> AI Summary/Insight -> Automatic Archive.
//
// Mirrors collectSource()'s structure/conventions in collector.js (same
// dedup approach, same relevance pre-filter, same per-source try/catch and
// last_collected_at/last_error bookkeeping) so the two acquisition methods
// stay recognizably the same pipeline shape — the difference is what
// Discovery/Acquisition/Extraction do, not the surrounding orchestration.
//
// Unlike collectSource(), a qualifying item here is archived automatically
// (see applyAiDraftIfEligible in aiDraft.js) — this is the one path in the
// codebase where AI's screening verdict, not a human reviewer, is the
// final "does this belong in the archive" decision.
const pool = require('../db/pool');
const { discoverReports } = require('./adapters/institutionPdf');
const { fetchPdfBuffer, extractPdfText } = require('./pdfExtract');
const { matchCompanies } = require('./companyMatch');
const { titleSimilarity } = require('./similarity');
const { generateAiDraftForItem, applyAiDraftIfEligible } = require('./aiDraft');
const { isRelevantToOilFatsScope } = require('./relevanceFilter');

const MAX_REPORTS_PER_RUN = 10;
const TITLE_SIMILARITY_THRESHOLD = 0.82;
const RECENT_TITLES_LIMIT = 500;

function isDuplicate(candidate, existingUrls, recentTitles) {
  if (existingUrls.has(candidate.link)) return true;
  return recentTitles.some((t) => titleSimilarity(candidate.title, t) >= TITLE_SIMILARITY_THRESHOLD);
}

// Collect one institutional source: discover report links on its listing
// page, skip ones already archived (by URL or near-duplicate title, same
// as RSS), run the same rule-based relevance pre-filter RSS uses as an
// inexpensive first-stage gate, then for each surviving candidate acquire
// the PDF, extract its text, and run it through AI screening — auto-
// archiving it if AI finds it eligible. One report's extraction/AI failure
// never stops the rest, same failure-isolation contract as collectSource().
async function collectInstitutionSource(source) {
  try {
    const candidates = (await discoverReports(source)).slice(0, MAX_REPORTS_PER_RUN);

    const { rows: urlRows } = await pool.query(
      'SELECT source_url FROM items WHERE source_url = ANY($1)',
      [candidates.map((c) => c.link)]
    );
    const existingUrls = new Set(urlRows.map((r) => r.source_url));

    const { rows: titleRows } = await pool.query(
      'SELECT title FROM items ORDER BY collected_at DESC LIMIT $1',
      [RECENT_TITLES_LIMIT]
    );
    const recentTitles = titleRows.map((r) => r.title);

    let archived = 0;
    let rejected = 0;
    let filtered = 0;
    let failed = 0;
    const details = [];

    for (const candidate of candidates) {
      if (isDuplicate(candidate, existingUrls, recentTitles)) continue;

      // Unlike RSS (which has a title+description to pre-filter on before
      // ever fetching anything), an institutional PDF candidate only has a
      // bare listing-page anchor title pre-acquisition — generic report
      // titles ("Commodity Markets Outlook, April 2026") routinely carry no
      // oil/fats keyword even when the report itself is squarely in scope.
      // Applying the title-only gate here produced real false rejections.
      // Institutional sources are also curated/trusted (unlike an open RSS
      // firehose), so per the "where appropriate" qualifier it's not
      // appropriate to gate on title alone: we run the same rule-based
      // filter after extraction, against the actual PDF text, still ahead
      // of the AI call, and let AI make the final call either way.

      let itemId;
      try {
        const { rows } = await pool.query(
          `INSERT INTO items (title, source_url, pdf_url, source_id, type)
           VALUES ($1,$2,$2,$3,'보고서') RETURNING id`,
          [candidate.title, candidate.link, source.id]
        );
        itemId = rows[0].id;
        await matchCompanies(itemId, candidate.title);
        existingUrls.add(candidate.link);
        recentTitles.push(candidate.title);
      } catch (err) {
        // 23505 = unique_violation on items.source_url — an overlapping
        // collection run already inserted this exact URL between our
        // dedup check above and this INSERT; the DB constraint is the
        // authoritative guard. Not a real failure.
        if (err.code === '23505') {
          existingUrls.add(candidate.link);
          continue;
        }
        failed++;
        details.push({ title: candidate.title, link: candidate.link, stage: 'insert', error: err.message });
        continue;
      }

      // Acquisition + extraction failures are preserved as a clean error
      // state on the item (ai_status='failed', ai_error set) rather than
      // corrupting or partially publishing it — the item row stays in the
      // archive as an auditable "acquisition failed" record, matching how
      // generateAiDraftForItem already records a provider failure.
      let extractedText;
      try {
        const buffer = await fetchPdfBuffer(candidate.link);
        const extracted = await extractPdfText(buffer);
        extractedText = extracted.text;
      } catch (err) {
        failed++;
        await pool.query(
          `UPDATE items SET ai_status = 'failed', ai_error = $1 WHERE id = $2`,
          [`PDF acquisition/extraction failed: ${err.message}`.slice(0, 200), itemId]
        );
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'extract', error: err.message });
        continue;
      }

      // Same inexpensive rule-based gate RSS collection uses, now checked
      // against the extracted body text (which has real signal, unlike the
      // bare title) — still ahead of the costly AI call, still leaving the
      // actual research-curation decision to AI for anything that passes.
      if (!isRelevantToOilFatsScope(candidate.title, extractedText)) {
        filtered++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'filtered_after_extraction' });
        continue;
      }

      const draftResult = await generateAiDraftForItem(itemId, undefined, extractedText);
      if (!draftResult.ok) {
        failed++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'ai_screening', error: draftResult.error });
        continue;
      }

      const { archived: wasArchived } = await applyAiDraftIfEligible(itemId);
      if (wasArchived) {
        archived++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'archived' });
      } else {
        rejected++;
        details.push({ title: candidate.title, link: candidate.link, itemId, stage: 'rejected_by_ai' });
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
      // fetched/count aliases so this result shape is drop-in compatible
      // with collectAllSourcesNow()'s existing RSS-oriented totals reducer
      // in collector.js — "new items" here means newly archived, since an
      // AI-rejected candidate still created an (unpublished) item row but
      // isn't what "new items in the archive" means to that aggregate.
      fetched: candidates.length,
      count: archived,
    };
  } catch (err) {
    await pool.query(
      'UPDATE sources SET last_error = $1, last_error_at = now() WHERE id = $2',
      [err.message, source.id]
    );
    return { sourceId: source.id, ok: false, error: err.message };
  }
}

module.exports = { collectInstitutionSource };
