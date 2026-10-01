const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, MAX_RESULTS } = require('../server/lib/adapters/webSearch');

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function withApiKey(key, fn) {
  const prev = process.env.BRAVE_SEARCH_API_KEY;
  if (key === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = key;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = prev;
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
