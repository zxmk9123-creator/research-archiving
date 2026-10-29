const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../server/lib/providerHealth');

function memStore() {
  const s = {
    data: null, writes: 0,
    async read() { return s.data; },
    async mutate(fn) { const n = fn(s.data ? JSON.parse(JSON.stringify(s.data)) : {}); if (n !== undefined) { s.writes++; s.data = JSON.parse(JSON.stringify(n)); } return true; },
  };
  return s;
}

test('providerHealth: classifies statuses by category', () => {
  assert.deepEqual([402, 429, 401, 403, 500, 503, 404].map(health.classify), ['quota', 'rate', 'auth', 'auth', 'server', 'server', 'other']);
});

test('providerHealth: parked keys persist across "instances" (fresh process state, same store) and expire', async () => {
  const store = memStore();
  health._setStoreForTests(store);
  health.record('brave', 'quota', { kid: 'k1', note: '402' });
  await health.flush();
  health._setStoreForTests(store); // simulates a cold start: no local state
  assert.equal(await health.isParked('brave', 'k1'), true);
  assert.equal(await health.isParked('brave', 'k2'), false);
  store.data.parked['brave:k1'].until = Date.now() - 1;
  health._setStoreForTests(store);
  assert.equal(await health.isParked('brave', 'k1'), false, 'recovers after the park expires');
});

test('providerHealth: daily counters accumulate requests, successes, quota and fallback outcomes, never a raw key', async () => {
  const store = memStore();
  health._setStoreForTests(store);
  health.record('brave', 'success', { kid: 'aa' });
  health.record('brave', 'quota', { kid: 'aa' });
  health.record('tavily', 'success');
  health.record('tavily', 'fallback_ok');
  health.record('tavily', 'rate', { note: '429' });
  health.record('tavily', 'fallback_fail', { note: 'tavily: 429' });
  await health.flush();
  const day = Object.values(store.data.days)[0];
  assert.equal(day.brave.requests, 2);
  assert.equal(day.brave.quota, 1);
  assert.equal(day.tavily.fallback_ok, 1);
  assert.equal(day.tavily.fallback_fail, 1);
  assert.equal(day.tavily.requests, 2);
  assert.ok(!JSON.stringify(store.data).includes('sk-'));
});

test('providerHealth: a store failure never throws', async () => {
  health._setStoreForTests({ read: async () => { throw new Error('db down'); }, mutate: async () => false });
  health.record('brave', 'quota', { kid: 'z' });
  await health.flush();
  assert.equal(await health.isParked('brave', 'z'), true, 'local park still applies');
});

test('providerHealth: a failed flush keeps counters for the next flush and never loses a cooldown', async () => {
  let up = false;
  const store = memStore();
  const flaky = { read: store.read, mutate: async (fn) => (up ? store.mutate(fn) : false) };
  health._setStoreForTests(flaky);
  health.record('brave', 'quota', { kid: 'q1' });
  health.record('tavily', 'success');
  await health.flush();
  assert.equal(store.data, null);
  assert.equal(await health.isParked('brave', 'q1'), true);
  up = true;
  await health.flush();
  const day = Object.values(store.data.days)[0];
  assert.equal(day.brave.quota, 1);
  assert.equal(day.tavily.success, 1);
  assert.ok(store.data.parked['brave:q1']);
});

test('providerHealth: two instances flushing against the same document both land (no lost update)', async () => {
  const store = memStore();
  // an instance whose mutate runs on a stale snapshot first, like a concurrent writer that lost the race
  const racing = { read: store.read, async mutate(fn) { const stale = store.data ? JSON.parse(JSON.stringify(store.data)) : {}; fn(stale); return store.mutate(fn); } };
  health._setStoreForTests(racing);
  health.record('brave', 'success', { kid: 'a' });
  await health.flush();
  health._setStoreForTests(racing);
  health.record('brave', 'success', { kid: 'a' });
  await health.flush();
  assert.equal(Object.values(store.data.days)[0].brave.success, 2);
});
