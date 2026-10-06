const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const sourcesRouter = require('../server/routes/sources');

// Same live-server harness convention as itemsRoute.test.js.
function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/sources', sourcesRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/sources`);
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
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('GET /: a non-reference source with no last_collected_at is still flagged stale (existing behavior unchanged)', async () => {
  const { restore } = mockPool([
    ['FROM sources s', () => ({
      rows: [{ id: 1, name: 'RSS Source', method: 'rss', is_reference: false, last_collected_at: null, stale: true }],
    })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(base);
      const body = await res.json();
      assert.equal(body[0].stale, true);
    });
  } finally {
    restore();
  }
});

test('GET /: the stale computation excludes is_reference sources (SQL asserts is_reference = false before the staleness check)', async () => {
  const { calls, restore } = mockPool([
    ['FROM sources s', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base);
      const listCall = calls.find((c) => c.text.includes('FROM sources s'));
      assert.ok(listCall);
      assert.match(listCall.text, /s\.is_reference = false AND/);
    });
  } finally {
    restore();
  }
});

test('POST /: persists every new Reference Source Library field', async () => {
  const { calls, restore } = mockPool([
    ['INSERT INTO sources', () => ({ rows: [{ id: 42 }] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'USDA FAS PSD Online',
          is_reference: true,
          source_type: '정부/국제기구 통계',
          region: 'Global',
          commodities: ['팜유', '대두유'],
          coverage_note: '세계 유지종자 생산·소비·교역 공식 통계',
          access_format: ['web', 'CSV', 'API'],
          update_frequency: 'Monthly',
          usage_note: 'NBO 작성 시 1차 출처로 사용',
          last_verified_at: '2026-10-01',
          rss_available: false,
        }),
      });
      assert.equal(res.status, 201);
      const insertCall = calls.find((c) => c.text.includes('INSERT INTO sources'));
      assert.ok(insertCall);
      assert.deepEqual(insertCall.params, [
        'USDA FAS PSD Online', null, null, 'manual', 1, null, 'A',
        true, '정부/국제기구 통계', 'Global', ['팜유', '대두유'], '세계 유지종자 생산·소비·교역 공식 통계',
        ['web', 'CSV', 'API'], 'Monthly', 'NBO 작성 시 1차 출처로 사용', '2026-10-01', false,
      ]);
    });
  } finally {
    restore();
  }
});

test('POST /: a plain operational source omitting the new fields still gets safe defaults (existing behavior unchanged)', async () => {
  const { calls, restore } = mockPool([
    ['INSERT INTO sources', () => ({ rows: [{ id: 43 }] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Plain RSS Source', method: 'rss', url: 'https://example.com/feed' }),
      });
      assert.equal(res.status, 201);
      const insertCall = calls.find((c) => c.text.includes('INSERT INTO sources'));
      assert.deepEqual(insertCall.params, [
        'Plain RSS Source', null, 'https://example.com/feed', 'rss', 1, null, 'A',
        false, null, null, [], null,
        [], null, null, null, false,
      ]);
    });
  } finally {
    restore();
  }
});
