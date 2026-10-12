const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, MAX_RESULTS } = require('../server/lib/adapters/serpApiSearch');

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function withApiKey(key, fn) {
  const prev = process.env.SERPAPI_API_KEY;
  if (key === undefined) delete process.env.SERPAPI_API_KEY;
  else process.env.SERPAPI_API_KEY = key;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.SERPAPI_API_KEY;
    else process.env.SERPAPI_API_KEY = prev;
  });
}

function serpApiResponse(organicResults) {
  return { ok: true, status: 200, json: async () => ({ organic_results: organicResults }) };
}

test('searchWeb: throws when no SERPAPI_API_KEY(S) configured', () => withApiKey(undefined, async () => {
  await assert.rejects(() => searchWeb('q'), /no SERPAPI_API_KEY/);
}));

test('searchWeb: maps organic_results to {title, link}, dropping entries missing either', () => withApiKey('serp-test', async () => {
  const restore = mockFetch(async () => serpApiResponse([
    { title: 'Palm oil tariff raised', link: 'https://example.org/a' },
    { title: '', link: 'https://example.org/no-title' },
    { title: 'No link', link: '' },
  ]));
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'Palm oil tariff raised', link: 'https://example.org/a' }]);
  } finally {
    restore();
  }
}));

test('searchWeb: sends query, num and api_key as URL params', () => withApiKey('serp-test', async () => {
  let seenUrl;
  const restore = mockFetch(async (url) => { seenUrl = url; return serpApiResponse([]); });
  try {
    await searchWeb('palm oil tariff');
    const parsed = new URL(seenUrl);
    assert.equal(parsed.origin + parsed.pathname, 'https://serpapi.com/search');
    assert.equal(parsed.searchParams.get('q'), 'palm oil tariff');
    assert.equal(parsed.searchParams.get('num'), String(MAX_RESULTS));
    assert.equal(parsed.searchParams.get('api_key'), 'serp-test');
  } finally {
    restore();
  }
}));

test('searchWeb: a freshness: pw option maps to Google\'s past-week time qualifier', () => withApiKey('serp-test', async () => {
  let seenUrl;
  const restore = mockFetch(async (url) => { seenUrl = url; return serpApiResponse([]); });
  try {
    await searchWeb('q', { freshness: 'pw' });
    assert.equal(new URL(seenUrl).searchParams.get('tbs'), 'qdr:w');
  } finally {
    restore();
  }
}));

test('searchWeb: a non-ok response throws "search failed: <status>"', () => withApiKey('serp-test', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 500/);
  } finally {
    restore();
  }
}));

test('searchWeb: rotates to the next key when one fails, same as the other tiers', async () => {
  const prev = process.env.SERPAPI_API_KEYS;
  process.env.SERPAPI_API_KEYS = 'key-a,key-b';
  const seenKeys = [];
  const restore = mockFetch(async (url) => {
    const apiKey = new URL(url).searchParams.get('api_key');
    seenKeys.push(apiKey);
    if (seenKeys.length === 1) return { ok: false, status: 500, text: async () => '' };
    return serpApiResponse([{ title: 't', link: 'https://example.org/x' }]);
  });
  try {
    const results = await searchWeb('q');
    assert.deepEqual(seenKeys, ['key-a', 'key-b']);
    assert.deepEqual(results, [{ title: 't', link: 'https://example.org/x' }]);
  } finally {
    restore();
    if (prev === undefined) delete process.env.SERPAPI_API_KEYS; else process.env.SERPAPI_API_KEYS = prev;
  }
});
