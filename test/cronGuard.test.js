const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const guard = require('../server/lib/cronGuard');
const dailyBrief = require('../server/lib/dailyBrief');

test('chainTarget follows the production host Vercel injects (survives a domain rename), never a hard-coded URL', () => {
  assert.equal(guard.chainTarget({ VERCEL_PROJECT_PRODUCTION_URL: 'oilfats-research.vercel.app' }), 'https://oilfats-research.vercel.app/api/cron/daily');
  assert.equal(guard.chainTarget({ VERCEL_URL: 'x-abc.vercel.app' }), 'https://x-abc.vercel.app/api/cron/daily');
  assert.equal(guard.chainTarget({}), null);
});

test('shouldChain: only an unfinished discovery chains, and never beyond the depth cap', () => {
  assert.equal(guard.shouldChain({ done: false, progress: '30/69' }, 0), true);
  assert.equal(guard.shouldChain({ done: true }, 0), false);
  assert.equal(guard.shouldChain({ ran: false, reason: 'in_progress' }, 0), false);
  assert.equal(guard.shouldChain('skipped_budget', 0), false);
  assert.equal(guard.shouldChain({ done: false }, guard.MAX_CHAIN_DEPTH), false);
});

test('chainNext: calls the next hop with the secret and the depth header; reports a failure instead of throwing', async () => {
  let seen;
  const ok = await guard.chainNext(2, { env: { VERCEL_PROJECT_PRODUCTION_URL: 'h.vercel.app', CRON_SECRET: 's3' }, fetchImpl: async (url, opts) => { seen = { url, opts }; return { status: 202 }; } });
  assert.equal(ok, 'hop_2_http_202');
  assert.equal(seen.url, 'https://h.vercel.app/api/cron/daily');
  assert.equal(seen.opts.headers.authorization, 'Bearer s3');
  assert.equal(seen.opts.headers['x-cron-chain'], '2');
  assert.match(await guard.chainNext(1, { env: { VERCEL_PROJECT_PRODUCTION_URL: 'h', CRON_SECRET: 's' }, fetchImpl: async () => { throw new Error('boom'); } }), /hop_1_failed_boom/);
  assert.equal(await guard.chainNext(1, { env: {} }), 'no_target');
});

test('pipelineIncident: stalled collection after 09:00 KST and a headline missing 30+ min after collection are incidents; normal progress is not', () => {
  const now = new Date('2026-10-24T02:00:00Z').getTime();
  assert.match(guard.pipelineIncident({ completedToday: false, state: 'stalled', progress: { done: 63, total: 69 } }, { state: 'none' }, { hourKst: 11, now }), /stalled at 63\/69/);
  assert.equal(guard.pipelineIncident({ completedToday: false, state: 'stalled', progress: null }, { state: 'none' }, { hourKst: 8, now }), null);
  assert.equal(guard.pipelineIncident({ completedToday: false, state: 'running' }, { state: 'none' }, { hourKst: 11, now }), null);
  assert.equal(guard.pipelineIncident({ completedToday: true, completedAt: new Date(now - 10 * 60000) }, { state: 'generating' }, { hourKst: 11, now }), null);
  assert.match(guard.pipelineIncident({ completedToday: true, completedAt: new Date(now - 45 * 60000) }, { state: 'none' }, { hourKst: 11, now }), /headline not ready 45 min/);
  assert.equal(guard.pipelineIncident({ completedToday: true, completedAt: new Date(now - 45 * 60000) }, { state: 'ready' }, { hourKst: 11, now }), null);
});

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params, calls.length); };
  return { calls, restore: () => { pool.query = original; } };
}
const AT_0830_KST = new Date('2026-10-23T23:30:00Z'); // 2026-10-24 08:30 KST
const AT_1100_KST = new Date('2026-10-24T02:00:00Z');

test('ensureDailyBrief: before the 10:00 KST deadline it waits for collection; after collection it generates; a ready brief is left alone', async () => {
  let m = mockPool(() => ({ rows: [] }));
  try {
    assert.deepEqual(await dailyBrief.ensureDailyBrief(AT_0830_KST, { discoveryDone: false }), { ran: false, reason: 'collection_running' });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
  // no brief row yet + collection done -> the claim INSERT runs (rows: [] = claim lost, so nothing is started in the test)
  m = mockPool((text) => (/SELECT status, item_count/.test(text) ? { rows: [] } : { rows: [] }));
  try {
    await dailyBrief.ensureDailyBrief(AT_1100_KST, { discoveryDone: true });
    assert.ok(m.calls.some((c) => /INSERT INTO daily_briefs/.test(c.text)));
  } finally { m.restore(); }
});

test('ensureDailyBrief: past the deadline a missing brief is generated even though collection is unfinished', async () => {
  const m = mockPool(() => ({ rows: [] }));
  try {
    await dailyBrief.ensureDailyBrief(AT_1100_KST, { discoveryDone: false });
    assert.ok(m.calls.some((c) => /INSERT INTO daily_briefs/.test(c.text)));
  } finally { m.restore(); }
});

test('ensureDailyBrief: a ready brief is final for the day (no refresh, however many items arrive later)', async () => {
  const m = mockPool((text) => (/SELECT status/.test(text) ? { rows: [{ status: 'ready' }] } : { rows: [{ n: 99 }] }));
  try {
    assert.deepEqual(await dailyBrief.ensureDailyBrief(AT_1100_KST, { discoveryDone: true }), { ran: false, reason: 'up_to_date' });
    assert.ok(!m.calls.some((c) => /INSERT INTO daily_briefs/.test(c.text)));
  } finally { m.restore(); }
});

test('pipelineIncident: a brief that is generating right now (e.g. a retry) is not an incident, a stuck one is', () => {
  const now = new Date('2026-10-25T04:31:00Z').getTime();
  const done = { completedToday: true, completedAt: new Date(now - 374 * 60000) };
  assert.equal(guard.pipelineIncident(done, { state: 'generating', updatedAt: new Date(now - 5 * 1000) }, { hourKst: 13, now }), null);
  assert.match(guard.pipelineIncident(done, { state: 'generating', updatedAt: new Date(now - 40 * 60000) }, { hourKst: 13, now }), /headline not ready/);
  assert.match(guard.pipelineIncident(done, { state: 'failed', updatedAt: new Date(now - 1000) }, { hourKst: 13, now }), /headline not ready/);
});
