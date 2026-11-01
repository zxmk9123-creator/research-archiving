const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTradeXml, callTradeApi } = require('../server/lib/tradeApi');
const { monthWindows, runTradeSync } = require('../server/lib/tradeSync');

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
  const w = monthWindows(24, new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual(w, [{ from: '202411', to: '202510' }, { from: '202511', to: '202610' }]);
  assert.deepEqual(monthWindows(3, new Date('2026-03-10T00:00:00Z')), [{ from: '202512', to: '202602' }]);
});
test('runTradeSync probe reports each API without writing; sync stores rows', async () => {
  const calls = [];
  const call = async (api, p) => { calls.push(api); return parseTradeXml(OK); };
  const probe = await runTradeSync({ mode: 'probe', call, now: new Date('2026-11-01T00:00:00Z'), db: { query: async () => { throw new Error('probe must not write'); } } });
  assert.deepEqual(Object.keys(probe.apis), ['trade_item', 'trade_item_country', 'trade_country']);
  assert.equal(probe.apis.trade_item.rows, 1);
  const q = [];
  const rep = await runTradeSync({ mode: 'sync', months: 12, call: async (api) => (api === 'trade_item_country' ? { ok: false, code: '99', message: 'x', rows: [], fields: [] } : parseTradeXml(OK)), now: new Date('2026-11-01T00:00:00Z'), db: { query: async (sql, args) => { q.push(args); return { rows: [] }; } } });
  assert.equal(rep.items['1511'], 1); assert.equal(rep.ok, false); assert.match(rep.errors[0], /country 1511/);
});

test('foldRows sums sub-codes per month (and per country) instead of overwriting', () => {
  const { foldRows } = require('../server/lib/tradeSync');
  const rows = [
    { period: '202511', countryCode: 'ID', countryName: '인도네시아', impWgt: 100, impAmt: 50, expWgt: null, expAmt: null },
    { period: '202511', countryCode: 'ID', countryName: '인도네시아', impWgt: 20, impAmt: 10, expWgt: 1, expAmt: 2 },
    { period: '202511', countryCode: 'MY', countryName: '말레이시아', impWgt: 5, impAmt: 3, expWgt: null, expAmt: null },
    { period: '202512', countryCode: '', countryName: null, impWgt: 7, impAmt: 1, expWgt: null, expAmt: null },
  ];
  const item = foldRows(rows, false);
  assert.deepEqual(item.map((r) => [r.period, r.impWgt, r.impAmt]), [['202511', 125, 63], ['202512', 7, 1]]);
  const byCountry = foldRows(rows, true);
  assert.equal(byCountry.length, 2);
  assert.deepEqual([byCountry[0].countryCode, byCountry[0].impWgt, byCountry[0].expWgt], ['ID', 120, 1]);
});
