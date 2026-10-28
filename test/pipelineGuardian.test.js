const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pool = require('../server/db/pool');
const guard = require('../server/lib/cronGuard');
const { needsKick, maybeKickStalledPipeline, KICK_MIN_GAP_MS } = require('../server/lib/pipelineGuardian');
const { recordPipelineEvent, MAX_EVENTS } = require('../server/lib/pipelineTrace');

const kst = (hh, mm) => new Date(Date.UTC(2026, 9, 28, hh - 9 + 24, mm)); // 2026-10-29 hh:mm KST
const ENV = { VERCEL_PROJECT_PRODUCTION_URL: 'h.vercel.app', CRON_SECRET: 's' };
const noSleep = async () => {};

test('chainNext: a dropped hand-off is retried (network error, 5xx, 429) and reports how it ended; a 401 is not retried', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error('reset'); if (n === 2) return { status: 503 }; return { status: 202 }; };
  assert.equal(await guard.chainNext(3, { env: ENV, fetchImpl: flaky, sleep: noSleep }), 'hop_3_http_202_attempt3');
  n = 0;
  assert.match(await guard.chainNext(3, { env: ENV, fetchImpl: async () => { n++; return { status: 500 }; }, sleep: noSleep }), /hop_3_http_500_gave_up/);
  assert.equal(n, 3, 'initial try + 2 retries');
  n = 0;
  assert.equal(await guard.chainNext(3, { env: ENV, fetchImpl: async () => { n++; return { status: 401 }; }, sleep: noSleep }), 'hop_3_http_401');
  assert.equal(n, 1);
});

test('needsKick: only an unfinished collection inside 07:00-12:00 KST that is stalled, or has not started 15 min into the window', () => {
  const stalled = { completedToday: false, state: 'stalled', progress: { done: 54, total: 80 } };
  assert.equal(needsKick(stalled, kst(8, 10)), true);
  assert.equal(needsKick({ ...stalled, completedToday: true }, kst(8, 10)), false);
  assert.equal(needsKick({ completedToday: false, state: 'running', progress: { done: 3, total: 80 } }, kst(8, 10)), false);
  assert.equal(needsKick(stalled, kst(6, 30)), false, 'before the window');
  assert.equal(needsKick(stalled, kst(12, 0)), false, 'after the window');
  assert.equal(needsKick({ completedToday: false, state: 'waiting', progress: null }, kst(7, 10)), false, 'cron may still arrive');
  assert.equal(needsKick({ completedToday: false, state: 'waiting', progress: null }, kst(7, 20)), true, 'the 07:00 cron never came');
});

function mockPool(claimGranted) {
  const original = pool.query; const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    if (/UPDATE scheduler_jobs SET last_completed_at = now\(\)/.test(text)) return { rows: claimGranted ? [{ job_name: 'pipeline_kick' }] : [] };
    if (/SELECT last_totals FROM scheduler_jobs/.test(text)) return { rows: [] };
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('maybeKickStalledPipeline: a stalled morning collection starts a fresh chain (depth 1) once per claim and is traced; a lost claim or a healthy state does nothing', async () => {
  const stalled = { completedToday: false, state: 'stalled', progress: { done: 54, total: 80 } };
  let m = mockPool(true); const seen = [];
  try {
    const r = await maybeKickStalledPipeline({ now: kst(8, 10), status: stalled, env: ENV, sleep: noSleep, fetchImpl: async (url, opts) => { seen.push({ url, depth: opts.headers['x-cron-chain'] }); return { status: 202 }; } });
    assert.deepEqual([r.kicked, r.result], [true, 'hop_1_http_202']);
    assert.deepEqual(seen, [{ url: 'https://h.vercel.app/api/cron/daily', depth: '1' }]);
    const claim = m.calls.find((c) => /UPDATE scheduler_jobs SET last_completed_at/.test(c.text));
    assert.equal(claim.params[0] * 1000, KICK_MIN_GAP_MS);
    const trace = m.calls.find((c) => /INSERT INTO scheduler_jobs \(job_name, last_run_date, last_totals\)/.test(c.text) && c.params[0] === 'pipeline_trace');
    assert.match(trace.params[1], /self_heal_kick/);
    assert.match(trace.params[1], /54\/80/);
  } finally { m.restore(); }
  m = mockPool(false);
  try {
    const r = await maybeKickStalledPipeline({ now: kst(8, 10), status: stalled, env: ENV, sleep: noSleep, fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.deepEqual(r, { kicked: false, reason: 'recently_kicked' });
    assert.deepEqual(await maybeKickStalledPipeline({ now: kst(8, 10), status: { completedToday: true }, env: ENV }), { kicked: false, reason: 'not_needed' });
  } finally { m.restore(); }
});

test('pipeline trace keeps the newest events only and never throws', async () => {
  const original = pool.query; let stored = null;
  const events = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ({ at: 'x', kind: 'old', i }));
  pool.query = async (text, params) => {
    if (/SELECT last_totals/.test(text)) return { rows: [{ last_totals: { events } }] };
    stored = JSON.parse(params[1]); return { rows: [] };
  };
  try {
    await recordPipelineEvent('chain', { depth: 2 });
    assert.equal(stored.events.length, MAX_EVENTS);
    assert.equal(stored.events[stored.events.length - 1].kind, 'chain');
    pool.query = async () => { throw new Error('db down'); };
    await recordPipelineEvent('chain', {});   // resolves
  } finally { pool.query = original; }
});

test('wiring: several Vercel cron kicks in the morning window, the visit hook is installed, the home light says recovery is automatic', () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const kicks = v.crons.filter((c) => c.path === '/api/cron/daily').map((c) => c.schedule);
  assert.ok(kicks.length >= 4);
  assert.ok(kicks.includes('0 22 * * *'));
  const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(index, /pipelineGuardian'\)\.maybeKickStalledPipeline\(\)/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /자동 복구 중/);
  assert.ok(!/재시도 대기/.test(app));
});
