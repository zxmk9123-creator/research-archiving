const express = require('express');
const reg = require('../lib/entityRegistry');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const rows = await reg.lookup(req.query.q ? String(req.query.q) : null);
  res.json({ count: rows.length, rows });
});
router.post('/learn-bilingual', requireAuth, async (req, res) => res.json(await reg.learnBilingual({ limit: req.body && req.body.limit })));
router.post('/reject-alias', requireAuth, async (req, res) => res.json(await reg.rejectAlias(req.body && req.body.term)));
router.get('/maintenance-status', requireAuth, async (req, res) => res.json(await require('../lib/entityMaintenance').getMaintenanceStatus()));
router.post('/maintenance/run', requireAuth, async (req, res) => res.json(await require('../lib/entityMaintenance').runMaintenance()));
router.post('/rebuild', requireAuth, async (req, res) => res.json(await reg.rebuild()));
router.post('/reclassify-roles', requireAuth, async (req, res) => res.json(await reg.reclassifyRoles({ limit: req.body && req.body.limit })));
router.post('/classify-roles', requireAuth, async (req, res) => res.json(await reg.classifyRoles({ limit: req.body && req.body.limit })));

module.exports = router;
