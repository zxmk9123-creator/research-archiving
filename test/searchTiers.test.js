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

test('searchWeb: when every tier fails the thrown error is the first one and names why the later tiers failed', async () => {
  const tiers = require('../server/lib/adapters/searchTiers');
  const brave = require('../server/lib/adapters/webSearch');
  const fc = require('../server/lib/adapters/firecrawlSearch');
  const serp = require('../server/lib/adapters/serpApiSearch');
  const saved = [brave.searchWeb, fc.searchWeb, serp.searchWeb];
  brave.searchWeb = async () => { throw new Error('search failed: 402 (brave)'); };
  fc.searchWeb = async () => { throw new Error('search failed: 429'); };
  serp.searchWeb = async () => { throw new Error('search failed: all SerpApi keys cooling down'); };
  try {
    await assert.rejects(() => tiers.searchWeb('q'), (err) => /402 \(brave\)/.test(err.message) && /firecrawl: search failed: 429/.test(err.message) && /serpapi: .*cooling down/.test(err.message));
  } finally { [brave.searchWeb, fc.searchWeb, serp.searchWeb] = saved; }
});

test('searchTiers: records Tavily fallback success and failure reasons in provider health', async () => {
  const health = require('../server/lib/providerHealth');
  const brave = require('../server/lib/adapters/webSearch');
  const tavily = require('../server/lib/adapters/tavilySearch');
  const store = { data: null, async read() { return store.data; }, async mutate(fn) { const n = fn(store.data ? JSON.parse(JSON.stringify(store.data)) : {}); if (n !== undefined) store.data = JSON.parse(JSON.stringify(n)); return true; } };
  const origB = brave.searchWeb; const origT = tavily.searchWeb;
  const tiers = require('../server/lib/adapters/searchTiers');
  try {
    health._setStoreForTests(store);
    brave.searchWeb = async () => { throw new Error('search failed: 402 (all 3 configured Brave Search API key(s) exhausted)'); };
    tavily.searchWeb = async () => [{ title: 'a', link: 'https://a.test' }];
    await tiers.searchWeb('q1');
    tavily.searchWeb = async () => { throw new Error('tavily search failed: status 429'); };
    await assert.rejects(() => tiers.searchWeb('q2'));
    const day = Object.values(store.data.days)[0].tavily;
    assert.equal(day.fallback_ok, 1);
    assert.equal(day.fallback_fail, 1);
    assert.equal(day.rate, 1);
    assert.match(day.lastError.note, /429/);
  } finally { brave.searchWeb = origB; tavily.searchWeb = origT; health._resetForTests(); }
});

test('searchTiers: fallback failures are categorized (402/429/401/5xx/network/config) for the provider metrics', async () => {
  const health = require('../server/lib/providerHealth');
  const brave = require('../server/lib/adapters/webSearch');
  const tavily = require('../server/lib/adapters/tavilySearch');
  const tiers = require('../server/lib/adapters/searchTiers');
  const store = { data: null, async read() { return store.data; }, async mutate(fn) { const n = fn(store.data ? JSON.parse(JSON.stringify(store.data)) : {}); if (n !== undefined) store.data = JSON.parse(JSON.stringify(n)); return true; } };
  const origB = brave.searchWeb; const origT = tavily.searchWeb;
  const fire = ['search failed: 402', 'search failed: 429', 'search failed: 401', 'search failed: 503', 'The operation was aborted due to timeout', 'no TAVILY_API_KEY(S) configured', 'search failed: all configured Tavily API keys are exhausted or invalid (cooling down)'];
  try {
    health._setStoreForTests(store);
    brave.searchWeb = async () => { throw new Error('search failed: 402 (all 3 configured Brave Search API key(s) exhausted)'); };
    for (const msg of fire) { tavily.searchWeb = async () => { throw new Error(msg); }; await assert.rejects(() => tiers.searchWeb('q')); }
    const t = Object.values(store.data.days)[0].tavily;
    assert.deepEqual([t.quota, t.rate, t.auth, t.server, t.config, t.fallback_fail], [2, 1, 1, 2, 1, 7]);
  } finally { brave.searchWeb = origB; tavily.searchWeb = origT; health._resetForTests(); }
});
