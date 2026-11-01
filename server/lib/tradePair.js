// Two-country trade (exporter -> importer) from UN Comtrade, fetched on demand and cached. Any pair and any HS heading can be asked for, so nothing
// is prefetched: the first view of a pair/item/year calls the API, every later view reads the cache. Per (reporter, partner, flow, item, year) a
// coverage row remembers that the year was fetched (even when it was empty), so empty years are not asked again.
const pool = require('../db/pool');
const { callComtrade } = require('./comtradeApi');
const Q = require('./tradeQuery');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS trade_bilateral (
    reporter INTEGER NOT NULL, partner INTEGER NOT NULL, flow CHAR(1) NOT NULL, cmd TEXT NOT NULL, period CHAR(6) NOT NULL,
    net_wgt NUMERIC, value NUMERIC, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (reporter, partner, flow, cmd, period))`,
  `CREATE TABLE IF NOT EXISTS trade_bilateral_cov (
    reporter INTEGER NOT NULL, partner INTEGER NOT NULL, flow CHAR(1) NOT NULL, cmd TEXT NOT NULL, year INTEGER NOT NULL,
    rows INTEGER NOT NULL DEFAULT 0, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (reporter, partner, flow, cmd, year))`,
];
const ensured = new WeakMap();
function ensureTables(db = pool) {
  if (!ensured.has(db)) ensured.set(db, (async () => { for (const sql of TABLES) await db.query(sql); })().catch((err) => { ensured.delete(db); throw err; }));
  return ensured.get(db);
}

const DAY = 86400000;
const LIMITS = { maxCalls: 8, budgetMs: 45000 };
// the newest month the API can plausibly have is two months back; older years never change once fetched, the open years refresh
const latestMonth = (now) => Q.addMonths(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`, -2);
const isStale = (year, fetchedAt, now) => now.getTime() - new Date(fetchedAt).getTime() > (year >= now.getUTCFullYear() - 1 ? 20 * DAY : 400 * DAY);

// Make sure one reporter/flow/year is cached. ctx = { calls, deadline, incomplete, error } shared across a request.
async function ensureYear(db, call, ctx, now, { reporter, partner, flow, cmd, year }) {
  const cov = await db.query('SELECT fetched_at FROM trade_bilateral_cov WHERE reporter=$1 AND partner=$2 AND flow=$3 AND cmd=$4 AND year=$5', [reporter, partner, flow, cmd, year]);
  if (cov.rows[0] && !isStale(year, cov.rows[0].fetched_at, now)) return;
  if (ctx.calls >= LIMITS.maxCalls || Date.now() > ctx.deadline) { ctx.incomplete = true; return; }
  const last = latestMonth(now);
  const periods = Array.from({ length: 12 }, (_, i) => `${year}${String(i + 1).padStart(2, '0')}`).filter((p) => p <= last);
  if (!periods.length) return;
  const r = await call({ freq: 'M', reporter, partner, flow, cmd, periods });
  ctx.calls += Math.max(1, r.calls || 1);
  if (!r.ok) { ctx.error = { code: r.code, message: r.message }; ctx.incomplete = true; return; } // nothing recorded: the year is asked again next time
  for (const x of r.rows) {
    await db.query(
      `INSERT INTO trade_bilateral (reporter, partner, flow, cmd, period, net_wgt, value) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (reporter, partner, flow, cmd, period) DO UPDATE SET net_wgt = EXCLUDED.net_wgt, value = EXCLUDED.value, fetched_at = now()`,
      [reporter, partner, flow, cmd, x.period, x.wgtKg, x.usd]);
  }
  await db.query(
    `INSERT INTO trade_bilateral_cov (reporter, partner, flow, cmd, year, rows) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (reporter, partner, flow, cmd, year) DO UPDATE SET rows = EXCLUDED.rows, fetched_at = now()`, [reporter, partner, flow, cmd, year, r.rows.length]);
}

async function readRows(db, { reporter, partner, flow, cmd }, from, to) {
  const { rows } = await db.query(
    'SELECT period, net_wgt, value FROM trade_bilateral WHERE reporter=$1 AND partner=$2 AND flow=$3 AND cmd=$4 AND period BETWEEN $5 AND $6 ORDER BY period',
    [reporter, partner, flow, cmd, from, to]);
  return rows.map((r) => ({ period: String(r.period), wgt: r.net_wgt == null ? null : Number(r.net_wgt), amt: r.value == null ? null : Number(r.value) }));
}

// Pure. Exporter's own report wins; the importer's mirror report is used only when the exporter has nothing in the range (one source per view,
// never mixed month by month: the two sides differ in valuation (FOB/CIF), timing and coverage).
const pickSource = (exporterRows, importerRows) => (exporterRows.length ? 'exporter_report' : importerRows.length ? 'importer_report' : 'none');

// q = { ex, im, hs, from, to } already validated; ex or im may be 0 ("all countries" = Comtrade's World partner) but not both.
// Returns the same series/kpis shape as the Customs-based dashboard, plus `scope`: pair | exporter_total | importer_total.
async function loadPair(q, { call = (p) => callComtrade(p), db = pool, now = new Date() } = {}) {
  await ensureTables(db);
  const cmd = q.hs.length > 6 ? q.hs.slice(0, 6) : q.hs;
  const ctx = { calls: 0, deadline: Date.now() + LIMITS.budgetMs, incomplete: false, error: null };
  const y0 = Number(Q.addMonths(q.from, -12).slice(0, 4)); const y1 = Number(q.to.slice(0, 4));
  const scope = q.ex && q.im ? 'pair' : q.ex ? 'exporter_total' : 'importer_total';
  // one country's total is that country's own report against the World partner; there is no mirror to fall back on (it would be the sum of every other country's report)
  const xKey = scope === 'importer_total' ? null : { reporter: q.ex, partner: q.im, flow: 'X', cmd }; // partner 0 = World
  const mKey = scope === 'exporter_total' ? null : { reporter: q.im, partner: q.ex, flow: 'M', cmd };
  const lo = Q.addMonths(q.from, -12);
  let xRows = [];
  if (xKey) {
    for (let y = y1; y >= y0; y--) await ensureYear(db, call, ctx, now, { ...xKey, year: y }); // newest years first: they matter most if the budget runs out
    xRows = await readRows(db, xKey, lo, q.to);
  }
  let mRows = [];
  if (mKey && (scope === 'importer_total' || !xRows.length)) {
    for (let y = y1; y >= y0; y--) await ensureYear(db, call, ctx, now, { ...mKey, year: y });
    mRows = await readRows(db, mKey, lo, q.to);
  }
  const source = pickSource(xRows, mRows);
  const rows = source === 'importer_report' ? mRows : xRows;
  return {
    source, scope, rows, cmd, incomplete: ctx.incomplete, error: ctx.error, calls: ctx.calls,
    series: Q.buildSeries(rows, q.from, q.to), kpis: Q.buildKpis(rows, q.from, q.to),
  };
}

module.exports = { loadPair, pickSource, ensureTables, latestMonth, LIMITS };
