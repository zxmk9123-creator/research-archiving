const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { collectWebDiscoverySource } = require('../server/lib/webDiscoveryIngest');
const webSearchAdapter = require('../server/lib/adapters/webSearch');
const extractMetadataModule = require('../server/lib/extractMetadata');

// Same no-provider guard collector.test.js/structuredDataIngest.test.js
// use: with no AI provider env vars set, generateAiDraftForItem's
// outbound call fails fast and deterministically, so the "reached AI
// screening" branch is exercised without a real network call or mocking
// aiDraft.js itself.
const PROVIDER_ENV_VARS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'LLAMA_API_KEY', 'FREELLMAPI_API_KEY'];

function withNoProviders(fn) {
  const prev = Object.fromEntries(PROVIDER_ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROVIDER_ENV_VARS) delete process.env[k];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of PROVIDER_ENV_VARS) {
        if (prev[k] !== undefined) process.env[k] = prev[k];
      }
    });
}

function mockPool(handlers) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

function mockSearchWeb(resultOrThrow) {
  const original = webSearchAdapter.searchWeb;
  webSearchAdapter.searchWeb = typeof resultOrThrow === 'function'
    ? resultOrThrow
    : async () => resultOrThrow;
  return () => { webSearchAdapter.searchWeb = original; };
}

function mockExtractMetadata(handler) {
  const original = extractMetadataModule.extractMetadata;
  extractMetadataModule.extractMetadata = handler;
  return () => { extractMetadataModule.extractMetadata = original; };
}

function webDiscoverySource(overrides) {
  return {
    id: 50,
    name: 'Palm oil export tariff query',
    url: 'palm oil export tariff regulation',
    method: 'crawl',
    ...overrides,
  };
}

test('collectWebDiscoverySource: a new relevant candidate reaches item creation and AI screening', () => withNoProviders(async () => {
  const restoreSearch = mockSearchWeb([{ title: 'Palm oil export tariff raised', link: 'https://example.org/a' }]);
  const restoreMeta = mockExtractMetadata(async () => ({
    title: 'Palm oil export tariff raised to 10%',
    summary: 'Indonesia raised its palm oil export tariff, affecting edible oil supply chains.',
    thumbnail_url: null,
    published_at: '2026-01-01',
  }));
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 777 }] })],
    ['SELECT \\* FROM items WHERE id', () => ({ rows: [{ id: 777, ai_status: null }] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());

    assert.equal(result.ok, true);
    assert.equal(result.discovered, 1);
    assert.equal(result.archived, 0); // no provider configured in this test, so AI screening fails fast
    assert.equal(result.failed, 1); // generateAiDraftForItem fails fast with no provider configured

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO items'));
    assert.ok(insertCall, 'expected the candidate to reach item creation');
    assert.equal(insertCall.params[0], 'Palm oil export tariff raised to 10%');
    assert.equal(insertCall.params[1], 'https://example.org/a');
    assert.match(insertCall.text, /'뉴스'/);

    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_collected_at')));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: exact-URL dedup skips a candidate already in the archive, no re-insert', () => withNoProviders(async () => {
  const restoreSearch = mockSearchWeb([{ title: 'Palm oil export tariff raised', link: 'https://example.org/a' }]);
  const restoreMeta = mockExtractMetadata(async () => { throw new Error('should not be called'); });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [{ id: 123 }] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.ok, true);
    assert.equal(result.archived, 0);
    assert.equal(result.filtered, 0);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: an irrelevant candidate is filtered after extraction and never reaches AI screening or item creation', () => withNoProviders(async () => {
  const restoreSearch = mockSearchWeb([{ title: 'Local football club wins championship', link: 'https://example.org/sports' }]);
  const restoreMeta = mockExtractMetadata(async () => ({
    title: 'Local football club wins championship',
    summary: 'The home team celebrated its first title in a decade.',
    thumbnail_url: null,
    published_at: null,
  }));
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.ok, true);
    assert.equal(result.filtered, 1);
    assert.equal(result.archived, 0);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: a per-candidate acquisition failure is isolated — the rest of the run continues', () => withNoProviders(async () => {
  const restoreSearch = mockSearchWeb([
    { title: 'Broken link', link: 'https://example.org/broken' },
    { title: 'Palm oil export tariff raised', link: 'https://example.org/ok' },
  ]);
  let call = 0;
  const restoreMeta = mockExtractMetadata(async () => {
    call++;
    if (call === 1) throw new Error('fetch failed: 500');
    return {
      title: 'Palm oil export tariff raised to 10%',
      summary: 'Indonesia raised its palm oil export tariff.',
      thumbnail_url: null,
      published_at: null,
    };
  });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 778 }] })],
    ['SELECT \\* FROM items WHERE id', () => ({ rows: [{ id: 778, ai_status: null }] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.discovered, 2);
    assert.equal(result.failed, 2); // 1 acquisition failure + 1 AI-screening failure (no provider)
    assert.ok(calls.some((c) => c.text.includes('INSERT INTO items')), 'the second, working candidate should still reach item creation');
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

// --- 403 acquisition fallback ---

function error403() {
  return new Error('fetch failed: 403');
}

test('collectWebDiscoverySource: a 403 falls back to an alternate accessible source and reaches AI screening', () => withNoProviders(async () => {
  const discoveryQuery = 'palm oil export tariff regulation';
  const blockedLink = 'https://www.sciencedirect.com/science/article/blocked';
  const altLink = 'https://alt-mirror.example.org/same-article';

  const restoreSearch = mockSearchWeb(async (query) => {
    if (query === discoveryQuery) {
      return [{ title: 'Palm oil export tariff study', link: blockedLink }];
    }
    // Fallback search is keyed on the candidate's title.
    assert.equal(query, 'Palm oil export tariff study');
    return [{ title: 'Palm oil export tariff study (mirror)', link: altLink }];
  });
  const restoreMeta = mockExtractMetadata(async (url) => {
    if (url === blockedLink) throw error403();
    if (url === altLink) {
      return {
        title: 'Palm oil export tariff study (mirror)',
        summary: 'Indonesia palm oil export tariff study with concrete figures.',
        thumbnail_url: null,
        published_at: '2026-01-01',
      };
    }
    throw new Error(`unexpected url ${url}`);
  });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', (text, params) => ({ rows: [{ id: 801 }] })],
    ['SELECT * FROM items WHERE id', () => ({ rows: [{ id: 801, ai_status: null }] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource({ url: discoveryQuery }));
    assert.equal(result.discovered, 1);
    assert.equal(result.failed, 1); // AI screening fails fast (no provider) — acquisition itself succeeded via fallback

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO items'));
    assert.ok(insertCall, 'expected the fallback-acquired candidate to reach item creation');
    // source_url (dedup key) stays the ORIGINAL blocked link; the fallback
    // URL is recorded separately for traceability.
    assert.equal(insertCall.params[1], blockedLink);
    assert.equal(insertCall.params[5], altLink);

    assert.ok(result.details.some((d) => d.stage === 'acquisition_fallback_used' && d.fallbackUrl === altLink));
    assert.ok(result.details.some((d) => d.stage === 'ai_screening_failed'));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: a 403 with an alternate that also fails to fetch stays acquisition_failed', () => withNoProviders(async () => {
  const blockedLink = 'https://www.sciencedirect.com/science/article/blocked';
  const altLink = 'https://also-blocked.example.org/mirror';

  const restoreSearch = mockSearchWeb(async (query) => {
    if (query.includes('export tariff regulation')) return [{ title: 'Palm oil export tariff study', link: blockedLink }];
    return [{ title: 'Palm oil export tariff study (mirror)', link: altLink }];
  });
  const restoreMeta = mockExtractMetadata(async (url) => {
    throw error403(); // both the original AND every fallback alternate are blocked
  });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.failed, 1);
    assert.equal(result.archived, 0);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')), 'a candidate with no real accessible page must never become an item');
    assert.ok(result.details.some((d) => d.stage === 'acquisition_failed'));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: a 403 whose fallback search finds no alternate stays acquisition_failed', () => withNoProviders(async () => {
  const blockedLink = 'https://www.sciencedirect.com/science/article/blocked';

  const restoreSearch = mockSearchWeb(async (query) => {
    if (query.includes('export tariff regulation')) return [{ title: 'Palm oil export tariff study', link: blockedLink }];
    return []; // fallback search returns no accessible alternate at all
  });
  const restoreMeta = mockExtractMetadata(async () => { throw error403(); });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.failed, 1);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
    assert.ok(result.details.some((d) => d.stage === 'acquisition_failed'));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: a non-403 acquisition failure never triggers the fallback search', () => withNoProviders(async () => {
  const link = 'https://example.org/gone';
  let fallbackSearchCalled = false;

  const restoreSearch = mockSearchWeb(async (query) => {
    if (query.includes('export tariff regulation')) return [{ title: 'Some article', link }];
    fallbackSearchCalled = true;
    return [];
  });
  const restoreMeta = mockExtractMetadata(async () => { throw new Error('fetch failed: 404'); });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
  ]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.failed, 1);
    assert.equal(fallbackSearchCalled, false, '404 must not trigger the 403 fallback path');
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectWebDiscoverySource: a search/API-level failure records last_error and creates no items', async () => {
  const restoreSearch = mockSearchWeb(async () => { throw new Error('no BRAVE_SEARCH_API_KEY configured'); });
  const { calls, restore } = mockPool([]);
  try {
    const result = await collectWebDiscoverySource(webDiscoverySource());
    assert.equal(result.ok, false);
    assert.match(result.error, /BRAVE_SEARCH_API_KEY/);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_error')));
  } finally {
    restoreSearch();
    restore();
  }
});

// --- optional searchOptions pass-through (e.g. a one-time 7-day backfill's
// { freshness: 'pw' }) — omitted by every existing caller (collector.js's
// hourly scheduler, dailyDiscovery.js), which keeps calling searchWeb(url)
// with no second argument, unchanged. ---

test('collectWebDiscoverySource: passes searchOptions through to searchWeb unchanged', () => withNoProviders(async () => {
  let receivedOptions;
  const restoreSearch = mockSearchWeb((query, options) => {
    receivedOptions = options;
    return [];
  });
  const { restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
  ]);
  try {
    await collectWebDiscoverySource(webDiscoverySource(), { freshness: 'pw' });
    assert.deepEqual(receivedOptions, { freshness: 'pw' });
  } finally {
    restoreSearch();
    restore();
  }
}));

test('collectWebDiscoverySource: defaults to an empty searchOptions object when omitted', () => withNoProviders(async () => {
  let receivedOptions;
  const restoreSearch = mockSearchWeb((query, options) => {
    receivedOptions = options;
    return [];
  });
  const { restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
  ]);
  try {
    await collectWebDiscoverySource(webDiscoverySource());
    assert.deepEqual(receivedOptions, {});
  } finally {
    restoreSearch();
    restore();
  }
}));
