const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseComtrade, callComtrade, comtradeKey } = require('../server/lib/comtradeApi');
const { loadPair, pickSource } = require('../server/lib/tradePair');
const { COUNTRIES, countryByCode, isCountry } = require('../server/lib/countries');

// a real answer of the key-free preview endpoint (Indonesia -> India, palm oil 1511, 2023)
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_comtrade_sample.json'), 'utf8'));
const KEY = 'SECRET-KEY-123';
const env = { UN_CONTRADE: KEY };

test('parseComtrade: the headline aggregate becomes kg and USD; breakdown rows are ignored', () => {
  const rows = parseComtrade(SAMPLE);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].period, rows[0].reporter, rows[0].partner, rows[0].flow, rows[0].cmd], ['2023', 360, 699, 'X', '1511']);
  assert.ok(rows[0].wgtKg > 5e9 && rows[0].usd > 4e9);
  const noisy = { data: [{ ...SAMPLE.data[0], motCode: 2000 }, { ...SAMPLE.data[0], customsCode: 'C01' }, { ...SAMPLE.data[0], partner2Code: 156 }, { ...SAMPLE.data[0], isAggregate: false }] };
  assert.equal(parseComtrade(noisy).length, 0);
  const noWgt = { data: [{ ...SAMPLE.data[0], netWgt: 0, qty: 5, qtyUnitCode: 8 }, { ...SAMPLE.data[0], period: '2024', netWgt: 0, qty: 7, qtyUnitCode: 1 }] };
  assert.deepEqual(parseComtrade(noWgt).map((r) => r.wgtKg), [5, null]);
});

test('key: UN_CONTRADE (the name set in Vercel) and the correctly spelled aliases; none -> no_key without any request', async () => {
  assert.equal(comtradeKey({ UN_CONTRADE: ' k ' }), 'k'); assert.equal(comtradeKey({ UN_COMTRADE: 'a' }), 'a'); assert.equal(comtradeKey({}), '');
  let called = 0;
  const r = await callComtrade({ freq: 'M', reporter: 360, partner: 699, flow: 'X', cmd: '1511', periods: ['202401'] }, { env: {}, fetchImpl: async () => { called++; } });
  assert.equal(r.code, 'no_key'); assert.equal(called, 0);
});

test('callComtrade: key only in the header; batch size adapts to "Maximum number of periods"; 401/429/network are named', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, header: opts.headers['Ocp-Apim-Subscription-Key'] });
    const periods = new URL(url).searchParams.get('period').split(',');
    if (periods.length > 3) return { status: 400, ok: false, text: async () => JSON.stringify({ error: 'Maximum number of periods is 3' }) };
    return { status: 200, ok: true, text: async () => JSON.stringify({ data: periods.map((p) => ({ ...SAMPLE.data[0], period: p })) }) };
  };
  const r = await callComtrade({ freq: 'M', reporter: 360, partner: 699, flow: 'X', cmd: '1511', periods: ['202401', '202402', '202403', '202404', '202405', '202406', '202407'] }, { env, fetchImpl });
  assert.equal(r.ok, true); assert.equal(r.rows.length, 7);
  assert.ok(seen.every((c) => c.header === KEY && !c.url.includes(KEY)), 'the key never appears in a URL');
  const bad = (status, body) => callComtrade({ freq: 'A', reporter: 1, partner: 2, flow: 'X', cmd: '15', periods: ['2023'] }, { env, fetchImpl: async () => ({ status, ok: false, text: async () => body }) });
  assert.equal((await bad(401, 'denied')).code, 'auth'); assert.equal((await bad(429, 'slow down')).code, 'rate_limited'); assert.equal((await bad(500, 'oops')).code, 'http_error');
  const net = await callComtrade({ freq: 'A', reporter: 1, partner: 2, flow: 'X', cmd: '15', periods: ['2023'] }, { env, fetchImpl: async () => { throw new Error(`connect failed ${KEY}`); } });
  assert.equal(net.code, 'network'); assert.doesNotMatch(JSON.stringify(net), /SECRET-KEY/);
});

test('countries: unique codes, Korean names, lookups', () => {
  assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length);
  assert.equal(countryByCode(360).ko, '인도네시아'); assert.equal(isCountry(699), true); assert.equal(isCountry(99999), false);
  assert.ok(COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.iso) && c.ko));
});

test('pickSource: exporter report first, importer mirror only when the exporter has nothing', () => {
  assert.equal(pickSource([{}], [{}]), 'exporter_report'); assert.equal(pickSource([], [{}]), 'importer_report'); assert.equal(pickSource([], []), 'none');
});

// a tiny in-memory stand-in for the two cache tables
function fakeDb() {
  const bil = new Map(); const cov = new Map();
  return {
    bil, cov,
    async query(sql, a) {
      if (/^CREATE TABLE/.test(sql)) return { rows: [] };
      if (/FROM trade_bilateral_cov/.test(sql)) { const v = cov.get(a.join('|')); return { rows: v ? [{ fetched_at: v }] : [] }; }
      if (/INSERT INTO trade_bilateral_cov/.test(sql)) { cov.set(a.slice(0, 5).join('|'), new Date()); return { rows: [] }; }
      if (/INSERT INTO trade_bilateral /.test(sql)) { bil.set(a.slice(0, 5).join('|'), { period: a[4], net_wgt: a[5], value: a[6] }); return { rows: [] }; }
      if (/FROM trade_bilateral /.test(sql)) { const [r, p, f, c, lo, hi] = a; return { rows: [...bil.entries()].filter(([k, v]) => k.startsWith([r, p, f, c].join('|') + '|') && v.period >= lo && v.period <= hi).map(([, v]) => v).sort((x, y) => x.period.localeCompare(y.period)) }; }
      throw new Error(`unexpected query ${sql.slice(0, 40)}`);
    },
  };
}
const NOW = new Date('2026-11-01T00:00:00Z');
const monthsOf = (periods, wgt) => periods.map((p) => ({ period: p, reporter: 0, partner: 0, flow: 'X', cmd: '1511', wgtKg: wgt, usd: wgt * 0.8 }));

test('loadPair: fetches once per year, then answers from the cache; exporter source; no mirror call when the exporter has data', async () => {
  const db = fakeDb(); const calls = [];
  const call = async (p) => { calls.push(`${p.reporter}>${p.partner}:${p.flow}:${p.periods[0].slice(0, 4)}`); return { ok: true, code: 'ok', calls: 1, rows: monthsOf(p.periods, 1000000) }; };
  const q = { ex: 360, im: 699, hs: '1511', from: '202501', to: '202609' };
  const first = await loadPair(q, { call, db, now: NOW });
  assert.equal(first.source, 'exporter_report'); assert.equal(first.incomplete, false);
  assert.deepEqual(calls.sort(), ['360>699:X:2024', '360>699:X:2025', '360>699:X:2026']);
  assert.equal(first.series.length, 21); assert.equal(first.series[0].ton, 1000);
  assert.ok(first.series[0].yoyTon === 0, 'the prior-year month came from the lookback year');
  const again = await loadPair(q, { call, db, now: NOW });
  assert.equal(calls.length, 3, 'nothing fetched the second time'); assert.equal(again.series.length, 21);
});

test('loadPair: no exporter data -> the importer mirror report; empty years are remembered; an API failure is reported, not stored', async () => {
  const db = fakeDb(); const calls = [];
  const call = async (p) => { calls.push(`${p.reporter}:${p.flow}`); return p.flow === 'X' ? { ok: true, code: 'ok', calls: 1, rows: [] } : { ok: true, code: 'ok', calls: 1, rows: monthsOf(p.periods, 2000000) }; };
  const q = { ex: 360, im: 699, hs: '1511', from: '202601', to: '202609' };
  const r = await loadPair(q, { call, db, now: NOW });
  assert.equal(r.source, 'importer_report'); assert.ok(calls.includes('360:X') && calls.includes('699:M'));
  const n = calls.length; await loadPair(q, { call, db, now: NOW });
  assert.equal(calls.length, n, 'empty exporter years and mirror years are cached');
  const db2 = fakeDb();
  const failing = await loadPair(q, { call: async () => ({ ok: false, code: 'rate_limited', message: 'slow', calls: 1, rows: [] }), db: db2, now: NOW });
  assert.equal(failing.incomplete, true); assert.equal(failing.error.code, 'rate_limited'); assert.equal(db2.cov.size, 0, 'a failed year is asked again next time');
});

test('loadPair: the per-request call budget stops a cold long range and says so', async () => {
  const db = fakeDb(); let n = 0;
  const call = async (p) => { n++; return { ok: true, code: 'ok', calls: 1, rows: monthsOf(p.periods, 1000) }; };
  const r = await loadPair({ ex: 360, im: 699, hs: '1511', from: '199601', to: '202609' }, { call, db, now: NOW });
  assert.equal(r.incomplete, true); assert.ok(n <= 8, `made ${n} calls`);
  assert.ok(r.series.some((p) => p.ton != null), 'the newest years were fetched first');
});
