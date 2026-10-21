const express = require('express');
const pool = require('../db/pool');
const ev = require('../lib/evalRunner');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

// GET /api/eval/latest — the last runs (admin only), newest first, with the failing cases of each.
router.get('/latest', requireAuth, async (req, res) => {
  try { res.json({ runs: await ev.getRecent(pool, Math.min(Number(req.query.n) || 10, 50)) }); } catch (err) { res.status(500).json({ error: err.message }); }
});
// POST /api/eval/run — run the golden set now (deterministic suites + live audit) and store the result.
router.post('/run', requireAuth, async (req, res) => {
  try { res.json(await ev.runAll(pool)); } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
