// Fills trade_flow from the Customs open APIs. Read-through-cache design: the page only ever reads trade_flow, so an API outage never reaches it.
// Stored at the finest level the API gives: item rows at HS10 (country_code ''), country rows at HS6. Any coarser selection (HS2/4/6/8) is a prefix
// SUM over those rows, which is what makes the HS drill-down a true partition (MECE): a node's children always add up to the node.
const pool = require('../db/pool');
const { callTradeApi } = require('./tradeApi');
const { HEADINGS, HS_NAMES } = require('./hsNames');

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

const TABLES = [
  `CREATE TABLE IF NOT EXISTS trade_flow (
    source TEXT NOT NULL DEFAULT 'customs', hs_code TEXT NOT NULL, period CHAR(6) NOT NULL, country_code TEXT NOT NULL DEFAULT '', country_name TEXT,
    imp_wgt NUMERIC, imp_amt NUMERIC, exp_wgt NUMERIC, exp_amt NUMERIC, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, hs_code, period, country_code))`,
  'CREATE TABLE IF NOT EXISTS hs_catalog (hs_code TEXT PRIMARY KEY, name TEXT NOT NULL, level SMALLINT NOT NULL)',
];
const ensured = new WeakMap();
function ensureTable(db = pool) {
  if (!ensured.has(db)) {
    ensured.set(db, (async () => { for (const sql of TABLES) await db.query(sql); })().catch((err) => { ensured.delete(db); throw err; }));
  }
  return ensured.get(db);
}

// The API answers per sub-code and per country: several rows can share a key. Fold them (sum) so a later row never overwrites an earlier one.
function foldRows(rows, withCountry) {
  const add = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));
  const map = new Map();
  for (const r of rows) {
    const country = withCountry ? (r.countryCode || '') : '';
    if (withCountry && !country) continue;
    const hs = r.hsCode || '';
    if (!hs) continue;
    const key = `${hs}|${r.period}|${country}`;
    const cur = map.get(key) || { hsCode: hs, name: r.name, period: r.period, countryCode: country, countryName: withCountry ? r.countryName : null, impWgt: null, impAmt: null, expWgt: null, expAmt: null };
    cur.impWgt = add(cur.impWgt, r.impWgt); cur.impAmt = add(cur.impAmt, r.impAmt);
    cur.expWgt = add(cur.expWgt, r.expWgt); cur.expAmt = add(cur.expAmt, r.expAmt);
    map.set(key, cur);
  }
  return [...map.values()];
}

async function upsertRows(db, rawRows, withCountry) {
  const rows = foldRows(rawRows, withCountry);
  const names = new Map();
  for (const r of rows) {
    await db.query(
      `INSERT INTO trade_flow (source, hs_code, period, country_code, country_name, imp_wgt, imp_amt, exp_wgt, exp_amt)
       VALUES ('customs',$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (source, hs_code, period, country_code) DO UPDATE SET country_name = EXCLUDED.country_name, imp_wgt = EXCLUDED.imp_wgt,
         imp_amt = EXCLUDED.imp_amt, exp_wgt = EXCLUDED.exp_wgt, exp_amt = EXCLUDED.exp_amt, fetched_at = now()`,
      [r.hsCode, r.period, r.countryCode, r.countryName, r.impWgt, r.impAmt, r.expWgt, r.expAmt],
    );
    if (r.name && !names.has(r.hsCode)) names.set(r.hsCode, r.name);
  }
  for (const [code, name] of names) {
    await db.query('INSERT INTO hs_catalog (hs_code, name, level) VALUES ($1,$2,$3) ON CONFLICT (hs_code) DO UPDATE SET name = EXCLUDED.name', [code, name, code.length]);
  }
  return rows.length;
}

async function seedCatalog(db) {
  for (const [code, name] of Object.entries(HS_NAMES)) {
    await db.query('INSERT INTO hs_catalog (hs_code, name, level) VALUES ($1,$2,$3) ON CONFLICT (hs_code) DO NOTHING', [code, name, code.length]);
  }
}

// mode 'probe': one call per API for the first heading and the latest window, nothing written.
// mode 'sync': `limit` headings starting at `offset` (item rows for `months`, country rows for 24 months). Returns { done, next } so a caller can loop
// in several short invocations instead of one that would outlive the function limit.
async function runTradeSync({ mode = 'sync', months = 36, offset = 0, limit = 6, now = new Date(), call = callTradeApi, db = pool } = {}) {
  if (mode === 'probe') {
    const w = monthWindows(12, now).pop();
    const out = {};
    for (const api of ['trade_item', 'trade_item_country', 'trade_country']) {
      const r = await call(api, { from: w.from, to: w.to, hs: api === 'trade_country' ? undefined : HEADINGS[0].hs });
      out[api] = { ok: r.ok, code: r.code, message: r.message, status: r.status, rows: r.rows.length, fields: r.fields, sample: r.rows[0] ? { period: r.rows[0].period, hsCode: r.rows[0].hsCode, impWgt: r.rows[0].impWgt, impAmt: r.rows[0].impAmt } : null };
    }
    return { mode, window: w, apis: out };
  }
  await ensureTable(db);
  if (offset === 0) {
    await seedCatalog(db);
    // earlier versions stored a folded 4-digit heading; those rows would double count under a prefix SUM
    await db.query("DELETE FROM trade_flow WHERE source = 'customs' AND length(hs_code) = 4");
  }
  const itemWindows = monthWindows(months, now);
  const countryWindows = monthWindows(24, now);
  const batch = HEADINGS.slice(offset, offset + limit);
  const report = { mode, offset, headings: batch.map((h) => h.hs), items: {}, countries: {}, errors: [] };
  for (const h of batch) {
    let stored = 0;
    for (const w of itemWindows) {
      const r = await call('trade_item', { from: w.from, to: w.to, hs: h.hs });
      if (!r.ok) { report.errors.push(`item ${h.hs} ${w.from}-${w.to}: ${r.code} ${r.message}`); continue; }
      stored += await upsertRows(db, r.rows, false);
    }
    report.items[h.hs] = stored;
    let cstored = 0;
    for (const w of countryWindows) {
      const rc = await call('trade_item_country', { from: w.from, to: w.to, hs: h.hs });
      if (!rc.ok) { report.errors.push(`country ${h.hs} ${w.from}-${w.to}: ${rc.code} ${rc.message}`); continue; }
      cstored += await upsertRows(db, rc.rows, true);
    }
    report.countries[h.hs] = cstored;
  }
  report.next = offset + limit < HEADINGS.length ? offset + limit : null;
  report.done = report.next === null;
  report.ok = report.errors.length === 0;
  return report;
}

module.exports = { foldRows, HEADINGS, monthWindows, runTradeSync, ensureTable };
