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
  const restore = mockFetch(async () => ({ ok: false, status: 429 }));
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

test('searchWeb: a non-402 failure (e.g. 429) on one key still throws immediately — only 402 triggers rotation', () => withApiKeys(['key-a', 'key-b'], async () => {
  const seenKeys = [];
  const restore = mockFetch(async (url, init) => {
    seenKeys.push(init.headers['X-Subscription-Token']);
    return { ok: false, status: 429 };
  });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 429/);
    assert.deepEqual(seenKeys, ['key-a'], 'a transient rate-limit on one key must not be treated as exhaustion of that key or trigger rotation');
  } finally {
    restore();
  }
}));

test('searchWeb: BRAVE_SEARCH_API_KEYS takes precedence over BRAVE_SEARCH_API_KEY when both are set', () => withApiKey('single-key', async () => {
  process.env.BRAVE_SEARCH_API_KEYS = 'multi-key-a';
  _resetKeyStateForTests();
  let seenKey;
  const restore = mockFetch(async (url, init) => { seenKey = init.headers['X-Subscription-Token']; return braveResponse([]); });
  try {
    await searchWeb('q');
    assert.equal(seenKey, 'multi-key-a');
  } finally {
    restore();
    delete process.env.BRAVE_SEARCH_API_KEYS;
    _resetKeyStateForTests();
  }
}));
