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

router.delete('/:id', requireAuth, async (req, res) => {
  await pool.query('UPDATE companies SET watched = false WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
