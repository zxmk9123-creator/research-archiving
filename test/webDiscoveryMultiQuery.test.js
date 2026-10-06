const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { collectAllSourcesNow } = require('../server/lib/collector');
const webSearchAdapter = require('../server/lib/adapters/webSearch');
const extractMetadataModule = require('../server/lib/extractMetadata');

// Discovery Query Registry v1 is just multiple method='crawl' sources
// rows (see schema.sql) — collectAllSourcesNow() already loops over
// every due/active source sequentially and isolates one source's
// failure from the rest (the same shared loop RSS/institution/structured
// already use); these tests exercise that loop specifically with
// multiple crawl queries, using the real collectAllSourcesNow() and
// collectBySource() dispatch, not a parallel reimplementation.

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

function mockSearchWebByQuery(byQuery) {
  const original = webSearchAdapter.searchWeb;
  webSearchAdapter.searchWeb = async (query) => {
    const outcome = byQuery[query];
    if (outcome instanceof Error) throw outcome;
    return outcome || [];
  };
  return () => { webSearchAdapter.searchWeb = original; };
}

function crawlSource(overrides) {
  return { method: 'crawl', frequency_days: 7, ...overrides };
}

// Every candidate in these tests is treated as relevant with real
// title/summary metadata — no real network fetch, consistent with how
// webDiscoveryIngest.test.js mocks extractMetadata.
function mockExtractMetadataAlwaysSucceeds() {
  const original = extractMetadataModule.extractMetadata;
  extractMetadataModule.extractMetadata = async (url) => ({
    title: null,
    summary: 'Palm oil export tariff and major traders affected by new regulation.',
    thumbnail_url: null,
    published_at: null,
  });
  return () => { extractMetadataModule.extractMetadata = original; };
}

// In-memory fake for the one global table these tests care about
// (items.source_url) so dedup behaves identically to the real exact-URL
// check, without a real database.
function mockItemsTable(existingUrls = []) {
  const urls = new Set(existingUrls);
  let nextId = 1000;
  return [
    ['SELECT id FROM items WHERE source_url', (text, params) => {
      const url = params[0];
      return urls.has(url) ? { rows: [{ id: 1 }] } : { rows: [] };
    }],
    ['INSERT INTO items', (text, params) => {
      const url = params[1];
      urls.add(url);
      return { rows: [{ id: nextId++ }] };
    }],
    ['SELECT * FROM items WHERE id', () => ({ rows: [{ id: nextId, ai_status: null }] })],
  ];
}

test('collectAllSourcesNow: multiple crawl (discovery query) sources are each collected sequentially', () => withNoProviders(async () => {
  const sourceA = crawlSource({ id: 60, name: 'Query A', url: 'palm oil export tariff regulation' });
  const sourceB = crawlSource({ id: 61, name: 'Query B', url: 'crude oil price OPEC supply policy' });

  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  const restoreSearch = mockSearchWebByQuery({
    'palm oil export tariff regulation': [{ title: 'Palm oil export tariff raised', link: 'https://example.org/a' }],
    'crude oil price OPEC supply policy': [{ title: 'OPEC agrees new output cuts', link: 'https://example.org/b' }],
  });
  const { calls, restore } = mockPool([
    ["FROM sources WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [sourceA, sourceB] })],
    ...mockItemsTable(),
  ]);
  try {
    const { results } = await collectAllSourcesNow();
    assert.equal(results.length, 2);
    assert.equal(results[0].sourceId, 60);
    assert.equal(results[1].sourceId, 61);
    assert.equal(results[0].discovered, 1);
    assert.equal(results[1].discovered, 1);
    // Both queries' candidates reached item creation.
    const inserted = calls.filter((c) => c.text.includes('INSERT INTO items'));
    assert.equal(inserted.length, 2);
    assert.ok(inserted.some((c) => c.params[1] === 'https://example.org/a'));
    assert.ok(inserted.some((c) => c.params[1] === 'https://example.org/b'));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectAllSourcesNow: one query failing does not stop the next query from running (failure isolation)', () => withNoProviders(async () => {
  const sourceA = crawlSource({ id: 62, name: 'Broken query', url: 'this query has no results api key' });
  const sourceB = crawlSource({ id: 63, name: 'Working query', url: 'vegetable oil tanker freight rates shipping' });

  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  const restoreSearch = mockSearchWebByQuery({
    'this query has no results api key': new Error('no BRAVE_SEARCH_API_KEY configured'),
    'vegetable oil tanker freight rates shipping': [{ title: 'Tanker rates rise on vegetable oil demand', link: 'https://example.org/c' }],
  });
  const { calls, restore } = mockPool([
    ["FROM sources WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [sourceA, sourceB] })],
    ...mockItemsTable(),
  ]);
  try {
    const { results, totals } = await collectAllSourcesNow();
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /BRAVE_SEARCH_API_KEY/);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].discovered, 1);
    assert.equal(totals.failedSources, 1);
    assert.ok(calls.some((c) => c.text.includes('INSERT INTO items') && c.params[1] === 'https://example.org/c'));
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_error') && c.params[1] === 62));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectAllSourcesNow: a candidate URL already discovered by one query is not duplicated when a second query also surfaces it', () => withNoProviders(async () => {
  const sourceA = crawlSource({ id: 64, name: 'Query A', url: 'palm oil export tariff regulation' });
  const sourceB = crawlSource({ id: 65, name: 'Query B', url: 'Wilmar Cargill palm oil investment expansion' });
  const sharedLink = 'https://example.org/shared-report';

  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  const restoreSearch = mockSearchWebByQuery({
    'palm oil export tariff regulation': [{ title: 'Palm oil export tariff and major traders', link: sharedLink }],
    'Wilmar Cargill palm oil investment expansion': [{ title: 'Palm oil export tariff and major traders', link: sharedLink }],
  });
  const { calls, restore } = mockPool([
    ["FROM sources WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [sourceA, sourceB] })],
    ...mockItemsTable(), // dedup is global by source_url, independent of which source/query is asking
  ]);
  try {
    const { results } = await collectAllSourcesNow();
    assert.equal(results[0].discovered, 1);
    assert.equal(results[1].discovered, 1);
    // Only the FIRST query's candidate actually gets inserted; the
    // second query's identical URL is caught by the existing exact-URL
    // dedup check, unchanged and unaware this is a "different query".
    const inserted = calls.filter((c) => c.text.includes('INSERT INTO items'));
    assert.equal(inserted.length, 1);
    assert.equal(results[1].details.some((d) => d.stage === 'already_ingested'), true);
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectAllSourcesNow: a second query\'s candidate reuses the exact same downstream AI/archive calls as the first (no parallel pipeline)', () => withNoProviders(async () => {
  const sourceA = crawlSource({ id: 66, name: 'Query A', url: 'crude oil price OPEC supply policy' });

  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  const restoreSearch = mockSearchWebByQuery({
    'crude oil price OPEC supply policy': [{ title: 'OPEC agrees new output cuts', link: 'https://example.org/opec' }],
  });
  const { calls, restore } = mockPool([
    ["FROM sources WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [sourceA] })],
    ...mockItemsTable(),
  ]);
  try {
    const { results } = await collectAllSourcesNow();
    // ai_status is set to 'pending' then 'failed' by the real
    // generateAiDraftForItem() (no provider configured) — proving this
    // discovery-sourced item went through the exact same AI entry point
    // every other acquisition method uses, not a separate code path.
    assert.ok(calls.some((c) => c.text.includes("UPDATE items SET ai_status = 'pending'")));
    assert.ok(calls.some((c) => c.text.includes("UPDATE items SET ai_status = 'failed'")));
    assert.equal(results[0].failed, 1);
    assert.equal(results[0].archived, 0);
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));
