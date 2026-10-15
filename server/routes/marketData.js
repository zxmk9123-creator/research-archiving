const express = require('express');
const { getMarketData } = require('../lib/marketData');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'private, max-age=30');
    res.json(await getMarketData());
  } catch (err) {
    // Keep provider details and credentials out of client responses/logs.
    console.error(`GET /api/market-data failed: ${err.name || 'Error'}`);
    res.status(200).json({
      configured: true,
      provider: 'Barchart OnDemand',
      generatedAt: new Date().toISOString(),
      stale: false,
      errors: ['market_data_unavailable'],
      instruments: [],
    });
  }
});

module.exports = router;

