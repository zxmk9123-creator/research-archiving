const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth');
const { OILS, ensureTable } = require('../lib/tradeSync');
const { tradeKeysStatus } = require('../lib/tradeApiConfig');

const router = express.Router();
const validHs = (hs) => OILS.find((o) => o.hs === String(hs));

router.get('/items', (req, res) => res.json({ items: OILS }));

// Monthly series for one heading: tons, USD and the computed unit price (USD per ton). kg -> ton here, once.
router.get('/series', async (req, res) => {
  const oil = validHs(req.query.hs);
  if (!oil) return res.status(400).json({ error: 'unknown_hs' });
  const months = Math.min(120, Math.max(1, Math.floor(Number(req.query.months)) || 24));
  try {
    await ensureTable(pool);
    const { rows } = await pool.query(
      `SELECT period, imp_wgt, imp_amt, exp_wgt, exp_amt FROM trade_flow
        WHERE source = 'customs' AND hs_code = $1 AND country_code = '' ORDER BY period DESC LIMIT $2`, [oil.hs, months]);
    const series = rows.reverse().map((r) => {
      const impT = r.imp_wgt == null ? null : Number(r.imp_wgt) / 1000;
      const impUsd = r.imp_amt == null ? null : Number(r.imp_amt);
      return { period: r.period, impTon: impT, impUsd, expTon: r.exp_wgt == null ? null : Number(r.exp_wgt) / 1000, expUsd: r.exp_amt == null ? null : Number(r.exp_amt),
        unitPrice: impT && impUsd != null ? Math.round(impUsd / impT) : null };
    });
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ hs: oil.hs, name: oil.name, source: 'customs', series });
  } catch (err) {
    console.error('GET /api/trade/series failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

// Import tons by origin country, summed over the latest 12 months present for that heading.
router.get('/countries', async (req, res) => {
  const oil = validHs(req.query.hs);
  if (!oil) return res.status(400).json({ error: 'unknown_hs' });
  try {
    await ensureTable(pool);
    const { rows } = await pool.query(
      `WITH latest AS (SELECT max(period) AS p FROM trade_flow WHERE source='customs' AND hs_code=$1 AND country_code <> '')
       SELECT country_code, max(country_name) AS name, sum(imp_wgt) AS wgt, sum(imp_amt) AS amt, (SELECT p FROM latest) AS latest
         FROM trade_flow WHERE source='customs' AND hs_code=$1 AND country_code <> ''
          AND period > to_char(to_date((SELECT p FROM latest),'YYYYMM') - interval '12 months','YYYYMM')
        GROUP BY country_code HAVING sum(imp_wgt) > 0 ORDER BY sum(imp_wgt) DESC LIMIT 12`, [oil.hs]);
    const total = rows.reduce((a, r) => a + Number(r.wgt), 0);
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ hs: oil.hs, name: oil.name, through: rows[0] ? rows[0].latest : null,
      countries: rows.map((r) => ({ code: r.country_code, name: r.name || r.country_code, ton: Number(r.wgt) / 1000, usd: Number(r.amt), share: total ? Number(r.wgt) / total : null })) });
  } catch (err) {
    console.error('GET /api/trade/countries failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

router.get('/status', requireAuth, (req, res) => res.json({ keys: tradeKeysStatus() }));

module.exports = router;
