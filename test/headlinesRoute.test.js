const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const dailyBriefModule = require('../server/lib/dailyBrief');
const headlinesRouter = require('../server/routes/headlines');
const { SESSION_COOKIE, issueSessionToken } = require('../server/lib/auth');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/headlines', headlinesRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/headlines`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

const authHeaders = () => ({ Cookie: `${SESSION_COOKIE}=${issueSessionToken()}` });

function mockBriefModule(fnName, handler) {
  const original = dailyBriefModule[fnName];
  dailyBriefModule[fnName] = handler;
  return () => { dailyBriefModule[fnName] = original; };
}

test('POST /generate: rejects an unauthenticated caller and never starts a generation', () => withServer(async (base) => {
  let called = 0;
  const restore = mockBriefModule('requestDailyBriefRegeneration', async () => { called++; return { started: true }; });
  try {
    const res = await fetch(`${base}/generate`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(called, 0);
  } finally {
    restore();
  }
}));

test('POST /generate: an authenticated admin starts a generation (202)', () => withServer(async (base) => {
  const restore = mockBriefModule('requestDailyBriefRegeneration', async () => ({ started: true, briefDate: '2026-10-16' }));
  try {
    const res = await fetch(`${base}/generate`, { method: 'POST', headers: authHeaders() });
    assert.equal(res.status, 202);
  } finally {
    restore();
  }
}));

test('POST /generate: the daily attempt ceiling maps to HTTP 429', () => withServer(async (base) => {
  const restore = mockBriefModule('requestDailyBriefRegeneration', async () => ({ started: false, reason: 'daily_attempt_limit_reached' }));
  try {
    const res = await fetch(`${base}/generate`, { method: 'POST', headers: authHeaders() });
    assert.equal(res.status, 429);
  } finally {
    restore();
  }
}));

test('GET /latest stays public (read-only dashboard data)', () => withServer(async (base) => {
  const restore = mockBriefModule('getLatestDailyBrief', async () => ({ brief_date: '2026-10-15', status: 'ready' }));
  try {
    const res = await fetch(`${base}/latest`);
    assert.equal(res.status, 200);
  } finally {
    restore();
  }
}));

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params, calls.length); };
  return { calls, restore: () => { pool.query = original; } };
}

test('queueDailyBriefGeneration(force): at the daily attempt ceiling it reports daily_attempt_limit_reached instead of starting', async () => {
  const { calls, restore } = mockPool((text, params, n) => (
    n === 1 ? { rows: [] } : { rows: [{ brief_date: '2026-10-16', status: 'ready', item_count: 3, attempt_count: 10 }] }
  ));
  try {
    const result = await dailyBriefModule.queueDailyBriefGeneration(new Date('2026-10-16T01:00:00Z'), { force: true });
    assert.equal(result.started, false);
    assert.equal(result.reason, 'daily_attempt_limit_reached');
    // The forced claim is bounded by attempt_count < MAX (10), passed as $6.
    assert.match(calls[0].text, /attempt_count < \$6/);
    assert.equal(calls[0].params[5], 10);
  } finally {
    restore();
  }
});

test('queueDailyBriefGeneration(non-force): the scheduled path is not subject to the manual ceiling message', async () => {
  const { restore } = mockPool((text, params, n) => (
    n === 1 ? { rows: [] } : { rows: [{ brief_date: '2026-10-16', status: 'ready', item_count: 3, attempt_count: 10 }] }
  ));
  try {
    const result = await dailyBriefModule.queueDailyBriefGeneration(new Date('2026-10-16T01:00:00Z'));
    assert.equal(result.started, false);
    assert.equal(result.reason, 'already_running_or_not_retryable');
  } finally {
    restore();
  }
});

test('maybeRefreshDailyBriefAtNoon: skips before noon KST and when the brief was already completed after noon', async () => {
  const before = mockPool(() => ({ rows: [] }));
  try {
    const r = await dailyBriefModule.maybeRefreshDailyBriefAtNoon(new Date('2026-10-23T02:00:00Z')); // 11:00 KST
    assert.deepEqual(r, { ran: false, reason: 'before_noon' });
    assert.equal(before.calls.length, 0);
  } finally { before.restore(); }
  const done = mockPool(() => ({ rows: [{ status: 'ready', completed_at: '2026-10-23T03:30:00Z' }] }));
  try {
    const r = await dailyBriefModule.maybeRefreshDailyBriefAtNoon(new Date('2026-10-23T04:07:00Z')); // 13:07 KST
    assert.equal(r.reason, 'already_refreshed');
  } finally { done.restore(); }
});

test('maybeRefreshDailyBriefAtNoon: a ready morning brief is force-regenerated after noon KST', async () => {
  const { calls, restore } = mockPool((text, params, n) => (n === 1
    ? { rows: [{ status: 'ready', completed_at: '2026-10-23T00:38:00Z' }] }
    : n === 2 ? { rows: [] } : { rows: [{ brief_date: '2026-10-23', status: 'ready', item_count: 3, attempt_count: 1 }] }));
  try {
    const r = await dailyBriefModule.maybeRefreshDailyBriefAtNoon(new Date('2026-10-23T03:07:00Z')); // 12:07 KST
    assert.equal(r.ran, false);
    assert.match(calls[1].text, /INSERT INTO daily_briefs/);
    assert.equal(calls[1].params[4], true); // force
  } finally { restore(); }
});
