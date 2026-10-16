const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM companies ORDER BY name');
  res.json(rows);
});

router.post('/', requireAuth, async (req, res) => {
  const { name, aliases } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await pool.query(
    `INSERT INTO companies (name, aliases) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET aliases = EXCLUDED.aliases RETURNING *`,
    [name, aliases || []]
  );
  res.status(201).json(rows[0]);
});

// Auto-discovered companies (see lib/companyDiscovery.js): candidates still
// collecting mentions, those promoted to the watchlist, and ignored ones.
router.get('/candidates', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT name_key, name, mention_count, cardinality(item_ids) AS items, status, company_id, last_seen_at, promoted_at
     FROM company_candidates ORDER BY (status = 'candidate') DESC, mention_count DESC, last_seen_at DESC LIMIT 200`
  );
  res.json(rows);
});
router.post('/candidates/:key/ignore', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    "UPDATE company_candidates SET status = 'ignored' WHERE name_key = $1 AND status = 'candidate'",
    [String(req.params.key || '').toLowerCase()]
  );
  res.status(rowCount ? 200 : 404).json({ ok: rowCount > 0 });
});

router.delete('/:id', requireAuth, async (req, res) => {
  await pool.query('UPDATE companies SET watched = false WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
