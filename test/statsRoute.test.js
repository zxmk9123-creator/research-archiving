const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const statsRouter = require('../server/routes/stats');

// Same live-server harness convention as searchRoute.test.js/itemsRoute.test.js.
function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/stats`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function mockPool(handlers) {
  const original = pool.query;
  pool.query = async (text, params) => {
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return () => { pool.query = original; };
}

test('GET /overview: returns an explicit, bounded aggregation basis', () => withServer(async (base) => {
  const restore = mockPool([]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.basis.collectionWindow.days, 7);
    assert.equal(body.basis.collectionWindow.kind, 'rolling_24h_utc');
    assert.ok(body.basis.collectionWindow.start);
    assert.ok(body.basis.collectionWindow.end);
    // end - start must be exactly 7 days, not a calendar-day/local-TZ boundary.
    const spanMs = new Date(body.basis.collectionWindow.end) - new Date(body.basis.collectionWindow.start);
    assert.equal(spanMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(body.basis.backlogDefinition, "status = 'Draft'");
    assert.match(body.basis.aiFailureReasonsScope, /status = 'Draft' AND ai_status = 'failed'/);
    assert.ok(body.basis.generatedAt);
  } finally {
    restore();
  }
}));

test('GET /overview: the Draft backlog is partitioned by ai_status and sums to the total', () => withServer(async (base) => {
  const restore = mockPool([
    [`WHERE status = 'Draft'\n      GROUP BY ai_status`, () => ({
      rows: [{ ai_status: 'completed', cnt: 12 }, { ai_status: 'failed', cnt: 3 }, { ai_status: null, cnt: 2 }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.equal(body.backlog.total, 17);
    assert.deepEqual(body.backlog.byAiStatus, { completed: 12, failed: 3, null: 2 });
    const sumOfBuckets = Object.values(body.backlog.byAiStatus).reduce((a, b) => a + b, 0);
    assert.equal(sumOfBuckets, body.backlog.total);
    assert.equal(body.backlog.ok, true);
  } finally {
    restore();
  }
}));

test('GET /overview: AI failure reasons are scoped to Draft+failed only, matching backlog.byAiStatus.failed', () => withServer(async (base) => {
  const restore = mockPool([
    [`WHERE status = 'Draft'\n      GROUP BY ai_status`, () => ({ rows: [{ ai_status: 'failed', cnt: 13 }] })],
    ["WHERE status = 'Draft' AND ai_status = 'failed'", () => ({
      rows: [{ ai_failure_type: 'timeout', cnt: 9 }, { ai_failure_type: 'server_error', cnt: 4 }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.deepEqual(body.aiFailureReasons.rows, [{ ai_failure_type: 'timeout', cnt: 9 }, { ai_failure_type: 'server_error', cnt: 4 }]);
    const failureSum = body.aiFailureReasons.rows.reduce((sum, r) => sum + r.cnt, 0);
    assert.equal(failureSum, body.backlog.byAiStatus.failed);
  } finally {
    restore();
  }
}));

test('GET /overview: a NULL ai_failure_type (application-level failure) is reported as \'unclassified\', not dropped from the count', () => withServer(async (base) => {
  const restore = mockPool([
    [`WHERE status = 'Draft'\n      GROUP BY ai_status`, () => ({ rows: [{ ai_status: 'failed', cnt: 198 }] })],
    ["WHERE status = 'Draft' AND ai_status = 'failed'", () => ({
      rows: [{ ai_failure_type: 'timeout', cnt: 9 }, { ai_failure_type: 'server_error', cnt: 3 }, { ai_failure_type: null, cnt: 186 }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.deepEqual(body.aiFailureReasons.rows, [
      { ai_failure_type: 'timeout', cnt: 9 },
      { ai_failure_type: 'server_error', cnt: 3 },
      { ai_failure_type: 'unclassified', cnt: 186 },
    ]);
    const failureSum = body.aiFailureReasons.rows.reduce((sum, r) => sum + r.cnt, 0);
    assert.equal(failureSum, 198);
    assert.equal(failureSum, body.backlog.byAiStatus.failed);
  } finally {
    restore();
  }
}));

test('GET /overview: returns sources currently in a collection-error state (most recent run only)', () => withServer(async (base) => {
  const restore = mockPool([
    ['FROM sources\n      WHERE last_error IS NOT NULL', () => ({
      rows: [{ id: 5, name: 'Example Feed', method: 'rss', last_error: 'fetch failed: 403', last_error_at: '2026-10-13T00:00:00Z' }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.equal(body.sourceErrors.rows.length, 1);
    assert.equal(body.sourceErrors.rows[0].name, 'Example Feed');
    assert.equal(body.sourceErrors.ok, true);
  } finally {
    restore();
  }
}));

test('GET /overview: returns per-source collected/published/ai_failed counts for the stated window', () => withServer(async (base) => {
  const restore = mockPool([
    ['FROM sources s\n      LEFT JOIN items i', () => ({
      rows: [{ id: 1, name: 'Web Discovery: palm oil', method: 'crawl', collected: 40, published: 6, ai_failed: 10 }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.deepEqual(body.perSource.rows, [{ id: 1, name: 'Web Discovery: palm oil', method: 'crawl', collected: 40, published: 6, ai_failed: 10 }]);
    assert.equal(body.perSource.ok, true);
  } finally {
    restore();
  }
}));

test('GET /overview: one failing section degrades only that section, not the whole response', () => withServer(async (base) => {
  const restore = mockPool([
    [`WHERE status = 'Draft'\n      GROUP BY ai_status`, () => ({ rows: [{ ai_status: 'completed', cnt: 5 }] })],
    ['FROM sources\n      WHERE last_error IS NOT NULL', () => { throw new Error('db connection reset'); }],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.backlog.ok, true);
    assert.equal(body.backlog.total, 5);
    assert.equal(body.sourceErrors.ok, false);
    assert.match(body.sourceErrors.error, /db connection reset/);
    assert.deepEqual(body.sourceErrors.rows, []);
  } finally {
    restore();
  }
}));
