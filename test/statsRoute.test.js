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

test('GET /overview: returns aggregation basis alongside the numbers it describes', () => withServer(async (base) => {
  const restore = mockPool([]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.basis.collectionWindowDays, 7);
    assert.equal(body.basis.backlogDefinition, "status = 'Draft'");
    assert.ok(body.basis.generatedAt);
  } finally {
    restore();
  }
}));

test('GET /overview: aggregates the unreviewed (Draft) backlog by ai_status', () => withServer(async (base) => {
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
  } finally {
    restore();
  }
}));

test('GET /overview: returns AI failure reasons ordered by count', () => withServer(async (base) => {
  const restore = mockPool([
    ["WHERE ai_status = 'failed' AND ai_failure_type IS NOT NULL", () => ({
      rows: [{ ai_failure_type: 'timeout', cnt: 9 }, { ai_failure_type: 'server_error', cnt: 4 }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.deepEqual(body.aiFailureReasons, [{ ai_failure_type: 'timeout', cnt: 9 }, { ai_failure_type: 'server_error', cnt: 4 }]);
  } finally {
    restore();
  }
}));

test('GET /overview: returns sources currently in a collection-error state', () => withServer(async (base) => {
  const restore = mockPool([
    ['FROM sources\n      WHERE last_error IS NOT NULL', () => ({
      rows: [{ id: 5, name: 'Example Feed', method: 'rss', last_error: 'fetch failed: 403', last_error_at: '2026-10-13T00:00:00Z' }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.equal(body.sourceErrors.length, 1);
    assert.equal(body.sourceErrors[0].name, 'Example Feed');
  } finally {
    restore();
  }
}));

test('GET /overview: returns per-source collected/published/ai_failed counts', () => withServer(async (base) => {
  const restore = mockPool([
    ['FROM sources s\n      LEFT JOIN items i', () => ({
      rows: [{ id: 1, name: 'Web Discovery: palm oil', method: 'crawl', collected: 40, published: 6, ai_failed: 10 }],
    })],
  ]);
  try {
    const res = await fetch(`${base}/overview`);
    const body = await res.json();
    assert.deepEqual(body.perSource, [{ id: 1, name: 'Web Discovery: palm oil', method: 'crawl', collected: 40, published: 6, ai_failed: 10 }]);
  } finally {
    restore();
  }
}));
