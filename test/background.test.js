const test = require('node:test');
const assert = require('node:assert/strict');
const { track, drain, _pendingCount } = require('../server/lib/background');

test('drain waits for tracked work, ignores its failures, and reports what is still running', async () => {
  let done = false;
  track(new Promise((r) => setTimeout(() => { done = true; r(); }, 60)));
  track(Promise.reject(new Error('boom')));
  assert.equal(await drain(2000), 0);
  assert.equal(done, true);
  track(new Promise((r) => setTimeout(r, 400)));
  assert.equal(await drain(50), 1, 'a slow task is reported, not waited for');
  assert.equal(await drain(2000), 0);
  assert.equal(_pendingCount(), 0);
});
