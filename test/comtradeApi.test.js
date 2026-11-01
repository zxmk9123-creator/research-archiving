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
      if (/FROM trade_bilateral_cov/.test(sql)) {
        const [r, p, f, cmds, years] = a;
        return { rows: [...cov.entries()].filter(([k]) => { const [kr, kp, kf, kc, ky] = k.split('|'); return Number(kr) === r && Number(kp) === p && kf === f && cmds.includes(kc) && years.includes(Number(ky)); })
          .map(([k, v]) => { const [, , , kc, ky] = k.split('|'); return { cmd: kc, year: Number(ky), fetched_at: v }; }) };
      }
      if (/INSERT INTO trade_bilateral_cov/.test(sql)) { cov.set(a.slice(0, 5).join('|'), new Date()); return { rows: [] }; }
      if (/INSERT INTO trade_bilateral /.test(sql)) { bil.set(a.slice(0, 5).join('|'), { period: a[4], net_wgt: a[5], value: a[6] }); return { rows: [] }; }
      if (/FROM trade_bilateral /.test(sql)) { const [r, p, f, c, lo, hi] = a; return { rows: [...bil.entries()].filter(([k, v]) => k.startsWith([r, p, f, c].join('|') + '|') && v.period >= lo && v.period <= hi).map(([, v]) => v).sort((x, y) => x.period.localeCompare(y.period)) }; }
      throw new Error(`unexpected query ${sql.slice(0, 40)}`);
    },
  };
}
const NOW = new Date('2026-11-01T00:00:00Z');
// an answer like the API's: every requested item, every requested month
const answer = (p, wgt) => p.cmd.split(',').flatMap((cmd) => p.periods.map((period) => ({ period, reporter: p.reporter, partner: p.partner, flow: p.flow, cmd, wgtKg: wgt, usd: wgt * 0.8 })));
const okCall = (calls, wgt = 1000000) => async (p) => { calls.push(`${p.reporter}>${p.partner}:${p.flow}:${p.cmd}:${p.periods[0].slice(0, 4)}`); return { ok: true, code: 'ok', calls: 1, rows: answer(p, wgt) }; };

test('loadPair: fetches once per year, then answers from the cache; exporter source; no mirror call when the exporter has data', async () => {
  const db = fakeDb(); const calls = [];
  const q = { ex: 360, im: 699, hs: '1511', from: '202501', to: '202609' };
  const first = await loadPair(q, { call: okCall(calls), db, now: NOW });
  assert.equal(first.source, 'exporter_report'); assert.equal(first.incomplete, false); assert.equal(first.pending, false);
  assert.deepEqual(calls.sort(), ['360>699:X:1511:2024', '360>699:X:1511:2025', '360>699:X:1511:2026']);
  assert.equal(first.series.length, 21); assert.equal(first.series[0].ton, 1000);
  assert.ok(first.series[0].yoyTon === 0, 'the prior-year month came from the lookback year');
  const again = await loadPair(q, { call: okCall(calls), db, now: NOW });
  assert.equal(calls.length, 3, 'nothing fetched the second time'); assert.equal(again.series.length, 21);
});

test('loadPair: years are fetched in parallel (four at a time), not one after another', async () => {
  let running = 0; let peak = 0;
  const call = async (p) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 25)); running--; return { ok: true, code: 'ok', calls: 1, rows: answer(p, 1000) }; };
  await loadPair({ ex: 360, im: 699, hs: '1511', from: '202301', to: '202609' }, { call, db: fakeDb(), now: NOW });
  assert.ok(peak >= 3 && peak <= 4, `peak concurrency ${peak}`);
});

test('loadPair: several items share one call per year (an item group asks its HS6 codes together)', async () => {
  const calls = [];
  const r = await loadPair({ ex: 360, im: 0, hs: 'RAPESEED', cmds: ['151411', '151419'], from: '202601', to: '202609' }, { call: okCall(calls), db: fakeDb(), now: NOW });
  assert.ok(calls.every((c) => c.includes(':151411,151419:')), 'one request carries both items');
  assert.equal(calls.length, 2, 'two years, one call each (not four)');
  assert.equal(r.series[0].ton, 2000, 'the two items are summed per month');
});

test('loadPair: no exporter data -> the importer mirror report; empty years are remembered; an API failure is reported, not stored', async () => {
  const db = fakeDb(); const calls = [];
  const call = async (p) => { calls.push(`${p.reporter}:${p.flow}`); return p.flow === 'X' ? { ok: true, code: 'ok', calls: 1, rows: [] } : { ok: true, code: 'ok', calls: 1, rows: answer(p, 2000000) }; };
  const q = { ex: 360, im: 699, hs: '1511', from: '202601', to: '202609' };
  const r = await loadPair(q, { call, db, now: NOW });
  assert.equal(r.source, 'importer_report'); assert.ok(calls.includes('360:X') && calls.includes('699:M'));
  const n = calls.length; await loadPair(q, { call, db, now: NOW });
  assert.equal(calls.length, n, 'empty exporter years and mirror years are cached');
  const db2 = fakeDb();
  const failing = await loadPair(q, { call: async () => ({ ok: false, code: 'rate_limited', message: 'slow', calls: 1, rows: [] }), db: db2, now: NOW });
  assert.equal(failing.incomplete, true); assert.equal(failing.error.code, 'rate_limited'); assert.equal(db2.cov.size, 0, 'a failed year is asked again next time');
  assert.equal(failing.pending, false, 'a failure is not "still loading": the page must not poll forever');
});

test('loadPair: the per-request call budget stops a cold long range and says so; the newest years come first', async () => {
  const db = fakeDb(); const calls = [];
  const r = await loadPair({ ex: 360, im: 699, hs: '1511', from: '199601', to: '202609' }, { call: okCall(calls), db, now: NOW });
  assert.equal(r.incomplete, true); assert.ok(calls.length <= 12, `made ${calls.length} calls`);
  assert.ok(r.series.some((p) => p.ton != null), 'the newest years were fetched first');
});

test('loadPair fast mode: answers after the first years, leaves the rest pending, and continueLoading() finishes them', async () => {
  const db = fakeDb(); const calls = [];
  const q = { ex: 360, im: 699, hs: '1511', from: '202301', to: '202609' };
  const first = await loadPair(q, { call: okCall(calls), db, now: NOW, fast: true });
  assert.equal(calls.length, 2, 'only the two newest years before answering'); assert.equal(first.pending, true); assert.equal(first.incomplete, true);
  assert.ok(first.series.some((p) => p.ton != null));
  await first.continueLoading();
  assert.equal(calls.length, 5, 'the three remaining years (2023-2025 plus the lookback year 2022) were fetched in the background');
  const done = await loadPair(q, { call: okCall(calls), db, now: NOW, fast: true });
  assert.equal(done.pending, false); assert.equal(done.incomplete, false); assert.equal(calls.length, 5);
});

test('loadPair: the same fetch asked twice at once is one API call', async () => {
  const calls = []; const db = fakeDb();
  const slow = async (p) => { calls.push(p.periods[0].slice(0, 4)); await new Promise((r) => setTimeout(r, 30)); return { ok: true, code: 'ok', calls: 1, rows: answer(p, 1000) }; };
  const q = { ex: 360, im: 699, hs: '1511', from: '202601', to: '202609' };
  await Promise.all([loadPair(q, { call: slow, db, now: NOW }), loadPair(q, { call: slow, db, now: NOW })]);
  assert.equal(calls.length, 2, 'two years, each fetched once although two requests asked');
});

test('loadPair: a country against "all countries" reads that country\'s own report vs World (partner 0) and never falls back to a mirror', async () => {
  const seenCalls = [];
  const call = async (p) => { seenCalls.push(`${p.reporter}>${p.partner}:${p.flow}`); return { ok: true, code: 'ok', calls: 1, rows: answer(p, 5000000) }; };
  const exp = await loadPair({ ex: 360, im: 0, hs: '1511', from: '202601', to: '202609' }, { call, db: fakeDb(), now: NOW });
  assert.equal(exp.scope, 'exporter_total'); assert.equal(exp.source, 'exporter_report'); assert.ok(seenCalls.every((c) => c === '360>0:X'));
  seenCalls.length = 0;
  const imp = await loadPair({ ex: 0, im: 410, hs: '1511', from: '202601', to: '202609' }, { call, db: fakeDb(), now: NOW });
  assert.equal(imp.scope, 'importer_total'); assert.equal(imp.source, 'importer_report'); assert.ok(seenCalls.every((c) => c === '410>0:M'));
  seenCalls.length = 0;
  const empty = await loadPair({ ex: 360, im: 0, hs: '1511', from: '202601', to: '202609' }, { call: async (p) => { seenCalls.push(p.flow); return { ok: true, code: 'ok', calls: 1, rows: [] }; }, db: fakeDb(), now: NOW });
  assert.equal(empty.source, 'none'); assert.ok(seenCalls.every((f) => f === 'X'), 'no mirror call for a total');
});

test('warm-up: fills the common series in batched calls, and a second run costs nothing', async () => {
  const { runWarm, COMBOS, BATCHES } = require('../server/lib/tradeWarm');
  const db = fakeDb(); const calls = [];
  const r1 = await runWarm({ offset: 0, limit: 2, now: NOW, call: okCall(calls), db });
  assert.equal(r1.ok, true); assert.equal(r1.next, 2); assert.equal(r1.done, false);
  assert.equal(calls.length, 2 * BATCHES.length * 4, 'combos x item batches x years, one call each');
  const before = calls.length;
  await runWarm({ offset: 0, limit: 2, now: NOW, call: okCall(calls), db });
  assert.equal(calls.length, before, 'everything already cached');
  assert.equal((await runWarm({ offset: COMBOS.length - 1, limit: 6, now: NOW, call: okCall([]), db: fakeDb() })).done, true);
});

test('item groups: rules resolve to the 10-digit codes in the catalog (by name, by 6-digit code, by prefix)', async () => {
  const { groupById, groupCodes, groupsUnder, isGroupId, _clearGroupCache } = require('../server/lib/hsGroups');
  assert.deepEqual(groupsUnder('1514').map((g) => g.id), ['RAPESEED', 'MUSTARD']); assert.deepEqual(groupsUnder('1512').map((g) => g.id), ['SUNFLOWER', 'SAFFLOWER', 'COTTONSEED']);
  assert.equal(isGroupId('RAPESEED'), true); assert.equal(isGroupId('1514'), false);
  const catalog = [['1514110000', '조유'], ['1514191000', '정제유'], ['1514911000', '그 밖의 유채유'], ['1514912000', '겨자유'], ['1514991010', '그 밖의 유채유'], ['1514991020', '겨자유'], ['1514999000', '기타'],
    ['1512111000', '해바라기씨유'], ['1512112000', '잇꽃유'], ['1512191010', '해바라기씨유'], ['1512191020', '잇꽃유'], ['1512210000', '면실 조유'], ['1512291000', '정제유'], ['1512299000', '기타']];
  const db = { query: async (sql, [under, nameLike, hs6In, prefix]) => ({ rows: catalog.filter(([c, n]) => c.startsWith(under.replace('%', '')) && ((nameLike && n.includes(nameLike.replace(/%/g, ''))) || hs6In.includes(c.slice(0, 6)) || (prefix && c.startsWith(prefix.replace('%', ''))))).map(([c]) => ({ hs_code: c })) }) };
  _clearGroupCache();
  const codes = async (id) => (await groupCodes(db, groupById(id))).sort();
  assert.deepEqual(await codes('RAPESEED'), ['1514110000', '1514191000', '1514911000', '1514991010']);
  assert.deepEqual(await codes('MUSTARD'), ['1514912000', '1514991020']);
  assert.deepEqual(await codes('SUNFLOWER'), ['1512111000', '1512191010']);
  assert.deepEqual(await codes('SAFFLOWER'), ['1512112000', '1512191020']);
  assert.deepEqual(await codes('COTTONSEED'), ['1512210000', '1512291000', '1512299000']);
  const rest = catalog.map(([c]) => c).filter((c) => c.startsWith('1514') && !['RAPESEED', 'MUSTARD'].some((id) => false));
  assert.ok(rest.length > 0);
  _clearGroupCache();
});

test('item groups: what Comtrade and the country breakdown can and cannot separate is declared', () => {
  const { groupById } = require('../server/lib/hsGroups');
  assert.deepEqual(groupById('COTTONSEED').comtrade.cmds, ['151221', '151229']);
  assert.equal(groupById('MUSTARD').comtrade, null); assert.equal(groupById('SAFFLOWER').country, null);
  assert.ok(groupById('RAPESEED').comtrade.note.includes('겨자유'));
});
