const express = require('express');
const pool = require('../db/pool');
const { matchCompanies } = require('../lib/companyMatch');
const { extractMetadata } = require('../lib/extractMetadata');
const { generateAiDraftForItem } = require('../lib/aiDraft');

const router = express.Router();

router.post('/extract-metadata', async (req, res) => {
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
  const { q, sector, usage, type, source_id, status, from, to } = req.query;
  const clauses = [];
  const params = [];

  if (status) { params.push(status); clauses.push(`i.status = $${params.length}`); }
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
router.post('/:id/ai-draft', async (req, res) => {
  const { rows } = await pool.query('SELECT id, status, ai_status FROM items WHERE id = $1', [req.params.id]);
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.status !== 'Draft') {
    return res.status(400).json({ error: 'Draft 상태의 항목만 AI 초안을 생성할 수 있습니다.' });
  }
  if (item.ai_status === 'pending') {
    return res.status(409).json({ error: 'AI 초안 생성이 이미 진행 중입니다.' });
  }

  const result = await generateAiDraftForItem(item.id);
  const { rows: full } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [item.id]);
  res.json({ ok: result.ok, error: result.error, item: full[0] });
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

router.post('/', async (req, res) => {
  const {
    title, source_url, pdf_url, published_at, source_id, type,
    summary, insight, attribution, thumbnail_url,
    sector_ids = [], usage_ids = [],
  } = req.body;
  if (!title || !source_url || !type) {
    return res.status(400).json({ error: 'title, source_url, type required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO items (title, source_url, pdf_url, published_at, source_id, type, summary, insight, attribution, thumbnail_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [title, source_url, pdf_url || null, published_at || null, source_id || null, type, summary || null, insight || null, attribution || null, thumbnail_url || null]
  );
  const item = rows[0];
  await setTags(item.id, sector_ids, usage_ids);
  await matchCompanies(item.id, `${title} ${summary || ''}`);
  const { rows: full } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [item.id]);
  res.status(201).json(full[0]);
});

router.patch('/:id', async (req, res) => {
  const id = req.params.id;
  const fields = ['title', 'source_url', 'pdf_url', 'published_at', 'source_id', 'type', 'summary', 'insight', 'attribution', 'thumbnail_url', 'status', 'reviewer_eligible'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (sets.length) {
    params.push(id);
    await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  if (req.body.sector_ids !== undefined || req.body.usage_ids !== undefined) {
    const { rows: current } = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    if (!current[0]) return res.status(404).json({ error: 'not found' });
    await setTags(
      id,
      req.body.sector_ids !== undefined ? req.body.sector_ids : [],
      req.body.usage_ids !== undefined ? req.body.usage_ids : []
    );
  }
  const { rows: full } = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  if (!full[0]) return res.status(404).json({ error: 'not found' });
  res.json(full[0]);
});

router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM items WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

module.exports = router;
