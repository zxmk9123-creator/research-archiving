const express = require('express');
const reg = require('../lib/entityRegistry');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const rows = await reg.lookup(req.query.q ? String(req.query.q) : null);
  res.json({ count: rows.length, rows });
});
router.post('/rebuild', requireAuth, async (req, res) => res.json(await reg.rebuild()));
router.post('/classify-roles', requireAuth, async (req, res) => res.json(await reg.classifyRoles({ limit: req.body && req.body.limit })));

module.exports = router;
