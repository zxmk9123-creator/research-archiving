const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../server/lib/ai/concurrencyLimiter');

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('createLimiter: never runs more than maxConcurrent tasks at once', async () => {
  const run = createLimiter(2);
  let active = 0;
  let maxActive = 0;

  const task = (value) => run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(20, value);
    active--;
    return value;
  });

  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(task));

  assert.ok(maxActive <= 2, `expected at most 2 concurrent, saw ${maxActive}`);
  assert.deepEqual(results.sort(), [1, 2, 3, 4, 5, 6]);
});

test('createLimiter: queued tasks all eventually run even with a burst far exceeding the limit', async () => {
  const run = createLimiter(2);
  let completed = 0;
  const N = 20; // simulates a 20-item RSS batch, same order of magnitude as the production incident

  await Promise.all(
    Array.from({ length: N }, () => run(async () => {
      await delay(1, null);
      completed++;
    }))
  );

  assert.equal(completed, N);
});

test('createLimiter: one task rejecting does not stop the others (failure isolation preserved)', async () => {
  const run = createLimiter(2);
  const tasks = [
    run(() => Promise.reject(new Error('boom'))),
    run(() => delay(5, 'ok-1')),
    run(() => delay(5, 'ok-2')),
  ];

  const settled = await Promise.allSettled(tasks);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(settled[1].value, 'ok-1');
  assert.equal(settled[2].status, 'fulfilled');
  assert.equal(settled[2].value, 'ok-2');
});

test('createLimiter: a slot frees up immediately after a task finishes, not after the whole batch', async () => {
  const run = createLimiter(1);
  const order = [];

  const p1 = run(async () => { order.push('start-1'); await delay(10); order.push('end-1'); });
  const p2 = run(async () => { order.push('start-2'); await delay(10); order.push('end-2'); });

  await Promise.all([p1, p2]);

  // With concurrency 1, task 2 must not start until task 1 has fully ended.
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});
