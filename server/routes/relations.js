const express = require('express');
const pool = require('../db/pool');
const rel = require('../lib/companyRelations');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

// GET /api/relations?entity=Neste  — relations touching the entity (either side), grouped by type, with the source article.
router.get('/', requireAuth, async (req, res) => {
  const entity = String(req.query.entity || '').trim();
  const rows = entity
    ? await rel.relationsFor([entity], { limit: 200 })
    : (await pool.query('SELECT id, src, dst, relation, share_pct, evidence, origin, item_id FROM company_relations ORDER BY created_at DESC LIMIT 200')).rows;
  res.json({ count: rows.length, labels: rel.LABEL, rows: rows.map((r) => ({ ...r, text: rel.describe(r) })) });
});

// GET /api/relations/summary — totals for the whole map (the list endpoint is capped at 200 rows).
router.get('/summary', requireAuth, async (req, res) => {
  const [tot, byRel, byOrigin, ents, items, top, pubs] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM company_relations'),
    pool.query('SELECT relation, COUNT(*)::int AS n FROM company_relations GROUP BY relation ORDER BY n DESC'),
    pool.query('SELECT origin, COUNT(*)::int AS n FROM company_relations GROUP BY origin'),
    pool.query('SELECT COUNT(DISTINCT LOWER(e))::int AS n FROM (SELECT src AS e FROM company_relations UNION ALL SELECT dst FROM company_relations) x'),
    pool.query('SELECT COUNT(DISTINCT item_id)::int AS n FROM company_relations WHERE item_id IS NOT NULL'),
    pool.query('SELECT e AS entity, COUNT(*)::int AS n FROM (SELECT src AS e FROM company_relations UNION ALL SELECT dst FROM company_relations) x GROUP BY e ORDER BY n DESC LIMIT 15'),
    pool.query("SELECT COUNT(*)::int AS published, COUNT(*) FILTER (WHERE relations_status IS NOT NULL)::int AS processed, COUNT(*) FILTER (WHERE relations_status = 'done')::int AS with_relations FROM items WHERE status = 'Published'"),
  ]);
  res.json({ total: tot.rows[0].n, byRelation: byRel.rows, byOrigin: byOrigin.rows, entities: ents.rows[0].n, sourceItems: items.rows[0].n, topEntities: top.rows, coverage: pubs.rows[0] });
});

router.get('/status', requireAuth, (req, res) => res.json({ ...rel.getStatus() }));

router.post('/seed-from-facts', requireAuth, async (req, res) => res.json({ seeded: await rel.seedFromFacts() }));

router.post('/cleanup', requireAuth, async (req, res) => res.json(await rel.cleanupRelations()));

router.post('/requeue', requireAuth, async (req, res) => res.json(await rel.requeueByEvidence(Array.isArray(req.body && req.body.names) ? req.body.names.slice(0, 20) : [])));

router.post('/backfill', requireAuth, async (req, res) => res.json(await rel.runBackfill({ limit: req.body && req.body.limit })));

// Manual curation: add / remove a row. Manual rows are never overwritten by the AI pass.
router.post('/', requireAuth, async (req, res) => {
  const b = req.body || {};
  const row = { src: String(b.src || '').trim(), dst: String(b.dst || '').trim(), relation: b.relation, share_pct: Number(b.share_pct) > 0 ? Number(b.share_pct) : null, evidence: b.evidence ? String(b.evidence).slice(0, 240) : null };
  if (!row.src || !row.dst || !rel.RELATIONS.includes(row.relation)) return res.status(400).json({ error: 'src, dst and a valid relation are required' });
  await rel.storeRelations([row], null, 'manual');
  res.status(201).json({ ok: true });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const r = await pool.query('DELETE FROM company_relations WHERE id = $1', [id]);
  res.status(r.rowCount ? 200 : 404).json({ ok: r.rowCount > 0 });
});

module.exports = router;
