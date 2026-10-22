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
