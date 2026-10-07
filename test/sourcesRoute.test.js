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
          sector_links: [
            { sector: '유지종자 공급·수요 데이터', label: 'PSD Online — 조회', url: 'https://apps.fas.usda.gov/psdonline/app/index.html#/app/advQuery' },
            { sector: '유지종자 시장 보고서', label: 'Oilseeds: World Markets and Trade', url: 'https://fas.usda.gov/data/oilseeds-world-markets-and-trade' },
          ],
        }),
      });
      assert.equal(res.status, 201);
      const insertCall = calls.find((c) => c.text.includes('INSERT INTO sources'));
      assert.ok(insertCall);
      assert.deepEqual(insertCall.params, [
        'USDA FAS PSD Online', null, null, 'manual', 1, null, 'A',
        true, '정부/국제기구 통계', 'Global', ['팜유', '대두유'], '세계 유지종자 생산·소비·교역 공식 통계',
        ['web', 'CSV', 'API'], 'Monthly', 'NBO 작성 시 1차 출처로 사용', '2026-10-01', false,
        JSON.stringify([
          { sector: '유지종자 공급·수요 데이터', label: 'PSD Online — 조회', url: 'https://apps.fas.usda.gov/psdonline/app/index.html#/app/advQuery' },
          { sector: '유지종자 시장 보고서', label: 'Oilseeds: World Markets and Trade', url: 'https://fas.usda.gov/data/oilseeds-world-markets-and-trade' },
        ]),
      ]);
      // Each sector link is independently reachable — the whole point of
      // the field — never collapsed into a single generic url.
      const parsedLinks = JSON.parse(insertCall.params[17]);
      assert.equal(parsedLinks.length, 2);
      assert.equal(parsedLinks[0].url, 'https://apps.fas.usda.gov/psdonline/app/index.html#/app/advQuery');
      assert.equal(parsedLinks[1].url, 'https://fas.usda.gov/data/oilseeds-world-markets-and-trade');
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
        [], null, null, null, false, '[]',
      ]);
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: updates sector_links on an existing Reference Source (the edit flow)', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id FROM sources WHERE id', () => ({ rows: [{ id: 7 }] })],
    ['UPDATE sources SET', () => ({ rows: [{ id: 7 }] })],
  ]);
  try {
    await withServer(async (base) => {
      const newLinks = [{ sector: '팜유 재고 통계', label: 'Monthly Stock Statistics', url: 'https://bepi.mpob.gov.my/index.php/en/statistics/stock.html' }];
      const res = await fetch(`${base}/7`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sector_links: newLinks }),
      });
      assert.equal(res.status, 200);
      const updateCall = calls.find((c) => c.text.includes('UPDATE sources SET'));
      assert.ok(updateCall);
      assert.match(updateCall.text, /sector_links = \$1/);
      assert.deepEqual(JSON.parse(updateCall.params[0]), newLinks);
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: returns 404 for a nonexistent source', async () => {
  const { restore } = mockPool([
    ['SELECT id FROM sources WHERE id', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/999`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sector_links: [] }),
      });
      assert.equal(res.status, 404);
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: a source whose method is an ingestion method can still be edited without is_reference ever being forced on by this route', async () => {
  // The route itself never sets is_reference automatically — that invariant
  // is enforced in schema.sql (standing UPDATE guard), not here. This just
  // confirms PATCH only touches fields explicitly present in the body.
  const { calls, restore } = mockPool([
    ['SELECT id FROM sources WHERE id', () => ({ rows: [{ id: 8 }] })],
    ['UPDATE sources SET', () => ({ rows: [{ id: 8 }] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/8`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'new-owner' }),
      });
      assert.equal(res.status, 200);
      const updateCall = calls.find((c) => c.text.includes('UPDATE sources SET'));
      assert.ok(!updateCall.text.includes('is_reference'));
      assert.ok(!updateCall.text.includes('sector_links'));
    });
  } finally {
    restore();
  }
});
