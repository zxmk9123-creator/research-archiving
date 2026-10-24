const test = require('node:test');
const assert = require('node:assert/strict');
const { advanceDiscovery } = require('../server/lib/dailyDiscovery');

const fakeRun = (log) => async (idx) => { log.push(idx); return { sourceId: idx + 100, ok: idx !== 4, error: idx === 4 ? 'boom' : null, discovered: 2, archived: 1, filtered: 1, failed: 0, details: ['x'.repeat(50)] }; };

test('advanceDiscovery: walks every source once, in groups, and drops the heavy details', async () => {
  const log = [];
  const out = await advanceDiscovery({ offset: 0, results: [] }, 7, fakeRun(log), { budgetMs: 10000, concurrency: 3 });
  assert.equal(out.done, true);
  assert.deepEqual(log.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(out.results.length, 7);
  assert.equal(out.results[4].ok, false);
  assert.equal(out.results[0].details, undefined);
});

test('advanceDiscovery: stops when the time budget is spent and resumes from the saved offset without repeating work', async () => {
  const log = [];
  let t = 0;
  const clock = () => t;
  const run = async (idx) => { t += 60; return fakeRun(log)(idx); };
  const first = await advanceDiscovery({ offset: 0, results: [] }, 10, run, { budgetMs: 100, concurrency: 2, now: clock });
  assert.equal(first.done, false);
  assert.ok(first.offset > 0 && first.offset < 10);
  const seen = [...log];
  const second = await advanceDiscovery(first, 10, run, { budgetMs: 100000, concurrency: 2, now: clock });
  assert.equal(second.done, true);
  assert.equal(second.results.length, 10);
  assert.equal(new Set([...seen, ...log]).size, 10, 'every source ran exactly once across the two calls');
  assert.equal(log.filter((i) => seen.includes(i)).length, 0 + log.filter((i) => seen.includes(i)).length);
});

test('advanceDiscovery: a source that throws is recorded as failed and does not stop the run', async () => {
  const out = await advanceDiscovery({ offset: 0 }, 3, async (i) => { if (i === 1) throw new Error('network down'); return { sourceId: i, ok: true }; }, { budgetMs: 1000, concurrency: 3 });
  assert.equal(out.done, true);
  assert.equal(out.results[1].ok, false);
  assert.match(out.results[1].error, /network down/);
});

test('advanceDiscovery: progress is reported after every group, so a killed function loses at most the group in flight', async () => {
  const seen = [];
  const run = async (idx) => ({ sourceId: idx, ok: true, discovered: 1, archived: 0, filtered: 0, failed: 0 });
  await advanceDiscovery({ offset: 0, results: [] }, 7, run, { budgetMs: 10000, concurrency: 3, onGroup: async (s) => { seen.push(s.offset); } });
  assert.deepEqual(seen, [3, 6, 7]);
});

const pool = require('../server/db/pool');
const { getDailyDiscoveryStatus } = require('../server/lib/dailyDiscovery');

function statusFor(rows, now) {
  const original = pool.query;
  pool.query = async () => ({ rows });
  return getDailyDiscoveryStatus(now).finally(() => { pool.query = original; });
}
const KST_0955 = new Date('2026-10-24T00:55:00Z'); // 09:55 KST
const cursor = (totals, runDate = '2026-10-24') => ({ job_name: 'daily_discovery_cursor', last_run_date: new Date(`${runDate}T00:00:00Z`), last_totals: totals });

test('getDailyDiscoveryStatus: completed / running (lease or recent progress) / stalled (no progress, nothing started) / waiting', async () => {
  const done = await statusFor([{ job_name: 'daily_discovery', last_run_date: '2026-10-24', last_completed_at: new Date('2026-10-24T00:30:00Z'), last_totals: { archived: 3 }, last_failed_sources: [] }], KST_0955);
  assert.equal(done.state, 'completed');
  assert.equal(done.completedToday, true);

  const leased = await statusFor([cursor({ offset: 30, total: 66, leaseUntil: KST_0955.getTime() + 60000, savedAt: KST_0955.getTime() - 1000 })], KST_0955);
  assert.equal(leased.state, 'running');
  assert.deepEqual(leased.progress, { done: 30, total: 66 });

  const between = await statusFor([cursor({ offset: 30, total: 66, leaseUntil: 0, savedAt: KST_0955.getTime() - 10 * 60000 })], KST_0955);
  assert.equal(between.state, 'running'); // between two slices, saved 10 minutes ago

  const stuck = await statusFor([cursor({ offset: 30, total: 66, leaseUntil: 0, savedAt: KST_0955.getTime() - 3 * 3600000 })], KST_0955);
  assert.equal(stuck.state, 'stalled');

  const oldCursor = await statusFor([cursor({ offset: 66, total: 66, leaseUntil: 0, savedAt: 1 }, '2026-10-23')], KST_0955);
  assert.equal(oldCursor.state, 'stalled'); // yesterday's cursor is ignored; it is past 08:00 and nothing started today
  assert.equal(oldCursor.progress, null);

  const early = await statusFor([], new Date('2026-10-23T21:00:00Z')); // 06:00 KST
  assert.equal(early.state, 'waiting');
});
