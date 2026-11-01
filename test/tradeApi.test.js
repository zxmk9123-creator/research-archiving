const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTradeXml, callTradeApi } = require('../server/lib/tradeApi');

const OK = `<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>
<item><year>2026.08</year><hsCode>1511</hsCode><statKor>팜유</statKor><expDlr>10</expDlr><expWgt>5</expWgt><impDlr>1,200,000</impDlr><impWgt>1,000,000</impWgt></item>
<item><year>총계</year><impDlr>9</impDlr><impWgt>9</impWgt></item></items></body></response>`;
const AUTH = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NULL</errMsg><returnAuthMsg>서비스 접근거부</returnAuthMsg><returnReasonCode>20</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';

test('parseTradeXml: months parsed, totals skipped, numbers cleaned', () => {
  const r = parseTradeXml(OK);
  assert.equal(r.ok, true); assert.equal(r.rows.length, 1);
  assert.deepEqual([r.rows[0].period, r.rows[0].hsCode, r.rows[0].impWgt, r.rows[0].impAmt], ['202608', '1511', 1000000, 1200000]);
  assert.ok(r.fields.includes('impWgt'));
});
test('parseTradeXml: gateway error and API error are reported by name', () => {
  assert.deepEqual([parseTradeXml(AUTH).ok, parseTradeXml(AUTH).code], [false, '20']);
  const e = parseTradeXml('<response><header><resultCode>30</resultCode><resultMsg>SERVICE KEY IS NOT REGISTERED</resultMsg></header></response>');
  assert.deepEqual([e.ok, e.code], [false, '30']);
});
test('callTradeApi: no key -> no_key, key never appears in an error, 5xx retried', async () => {
  assert.equal((await callTradeApi('trade_item', { from: '202601', to: '202601' }, { env: {} })).code, 'no_key');
  const env = { DATA_GO_KR_KEY: 'TOPSECRETKEY' };
  const r = await callTradeApi('trade_item', { from: '202601', to: '202601', hs: '1511' }, { env, fetchImpl: async () => { throw new Error('connect TOPSECRETKEY failed'); } });
  assert.equal(r.code, 'network'); assert.doesNotMatch(JSON.stringify(r), /TOPSECRETKEY/);
  let n = 0;
  const ok = await callTradeApi('trade_item', { from: '202601', to: '202601', hs: '1511' }, { env, fetchImpl: async (u) => { n++; assert.match(u, /serviceKey=TOPSECRETKEY/); return n < 2 ? { status: 502, text: async () => 'bad' } : { status: 200, text: async () => OK }; } });
  assert.equal(ok.ok, true); assert.equal(n, 2);
});
test('monthWindows: ends at the last completed month, 12-month windows', () => {
  const { monthWindows } = require('../server/lib/tradeSync');
  assert.deepEqual(monthWindows(24, new Date('2026-11-01T00:00:00Z')), [{ from: '202411', to: '202510' }, { from: '202511', to: '202610' }]);
  assert.deepEqual(monthWindows(3, new Date('2026-03-10T00:00:00Z')), [{ from: '202512', to: '202602' }]);
});
test('runTradeSync probe reports each API without writing; sync batches headings and stores folded rows', async () => {
  const { runTradeSync, HEADINGS } = require('../server/lib/tradeSync');
  const probe = await runTradeSync({ mode: 'probe', call: async () => parseTradeXml(OK), now: new Date('2026-11-01T00:00:00Z'), db: { query: async () => { throw new Error('probe must not write'); } } });
  assert.deepEqual(Object.keys(probe.apis), ['trade_item', 'trade_item_country', 'trade_country']);
  const sql = [];
  const db = { query: async (q, a) => { sql.push([q, a]); return { rows: [] }; } };
  const call = async (api) => (api === 'trade_item_country' ? { ok: false, code: '99', message: 'x', rows: [], fields: [] } : parseTradeXml(OK));
  const rep = await runTradeSync({ mode: 'sync', months: 12, offset: 0, limit: 2, call, now: new Date('2026-11-01T00:00:00Z'), db });
  assert.deepEqual(rep.headings, [HEADINGS[0].hs, HEADINGS[1].hs]);
  assert.equal(rep.done, false); assert.equal(rep.next, 2); assert.equal(rep.ok, false); assert.match(rep.errors[0], /country 1501/);
  assert.ok(sql.some(([q]) => /DELETE FROM trade_flow/.test(q)), 'first batch removes the old folded 4-digit rows');
  const last = await runTradeSync({ mode: 'sync', months: 12, offset: HEADINGS.length - 1, limit: 6, call, now: new Date('2026-11-01T00:00:00Z'), db });
  assert.equal(last.done, true);
});
test('foldRows keeps HS codes apart and sums the same code/month/country', () => {
  const { foldRows } = require('../server/lib/tradeSync');
  const rows = [
    { hsCode: '1511901000', name: 'a', period: '202511', countryCode: '', impWgt: 100, impAmt: 50, expWgt: null, expAmt: null },
    { hsCode: '1511901000', name: 'a', period: '202511', countryCode: '', impWgt: 20, impAmt: 10, expWgt: 1, expAmt: 2 },
    { hsCode: '1511909000', name: 'b', period: '202511', countryCode: '', impWgt: 5, impAmt: 3, expWgt: null, expAmt: null },
    { hsCode: '151190', name: 'c', period: '202511', countryCode: 'ID', countryName: '인도네시아', impWgt: 7, impAmt: 1, expWgt: null, expAmt: null },
    { hsCode: '151190', name: 'c', period: '202511', countryCode: 'ID', countryName: '인도네시아', impWgt: 3, impAmt: 1, expWgt: null, expAmt: null },
  ];
  const item = foldRows(rows, false);
  assert.deepEqual(item.map((r) => [r.hsCode, r.impWgt, r.impAmt]), [['1511901000', 120, 60], ['1511909000', 5, 3], ['151190', 10, 2]]);
  const byCountry = foldRows(rows, true);
  assert.equal(byCountry.length, 1); assert.deepEqual([byCountry[0].countryCode, byCountry[0].impWgt], ['ID', 10]);
});

test('probe can test an older window and reports the earliest month returned', async () => {
  const { runTradeSync } = require('../server/lib/tradeSync');
  const seen = [];
  const r = await runTradeSync({ mode: 'probe', probeFrom: '198801', call: async (api, p) => { seen.push(p); return parseTradeXml(OK); }, db: { query: async () => { throw new Error('no writes'); } } });
  assert.deepEqual([seen[0].from, seen[0].to], ['198801', '198812']);
  assert.equal(r.apis.trade_item.firstPeriod, '202608');
});
