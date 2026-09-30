// Structured statistical-data ingestion: Source (method='structured') ->
// Acquisition+Parsing -> Normalization -> AI Research Screening -> AI
// Summary/Insight -> Automatic Archive.
//
// Unlike institutionalIngest.js (which discovers/acquires/extracts a
// document), this source IS already structured data — there is no
// document to discover or extract text from, just one known file to
// download and parse into a compact snapshot. From that point on it
// reuses the exact same AI screening/auto-archive contract as the
// institutional path: generateAiDraftForItem() writes ai_* suggestion
// columns, applyAiDraftIfEligible() is the only place that promotes a
// draft to canonical summary/insight/status='Published' with no human
// review in between.
const pool = require('../db/pool');
// Required as the module object (not destructured) so tests can swap
// fetchAndParse out for a synthetic result without a network fetch, the
// same way collector.test.js/aiDraft.test.js swap out pool.query.
const structuredDataAdapter = require('./adapters/structuredData');
const { generateAiDraftForItem, applyAiDraftIfEligible } = require('./aiDraft');

function formatDelta(deltaPct) {
  if (deltaPct === null) return '변동률 미확보';
  const sign = deltaPct >= 0 ? '+' : '';
  return `${sign}${deltaPct.toFixed(1)}%`;
}

// Compact table-as-text representation fed into the existing AI prompt in
// place of a PDF's extracted text — buildUserPrompt() in aiDraft.js treats
// this exactly like extractedText, so no parallel AI pipeline is needed.
function buildSnapshotText(latestPeriod, previousPeriod, series) {
  const lines = series.map(({ label, unit, latest, previous, deltaPct }) => {
    if (latest === null) return `${label}: 미확보`;
    const prevText = previous === null ? '미확보' : `${previous} ${unit}`;
    return `${label}: ${latest} ${unit} (전월 ${prevText}, 전월 대비 ${formatDelta(deltaPct)})`;
  });
  return `World Bank Commodity Markets (Pink Sheet) ${latestPeriod} 월간 가격 스냅샷 (전월 ${previousPeriod} 대비):\n${lines.join('\n')}`;
}

function markSourceHealthy(sourceId) {
  return pool.query(
    'UPDATE sources SET last_collected_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1',
    [sourceId]
  );
}

// One item per latest available month, never per commodity — the source's
// "document" is the whole snapshot table, matching the one-item-per-report
// shape every other acquisition method already uses. Dedup is by period,
// not URL: the same XLSX file is re-fetched every run, so a distinct
// per-period source_url tag (the file URL plus a #period= fragment) is
// what actually identifies "have we already ingested this month", reusing
// the exact-match items.source_url lookup collectSource()/
// collectInstitutionSource() already use for dedup.
async function collectStructuredSource(source) {
  try {
    const { latestPeriod, previousPeriod, series } = await structuredDataAdapter.fetchAndParse(source.url);
    const periodTag = `${source.url}#period=${latestPeriod}`;

    const { rows: existing } = await pool.query('SELECT id FROM items WHERE source_url = $1', [periodTag]);
    if (existing.length) {
      await markSourceHealthy(source.id);
      return {
        sourceId: source.id, ok: true, alreadyIngested: true, itemId: existing[0].id,
        fetched: 0, count: 0,
      };
    }

    const title = `유지 원자재 가격 동향 (${latestPeriod})`;
    const snapshotText = buildSnapshotText(latestPeriod, previousPeriod, series);

    const { rows: inserted } = await pool.query(
      `INSERT INTO items (title, source_url, source_id, type)
       VALUES ($1, $2, $3, '통계') RETURNING id`,
      [title, periodTag, source.id]
    );
    const itemId = inserted[0].id;

    const draftResult = await generateAiDraftForItem(itemId, undefined, snapshotText);
    if (!draftResult.ok) {
      await markSourceHealthy(source.id);
      return {
        sourceId: source.id, ok: true, itemId, latestPeriod, archived: false,
        aiError: draftResult.error, fetched: 1, count: 0,
      };
    }

    const { archived } = await applyAiDraftIfEligible(itemId);
    await markSourceHealthy(source.id);
    return {
      sourceId: source.id, ok: true, itemId, latestPeriod, archived,
      fetched: 1, count: archived ? 1 : 0,
    };
  } catch (err) {
    await pool.query('UPDATE sources SET last_error = $1, last_error_at = now() WHERE id = $2', [err.message, source.id]);
    return { sourceId: source.id, ok: false, error: err.message };
  }
}

module.exports = { collectStructuredSource, buildSnapshotText };
