const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { isCronAuthorized, summarize, runSteps, dailyHandler } = require('../server/lib/cronRunner');

const req = (authorization) => ({ get: (h) => (h.toLowerCase() === 'authorization' ? authorization : undefined) });

test('isCronAuthorized: exact bearer match only; no configured secret means nobody; length mismatch is rejected without throwing', () => {
  const env = { CRON_SECRET: 's3cret' };
  assert.equal(isCronAuthorized(req('Bearer s3cret'), env), true);
  assert.equal(isCronAuthorized(req('Bearer s3creT'), env), false);
  assert.equal(isCronAuthorized(req('Bearer s3cret '), env), false);
  assert.equal(isCronAuthorized(req('s3cret'), env), false);
  assert.equal(isCronAuthorized(req(undefined), env), false);
  assert.equal(isCronAuthorized(req('Bearer '), {}), false);
  assert.equal(isCronAuthorized(req('Bearer undefined'), {}), false);
});

test('summarize: arrays are counted, objects keep the report fields, other values read "done"', () => {
  assert.deepEqual(summarize([{ ok: true, count: 2 }, { ok: false }]), { sources: 2, ok: 1, failed: 1, newItems: 2 });
  assert.equal(summarize({ ran: true, done: false, progress: '3/9', extra: 'dropped' }).progress, '3/9');
  assert.equal('extra' in summarize({ ran: true, extra: 1 }), false);
  assert.equal(summarize('x'), 'done');
});

test('runSteps: a throwing step is reported and the rest still run; past the budget steps are skipped except the watchdog', async () => {
  const calls = [];
  const steps = [
    ['a', async () => { calls.push('a'); return { ran: true }; }],
    ['b', async () => { calls.push('b'); throw new Error('boom'); }],
    ['c', async () => { calls.push('c'); return 1; }],
  ];
  const r = await runSteps(steps, { started: 0, budgetMs: 1000, now: () => 0 });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(r.b, 'error: boom');
  assert.equal(r.c, 'done');
  const late = [['a', async () => 1], ['pipeline_watchdog', async () => ({ ran: true })]];
  const r2 = await runSteps(late, { started: 0, budgetMs: 10, now: () => 5000 });
  assert.equal(r2.a, 'skipped_budget');
  assert.equal(r2.pipeline_watchdog.ran, true);
});

test('runSteps: a chained hop runs only the morning-pipeline steps', async () => {
  const ran = [];
  const mk = (n) => [n, async () => { ran.push(n); return 1; }];
  await runSteps([mk('daily_discovery'), mk('collections'), mk('ensure_daily_brief'), mk('review_autopilot'), mk('pipeline_watchdog')],
    { started: Date.now(), budgetMs: 1e9, isChain: true, chainSteps: new Set(['daily_discovery', 'ensure_daily_brief', 'pipeline_watchdog']) });
  assert.deepEqual(ran, ['daily_discovery', 'ensure_daily_brief', 'pipeline_watchdog']);
});

function serve(handler) {
  const app = express();
  app.get('/api/cron/daily', handler);
  return new Promise((resolve) => { const server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${server.address().port}/api/cron/daily`, close: () => server.close() })); });
}

test('daily handler: 401 without the secret; 202 at once for a chained hop (work tracked in the background); 200 with the report otherwise', async () => {
  process.env.CRON_SECRET = 'abc';
  const tracked = [];
  let runWith = null;
  const run = async (depth) => { runWith = depth; return { ok: true, chain: depth, results: {} }; };
  const s = await serve(dailyHandler({ run, track: (p) => tracked.push(p) }));
  try {
    assert.equal((await fetch(s.base)).status, 401);
    assert.equal((await fetch(s.base, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal(runWith, null);
    const ok = await fetch(s.base, { headers: { authorization: 'Bearer abc' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).chain, 0);
    const hop = await fetch(s.base, { headers: { authorization: 'Bearer abc', 'x-cron-chain': '3' } });
    assert.equal(hop.status, 202);
    assert.deepEqual(await hop.json(), { chained: true, depth: 3 });
    assert.equal(tracked.length, 1);
    await tracked[0];
    assert.equal(runWith, 3);
  } finally { s.close(); delete process.env.CRON_SECRET; }
});
