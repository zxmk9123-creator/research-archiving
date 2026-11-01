const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth');
const { ensureTable } = require('../lib/tradeSync');
const { tradeKeysStatus } = require('../lib/tradeApiConfig');
const Q = require('../lib/tradeQuery');

const router = express.Router();
// SQL value expressions per flow; net = exports − imports (a missing side counts as 0 only when the other side exists)
const col = (flow) => (flow === 'exp' ? { wgt: 'exp_wgt', amt: 'exp_amt' }
  : flow === 'net' ? { wgt: '(coalesce(exp_wgt, 0) - coalesce(imp_wgt, 0))', amt: '(coalesce(exp_amt, 0) - coalesce(imp_amt, 0))' }
  : { wgt: 'imp_wgt', amt: 'imp_amt' });
// ranking: by size for imports/exports, by size of the balance (either sign) for net
const rankBy = (flow, expr) => (flow === 'net' ? `abs(${expr})` : expr);
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

// With a partner country the per-country rows are read; they exist down to HS 6 digits, so a finer item answers at its HS6 parent.
const countryHs = (hs) => (hs.length > 6 ? hs.slice(0, 6) : hs);
async function loadSeriesRows(hs, flow, from, to, country = '') {
  const c = col(flow);
  const { rows } = await pool.query(
    `SELECT period, sum(${c.wgt}) AS wgt, sum(${c.amt}) AS amt FROM trade_flow
      WHERE source = 'customs' AND country_code = $4 AND hs_code LIKE $1 AND period BETWEEN $2 AND $3 GROUP BY period ORDER BY period`,
    [like(country ? countryHs(hs) : hs), Q.addMonths(from, -36), to, country]);
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
    const { hs, flow, from, to, country } = parsed.value;
    const c = col(flow);
    const rows = await loadSeriesRows(hs, flow, from, to, country);
    const opts = { noPrice: flow === 'net' };
    const series = Q.buildSeries(rows, from, to, opts);
    const kpis = Q.buildKpis(rows, from, to, opts);

    // children = the next HS level under the selection; they partition it, so shares add up to 100%
    // children: by item rows (to HS10), or for one partner by its per-country rows (to HS6 only)
    const nl = country ? (hs.length < 4 ? 4 : hs.length < 6 ? 6 : null) : Q.nextLevel(hs.length);
    let children = [];
    if (nl) {
      const r = await pool.query(
        `SELECT left(hs_code, $2) AS code, sum(${c.wgt}) AS wgt, sum(${c.amt}) AS amt FROM trade_flow
          WHERE source = 'customs' AND country_code = $5 AND hs_code LIKE $1 AND period BETWEEN $3 AND $4
          GROUP BY 1 HAVING ${rankBy(flow, `sum(${c.wgt})`)} > 0 ORDER BY ${rankBy(flow, `sum(${c.wgt})`)} DESC LIMIT 30`, [like(hs), nl, from, to, country]);
      const total = r.rows.reduce((a, x) => a + Math.abs(Number(x.wgt)), 0); // net: share of the total balance moved, sign kept on the value
      const nm = await names(r.rows.map((x) => x.code));
      children = r.rows.map((x) => ({ code: x.code, name: nm.get(x.code) || null, ton: Number(x.wgt) / 1000, usd: num(x.amt), share: total ? Math.abs(Number(x.wgt)) / total : null }));
    }

    // countries: stored at HS6, so a finer selection answers at its HS6 parent (flagged in `countryScope`)
    const cs = countryHs(hs);
    const cr = await pool.query(
      `SELECT country_code, max(country_name) AS name, sum(${c.wgt}) AS wgt, sum(${c.amt}) AS amt, min(period) AS pmin, max(period) AS pmax FROM trade_flow
        WHERE source = 'customs' AND country_code <> '' AND hs_code LIKE $1 AND period BETWEEN $2 AND $3
        GROUP BY country_code HAVING ${rankBy(flow, `sum(${c.wgt})`)} > 0 ORDER BY ${rankBy(flow, `sum(${c.wgt})`)} DESC`, [like(cs), from, to]);
    const ctotal = cr.rows.reduce((a, x) => a + Math.abs(Number(x.wgt)), 0);
    const countries = cr.rows.slice(0, 15).map((x) => ({ code: x.country_code, name: x.name || x.country_code, ton: Number(x.wgt) / 1000, usd: num(x.amt), share: ctotal ? Math.abs(Number(x.wgt)) / ctotal : null }));
    const covered = cr.rows.length ? { from: cr.rows.reduce((a, x) => (x.pmin < a ? x.pmin : a), '999999'), to: cr.rows.reduce((a, x) => (x.pmax > a ? x.pmax : a), '000000') } : null;

    // breadcrumb: the selection and its ancestors with names
    const chain = [2, 4, 6, 8, 10].filter((n) => n <= hs.length).map((n) => hs.slice(0, n));
    const cn = await names(chain);
    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      hs, flow, from, to, country, countryName: country ? ((cr.rows.find((x) => x.country_code === country) || {}).name || await partnerName(country)) : null, seriesHs: country ? cs : hs,
      latest, bounds, adjusted: parsed.adjusted, name: cn.get(hs) || null,
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

// Browse without codes: plain-language groups of headings, each with its last-12-month imports/exports and a monthly import trail for a sparkline.
router.get('/groups', async (req, res) => {
  try {
    await ensureTable(pool);
    const bounds = await periodBounds();
    const stats = new Map();
    if (bounds) {
      const since = Q.addMonths(bounds.max, -11);
      const { rows } = await pool.query(
        `SELECT left(hs_code, 4) AS h, period, sum(imp_wgt) AS imp, sum(exp_wgt) AS exp FROM trade_flow
          WHERE source = 'customs' AND country_code = '' AND period BETWEEN $1 AND $2 GROUP BY 1, 2`, [since, bounds.max]);
      for (const r of rows) {
        const s = stats.get(r.h) || { imp: 0, exp: 0, trail: {} };
        s.imp += Number(r.imp) || 0; s.exp += Number(r.exp) || 0; s.trail[String(r.period)] = (Number(r.imp) || 0) / 1000;
        stats.set(r.h, s);
      }
    }
    const months = bounds ? Array.from({ length: 12 }, (_, i) => Q.addMonths(bounds.max, i - 11)) : [];
    res.set('Cache-Control', 'private, max-age=300');
    res.json({
      through: bounds ? bounds.max : null,
      groups: GROUPS.map((g) => ({
        name: g.name,
        items: g.codes.map((c) => {
          const s = stats.get(c);
          return { code: c, name: HS_NAMES[c] || c, impTon: s ? s.imp / 1000 : null, expTon: s ? s.exp / 1000 : null, trail: s ? months.map((p) => s.trail[p] ?? null) : [] };
        }),
      })),
    });
  } catch (err) {
    console.error('GET /api/trade/groups failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

// CSV of the monthly series for the current selection (UTF-8 with BOM so Excel reads Korean text).
router.get('/export.csv', async (req, res) => {
  try {
    await ensureTable(pool);
    const bounds = await periodBounds();
    const parsed = bounds ? Q.parseQuery(req.query, bounds) : { ok: false, error: 'no_data' };
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { hs, flow, from, to, country } = parsed.value;
    const series = Q.buildSeries(await loadSeriesRows(hs, flow, from, to, country), from, to, { noPrice: flow === 'net' });
    const f = (v, d = 0) => (v == null ? '' : Number(v).toFixed(d));
    const lines = [`월,${flow === 'net' ? '순수출 ' : ''}물량(톤),${flow === 'net' ? '순수출 ' : ''}금액(USD),단가(USD/톤),물량 전년비,금액 전년비,단가 전년비`];
    for (const p of series) lines.push([p.period, f(p.ton, 1), f(p.usd), f(p.price), f(p.yoyTon, 4), f(p.yoyUsd, 4), f(p.yoyPrice, 4)].join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="trade_${hs}${country ? `_${country}` : ''}_${flow}_${from}-${to}.csv"`);
    res.send(`\uFEFF${lines.join('\n')}\n`);
  } catch (err) {
    console.error('GET /api/trade/export failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

async function partnerName(code) {
  const { rows } = await pool.query("SELECT max(country_name) AS name FROM trade_flow WHERE source = 'customs' AND country_code = $1", [code]);
  return (rows[0] && rows[0].name) || code;
}

// Partner countries for the picker: everyone that traded the item (HS6 rows) in the last 36 months, largest total trade first.
router.get('/partners', async (req, res) => {
  const hs = String(req.query.hs || '15');
  if (!/^\d+$/.test(hs) || !Q.LEVELS.includes(hs.length)) return res.status(400).json({ error: 'invalid_hs' });
  try {
    await ensureTable(pool);
    const bounds = await periodBounds();
    if (!bounds) return res.json({ partners: [] });
    const { rows } = await pool.query(
      `SELECT country_code AS code, max(country_name) AS name, sum(coalesce(imp_wgt, 0)) AS imp, sum(coalesce(exp_wgt, 0)) AS exp FROM trade_flow
        WHERE source = 'customs' AND country_code <> '' AND hs_code LIKE $1 AND period >= $2
        GROUP BY country_code HAVING sum(coalesce(imp_wgt, 0) + coalesce(exp_wgt, 0)) > 0
        ORDER BY sum(coalesce(imp_wgt, 0) + coalesce(exp_wgt, 0)) DESC LIMIT 200`, [like(countryHs(hs)), Q.addMonths(bounds.max, -35)]);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ partners: rows.map((r) => ({ code: r.code, name: r.name || r.code, impTon: Number(r.imp) / 1000, expTon: Number(r.exp) / 1000 })) });
  } catch (err) {
    console.error('GET /api/trade/partners failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

// Two-country view (UN Comtrade): exporter -> importer for an HS heading. Both countries come from the fixed list; the period is clamped like the
// Korea-based view, and a pair that is still being fetched answers with what is cached so far (incomplete: true).
const { COUNTRIES, countryByCode, isCountry } = require('../lib/countries');
const { loadPair, latestMonth } = require('../lib/tradePair');
const { comtradeKey } = require('../lib/comtradeApi');
router.get('/countries-list', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ countries: COUNTRIES.map((c) => ({ code: c.code, iso: c.iso, name: c.ko })), enabled: Boolean(comtradeKey()) });
});
router.get('/pair', async (req, res) => {
  // 0 = all countries (a country's total exports or total imports); both sides at 0 would be "the world with itself" and is refused
  const ex = Number(req.query.ex); const im = Number(req.query.im);
  if ((ex !== 0 && !isCountry(ex)) || (im !== 0 && !isCountry(im))) return res.status(400).json({ error: 'invalid_country' });
  if (ex === 0 && im === 0) return res.status(400).json({ error: 'need_one_country' });
  if (ex === im) return res.status(400).json({ error: 'same_country' });
  if (!comtradeKey()) return res.json({ disabled: true });
  try {
    const now = new Date();
    const max = latestMonth(now); const min = `${now.getUTCFullYear() - 30}01`;
    const parsed = Q.parseQuery({ hs: req.query.hs, from: req.query.from, to: req.query.to, flow: 'imp' }, { min, max });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { hs, from, to } = parsed.value;
    const r = await loadPair({ ex, im, hs, from, to });
    const chain = [2, 4, 6].filter((n) => n <= hs.length).map((n) => hs.slice(0, n));
    const cn = await names(chain.concat(hs.length > 6 ? [hs] : []));
    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      mode: 'pair', hs, flow: 'pair', from, to, latest: max, bounds: { min, max }, adjusted: parsed.adjusted, name: cn.get(hs) || null, seriesHs: r.cmd,
      breadcrumb: chain.map((code) => ({ code, name: cn.get(code) || null })), exporter: { code: ex, name: ex ? countryByCode(ex).ko : '전체 국가' }, importer: { code: im, name: im ? countryByCode(im).ko : '전체 국가' },
      scope: r.scope, source: r.source, incomplete: r.incomplete, apiError: r.error, kpis: r.kpis, series: r.series, children: [], countries: [],
    });
  } catch (err) {
    console.error('GET /api/trade/pair failed:', err.message);
    res.status(500).json({ error: 'trade_unavailable' });
  }
});

router.get('/status', requireAuth, (req, res) => res.json({ keys: tradeKeysStatus() }));

module.exports = router;
