const test = require('node:test');
const assert = require('node:assert/strict');

const KEYS = ['BARCHART_ONDEMAND_API_KEY', 'BARCHART_DATA_DISPLAY_ENABLED'];
function setEnv(vals) { for (const k of KEYS) { if (vals[k] === undefined) delete process.env[k]; else process.env[k] = vals[k]; } }
function fresh() { delete require.cache[require.resolve('../server/lib/marketData')]; return require('../server/lib/marketData'); }
const quoteBody = { status: { code: 200 }, results: [
  { symbol: 'KO*0', lastPrice: '4793', netChange: '20', percentChange: '0.42', mode: 'I', tradeTimestamp: '2026-10-22T10:00:00Z', high: '4800', low: '4700', volume: '100' },
  { symbol: 'ZL*0', lastPrice: '', mode: 'D' },
] };
const histBody = { status: { code: 200 }, results: [{ timestamp: 't1', tradingDay: 'd', close: '1.5' }, { timestamp: null, close: '2' }, { timestamp: 't3', close: 'x' }] };
function stubFetch(handler) { const original = global.fetch; global.fetch = handler; return () => { global.fetch = original; }; }
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('disabled unless BOTH the key and the display flag are set: no network call, an explicit reason, all instruments unavailable', async () => {
  const calls = [];
  const restore = stubFetch(async (...a) => { calls.push(a); return json(quoteBody); });
  try {
    for (const env of [{}, { BARCHART_ONDEMAND_API_KEY: 'k' }, { BARCHART_DATA_DISPLAY_ENABLED: 'true' }, { BARCHART_ONDEMAND_API_KEY: 'k', BARCHART_DATA_DISPLAY_ENABLED: 'yes' }]) {
      setEnv(env);
      const out = await fresh().getMarketData();
      assert.equal(out.configured, false);
      assert.equal(out.reason, 'provider_not_enabled');
      assert.ok(out.instruments.every((i) => i.available === false && i.price === null && i.bars.length === 0));
    }
    assert.equal(calls.length, 0);
  } finally { restore(); setEnv({}); }
});

test('enabled: quotes and history are normalised (non-numeric -> null, bars without timestamp or close dropped) and the key is only sent to the provider', async () => {
  setEnv({ BARCHART_ONDEMAND_API_KEY: 'secret-key', BARCHART_DATA_DISPLAY_ENABLED: 'true' });
  const urls = [];
  const restore = stubFetch(async (url) => { urls.push(String(url)); return json(String(url).includes('getQuote') ? quoteBody : histBody); });
  try {
    const out = await fresh().getMarketData();
    assert.equal(out.configured, true);
    assert.deepEqual(out.errors, []);
    const palm = out.instruments.find((i) => i.id === 'palm-oil');
    const soy = out.instruments.find((i) => i.id === 'soybean-oil');
    assert.equal(palm.available, true);
    assert.equal(palm.price, 4793);
    assert.equal(palm.mode, 'I');
    assert.equal(soy.available, false);
    assert.equal(soy.price, null);
    assert.deepEqual(palm.bars, [{ timestamp: 't1', tradingDay: 'd', close: 1.5 }]);
    assert.ok(urls.every((u) => u.startsWith('https://ondemand.websol.barchart.com/')));
    assert.ok(!JSON.stringify(out).includes('secret-key'), 'the API key never appears in the response');
  } finally { restore(); setEnv({}); }
});

test('quotes are cached per process: a second call within the TTL makes no new provider request', async () => {
  setEnv({ BARCHART_ONDEMAND_API_KEY: 'k', BARCHART_DATA_DISPLAY_ENABLED: 'true' });
  let n = 0;
  const restore = stubFetch(async (url) => { n += 1; return json(String(url).includes('getQuote') ? quoteBody : histBody); });
  try {
    const m = fresh();
    await m.getMarketData();
    const first = n;
    await m.getMarketData();
    assert.equal(n, first);
  } finally { restore(); setEnv({}); }
});

test('provider failure with nothing cached: reported as unavailable, never thrown; HTTP error and bad status are both failures', async () => {
  setEnv({ BARCHART_ONDEMAND_API_KEY: 'k', BARCHART_DATA_DISPLAY_ENABLED: 'true' });
  let restore = stubFetch(async () => json({}, false, 503));
  try {
    const out = await fresh().getMarketData();
    assert.deepEqual(out.errors.sort(), ['history_unavailable', 'quotes_unavailable']);
    assert.ok(out.instruments.every((i) => i.available === false));
    assert.equal(out.stale, false);
  } finally { restore(); }
  restore = stubFetch(async () => json({ status: { code: 401 }, results: [] }));
  try {
    assert.equal((await fresh().getMarketData()).errors.length, 2);
  } finally { restore(); setEnv({}); }
});

test('after a successful load, a later provider failure serves the cached data marked stale', async () => {
  setEnv({ BARCHART_ONDEMAND_API_KEY: 'k', BARCHART_DATA_DISPLAY_ENABLED: 'true' });
  const realNow = Date.now;
  let fail = false;
  const restore = stubFetch(async (url) => (fail ? json({}, false, 500) : json(String(url).includes('getQuote') ? quoteBody : histBody)));
  try {
    const m = fresh();
    await m.getMarketData();
    fail = true;
    Date.now = () => realNow() + 20 * 60 * 1000; // both caches expired
    const out = await m.getMarketData();
    assert.equal(out.stale, true);
    assert.equal(out.instruments.find((i) => i.id === 'palm-oil').price, 4793);
  } finally { Date.now = realNow; restore(); setEnv({}); }
});
