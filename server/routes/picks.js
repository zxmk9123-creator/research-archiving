const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  const { item_id, user_email, kind } = req.query;
  const clauses = [];
  const params = [];
  if (item_id) { params.push(item_id); clauses.push(`item_id = $${params.length}`); }
  if (user_email) { params.push(user_email); clauses.push(`user_email = $${params.length}`); }
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM picks ${where} ORDER BY created_at DESC`, params);
  res.json(rows);
});

// Team-pick ranking: most-saved items.
router.get('/ranking', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT i.id, i.title, i.type, COUNT(p.id) AS pick_count
    FROM picks p JOIN items i ON i.id = p.item_id
    WHERE p.kind = 'team'
    GROUP BY i.id ORDER BY pick_count DESC LIMIT 20
  `);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { item_id, user_email, kind, memo } = req.body;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const { rows } = await pool.query(
    `INSERT INTO picks (item_id, user_email, kind, memo) VALUES ($1,$2,$3,$4) RETURNING *`,
    [item_id, user_email || null, kind || 'personal', memo || null]
  );
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM picks WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
