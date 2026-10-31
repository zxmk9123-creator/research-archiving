const test = require('node:test');
const assert = require('node:assert/strict');
const { aiRouterCheck, probeRouter, collectAiRouterInput, runAiRouterCheck } = require('../server/lib/aiRouterHealth');
const { aiProbeHandler } = require('../server/lib/cronRunner');

const NOW = Date.parse('2026-10-31T00:00:00Z');
const base = { success: 20, providerError: 0, p50Ms: 8000, p95Ms: 15000, ttftP50Ms: 3000, lastSuccessAt: new Date(NOW - 3600000).toISOString(), failureTypes: {} };
const st = (input) => aiRouterCheck(input, NOW)[0].status;

test('not collected -> no row', () => assert.deepEqual(aiRouterCheck({}, NOW), []));
test('healthy -> pass', () => assert.equal(st({ searches: base, probe: { ok: true, ms: 900 } }), 'pass'));
test('unreadable telemetry without probe -> unknown', () => assert.equal(st({ searches: null }), 'unknown'));
test('error rate thresholds', () => {
  assert.equal(st({ searches: { ...base, success: 12, providerError: 8 } }), 'warn');
  assert.equal(st({ searches: { ...base, success: 4, providerError: 6, failureTypes: { rate_limited: 6 } } }), 'fail');
  assert.equal(st({ searches: { ...base, success: 1, providerError: 3 } }), 'pass'); // too few to judge
});
test('probe failure: warn when recently ok, fail when nothing worked for hours', () => {
  const bad = { ok: false, status: 502, ms: 1, error: 'no model' };
  assert.equal(st({ searches: base, probe: bad }), 'warn');
  assert.equal(st({ searches: { ...base, lastSuccessAt: new Date(NOW - 8 * 3600000).toISOString() }, probe: bad }), 'fail');
});
test('slow answers warn', () => {
  assert.equal(st({ searches: { ...base, p95Ms: 90000 } }), 'warn');
  assert.equal(st({ searches: { ...base, ttftP50Ms: 30000 } }), 'warn');
});
test('probeRouter: ok, http error, missing config, timeout; never leaks the key', async () => {
  const env = { FREELLMAPI_BASE_URL: 'https://r/v1', FREELLMAPI_API_KEY: 'k' };
  const mk = (status, body) => async () => ({ ok: status < 400, status, text: async () => body });
  assert.equal((await probeRouter({ env, fetchImpl: mk(200, '{"choices":[{"message":{"content":"ok"}}]}') })).ok, true);
  const r = await probeRouter({ env, fetchImpl: mk(401, 'bad key sk-abcdefghijklmnop12345') });
  assert.equal(r.ok, false); assert.match(r.hint, /refused/); assert.doesNotMatch(r.error, /abcdefghijkl/);
  assert.equal((await probeRouter({ env: {}, fetchImpl: mk(200, '{}') })).ok, false);
  const t = await probeRouter({ env, fetchImpl: async () => { const e = new Error('x'); e.name = 'TimeoutError'; throw e; } });
  assert.match(t.error, /no answer/);
});
test('collect + run with mocked pool/probe', async () => {
  const pool = { query: async (sql) => (/GROUP BY 1/.test(sql) ? { rows: [{ t: 'timeout', n: 2 }] } : { rows: [{ success: 9, provider_error: 1, p50_ms: 5000, p95_ms: 9000, ttft_p50_ms: 2000, last_success_at: new Date(NOW).toISOString() }] }) };
  const i = await collectAiRouterInput({ withProbe: true, pool, probe: async () => ({ ok: true, ms: 500 }) });
  assert.equal(i.searches.failureTypes.timeout, 2);
  const r = await runAiRouterCheck({ now: NOW, pool, probe: async () => ({ ok: true, ms: 500 }) });
  assert.equal(r.status, 'pass');
  const dead = await collectAiRouterInput({ pool: { query: async () => { throw new Error('db'); } } });
  assert.equal(dead.searches, null);
});
test('handler: 401 without secret, 200 verdict, 500 on error', async () => {
  const res = () => { const o = { code: 200 }; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; return o; }; return o; };
  process.env.CRON_SECRET = 's';
  const call = async (h, auth) => { const r = res(); await h({ headers: { authorization: auth }, query: {} }, r); return r; };
  assert.equal((await call(aiProbeHandler({ check: async () => ({}) }), undefined)).code, 401);
  assert.equal((await call(aiProbeHandler({ check: async () => ({ status: 'pass' }) }), 'Bearer s')).body.status, 'pass');
  assert.equal((await call(aiProbeHandler({ check: async () => { throw new Error('x'); } }), 'Bearer s')).code, 500);
});
