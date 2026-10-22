const express = require('express');
const pool = require('../db/pool');
const { matchCompanies } = require('../lib/companyMatch');
const { extractMetadata, extractMetadataWithRetry } = require('../lib/extractMetadata');
const { generateAiDraftForItem, applyAiDraftIfEligible } = require('../lib/aiDraft');
const { requireAuth } = require('../lib/auth');
const { hasValidClassification, deriveContentCategory } = require('../lib/classification');

const router = express.Router();

function titleFromUrlPath(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    let segment;
    try {
      segment = decodeURIComponent(segments[i]);
    } catch {
      continue;
    }
    segment = segment.replace(/\.(html?|article|aspx?)$/i, '');
    if (!/[a-z]/i.test(segment) || /^\d+$/.test(segment)) continue;
    const words = segment.replace(/[-_]+/g, ' ').trim().split(/\s+/);
    return words.map((word) => {
      const lower = word.toLowerCase();
      if (['uk', 'saf', 'eu', 'us'].includes(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
  }
  return null;
}

// Item facts backfill (lib/itemFacts.js): extracts, verifies and stores the quantities of
// already-published items, newest first, in the background (batch lane, throttled).
// Resumable: only items with facts_status IS NULL are picked, so repeating continues.
router.post('/backfill-facts', requireAuth, async (req, res) => {
  const itemFacts = require('../lib/itemFacts');
  const r = await itemFacts.runBackfill({ limit: req.body && req.body.limit, mode: req.body && ['product', 'kind'].includes(req.body.mode) ? req.body.mode : 'new' });
  res.status(r.started ? 202 : 409).json(r);
});
// Annual-report extraction TRIAL (lib/annualReport.js): downloads a PDF, selects the few pages that state
// capacity/output/area figures without any AI call, extracts only those pages, verifies every figure against
// its page. Returns the result for review; stores nothing.
router.post('/annual-report-trial', requireAuth, async (req, res) => {
  try {
    const { url, entity, publishedAt, store } = req.body || {};
    if (!/^https:\/\//.test(String(url || '')) || !entity) return res.status(400).json({ error: 'https url and entity required' });
    const { ingestAnnualReport } = require('../lib/annualReportIngest');
    res.json(await ingestAnnualReport({ url, entity, publishedAt: publishedAt || null, store: store === true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Read-only view of the stored annual-report facts (review / debugging): ?entity=&q=<metric text>
router.get('/annual-report-facts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT entity, fiscal_year, segment, scope, location, metric, value, value_max, unit, definition, page FROM annual_report_facts
     WHERE ($1::text IS NULL OR lower(entity) = lower($1)) AND ($2::text IS NULL OR metric ILIKE '%' || $2 || '%') ORDER BY entity, page, id LIMIT 500`,
    [req.query.entity || null, req.query.q || null]
  );
  res.json({ count: rows.length, rows });
});
// Read-only view of stored item_facts with their source article (review): ?entity=<name>
router.get('/facts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.entity, f.site, f.metric, f.status, f.year, f.grp, f.amount, f.original, f.basis, f.entity_type, f.product, f.kind, i.id AS item_id, COALESCE(i.ai_summary, i.summary) AS summary, i.title, i.published_at
       FROM item_facts f JOIN items i ON i.id = f.item_id
      WHERE ($1::text IS NULL OR f.entity ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR f.kind = $2) ORDER BY ${req.query.kind ? 'random()' : 'f.entity, i.published_at DESC NULLS LAST'} LIMIT 200`,
    [req.query.entity || null, req.query.kind || null]
  );
  res.json({ count: rows.length, rows });
});
// Review autopilot (lib/reviewAutopilot.js): the scheduler runs it by itself; these are for operators.
router.post('/auto-review/run', requireAuth, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isSafeInteger(n)).slice(0, 200) : null;
  res.json(await require('../lib/reviewAutopilot').runAutopilot({ dryRun: b.dryRun === true, aiBudget: Math.min(Number(b.aiBudget) || 8, 40), ids }));
});
router.get('/auto-review/status', requireAuth, async (req, res) => {
  res.json(await require('../lib/reviewAutopilot').getStatus());
});
router.post('/:id/restore', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = await require('../lib/reviewAutopilot').restore(id);
  res.status(ok ? 200 : 404).json({ ok });
});
router.post('/backfill-published-dates', requireAuth, async (req, res) => {
  res.json(await require('../lib/publishedDates').backfillPublishedDates());
});
// Fills undated published items from the date their own page declares; call again with afterId = nextAfterId until remainingAfter is 0.
router.post('/backfill-published-dates-pages', requireAuth, async (req, res) => {
  res.json(await require('../lib/publishedDates').backfillFromPages({ limit: Math.min(80, Number(req.query.limit) || 40), afterId: Number(req.query.afterId) || 0 }));
});
router.post('/annual-report-rebuild', requireAuth, async (req, res) => {
  try { res.json(await require('../lib/annualReportIngest').rebuildReportItems()); } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/classify-entities', requireAuth, async (req, res) => {
  const r = await require('../lib/itemFacts').classifyEntities();
  res.status(r.started ? 202 : 409).json(r);
});
router.get('/classify-entities/status', requireAuth, (req, res) => res.json(require('../lib/itemFacts').getClassifyStatus()));
router.get('/backfill-facts/status', requireAuth, (req, res) => {
  res.json(require('../lib/itemFacts').getBackfillStatus());
});

router.post('/extract-metadata', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const meta = await extractMetadata(url);
    res.json(meta);
  } catch (err) {
    // Preserve the SSRF/URL validation boundary: only ordinary page-fetch or
    // extraction failures receive this manual-form fallback. Invalid and
    // explicitly unsafe URLs still return an error.
    if (/^unsafe URL:|^unsafe url:/i.test(err.message)) {
      return res.status(422).json({ error: `metadata extraction failed: ${err.message}` });
    }
    const title = titleFromUrlPath(url);
    if (!title) {
      return res.status(422).json({ error: `metadata extraction failed: ${err.message}` });
    }
    console.warn(`manual metadata fallback: URL title only for ${url}: ${err.message}`);
    res.json({
      title,
      summary: null,
      thumbnail_url: null,
      published_at: null,
      body_text: null,
      metadata_source: 'url_fallback',
      metadata_warning: '페이지 접근이 제한되어 URL에서 제목만 추정했습니다. 원문 확인이 필요합니다.',
    });
  }
});

// One-off bulk re-processing: re-extracts body_text (via extractMetadata,
// now cheerio-based with structural boilerplate exclusion — see
// extractMetadata.js) and regenerates ai_summary/ai_insight for every
// still-unreviewed Draft item, so the quality improvement from that
// switch reaches items collected before it, not just new ones going
// forward. Scoped to Draft only, by design: a Published item's
// summary/insight is whatever a reviewer already confirmed, and
// silently overwriting that behind their back (even just its ai_* advisory
// fields) is a worse outcome than leaving older Published items as-is.
//
// Responds immediately and does the actual work in the background rather
// than blocking the request for however long several hundred sequential
// external fetches + AI calls take — a review-audit run earlier this
// session doing exactly that (one long synchronous loop inside a single
// request) made the whole server feel unresponsive for other requests
// while it ran. generateAiDraftForItem's own limitAiCall already bounds
// AI call concurrency/rate; the external re-fetch here stays sequential
// (one site at a time) rather than hammering many different origins at
// once.
async function reextractDraftsInBackground(rows) {
  let ok = 0;
  let failed = 0;
  console.log(`reextract-drafts started: ${rows.length} Draft item(s)`);
  for (const { id, source_url } of rows) {
    try {
      const meta = await extractMetadataWithRetry(source_url);
      const result = await generateAiDraftForItem(id, undefined, meta.body_text || meta.summary);
      if (result.ok) ok++; else failed++;
    } catch (err) {
      failed++;
      console.error(`reextract-drafts: item ${id} failed: ${err.message}`);
    }
  }
  console.log(`reextract-drafts completed: ok=${ok} failed=${failed} total=${rows.length}`);
}

router.post('/reextract-drafts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, source_url FROM items WHERE status = 'Draft' AND source_url IS NOT NULL`
  );
  res.json({ started: true, total: rows.length });
  require('../lib/background').track(reextractDraftsInBackground(rows).catch((err) => console.error('reextract-drafts failed', err)));
});

const ITEM_SELECT = `
  SELECT i.*, s.name AS source_name, s.trust_grade,
    COALESCE(sec.sectors, '[]') AS sectors,
    COALESCE(us.usages, '[]') AS usages,
    COALESCE(co.companies, '[]') AS companies
  FROM items i
  LEFT JOIN sources s ON s.id = i.source_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', sec.id, 'name', sec.name)) AS sectors
    FROM item_sectors isec JOIN sectors sec ON sec.id = isec.sector_id WHERE isec.item_id = i.id
  ) sec ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', u.id, 'name', u.name)) AS usages
    FROM item_usages iu JOIN usages u ON u.id = iu.usage_id WHERE iu.item_id = i.id
  ) us ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', c.id, 'name', c.name)) AS companies
    FROM item_companies ic JOIN companies c ON c.id = ic.company_id WHERE ic.item_id = i.id
  ) co ON true
`;

// Shared by GET / and GET /month-counts so the two can never drift apart —
// a filter that narrows the page's items must narrow the sidebar's month
// counts by the exact same rule, or the sidebar would promise months the
// filtered list doesn't actually contain.
function buildItemFilterClauses(query) {
  const { q, sector, usage, type, source_id, status, from, to, category } = query;
  const clauses = [];
  const params = [];

  if (status) { params.push(status); clauses.push(`i.status = $${params.length}`); }
  if (category) { params.push(category); clauses.push(`i.content_category = $${params.length}`); }
  if (type) { params.push(type); clauses.push(`i.type = $${params.length}`); }
  if (source_id) { params.push(source_id); clauses.push(`i.source_id = $${params.length}`); }
  if (from) { params.push(from); clauses.push(`i.published_at >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`i.published_at <= $${params.length}`); }
  if (q) { params.push(`%${q}%`); clauses.push(`(i.title ILIKE $${params.length} OR i.summary ILIKE $${params.length})`); }
  if (sector) {
    // Comma-separated list of sector ids (multi-select tree filter); a single id still works.
    const sectorIds = String(sector).split(',').map(Number).filter((n) => !Number.isNaN(n));
    if (sectorIds.length) {
      params.push(sectorIds);
      clauses.push(`EXISTS (SELECT 1 FROM item_sectors isec WHERE isec.item_id = i.id AND isec.sector_id = ANY($${params.length}))`);
    }
  }
  if (usage) {
    params.push(usage);
    clauses.push(`EXISTS (SELECT 1 FROM item_usages iu WHERE iu.item_id = i.id AND iu.usage_id = $${params.length})`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// Full-result month counts for the 자료 tab's year-month sidebar — computed
// against the SAME filters as GET / but independent of its limit/offset, so
// a month from before the current 100-item page never silently disappears
// from the sidebar (production bug: the sidebar used to be built from only
// the already-paginated page of items, so months outside that page looked
// like they'd vanished rather than just being on a later page). The client
// jumps to a month by re-querying GET / with from/to set to that month's
// bounds, not by fetching everything at once — so pagination's performance
// benefit for the main list is unaffected.
router.get('/month-counts', async (req, res) => {
  const { where, params } = buildItemFilterClauses(req.query);
  try {
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month', i.published_at), 'YYYY-MM') AS month_key, COUNT(*)::int AS count
       FROM items i
       ${where}
       GROUP BY month_key
       ORDER BY month_key DESC NULLS LAST`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/items/month-counts failed:', err.message);
    res.status(500).json({ error: '월별 집계를 불러오는 중 오류가 발생했습니다.' });
  }
});

router.get('/', async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const offset = Math.min(100000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
  const { where, params } = buildItemFilterClauses(req.query);
  params.push(limit + 1, offset);
  const orderBy = req.query.status === 'Draft'
    ? 'ORDER BY CASE WHEN i.reviewer_eligible IS NULL THEN 0 ELSE 1 END, i.collected_at DESC, i.id DESC'
    : 'ORDER BY i.published_at DESC NULLS LAST, i.collected_at DESC, i.id DESC';
  try {
    // LIMIT/OFFSET must be bind placeholders ($N), not the raw param-array
    // length spliced into the SQL text — that previously left `params`
    // carrying 2 values the query text never referenced, which Postgres
    // rejects ("bind message supplies N parameters, but prepared statement
    // requires M"). An unhandled rejection from that mismatch crashed the
    // whole Node process (unhandled rejection terminates by default),
    // taking down every other in-flight request until Railway restarted
    // the container — so this query is now also wrapped like the INSERT
    // above.
    const { rows } = await pool.query(
      `${ITEM_SELECT} ${where} ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    res.set('X-Has-More', String(hasMore));
    res.json(rows);
  } catch (err) {
    console.error('GET /api/items failed:', err.message);
    res.status(500).json({ error: '목록을 불러오는 중 오류가 발생했습니다.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/items/:id failed:', err.message);
    res.status(500).json({ error: '항목을 불러오는 중 오류가 발생했습니다.' });
  }
});

// Related = published items sharing at least one sector or usage tag,
// ranked by how many tags overlap. No separate recommendation model needed.
router.get('/:id/related', async (req, res) => {
  const { rows } = await pool.query(`
    ${ITEM_SELECT}
    WHERE i.id <> $1 AND i.status = 'Published'
      AND (
        EXISTS (SELECT 1 FROM item_sectors a WHERE a.item_id = i.id AND a.sector_id IN (SELECT sector_id FROM item_sectors WHERE item_id = $1))
        OR EXISTS (SELECT 1 FROM item_usages a WHERE a.item_id = i.id AND a.usage_id IN (SELECT usage_id FROM item_usages WHERE item_id = $1))
      )
    ORDER BY (
      (SELECT COUNT(*) FROM item_sectors a WHERE a.item_id = i.id AND a.sector_id IN (SELECT sector_id FROM item_sectors WHERE item_id = $1))
      + (SELECT COUNT(*) FROM item_usages a WHERE a.item_id = i.id AND a.usage_id IN (SELECT usage_id FROM item_usages WHERE item_id = $1))
    ) DESC, i.published_at DESC NULLS LAST
    LIMIT 6
  `, [req.params.id]);
  res.json(rows);
});

// Manual trigger/retry for a Draft item's AI draft. Restricted to Draft
// status (the milestone's scope: newly collected / manually added Draft
// items — never bulk-regenerating the published archive). A reviewer may
// explicitly retry even after 'completed'; concurrent 'pending' is rejected
// so double-clicking can't fire two overlapping generations for one item.
router.post('/:id/ai-draft', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, status, ai_status, source_url FROM items WHERE id = $1', [req.params.id]);
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.status !== 'Draft') {
    return res.status(400).json({ error: 'Draft 상태의 항목만 AI 초안을 생성할 수 있습니다.' });
  }
  if (item.ai_status === 'pending') {
    return res.status(409).json({ error: 'AI 초안 생성이 이미 진행 중입니다.' });
  }

  // Flip to pending synchronously (so a double-click / concurrent request
  // is rejected by the check above, same as before) and respond right
  // away — the slow part (re-extracting body text from source_url when the
  // caller didn't already send it, then the AI call itself, anywhere from a
  // few seconds to well over a minute) now runs in the background instead
  // of making the button wait it out. The frontend already polls the
  // item's ai_status after this call (triggerAiDraftAndPoll in app.js,
  // added earlier for a gateway-timeout issue) regardless of what this
  // response contains, so this was previously wasted architecture — the
  // route still made the client wait out the whole generation before that
  // polling ever got a chance to start.
  await pool.query(`UPDATE items SET ai_status = 'pending', ai_error = NULL WHERE id = $1`, [item.id]);

  const providedText = req.body.extracted_text || undefined;
  (async () => {
    // Richer source material than item.summary alone — same principle
    // wherever an AI draft is (re)generated, manual or collected: the
    // fuller <p> body text beats a one-line og:description/RSS-teaser
    // summary, because a deeper point the article makes (e.g. an economic
    // argument a few paragraphs in) is otherwise invisible to the model.
    // The manual-registration form already has this from its own
    // metadata-extraction step and sends it directly; a retry/regenerate
    // on an existing item has no such client-side value to send, so
    // re-extract it from the item's own source_url here instead.
    // Best-effort: a failed re-fetch (dead link, blocked, no body text
    // found) just falls through to the existing summary-based behavior.
    let extractedText = providedText;
    if (!extractedText && item.source_url) {
      try {
        // extractMetadataWithRetry (see its own comment in
        // extractMetadata.js) — this is the one route both an initial
        // manual "AI 초안 작성" click and a later "다시 생성" go through,
        // so giving it the same retry chance on both calls removes the
        // "regenerate just happens to work better" disparity at the source.
        const meta = await extractMetadataWithRetry(item.source_url);
        extractedText = meta.body_text || undefined;
      } catch (err) {
        // Not fatal — generateAiDraftForItem falls back to item.summary.
        console.warn(`ai-draft body extraction failed for item ${item.id}: ${err.message}`);
      }
    }
    await generateAiDraftForItem(item.id, undefined, extractedText);
  })().catch((err) => {
    // generateAiDraftForItem itself never throws (see aiDraft.js), so this
    // only catches something going wrong in the re-extraction wrapper
    // above — never let it become an unhandled rejection.
    console.error(`background ai-draft generation failed for item ${item.id}:`, err);
  });

  const { rows: full } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [item.id]);
  res.json({ ok: true, pending: true, item: full[0] });
});

async function setTags(itemId, sectorIds = [], usageIds = []) {
  await pool.query('DELETE FROM item_sectors WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM item_usages WHERE item_id = $1', [itemId]);
  if (sectorIds.length) {
    const values = sectorIds.map((sid) => `(${itemId}, ${Number(sid)})`).join(',');
    await pool.query(`INSERT INTO item_sectors (item_id, sector_id) VALUES ${values}`);
  }
  if (usageIds.length) {
    const values = usageIds.map((uid) => `(${itemId}, ${Number(uid)})`).join(',');
    await pool.query(`INSERT INTO item_usages (item_id, usage_id) VALUES ${values}`);
  }
}

router.post('/', requireAuth, async (req, res) => {
  const {
    title, source_url, pdf_url, published_at, source_id, type,
    summary, insight, attribution, thumbnail_url,
    sector_ids = [], usage_ids = [],
  } = req.body;
  if (!title || !source_url || !type) {
    return res.status(400).json({ error: 'title, source_url, type required' });
  }
  let item;
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (title, source_url, pdf_url, published_at, source_id, type, summary, insight, attribution, thumbnail_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [title, source_url, pdf_url || null, published_at || null, source_id || null, type, summary || null, insight || null, attribution || null, thumbnail_url || null]
    );
    item = rows[0];
  } catch (err) {
    // idx_items_source_url_unique — an unhandled constraint violation here
    // previously crashed the whole Node process (unhandled rejection),
    // returning a 502 "Application failed to respond" to every request
    // against the app until Railway restarted the container. A duplicate
    // source_url is routine (double-click, retry on the same URL after an
    // earlier attempt already saved it) and must stay a normal 409, never
    // take the app down.
    if (err.code === '23505') {
      return res.status(409).json({ error: '이미 등록된 원문 URL입니다. 기존 Draft를 목록에서 확인하세요.' });
    }
    // Any other insert failure: respond with 500 rather than rethrowing —
    // Express 4 does not catch a rejected async handler, so an uncaught
    // throw here is exactly the same whole-process crash this fix exists
    // to prevent, just for a different error.
    console.error('POST /items insert failed:', err);
    return res.status(500).json({ error: 'failed to save item' });
  }
  await setTags(item.id, sector_ids, usage_ids);
  await matchCompanies(item.id, `${title} ${summary || ''}`);
  const { rows: full } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [item.id]);
  res.status(201).json(full[0]);
});

router.patch('/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { rows: existingRows } = await pool.query('SELECT id, type FROM items WHERE id = $1', [id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'not found' });

  // Apply any tag changes from this same request first, so a reviewer
  // classifying and publishing an item in one PATCH (sector_ids/usage_ids
  // + status='Published' together) is evaluated against its new tags,
  // not whatever existed before this request.
  if (req.body.sector_ids !== undefined || req.body.usage_ids !== undefined) {
    await setTags(
      id,
      req.body.sector_ids !== undefined ? req.body.sector_ids : [],
      req.body.usage_ids !== undefined ? req.body.usage_ids : []
    );
  }

  // Minimum classification invariant: the manual Review path can never
  // publish an item with no sector/usage tags, same as the autonomous
  // applyAiDraftIfEligible() path in aiDraft.js. An item already
  // Published, or a PATCH that doesn't touch status, is unaffected.
  if (req.body.status === 'Published' && !(await hasValidClassification(id))) {
    return res.status(400).json({ error: '최소 1개 이상의 섹터와 용도 분류가 있어야 발행할 수 있습니다.' });
  }

  const fields = ['title', 'source_url', 'pdf_url', 'published_at', 'source_id', 'type', 'summary', 'insight', 'attribution', 'thumbnail_url', 'status', 'reviewer_eligible'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  // Archive / Daily Report split, same deterministic type-based rule the
  // autonomous publish path (aiDraft.js) uses — set only when this request
  // actually publishes, against whichever type ends up effective (a type
  // change in the same request takes precedence over the stored one).
  if (req.body.status === 'Published') {
    const effectiveType = req.body.type !== undefined ? req.body.type : existingRows[0].type;
    params.push(deriveContentCategory(effectiveType));
    sets.push(`content_category = $${params.length}`);
  }
  if (sets.length) {
    params.push(id);
    await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }

  const { rows: full } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  res.json(full[0]);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM items WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// MANUAL AUDIT TOOL — re-judges every currently-Draft item with the AI
// pipeline as it stands right now (including the reviewer-feedback
// calibration block in aiDraft.js, which a Draft sitting unreviewed for a
// while never benefited from at its original collection time) and
// auto-publishes whatever now clears applyAiDraftIfEligible's bar. Not on
// a schedule — a Review workflow operator runs this deliberately to sweep
// the backlog after a judgment-quality change, same spirit as the existing
// one-time backfill tools in routes/sources.js. Sequential (not
// Promise.all) to keep logs readable and respect the AI call limiter in
// aiDraft.js the same way a burst of individual retries would; safe to
// re-run, since generateAiDraftForItem/applyAiDraftIfEligible are both
// idempotent per item.
router.post('/review-audit', requireAuth, async (req, res) => {
  const { rows: drafts } = await pool.query(
    `SELECT id, title, source_url, summary FROM items WHERE status = 'Draft' ORDER BY id`
  );
  const results = [];
  for (const item of drafts) {
    let extractedText;
    if (item.source_url) {
      try {
        const meta = await extractMetadataWithRetry(item.source_url);
        extractedText = meta.body_text || undefined;
      } catch (err) {
        // Best-effort, same fallback as POST /:id/ai-draft — falls through
        // to item.summary inside generateAiDraftForItem.
      }
    }
    const genResult = await generateAiDraftForItem(item.id, undefined, extractedText);
    if (!genResult.ok) {
      results.push({ id: item.id, title: item.title, outcome: 'ai_failed', error: genResult.error });
      continue;
    }
    const { archived } = await applyAiDraftIfEligible(item.id);
    results.push({ id: item.id, title: item.title, outcome: archived ? 'published' : 'still_draft' });
  }
  const totals = results.reduce(
    (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }),
    { published: 0, still_draft: 0, ai_failed: 0 }
  );
  console.log(`review-audit: ${drafts.length} drafts processed — ${JSON.stringify(totals)}`);
  res.json({ totalDrafts: drafts.length, totals, results });
});

module.exports = router;
