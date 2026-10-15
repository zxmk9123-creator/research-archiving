const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { recordExclusion } = require('../server/lib/discoveryExclusions');

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(); };
  return { calls, restore: () => { pool.query = original; } };
}

test('recordExclusion: upserts by URL (repeat sightings bump seen_count) and bounds stored text', async () => {
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  try {
    await recordExclusion({ sourceId: 7, url: 'https://x.test/a', title: 't'.repeat(900), summary: 's'.repeat(2000), publishedAt: null, reason: 'out_of_scope' });
    assert.match(calls[0].text, /ON CONFLICT \(url\) DO UPDATE/);
    assert.match(calls[0].text, /seen_count = discovery_exclusions\.seen_count \+ 1/);
    assert.equal(calls[0].params[2].length, 300);
    assert.equal(calls[0].params[3].length, 600);
  } finally {
    restore();
  }
});

test('recordExclusion: a missing url or reason is a no-op (no query)', async () => {
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  try {
    await recordExclusion({ sourceId: 1, url: '', title: 'x', reason: 'stale' });
    await recordExclusion({ sourceId: 1, url: 'https://x.test/b', title: 'x' });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('recordExclusion: a database failure is swallowed — it must never fail a collection run', async () => {
  const original = pool.query;
  pool.query = async () => { throw new Error('db down'); };
  const origErr = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(recordExclusion({ sourceId: 1, url: 'https://x.test/c', title: 'x', reason: 'stale' }));
  } finally {
    pool.query = original;
    console.error = origErr;
  }
});
