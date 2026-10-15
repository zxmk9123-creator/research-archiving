// Scope-tuning proposals (see lib/scopeAnalysis.js). Reading is public like
// every other Ops read model; anything that changes behavior — running the
// analysis, approving, rejecting — is admin-only.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth');
// Module object (not destructured) so tests can mock without a database/LLM.
const scopeAnalysis = require('../lib/scopeAnalysis');

const router = express.Router();
let analysisRunning = false;

router.get('/', async (req, res) => {
  try {
    const status = ['pending', 'applied', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const [{ rows: proposals }, { rows: terms }] = await Promise.all([
      pool.query(
        `SELECT id, kind, term, rationale, evidence, status, created_at, decided_at
           FROM scope_proposals WHERE status = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
        [status]
      ),
      pool.query('SELECT term, mode FROM scope_terms ORDER BY created_at DESC LIMIT 200'),
    ]);
    res.json({ proposals, activeTerms: terms, analysisRunning, minExclusions: scopeAnalysis.MIN_EXCLUSIONS });
  } catch (err) {
    console.error(`GET /api/scope-proposals failed: ${err.message}`);
    res.status(500).json({ error: '범위 조정 제안을 불러오지 못했습니다.' });
  }
});

// Starts the analysis in the background (an LLM call can outlast a proxy
// timeout); the page re-reads GET / to see results.
router.post('/run', requireAuth, (req, res) => {
  if (analysisRunning) return res.status(202).json({ started: false, reason: 'already_running' });
  analysisRunning = true;
  scopeAnalysis.runScopeAnalysis()
    .then((r) => console.log(`scope_analysis manual run: ${JSON.stringify(r)}`))
    .catch((err) => console.error(`scope_analysis manual run failed: ${err.message}`))
    .finally(() => { analysisRunning = false; });
  res.status(202).json({ started: true });
});

function decide(action) {
  return async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
    try {
      const result = await scopeAnalysis[action](id);
      if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
      res.json({ ok: true });
    } catch (err) {
      console.error(`scope proposal ${action} failed: ${err.message}`);
      res.status(500).json({ error: '처리하지 못했습니다.' });
    }
  };
}
router.post('/:id/approve', requireAuth, decide('applyProposal'));
router.post('/:id/reject', requireAuth, decide('rejectProposal'));

module.exports = router;
