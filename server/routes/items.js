const express = require('express');
const pool = require('../db/pool');
const { matchCompanies } = require('../lib/companyMatch');
const { extractMetadata } = require('../lib/extractMetadata');
const { generateAiDraftForItem, applyAiDraftIfEligible } = require('../lib/aiDraft');
const { requireAuth } = require('../lib/auth');
const { hasValidClassification, deriveContentCategory } = require('../lib/classification');

const router = express.Router();

router.post('/extract-metadata', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const meta = await extractMetadata(url);
    res.json(meta);
  } catch (err) {
    res.status(422).json({ error: `metadata extraction failed: ${err.message}` });
  }
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

router.get('/', async (req, res) => {
  const { q, sector, usage, type, source_id, status, from, to, category } = req.query;
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

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`${ITEM_SELECT} ${where} ORDER BY i.published_at DESC NULLS LAST, i.collected_at DESC`, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
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
        const meta = await extractMetadata(item.source_url);
        extractedText = meta.body_text || undefined;
      } catch (err) {
        // Not fatal — generateAiDraftForItem falls back to item.summary.
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
        const meta = await extractMetadata(item.source_url);
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
