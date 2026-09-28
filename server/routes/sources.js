const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*,
      (s.last_collected_at IS NULL OR s.last_collected_at < now() - (s.frequency_days || ' days')::interval) AS stale
    FROM sources s ORDER BY s.name
  `);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, publisher, url, method, frequency_days, owner, trust_grade } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await pool.query(
    `INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, publisher || null, url || null, method || 'manual', frequency_days || 1, owner || null, trust_grade || 'A']
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
