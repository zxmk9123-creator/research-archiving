const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth');
const { ensureTable } = require('../lib/tradeSync');
const { tradeKeysStatus } = require('../lib/tradeApiConfig');
const Q = require('../lib/tradeQuery');

const router = express.Router();
const col = (flow) => (flow === 'exp' ? { wgt: 'exp_wgt', amt: 'exp_amt' } : { wgt: 'imp_wgt', amt: 'imp_amt' });
const num = (v) => (v == null ? null : Number(v));
const like = (hs) => `${hs}%`;

// the months the data covers: the period picker and the clamp both use these
async function periodBounds() {
  const { rows } = await pool.query("SELECT min(period) AS lo, max(period) AS hi FROM trade_flow WHERE source = 'customs' AND country_code = ''");
  return rows[0] && rows[0].hi ? { min: String(rows[0].lo), max: String(rows[0].hi) } : null;
}
// Display names: the cleaned catalog name; a bare "기타" reads as "기타 <nearest named ancestor>" so it means something out of context.
const { cleanHsName, HS_NAMES: SEED_NAMES } = require('../lib/hsNames');
async function names(codes) {
  if (!codes.length) return new Map();
  const want = [...new Set(codes.flatMap((c) => [c, ...[2, 4, 6, 8].filter((n) => n < c.length).map((n) => c.slice(0, n))]))];
  const { rows } = await pool.query('SELECT hs_code, name FROM hs_catalog WHERE hs_code = ANY($1)', [want]);
  const raw = new Map(rows.map((r) => [r.hs_code, r.name]));
  const clean = (c) => { const n = SEED_NAMES[c] || raw.get(c); return n ? cleanHsName(c, n) : null; };
  const label = (c) => {
    const own = clean(c);
    if (own && own !== '기타') return own;
    for (const n of [8, 6, 4, 2]) {
      if (n >= c.length) continue;
      const up = clean(c.slice(0, n));
      if (up && up !== '기타') return own ? `기타 ${up}` : up;
    }
    return own;
  };
  return new Map(codes.map((c) => [c, label(c)]));
}

async function loadSeriesRows(hs, flow, from, to) {
  const c = col(flow);
  const { rows } = await pool.query(
    `SELECT period, sum(${c.wgt}) AS wgt, sum(${c.amt}) AS amt FROM trade_flow
      WHERE source = 'customs' AND country_code = '' AND hs_code LIKE $1 AND period BETWEEN $2 AND $3 GROUP BY period ORDER BY period`,
    [like(hs), Q.addMonths(from, -36), to]);
  return rows.map((r) => ({ period: String(r.period), wgt: num(r.wgt), amt: num(r.amt) }));
}

// Everything the dashboard shows for one selection, in one response.
router.get('/dashboard', async (req, res) => {
  try {
    await ensureTable(pool);
    const bounds = await periodBounds();
    if (!bounds) return res.json({ empty: true });
    const latest = bounds.max;
    const parsed = Q.parseQuery(req.query, bounds);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { hs, flow, from, to } = parsed.value;
    const c = col(flow);
    const rows = await loadSeriesRows(hs, flow, from, to);
    const series = Q.buildSeries(rows, from, to);
    const kpis = Q.buildKpis(rows, from, to);

    // children = the next HS level under the selection; they partition it, so shares add up to 100%
    const nl = Q.nextLevel(hs.length);
    let children = [];
    if (nl) {
      const r = await pool.query(
        `SELECT left(hs_code, $2) AS code, sum(${c.wgt}) AS wgt, sum(${c.amt}) AS amt FROM trade_flow
          WHERE source = 'customs' AND country_code = '' AND hs_code LIKE $1 AND period BETWEEN $3 AND $4
          GROUP BY 1 HAVING sum(${c.wgt}) > 0 ORDER BY sum(${c.wgt}) DESC LIMIT 30`, [like(hs), nl, from, to]);
      const total = r.rows.reduce((a, x) => a + Number(x.wgt), 0);
      const nm = await names(r.rows.map((x) => x.code));
      children = r.rows.map((x) => ({ code: x.code, name: nm.get(x.code) || null, ton: Number(x.wgt) / 1000, usd: num(x.amt), share: total ? Number(x.wgt) / total : null }));
    }

    // countries: stored at HS6, so a finer selection answers at its HS6 parent (flagged in `countryScope`)
    const cs = hs.length > 6 ? hs.slice(0, 6) : hs;
    const cr = await pool.query(
      `SELECT country_code, max(country_name) AS name, sum(${c.wgt}) AS wgt, sum(${c.amt}) AS amt, min(period) AS pmin, max(period) AS pmax FROM trade_flow
        WHERE source = 'customs' AND country_code <> '' AND hs_code LIKE $1 AND period BETWEEN $2 AND $3
        GROUP BY country_code HAVING sum(${c.wgt}) > 0 ORDER BY sum(${c.wgt}) DESC`, [like(cs), from, to]);
    const ctotal = cr.rows.reduce((a, x) => a + Number(x.wgt), 0);
    const countries = cr.rows.slice(0, 15).map((x) => ({ code: x.country_code, name: x.name || x.country_code, ton: Number(x.wgt) / 1000, usd: num(x.amt), share: ctotal ? Number(x.wgt) / ctotal : null }));
    const covered = cr.rows.length ? { from: cr.rows.reduce((a, x) => (x.pmin < a ? x.pmin : a), '999999'), to: cr.rows.reduce((a, x) => (x.pmax > a ? x.pmax : a), '000000') } : null;

    // breadcrumb: the selection and its ancestors with names
    const chain = [2, 4, 6, 8, 10].filter((n) => n <= hs.length).map((n) => hs.slice(0, n));
    const cn = await names(chain);
    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      hs, flow, from, to, latest, bounds, adjusted: parsed.adjusted, name: cn.get(hs) || null,
      breadcrumb: chain.map((code) => ({ code, name: cn.get(code) || null })),
      kpis, series, children, countries, countryScope: cs, countryCoverage: covered,
    });
  } catch (err) {
    console.error('GET /api/trade/dashboard failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

// Find an item the way people think of it: everyday words first (콩기름 -> 대두유), then catalog names, then codes. Each result carries its
// parent heading so a 10-digit line reads "팜유 › 정제한 것" instead of a bare code.
const { ALIASES, GROUPS, HS_NAMES } = require('../lib/hsNames');
const norm = (t) => String(t || '').toLowerCase().replace(/[\s·,()]/g, '');
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (!q) return res.json({ results: [] });
  try {
    await ensureTable(pool);
    const nq = norm(q);
    const scored = new Map(); // code -> score (higher first)
    const bump = (code, score) => { if (!scored.has(code) || scored.get(code) < score) scored.set(code, score); };
    for (const [word, codes] of Object.entries(ALIASES)) {
      const nw = norm(word);
      if (nw === nq) codes.forEach((c, i) => bump(c, 100 - i));
      else if (nw.startsWith(nq) || (nq.length >= 2 && nq.includes(nw))) codes.forEach((c, i) => bump(c, 80 - i));
    }
    const isCode = /^\d+$/.test(q);
    const { rows } = isCode
      ? await pool.query('SELECT hs_code, name, level FROM hs_catalog WHERE hs_code LIKE $1 ORDER BY level, hs_code LIMIT 30', [`${q}%`])
      : await pool.query("SELECT hs_code, name, level FROM hs_catalog WHERE replace(name, ' ', '') ILIKE $1 ORDER BY level, hs_code LIMIT 30", [`%${q.replace(/[%_\\\s]/g, '')}%`]);
    for (const r of rows) bump(r.hs_code, isCode ? 60 - r.level : 50 - r.level);
    const codes = [...scored.keys()];
    const parents = [...new Set(codes.flatMap((c) => [c.slice(0, 4), c.slice(0, 2)]))];
    const nm = await names([...new Set([...codes, ...parents])]);
    const label = (c) => nm.get(c) || HS_NAMES[c] || null;
    const results = codes.sort((a, b) => scored.get(b) - scored.get(a) || a.length - b.length || a.localeCompare(b)).slice(0, 12)
      .map((c) => ({ code: c, name: label(c), level: c.length, parent: c.length > 4 ? label(c.slice(0, 4)) : c.length === 4 ? label(c.slice(0, 2)) : null }));
    res.json({ results });
  } catch (err) {
    console.error('GET /api/trade/search failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

// Browse without codes: plain-language groups of headings.
router.get('/groups', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ groups: GROUPS.map((g) => ({ name: g.name, items: g.codes.map((c) => ({ code: c, name: HS_NAMES[c] || c })) })) });
});

// CSV of the monthly series for the current selection (UTF-8 with BOM so Excel reads Korean text).
router.get('/export.csv', async (req, res) => {
  try {
    await ensureTable(pool);
    const bounds = await periodBounds();
    const parsed = bounds ? Q.parseQuery(req.query, bounds) : { ok: false, error: 'no_data' };
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { hs, flow, from, to } = parsed.value;
    const series = Q.buildSeries(await loadSeriesRows(hs, flow, from, to), from, to);
    const f = (v, d = 0) => (v == null ? '' : Number(v).toFixed(d));
    const lines = ['월,물량(톤),금액(USD),단가(USD/톤),물량 전년비,금액 전년비,단가 전년비'];
    for (const p of series) lines.push([p.period, f(p.ton, 1), f(p.usd), f(p.price), f(p.yoyTon, 4), f(p.yoyUsd, 4), f(p.yoyPrice, 4)].join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="trade_${hs}_${flow}_${from}-${to}.csv"`);
    res.send(`\uFEFF${lines.join('\n')}\n`);
  } catch (err) {
    console.error('GET /api/trade/export failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

router.get('/status', requireAuth, (req, res) => res.json({ keys: tradeKeysStatus() }));

module.exports = router;
