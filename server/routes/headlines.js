const express = require('express');
const dailyBriefModule = require('../lib/dailyBrief');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.get('/latest', async (req, res) => {
  try {
    res.json(await dailyBriefModule.getLatestDailyBrief());
  } catch (err) {
    console.error(`GET /api/headlines/latest failed: ${err.message}`);
    res.status(500).json({ error: '헤드라인 브리프를 불러오지 못했습니다.' });
  }
});

// Direct command endpoint: regenerate from the existing archive only.
// The scheduled routine keeps using queueDailyBriefGeneration() independently.
// Admin-only: this forces a regeneration even over a 'ready' brief and costs
// an LLM call, so an anonymous caller must never be able to trigger it (an
// unauthenticated probe once replaced the live brief with an empty one).
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const result = await dailyBriefModule.requestDailyBriefRegeneration();
    const status = result.started ? 202
      : result.reason === 'daily_attempt_limit_reached' ? 429
        : 200;
    res.status(status).json(result);
  } catch (err) {
    console.error(`POST /api/headlines/generate failed: ${err.message}`);
    res.status(500).json({ error: '헤드라인 생성 작업을 시작하지 못했습니다.' });
  }
});

module.exports = router;
