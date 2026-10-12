const test = require('node:test');
const assert = require('node:assert/strict');
const braveAdapter = require('../server/lib/adapters/webSearch');
const firecrawlAdapter = require('../server/lib/adapters/firecrawlSearch');
const serpApiAdapter = require('../server/lib/adapters/serpApiSearch');
const { searchWeb } = require('../server/lib/adapters/searchTiers');

function mockTier(adapter, resultOrThrow) {
  const original = adapter.searchWeb;
  adapter.searchWeb = typeof resultOrThrow === 'function'
    ? resultOrThrow
    : async () => resultOrThrow;
  return () => { adapter.searchWeb = original; };
}

const neverCalled = async () => { throw new Error('must not be called'); };

test('searchWeb: uses Brave results and never calls Firecrawl/SerpApi when Brave succeeds', async () => {
  const restoreBrave = mockTier(braveAdapter, [{ title: 'a', link: 'https://example.org/a' }]);
  const restoreFirecrawl = mockTier(firecrawlAdapter, neverCalled);
  const restoreSerpApi = mockTier(serpApiAdapter, neverCalled);
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'a', link: 'https://example.org/a' }]);
  } finally {
    restoreBrave();
    restoreFirecrawl();
    restoreSerpApi();
  }
});

test('searchWeb: falls back to Firecrawl when Brave throws, without reaching SerpApi', async () => {
  const restoreBrave = mockTier(braveAdapter, async () => { throw new Error('search failed: 402 (all keys exhausted)'); });
  const restoreFirecrawl = mockTier(firecrawlAdapter, [{ title: 'b', link: 'https://example.org/b' }]);
  const restoreSerpApi = mockTier(serpApiAdapter, neverCalled);
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'b', link: 'https://example.org/b' }]);
  } finally {
    restoreBrave();
    restoreFirecrawl();
    restoreSerpApi();
  }
});

test('searchWeb: falls back to SerpApi when both Brave and Firecrawl throw', async () => {
  const restoreBrave = mockTier(braveAdapter, async () => { throw new Error('brave down'); });
  const restoreFirecrawl = mockTier(firecrawlAdapter, async () => { throw new Error('firecrawl down'); });
  const restoreSerpApi = mockTier(serpApiAdapter, [{ title: 'c', link: 'https://example.org/c' }]);
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'c', link: 'https://example.org/c' }]);
  } finally {
    restoreBrave();
    restoreFirecrawl();
    restoreSerpApi();
  }
});

test('searchWeb: when all three tiers fail, throws the original Brave error', async () => {
  const restoreBrave = mockTier(braveAdapter, async () => { throw new Error('no BRAVE_SEARCH_API_KEY(S) configured'); });
  const restoreFirecrawl = mockTier(firecrawlAdapter, async () => { throw new Error('no FIRECRAWL_API_KEY(S) configured'); });
  const restoreSerpApi = mockTier(serpApiAdapter, async () => { throw new Error('no SERPAPI_API_KEY(S) configured'); });
  try {
    await assert.rejects(() => searchWeb('q'), /BRAVE_SEARCH_API_KEY/);
  } finally {
    restoreBrave();
    restoreFirecrawl();
    restoreSerpApi();
  }
});

test('searchWeb: passes options (e.g. freshness) through to whichever tier answers', async () => {
  let seenOptions;
  const restoreBrave = mockTier(braveAdapter, async () => { throw new Error('brave down'); });
  const restoreFirecrawl = mockTier(firecrawlAdapter, async () => { throw new Error('firecrawl down'); });
  const restoreSerpApi = mockTier(serpApiAdapter, async (query, options) => { seenOptions = options; return []; });
  try {
    await searchWeb('q', { freshness: 'pw' });
    assert.deepEqual(seenOptions, { freshness: 'pw' });
  } finally {
    restoreBrave();
    restoreFirecrawl();
    restoreSerpApi();
  }
});
