// Read side of the trade-statistics dashboard: one validated query model, one round trip. Pure helpers are exported for tests.
const KG_PER_TON = 1000;
const LEVELS = [2, 4, 6, 8, 10];
const nextLevel = (len) => (len < 4 ? 4 : len < 6 ? 6 : len < 10 ? 10 : null);

const isPeriod = (v) => /^\d{6}$/.test(v) && Number(v.slice(4)) >= 1 && Number(v.slice(4)) <= 12;
const addMonths = (period, n) => {
  const y = Number(period.slice(0, 4)); const m = Number(period.slice(4)) - 1 + n;
  const yy = y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12;
  return `${yy}${String(mm + 1).padStart(2, '0')}`;
};

// Returns { ok, value } | { ok:false, error }. Defaults: HS 15 (all fats and oils), last 24 months, imports.
function parseQuery(q, latest) {
  const hs = String(q.hs || '15').trim();
  if (!/^\d+$/.test(hs) || !LEVELS.includes(hs.length)) return { ok: false, error: 'invalid_hs' };
  const flow = q.flow === 'exp' ? 'exp' : 'imp';
  const to = q.to ? String(q.to) : latest;
  if (!to || !isPeriod(to)) return { ok: false, error: 'invalid_period' };
  const from = q.from ? String(q.from) : addMonths(to, -23);
  if (!isPeriod(from) || from > to) return { ok: false, error: 'invalid_period' };
  if (addMonths(from, 119) < to) return { ok: false, error: 'range_too_long' };
  return { ok: true, value: { hs, flow, from, to } };
}

const pctChange = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : (cur - prev) / prev);

// rows: [{ period, wgt, amt }] (kg, USD) sorted by period -> series with tons, usd, unit price (USD/ton) and year-over-year changes.
function buildSeries(rows, from, to) {
  const by = new Map(rows.map((r) => [r.period, r]));
  const out = [];
  for (let p = from; p <= to; p = addMonths(p, 1)) {
    const r = by.get(p);
    const ton = r && r.wgt != null ? r.wgt / KG_PER_TON : null;
    const usd = r && r.amt != null ? r.amt : null;
    const prevR = by.get(addMonths(p, -12));
    const pTon = prevR && prevR.wgt != null ? prevR.wgt / KG_PER_TON : null;
    const pUsd = prevR && prevR.amt != null ? prevR.amt : null;
    const price = ton && usd != null ? usd / ton : null;
    const pPrice = pTon && pUsd != null ? pUsd / pTon : null;
    out.push({ period: p, ton, usd, price, prevTon: pTon, prevUsd: pUsd, prevPrice: pPrice, yoyTon: pctChange(ton, pTon), yoyUsd: pctChange(usd, pUsd), yoyPrice: pctChange(price, pPrice) });
  }
  return out;
}

// KPIs over the series (latest month with data, its month-on-month and year-on-year change, trailing-12-month total vs the 12 months before).
function buildKpis(rows, from, to) {
  const all = buildSeries(rows, addMonths(from, -24), to); // include the lookback needed for the 12M comparison
  const have = all.filter((p) => p.ton != null && p.period >= from);
  const last = have[have.length - 1];
  if (!last) return null;
  const idx = all.findIndex((p) => p.period === last.period);
  const prev = all[idx - 1];
  const sum = (arr, k) => arr.reduce((a, p) => a + (p[k] || 0), 0);
  const t12 = all.slice(Math.max(0, idx - 11), idx + 1);
  const p12 = all.slice(Math.max(0, idx - 23), Math.max(0, idx - 11));
  const full = (arr) => arr.length === 12 && arr.every((p) => p.ton != null);
  const t12ton = sum(t12, 'ton'); const t12usd = sum(t12, 'usd');
  return {
    period: last.period, ton: last.ton, usd: last.usd, price: last.price,
    momTon: prev && prev.ton != null ? pctChange(last.ton, prev.ton) : null, yoyTon: last.yoyTon, yoyUsd: last.yoyUsd, yoyPrice: last.yoyPrice,
    t12: full(t12) ? { ton: t12ton, usd: t12usd, price: t12ton ? t12usd / t12ton : null, prevTon: full(p12) ? sum(p12, 'ton') : null, changeTon: full(p12) ? pctChange(t12ton, sum(p12, 'ton')) : null } : null,
  };
}

module.exports = { LEVELS, nextLevel, isPeriod, addMonths, parseQuery, pctChange, buildSeries, buildKpis };
