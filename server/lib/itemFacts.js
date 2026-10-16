// ITEM FACTS — quantities extracted ONCE, when an item is published, instead of at
// question time. A published item's figures ({entity, site, metric, value, unit, period,
// status, year}) are extracted by an AI call on the batch lane, VERIFIED against the
// item's own text (the figure must literally appear there, unit-aware) and stored in
// `item_facts`. A quantity-comparison question then reads rows from the database: no
// extraction call, no 20k-token prompt, identical result every time.
//
// Cheap path first: an item whose text states no unit-bearing quantity is marked
// facts_status='none' with NO AI call at all.
const pool = require('../db/pool');
const provider = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');
const nc = require('./numberCheck');
const dp = require('./datasetPipeline');

const QUANTITY_GROUPS = new Set(['mass', 'gal', 'bbl', 'bpd', 'liter', 'usd', 'eur', 'krw']);
// background extraction is spaced out so it never competes with interactive work
const limitFactsCall = createLimiter(1, 4000);

const textOf = (item) => [item.title, item.summary, item.ai_summary, item.insight, item.ai_insight].filter(Boolean).join(' ');
const hasQuantity = (text) => nc.extractQuantities(text).some((q) => QUANTITY_GROUPS.has(q.cls));

async function storeFacts(itemId, records) {
  for (const r of records) {
    await pool.query(
      `INSERT INTO item_facts (item_id, entity, site, metric, status, year, grp, amount, basis, original)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (item_id, entity, COALESCE(site,''), status, grp, amount) DO NOTHING`,
      [itemId, r.entity, r.site, r.metric, r.status, r.year, r.group, r.amount, r.basis, r.original]
    );
  }
}

async function markStatus(itemId, status) {
  await pool.query('UPDATE items SET facts_status = $1, facts_extracted_at = now() WHERE id = $2', [status, itemId]);
}

// Extracts, verifies and stores the facts of ONE item. Never throws.
async function extractFactsForItem(item) {
  try {
    const text = textOf(item);
    if (!hasQuantity(text)) { await markStatus(item.id, 'none'); return { status: 'none', facts: 0 }; }
    const block = `자료 1 — 제목: ${item.title}\n요약: ${item.summary || item.ai_summary || ''}${item.insight || item.ai_insight ? `\n인사이트: ${item.insight || item.ai_insight}` : ''}`;
    const result = await limitFactsCall(() => provider.callProviderWithFallback({
      system: dp.EXTRACTION_SYSTEM,
      user: dp.buildExtractionUser('이 자료에 명시된 모든 수량(생산능력, 생산량, 물량, 투자액 등)을 추출하라.', block),
    }));
    const records = dp.verifyRecords(dp.parseRecords(result.text).map((r) => ({ ...r, source: 1 })), [item], textOf, { density: null });
    await storeFacts(item.id, records);
    await markStatus(item.id, records.length ? 'done' : 'none');
    return { status: records.length ? 'done' : 'none', facts: records.length };
  } catch (err) {
    console.error(`item_facts extraction failed for item ${item && item.id}: ${err.message}`);
    return { status: 'error', facts: 0, error: err.message };
  }
}

// Called by the publish path; fire-and-forget by design.
function extractFactsInBackground(item) {
  if (process.env.ITEM_FACTS === 'off') return;
  extractFactsForItem(item).catch(() => {});
}

// Facts of the given candidate items, as dataset-pipeline records (source = candidate index + 1).
async function loadFactRecords(candidates) {
  const ids = candidates.map((c) => c.id).filter(Boolean);
  if (!ids.length) return { records: [], statusById: new Map() };
  const { rows: statuses } = await pool.query('SELECT id, facts_status FROM items WHERE id = ANY($1)', [ids]);
  const statusById = new Map(statuses.map((r) => [r.id, r.facts_status]));
  const { rows } = await pool.query('SELECT item_id, entity, site, metric, status, year, grp, amount, basis, original FROM item_facts WHERE item_id = ANY($1)', [ids]);
  const indexById = new Map(candidates.map((c, i) => [c.id, i + 1]));
  const pubById = new Map(candidates.map((c) => [c.id, c.published_at || null]));
  const records = rows.map((r) => ({
    entity: r.entity, site: r.site, metric: r.metric, status: r.status, year: r.year, source: indexById.get(r.item_id),
    group: r.grp, amount: Number(r.amount), basis: r.basis, original: r.original, pubAt: pubById.get(r.item_id) || null,
    tons: null,
  }));
  return { records, statusById };
}

// DB-wide facts for a topic ("SAF", "팜유"...): every stored fact of every PUBLISHED item whose
// text mentions one of the topic terms — so a quantity dataset is complete over the whole
// archive, not just over the handful of articles that happened to rank into the chat's top-N.
// Returned items are appended after the chat's own candidates (sources are numbered after them).
async function loadFactsByTopic(topicForms, { excludeIds = [], baseIndex = 0, maxItems = 150 } = {}) {
  const forms = (topicForms || []).map((f) => String(f).trim()).filter((f) => f.length >= 2);
  if (!forms.length) return { records: [], items: [] };
  const pats = forms.map((f) => `%${f}%`);
  const { rows: items } = await pool.query(
    `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name
     FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.status = 'Published' AND i.facts_status = 'done' AND NOT (i.id = ANY($2))
       AND EXISTS (SELECT 1 FROM item_facts f WHERE f.item_id = i.id)
       AND (i.title ILIKE ANY($1) OR i.summary ILIKE ANY($1) OR i.ai_summary ILIKE ANY($1) OR i.insight ILIKE ANY($1))
     ORDER BY i.published_at DESC NULLS LAST LIMIT $3`,
    [pats, excludeIds.length ? excludeIds : [0], maxItems]
  );
  if (!items.length) return { records: [], items: [] };
  const { rows } = await pool.query(
    'SELECT item_id, entity, site, metric, status, year, grp, amount, basis, original FROM item_facts WHERE item_id = ANY($1)',
    [items.map((i) => i.id)]
  );
  const indexById = new Map(items.map((it, k) => [it.id, baseIndex + k + 1]));
  const pubById = new Map(items.map((it) => [it.id, it.published_at || null]));
  const records = rows.map((r) => ({
    entity: r.entity, site: r.site, metric: r.metric, status: r.status, year: r.year, source: indexById.get(r.item_id),
    group: r.grp, amount: Number(r.amount), basis: r.basis, original: r.original, pubAt: pubById.get(r.item_id) || null, tons: null,
  }));
  return { records, items };
}

// Backfill: facts for already-published items, newest first, resumable (facts_status IS NULL).
const backfillStatus = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, withFacts: 0, none: 0, errors: 0 };
async function runBackfill({ limit = 300 } = {}) {
  if (backfillStatus.running) return { started: false, reason: 'already_running' };
  const { rows } = await pool.query(
    `SELECT id, title, summary, ai_summary, insight, ai_insight FROM items
     WHERE status = 'Published' AND facts_status IS NULL
     ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1`,
    [Math.min(Number(limit) || 300, 2000)]
  );
  Object.assign(backfillStatus, { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: rows.length, done: 0, withFacts: 0, none: 0, errors: 0 });
  (async () => {
    try {
      for (const item of rows) {
        const r = await extractFactsForItem(item);
        backfillStatus.done++;
        if (r.status === 'done') backfillStatus.withFacts++;
        else if (r.status === 'none') backfillStatus.none++;
        else backfillStatus.errors++;
      }
    } finally {
      backfillStatus.running = false;
      backfillStatus.finishedAt = new Date().toISOString();
      console.log(`item_facts backfill completed ${JSON.stringify(backfillStatus)}`);
    }
  })();
  return { started: true, total: rows.length };
}

module.exports = { loadFactsByTopic, extractFactsForItem, extractFactsInBackground, loadFactRecords, runBackfill, getBackfillStatus: () => backfillStatus, hasQuantity, textOf };
