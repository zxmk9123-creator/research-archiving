const test = require('node:test');
const assert = require('node:assert/strict');
const braveAdapter = require('../server/lib/adapters/webSearch');
const firecrawlAdapter = require('../server/lib/adapters/firecrawlSearch');
const { searchWeb } = require('../server/lib/adapters/searchTiers');

function mockBrave(resultOrThrow) {
  const original = braveAdapter.searchWeb;
  braveAdapter.searchWeb = typeof resultOrThrow === 'function'
    ? resultOrThrow
    : async () => resultOrThrow;
  return () => { braveAdapter.searchWeb = original; };
}

function mockFirecrawl(resultOrThrow) {
  const original = firecrawlAdapter.searchWeb;
  firecrawlAdapter.searchWeb = typeof resultOrThrow === 'function'
    ? resultOrThrow
    : async () => resultOrThrow;
  return () => { firecrawlAdapter.searchWeb = original; };
}

test('searchWeb: uses Brave results and never calls Firecrawl when Brave succeeds', async () => {
  const restoreBrave = mockBrave([{ title: 'a', link: 'https://example.org/a' }]);
  const restoreFirecrawl = mockFirecrawl(async () => { throw new Error('must not be called'); });
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'a', link: 'https://example.org/a' }]);
  } finally {
    restoreBrave();
    restoreFirecrawl();
  }
});

test('searchWeb: falls back to Firecrawl when Brave throws', async () => {
  const restoreBrave = mockBrave(async () => { throw new Error('search failed: 402 (all keys exhausted)'); });
  const restoreFirecrawl = mockFirecrawl([{ title: 'b', link: 'https://example.org/b' }]);
  try {
    const results = await searchWeb('q');
    assert.deepEqual(results, [{ title: 'b', link: 'https://example.org/b' }]);
  } finally {
    restoreBrave();
    restoreFirecrawl();
  }
});

test('searchWeb: when both tiers fail, throws the original Brave error (not the Firecrawl one)', async () => {
  const restoreBrave = mockBrave(async () => { throw new Error('no BRAVE_SEARCH_API_KEY(S) configured'); });
  const restoreFirecrawl = mockFirecrawl(async () => { throw new Error('no FIRECRAWL_API_KEY(S) configured'); });
  try {
    await assert.rejects(() => searchWeb('q'), /BRAVE_SEARCH_API_KEY/);
  } finally {
    restoreBrave();
    restoreFirecrawl();
  }
});

test('searchWeb: passes options (e.g. freshness) through to whichever tier answers', async () => {
  let seenOptions;
  const restoreBrave = mockBrave(async (query, options) => { throw new Error('brave down'); });
  const restoreFirecrawl = mockFirecrawl(async (query, options) => { seenOptions = options; return []; });
  try {
    await searchWeb('q', { freshness: 'pw' });
    assert.deepEqual(seenOptions, { freshness: 'pw' });
  } finally {
    restoreBrave();
    restoreFirecrawl();
  }
});
