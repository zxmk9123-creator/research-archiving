const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/sectors', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, parent_id FROM sectors ORDER BY parent_id NULLS FIRST, id');
  res.json(rows);
});

router.get('/usages', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM usages ORDER BY id');
  res.json(rows);
});

module.exports = router;
