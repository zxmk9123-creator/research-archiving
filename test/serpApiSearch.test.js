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

test('searchWeb: SERPAPI_API_KEY is merged into the rotation alongside SERPAPI_API_KEYS, not dropped', () => withApiKey('single-key', async () => {
  process.env.SERPAPI_API_KEYS = 'multi-key-a';
  const seenKeys = [];
  const restore = mockFetch(async (url) => {
    seenKeys.push(new URL(url).searchParams.get('api_key'));
    return { ok: false, status: 500, text: async () => '' };
  });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed: 500/);
    assert.deepEqual(new Set(seenKeys), new Set(['single-key', 'multi-key-a']));
  } finally {
    restore();
    delete process.env.SERPAPI_API_KEYS;
  }
}));

test('searchWeb: a key reported out of searches is parked and the next key takes over; later calls skip it without spending a request', async () => {
  const sa = require('../server/lib/adapters/serpApiSearch');
  sa._resetKeyState();
  const prev = process.env.SERPAPI_API_KEYS;
  const prevSingle = process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEYS = 'primary-0001,backup-0002';
  const seen = [];
  const restore = mockFetch(async (url) => {
    const k = new URL(url).searchParams.get('api_key');
    seen.push(k);
    if (k === 'primary-0001') return { ok: false, status: 429, text: async () => 'Your account has run out of searches.' };
    return serpApiResponse([{ title: 't', link: 'https://example.org/x' }]);
  });
  try {
    const first = await searchWeb('q');
    assert.deepEqual(first, [{ title: 't', link: 'https://example.org/x' }]);
    assert.deepEqual(seen, ['primary-0001', 'backup-0002']);
    seen.length = 0;
    await searchWeb('q2');
    assert.deepEqual(seen, ['backup-0002']);                 // the exhausted key is not asked again
    const st = sa.getKeyStatus();
    assert.equal(st.configured, 2);
    assert.equal(st.available, 1);
    assert.deepEqual(st.reasons, [{ key: '…0001', reason: 'exhausted' }]);
  } finally {
    restore();
    sa._resetKeyState();
    if (prev === undefined) delete process.env.SERPAPI_API_KEYS; else process.env.SERPAPI_API_KEYS = prev;
    if (prevSingle !== undefined) process.env.SERPAPI_API_KEY = prevSingle;
  }
});

test('searchWeb: a 200 answer carrying an out-of-searches error moves on; when every key is parked it fails at once (the next tier answers); 5xx parks nothing', async () => {
  const sa = require('../server/lib/adapters/serpApiSearch');
  sa._resetKeyState();
  const prev = process.env.SERPAPI_API_KEYS;
  const prevSingle = process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEYS = 'one-1111,two-2222';
  let calls = 0;
  let mode = 'quota';
  const restore = mockFetch(async () => {
    calls++;
    if (mode === 'quota') return { ok: true, status: 200, json: async () => ({ error: 'Your account has run out of searches.' }) };
    if (mode === 'empty') return { ok: true, status: 200, json: async () => ({ error: "Google hasn't returned any results for this query." }) };
    return { ok: false, status: 503, text: async () => 'busy' };
  });
  try {
    await assert.rejects(() => searchWeb('q'), /search failed/);
    assert.equal(calls, 2);                                   // both keys tried once, both parked
    calls = 0;
    await assert.rejects(() => searchWeb('q'), /exhausted or invalid/);
    assert.equal(calls, 0);                                   // fails at once, no request spent
    sa._resetKeyState();
    mode = 'empty';
    assert.deepEqual(await searchWeb('q'), []);               // "no results" is an empty answer, not a key problem
    assert.equal(sa.getKeyStatus().parked, 0);
    mode = '503';
    await assert.rejects(() => searchWeb('q'), /search failed: 503/);
    assert.equal(sa.getKeyStatus().parked, 0);                // server errors park nothing
  } finally {
    restore();
    sa._resetKeyState();
    if (prev === undefined) delete process.env.SERPAPI_API_KEYS; else process.env.SERPAPI_API_KEYS = prev;
    if (prevSingle !== undefined) process.env.SERPAPI_API_KEY = prevSingle;
  }
});
