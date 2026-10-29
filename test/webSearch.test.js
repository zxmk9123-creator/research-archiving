const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, MAX_RESULTS, _resetKeyStateForTests } = require('../server/lib/adapters/webSearch');

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function withApiKey(key, fn) {
  const prev = process.env.BRAVE_SEARCH_API_KEY;
  if (key === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = key;
  _resetKeyStateForTests();
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = prev;
    _resetKeyStateForTests();
  });
}

function withApiKeys(keys, fn) {
  const prevMulti = process.env.BRAVE_SEARCH_API_KEYS;
  const prevSingle = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEYS = keys.join(',');
  delete process.env.BRAVE_SEARCH_API_KEY;
  _resetKeyStateForTests();
  return Promise.resolve().then(fn).finally(() => {
    if (prevMulti === undefined) delete process.env.BRAVE_SEARCH_API_KEYS;
    else process.env.BRAVE_SEARCH_API_KEYS = prevMulti;
    if (prevSingle === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = prevSingle;
    _resetKeyStateForTests();
  });
}

function braveResponse(results) {
  return { ok: true, status: 200, json: async () => ({ web: { results } }) };
}

test('searchWeb: normalizes Brave API results into {title, link} pairs', () => withApiKey('test-key', async () => {
  const restore = mockFetch(async () => braveResponse([
    { title: '  Palm oil export tariff raised  ', url: 'https://example.org/a' },
    { title: 'Edible oil market update', url: 'https://example.org/b' },
  ]));
  try {
    const results = await searchWeb('palm oil export tariff');
    assert.deepEqual(results, [
      { title: 'Palm oil export tariff raised', link: 'https://example.org/a' },
      { title: 'Edible oil market update', link: 'https://example.org/b' },
    ]);
  } finally {
    restore();
  }
}));

test('searchWeb: filters out a result missing a title or url', () => withApiKey('test-key', async () => {
  const restore = mockFetch(async () => braveResponse([
    { title: '', url: 'https://example.org/no-title' },
    { title: 'No URL here', url: '' },
    { title: 'Valid result', url: 'https://example.org/valid' },
  ]));
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'Valid result', link: 'https://example.org/valid' }]);
  } finally {
    restore();
  }
}));

test('searchWeb: caps results at MAX_RESULTS even if the API returns more', () => withApiKey('test-key', async () => {
  const many = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({ title: `Result ${i}`, url: `https://example.org/${i}` }));
  const restore = mockFetch(async () => braveResponse(many));
  try {
    const results = await searchWeb('q');
    assert.equal(results.length, MAX_RESULTS);
  } finally {
    restore();
  }
}));

test('searchWeb: an empty web.results (or missing web key) returns an empty list, not an error', () => withApiKey('test-key', async () => {
  const restore = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  try {
    assert.deepEqual(await searchWeb('q'), []);
  } finally {
    restore();
  }
}));

test('searchWeb: throws a clear error when no API key is configured', () => withApiKey(undefined, async () => {
  await assert.rejects(() => searchWeb('q'), /BRAVE_SEARCH_API_KEY/);
}));

test('searchWeb: throws a clear error on a non-ok API response', () => withApiKey('test-key', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 429, text: async () => '' }));
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 429/);
  } finally {
    restore();
  }
}));

// --- freshness: optional date-range pass-through (e.g. a one-time 7-day
// backfill), omitted by every existing caller so their query is unaffected ---

test('searchWeb: omits the freshness param entirely when not given', () => withApiKey('test-key', async () => {
  let requestedUrl;
  const restore = mockFetch(async (url) => { requestedUrl = url; return braveResponse([]); });
  try {
    await searchWeb('q');
    assert.ok(!requestedUrl.includes('freshness'));
  } finally {
    restore();
  }
}));

test('searchWeb: passes options.freshness through as the Brave freshness param', () => withApiKey('test-key', async () => {
  let requestedUrl;
  const restore = mockFetch(async (url) => { requestedUrl = url; return braveResponse([]); });
  try {
    await searchWeb('q', { freshness: 'pw' });
    assert.match(requestedUrl, /freshness=pw/);
  } finally {
    restore();
  }
}));

// --- Multi-key rotation: a free-tier Brave key's monthly quota runs out
// (HTTP 402) well before the registry's daily query volume does, so a
// second (third, ...) account's key keeps Web Discovery running instead of
// every query failing until the next billing cycle. ---

test('searchWeb: BRAVE_SEARCH_API_KEYS (comma-separated) rotates to the next key when the first returns 402', () => withApiKeys(['key-a', 'key-b'], async () => {
  const seenKeys = [];
  const restore = mockFetch(async (url, init) => {
    const key = init.headers['X-Subscription-Token'];
    seenKeys.push(key);
    if (key === 'key-a') return { ok: false, status: 402 };
    return braveResponse([{ title: 'Found via key-b', url: 'https://example.org/b' }]);
  });
  try {
    const results = await searchWeb('q');
    assert.deepEqual(seenKeys, ['key-a', 'key-b']);
    assert.deepEqual(results, [{ title: 'Found via key-b', link: 'https://example.org/b' }]);
  } finally {
    restore();
  }
}));

test('searchWeb: a later call starts from the last key that worked, not from the front of the list every time', () => withApiKeys(['key-a', 'key-b'], async () => {
  const seenKeys = [];
  const restore = mockFetch(async (url, init) => {
    const key = init.headers['X-Subscription-Token'];
    seenKeys.push(key);
    if (key === 'key-a') return { ok: false, status: 402 };
    return braveResponse([]);
  });
  try {
    await searchWeb('first query'); // key-a exhausted, falls through to key-b
    await searchWeb('second query'); // should go straight to key-b, no retry of key-a
    assert.deepEqual(seenKeys, ['key-a', 'key-b', 'key-b']);
  } finally {
    restore();
  }
}));

test('searchWeb: once ALL configured keys are exhausted, throws immediately without a network call', () => withApiKeys(['key-a', 'key-b'], async () => {
  let callCount = 0;
  const restore = mockFetch(async () => { callCount++; return { ok: false, status: 402 }; });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 402/);
    assert.equal(callCount, 2, 'both keys should have been tried exactly once each');
    callCount = 0;
    await assert.rejects(() => searchWeb('q'), /all .* exhausted/);
    assert.equal(callCount, 0, 'a known-exhausted set of keys must not trigger another network call');
  } finally {
    restore();
  }
}));

test('searchWeb: 429 rate-limits a key only briefly and rotates to the next key; 402 parks it for hours', () => withApiKeys(['key-a', 'key-b'], async () => {
  const health = require('../server/lib/providerHealth');
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    const k = init.headers['X-Subscription-Token'];
    seen.push(k);
    if (k === 'key-a') return { ok: false, status: 429, headers: { get: () => '5' }, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ web: { results: [{ title: 't', url: 'https://x.test/a' }] } }) };
  });
  try {
    assert.equal((await searchWeb('q'))[0].link, 'https://x.test/a');
    assert.deepEqual(seen, ['key-a', 'key-b']);
    assert.equal(await health.isParked('brave', health.keyId('key-a')), true);
    assert.ok(health.PARK_MS.rate < health.PARK_MS.quota);
    seen.length = 0;
    await searchWeb('q2');
    assert.deepEqual(seen, ['key-b'], 'a parked key is not re-tried by the next call');
  } finally { restore(); }
}));

test('searchWeb: 5xx on every key rotates through all keys and reports the categories without parking', () => withApiKeys(['key-a', 'key-b'], async () => {
  const health = require('../server/lib/providerHealth');
  let calls = 0;
  const restore = mockFetch(async () => { calls++; return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }; });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 503 \(2 Brave key attempt/);
    assert.equal(calls, 2);
    assert.equal(await health.isParked('brave', health.keyId('key-a')), false, '5xx is a provider fault, not a reason to skip the key');
  } finally { restore(); }
}));

test('searchWeb: 401/403 is reported as an auth failure (not exhaustion) and the key is parked', () => withApiKeys(['key-a'], async () => {
  const health = require('../server/lib/providerHealth');
  const restore = mockFetch(async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => '' }));
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 401/);
    await assert.rejects(() => searchWeb('q'), /unavailable \(auth\)/);
    assert.ok(!/key-a/.test(String(JSON.stringify(health.parkedInfo('brave', health.keyId('key-a'))))));
  } finally { restore(); }
}));

test('searchWeb: BRAVE_SEARCH_API_KEY is merged into the rotation alongside BRAVE_SEARCH_API_KEYS, not dropped', () => withApiKey('single-key', async () => {
  process.env.BRAVE_SEARCH_API_KEYS = 'multi-key-a';
  _resetKeyStateForTests();
  const seenKeys = [];
  // Both keys are 402-exhausted in turn, so rotation must reach both of
  // them — proof that 'single-key' is actually in the configured list,
  // not silently dropped because BRAVE_SEARCH_API_KEYS was also set.
  const restore = mockFetch(async (url, init) => {
    seenKeys.push(init.headers['X-Subscription-Token']);
    return { ok: false, status: 402, text: async () => '' };
  });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 402/);
    assert.deepEqual(new Set(seenKeys), new Set(['single-key', 'multi-key-a']));
  } finally {
    restore();
    delete process.env.BRAVE_SEARCH_API_KEYS;
    _resetKeyStateForTests();
  }
}));

test('searchWeb: a network error on one key is recorded as a server-side fault and the next key is tried', () => withApiKeys(['key-a', 'key-b'], async () => {
  let n = 0;
  const restore = mockFetch(async () => { n++; if (n === 1) throw new Error('fetch failed'); return { ok: true, status: 200, text: async () => JSON.stringify({ web: { results: [{ title: 't', url: 'https://x.test/n' }] } }) }; });
  try { assert.equal((await searchWeb('q'))[0].link, 'https://x.test/n'); assert.equal(n, 2); } finally { restore(); }
}));
