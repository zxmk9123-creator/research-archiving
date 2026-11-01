// Fills trade_flow from the Customs open APIs. Read-through-cache design: the page only ever reads trade_flow, so an API outage never reaches it.
const pool = require('../db/pool');
const { callTradeApi } = require('./tradeApi');

// 4-digit headings first (what the demo shows). Names are the display labels; they are not sent to the API.
const OILS = [
  { hs: '1511', name: '팜유' },
  { hs: '1507', name: '대두유' },
  { hs: '1514', name: '유채유(카놀라)' },
  { hs: '1512', name: '해바라기유' },
];

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
// [from, to] windows of at most 12 months, ending at the last COMPLETED month (the current month is not published yet)
function monthWindows(months, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const out = [];
  let cursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months + 1, 1));
  while (cursor <= end) {
    const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 11, 1));
    const to = last < end ? last : end;
    out.push({ from: ymd(cursor), to: ymd(to) });
    cursor = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 1));
  }
  return out;
}

async function ensureTable(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS trade_flow (
    source TEXT NOT NULL DEFAULT 'customs', hs_code TEXT NOT NULL, period CHAR(6) NOT NULL, country_code TEXT NOT NULL DEFAULT '', country_name TEXT,
    imp_wgt NUMERIC, imp_amt NUMERIC, exp_wgt NUMERIC, exp_amt NUMERIC, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, hs_code, period, country_code))`);
}

async function upsertRows(db, hs, rows, withCountry) {
  let n = 0;
  for (const r of rows) {
    const country = withCountry ? (r.countryCode || '') : '';
    if (withCountry && !country) continue;
    await db.query(
      `INSERT INTO trade_flow (source, hs_code, period, country_code, country_name, imp_wgt, imp_amt, exp_wgt, exp_amt)
       VALUES ('customs',$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (source, hs_code, period, country_code) DO UPDATE SET country_name = EXCLUDED.country_name, imp_wgt = EXCLUDED.imp_wgt,
         imp_amt = EXCLUDED.imp_amt, exp_wgt = EXCLUDED.exp_wgt, exp_amt = EXCLUDED.exp_amt, fetched_at = now()`,
      [hs, r.period, country, withCountry ? r.countryName : null, r.impWgt, r.impAmt, r.expWgt, r.expAmt],
    );
    n++;
  }
  return n;
}

// mode 'probe': one call per API for the first heading and the latest window, nothing written; reports what the API answered (no key, no rows).
// mode 'sync': item level for every heading over `months`, plus the country breakdown for the latest 12 months.
async function runTradeSync({ mode = 'sync', months = 24, now = new Date(), call = callTradeApi, db = pool } = {}) {
  const windows = monthWindows(months, now);
  if (mode === 'probe') {
    const w = windows[windows.length - 1];
    const out = {};
    for (const api of ['trade_item', 'trade_item_country', 'trade_country']) {
      const r = await call(api, { from: w.from, to: w.to, hs: api === 'trade_country' ? undefined : OILS[0].hs });
      out[api] = { ok: r.ok, code: r.code, message: r.message, status: r.status, rows: r.rows.length, fields: r.fields, sample: r.rows[0] ? { period: r.rows[0].period, hsCode: r.rows[0].hsCode, impWgt: r.rows[0].impWgt, impAmt: r.rows[0].impAmt } : null };
    }
    return { mode, window: w, apis: out };
  }
  await ensureTable(db);
  const report = { mode, windows: windows.length, items: {}, countries: {}, errors: [] };
  for (const oil of OILS) {
    let stored = 0;
    for (const w of windows) {
      const r = await call('trade_item', { from: w.from, to: w.to, hs: oil.hs });
      if (!r.ok) { report.errors.push(`item ${oil.hs} ${w.from}-${w.to}: ${r.code} ${r.message}`); continue; }
      stored += await upsertRows(db, oil.hs, r.rows, false);
    }
    report.items[oil.hs] = stored;
    // country breakdown: latest 12 months only
    const w = windows[windows.length - 1];
    const rc = await call('trade_item_country', { from: w.from, to: w.to, hs: oil.hs });
    if (!rc.ok) { report.errors.push(`country ${oil.hs}: ${rc.code} ${rc.message}`); report.countries[oil.hs] = 0; continue; }
    report.countries[oil.hs] = await upsertRows(db, oil.hs, rc.rows, true);
  }
  report.ok = report.errors.length === 0;
  return report;
}

module.exports = { OILS, monthWindows, runTradeSync, ensureTable };
