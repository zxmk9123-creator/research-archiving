const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, MAX_RESULTS } = require('../server/lib/adapters/firecrawlSearch');

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function withApiKey(key, fn) {
  const prev = process.env.FIRECRAWL_API_KEY;
  if (key === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = key;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = prev;
  });
}

function firecrawlResponse(results) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: results }) };
}

test('searchWeb: throws when no FIRECRAWL_API_KEY(S) configured', () => withApiKey(undefined, async () => {
  await assert.rejects(() => searchWeb('q'), /no FIRECRAWL_API_KEY/);
}));

test('searchWeb: maps Firecrawl results to {title, link}, dropping entries missing either', () => withApiKey('fc-test', async () => {
  const restore = mockFetch(async () => firecrawlResponse([
    { title: 'Palm oil tariff raised', url: 'https://example.org/a' },
    { title: '', url: 'https://example.org/no-title' },
    { title: 'No URL', url: '' },
  ]));
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'Palm oil tariff raised', link: 'https://example.org/a' }]);
  } finally {
    restore();
  }
}));

test('searchWeb: sends the query and limit, with Bearer auth', () => withApiKey('fc-test', async () => {
  let seenUrl, seenInit;
  const restore = mockFetch(async (url, init) => { seenUrl = url; seenInit = init; return firecrawlResponse([]); });
  try {
    await searchWeb('palm oil tariff');
    assert.equal(seenUrl, 'https://api.firecrawl.dev/v1/search');
    assert.equal(seenInit.headers.Authorization, 'Bearer fc-test');
    assert.deepEqual(JSON.parse(seenInit.body), { query: 'palm oil tariff', limit: MAX_RESULTS });
  } finally {
    restore();
  }
}));

test('searchWeb: a freshness: pw option maps to Firecrawl\'s past-week time operator', () => withApiKey('fc-test', async () => {
  let seenBody;
  const restore = mockFetch(async (url, init) => { seenBody = JSON.parse(init.body); return firecrawlResponse([]); });
  try {
    await searchWeb('q', { freshness: 'pw' });
    assert.equal(seenBody.tbs, 'qdr:w');
  } finally {
    restore();
  }
}));

test('searchWeb: a non-ok response throws "search failed: <status>"', () => withApiKey('fc-test', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 500/);
  } finally {
    restore();
  }
}));

test('searchWeb: rotates to the next key when one fails, same as Brave\'s adapter', async () => {
  const prev = process.env.FIRECRAWL_API_KEYS;
  process.env.FIRECRAWL_API_KEYS = 'key-a,key-b';
  const seenKeys = [];
  const restore = mockFetch(async (url, init) => {
    seenKeys.push(init.headers.Authorization);
    if (seenKeys.length === 1) return { ok: false, status: 500, text: async () => '' };
    return firecrawlResponse([{ title: 't', url: 'https://example.org/x' }]);
  });
  try {
    const results = await searchWeb('q');
    assert.deepEqual(seenKeys, ['Bearer key-a', 'Bearer key-b']);
    assert.deepEqual(results, [{ title: 't', link: 'https://example.org/x' }]);
  } finally {
    restore();
    if (prev === undefined) delete process.env.FIRECRAWL_API_KEYS; else process.env.FIRECRAWL_API_KEYS = prev;
  }
});

test('searchWeb: FIRECRAWL_API_KEY is merged into the rotation alongside FIRECRAWL_API_KEYS, not dropped', () => withApiKey('single-key', async () => {
  process.env.FIRECRAWL_API_KEYS = 'multi-key-a';
  const seenKeys = [];
  const restore = mockFetch(async (url, init) => {
    seenKeys.push(init.headers.Authorization);
    return { ok: false, status: 500, text: async () => '' };
  });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 500/);
    assert.deepEqual(new Set(seenKeys), new Set(['Bearer single-key', 'Bearer multi-key-a']));
  } finally {
    restore();
    delete process.env.FIRECRAWL_API_KEYS;
  }
}));

test('firecrawl keys: numbered FIRECRAWL_API_KEY_n variables are merged and deduped with singular/plural', () => {
  const saved = { a: process.env.FIRECRAWL_API_KEY, b: process.env.FIRECRAWL_API_KEYS, c: process.env.FIRECRAWL_API_KEY_2 };
  try {
    process.env.FIRECRAWL_API_KEY = 'k-new';
    process.env.FIRECRAWL_API_KEYS = 'k-p1, k-new';
    process.env.FIRECRAWL_API_KEY_2 = 'k-old';
    const keys = require('../server/lib/adapters/firecrawlSearch')._getConfiguredKeysForTests();
    assert.deepEqual(keys, ['k-new', 'k-old', 'k-p1']);
  } finally {
    for (const [k, v] of [['FIRECRAWL_API_KEY', saved.a], ['FIRECRAWL_API_KEYS', saved.b], ['FIRECRAWL_API_KEY_2', saved.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
