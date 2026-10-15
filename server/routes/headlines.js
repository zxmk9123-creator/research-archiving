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

// Retry a failed/stale brief without repeating the article collection.
// Generation itself runs in the background and the dashboard polls the
// read endpoint; a request never waits on the provider's long cascade.
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const result = await dailyBriefModule.queueDailyBriefGeneration();
    res.status(result.started ? 202 : 200).json(result);
  } catch (err) {
    console.error(`POST /api/headlines/generate failed: ${err.message}`);
    res.status(500).json({ error: '헤드라인 생성 작업을 시작하지 못했습니다.' });
  }
});

module.exports = router;
