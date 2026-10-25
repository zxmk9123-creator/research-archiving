// Each test file runs in its own process, so the discovery module can be stubbed before the router destructures it.
const test = require('node:test');
const assert = require('node:assert/strict');
const ingest = require('../server/lib/webDiscoveryIngest');
const calls = [];
ingest.collectWebDiscoverySource = async (source, options) => { calls.push({ id: source.id, options }); return { ok: source.id !== 2, discovered: 3, filtered: 1, archived: 1, rejected: 0, failed: 0 }; };

const express = require('express');
const pool = require('../server/db/pool');
const sourcesRouter = require('../server/routes/sources');
const { SESSION_COOKIE, issueSessionToken } = require('../server/lib/auth');

const SOURCES = [{ id: 1, name: 'a', url: 'q1', is_archive_discovery: false }, { id: 2, name: 'b', url: 'q2', is_archive_discovery: true }];
function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/sources', sourcesRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => { try { await fn(`http://127.0.0.1:${server.address().port}/api/sources`); resolve(); } catch (e) { reject(e); } finally { server.close(); } });
  });
}
const ADMIN = { Cookie: `${SESSION_COOKIE}=${issueSessionToken()}` };

test('the four backfill routes keep their URLs, need an admin session, and run each query with their own window and options', async () => {
  const original = pool.query;
  pool.query = async () => ({ rows: SOURCES });
  try {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/backfill-7day-discovery`, { method: 'POST' })).status, 401);
      assert.equal(calls.length, 0);
      const expected = {
        'backfill-7day-discovery': { freshness: 'pw' },
        'backfill-sept2026-discovery': { freshness: '2026-09-01to2026-09-30' },
        'backfill-2026h1-discovery': { freshness: '2026-01-01to2026-06-30', skipStaleCheck: true },
      };
      for (const [route, options] of Object.entries(expected)) {
        calls.length = 0;
        const res = await fetch(`${base}/${route}`, { method: 'POST', headers: ADMIN });
        const body = await res.json();
        assert.equal(res.status, 200, route);
        assert.deepEqual(calls.map((c) => c.options), [options, options], route);
        assert.deepEqual(body.totals, { discovered: 6, filtered: 2, archived: 2, rejected: 0, failed: 0, failedQueries: 1 }, route);
        assert.equal(body.perQuery.length, 2);
      }
      calls.length = 0;
      await fetch(`${base}/backfill-2026fullyear-discovery`, { method: 'POST', headers: ADMIN });
      assert.deepEqual(calls.map((c) => c.options), [
        { freshness: '2026-01-01to2026-10-07', skipStaleCheck: true, itemType: '뉴스' },
        { freshness: '2026-01-01to2026-10-07', skipStaleCheck: true, itemType: '보고서' },
      ]);
    });
  } finally { pool.query = original; }
});
