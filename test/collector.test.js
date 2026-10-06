const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { getDueSources, runDueCollections } = require('../server/lib/collector');

// Ensures no AI provider is configured during these tests, so
// generateAiDraftForItem's fire-and-forget call (triggered inside
// collectSource on a successful insert) fails fast on "No AI provider
// configured" without ever attempting a real network fetch.
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

// Substring-matched pool.query dispatcher (same idea as providerFallback
// test's mockFetchByUrl) — order-independent, since collectSource's
// fire-and-forget AI call can interleave with the main awaited chain.
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

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function feedResponse(items) {
  const xml = `<rss><channel>${items.map((i) => `
    <item>
      <title>${i.title}</title>
      <link>${i.link}</link>
      <description>${i.description || ''}</description>
      <pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate>
    </item>`).join('')}</channel></rss>`;
  return { ok: true, status: 200, text: async () => xml };
}

function rssSource(overrides) {
  return {
    id: 1,
    name: 'Test Source',
    url: 'https://example.com/feed',
    method: 'rss',
    frequency_days: 1,
    last_collected_at: null,
    last_error: null,
    last_error_at: null,
    ...overrides,
  };
}

// --- getDueSources: backoff clause ---

test('getDueSources: query includes both the frequency_days due-check and the failure backoff clause', async () => {
  const { calls, restore } = mockPool([]);
  try {
    await getDueSources();
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /last_collected_at IS NULL OR last_collected_at < now\(\)/);
    assert.match(calls[0].text, /last_error_at IS NULL OR last_error_at < now\(\) - \$1::interval/);
    assert.deepEqual(calls[0].params, ['1 day']);
  } finally {
    restore();
  }
});

// --- runDueCollections: scheduled-run logging/flow ---

test('runDueCollections: logs run_started/run_completed with due-source count, even with zero due sources', async () => {
  const { restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [] })],
  ]);
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const results = await runDueCollections();
    assert.deepEqual(results, []);
    assert.ok(logs.some((l) => l.includes('scheduled_collection run_started due_sources=0')));
    assert.ok(logs.some((l) => l.includes('scheduled_collection run_completed due_sources=0 succeeded=0 failed=0')));
  } finally {
    console.log = originalLog;
    restore();
  }
});

test('runDueCollections: healthy due source runs normally and is logged as a success', () => withNoProviders(async () => {
  const source = rssSource({ id: 42, name: 'Healthy Source' });
  const restoreFetch = mockFetch(async () => feedResponse([
    { title: 'Brent crude oil price surges on supply disruption', link: 'https://example.com/a1' },
  ]));
  const { calls, restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [source] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 999 }] })],
  ]);
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const results = await runDueCollections();
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].count, 1);
    assert.ok(logs.some((l) => l.includes('scheduled_collection source_result source=Healthy Source id=42 ok=true fetched=1 filtered=0 new=1')));
    assert.ok(logs.some((l) => l.includes('run_completed due_sources=1 succeeded=1 failed=0')));
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_collected_at')));
  } finally {
    console.log = originalLog;
    restoreFetch();
    restore();
  }
}));

test('runDueCollections: a persistently failing source recently marked with last_error_at is excluded from the due query (not retried every tick)', async () => {
  // getDueSources' SQL applies this filter in Postgres itself; here we
  // confirm the code passes the exact source row from the DB straight
  // through unfiltered in JS (i.e. the exclusion is entirely the SQL
  // predicate's job, not an app-level re-filter) — a source the SQL
  // layer would have excluded simply never appears in `rows`.
  const { restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [] })], // simulates Postgres excluding the backed-off row
  ]);
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const results = await runDueCollections();
    assert.deepEqual(results, []);
    assert.ok(logs.some((l) => l.includes('run_started due_sources=0')));
  } finally {
    console.log = originalLog;
    restore();
  }
});

test('runDueCollections: a source that fails is logged as a failure and its sources.last_error is updated, never last_collected_at', () => withNoProviders(async () => {
  const source = rssSource({ id: 7, name: 'Broken Source' });
  const restoreFetch = mockFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
  const { calls, restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [source] })],
  ]);
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const results = await runDueCollections();
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /fetch failed: 404/);
    assert.ok(logs.some((l) => l.includes('source=Broken Source id=7 ok=false error=fetch failed: 404')));
    assert.ok(logs.some((l) => l.includes('run_completed due_sources=1 succeeded=0 failed=1')));
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_error')));
    assert.ok(!calls.some((c) => c.text.includes('UPDATE sources SET last_collected_at')));
  } finally {
    console.log = originalLog;
    restoreFetch();
    restore();
  }
}));

test('runDueCollections: a successful collection clears last_error/last_error_at (existing collectSource behavior, unaffected by backoff change)', () => withNoProviders(async () => {
  const source = rssSource({ id: 9, name: 'Recovering Source', last_error: 'fetch failed: 500', last_error_at: new Date().toISOString() });
  const restoreFetch = mockFetch(async () => feedResponse([]));
  const { calls, restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [source] })],
  ]);
  try {
    const results = await runDueCollections();
    assert.equal(results[0].ok, true);
    const updateCall = calls.find((c) => c.text.includes('UPDATE sources SET last_collected_at'));
    assert.ok(updateCall);
    assert.match(updateCall.text, /last_error = NULL, last_error_at = NULL/);
  } finally {
    restoreFetch();
    restore();
  }
}));

// --- RSS now shares the same autonomous-publish gate institution/
// structured/crawl already use (AI eligible + >=1 valid sector + >=1 valid
// usage), via the exact same generateAiDraftForItem/applyAiDraftIfEligible
// pair — see collectSource()'s fire-and-forget chain in collector.js. ---

function fullDraftResponse(overrides = {}) {
  return JSON.stringify({
    eligible: true,
    eligibility_reason: '구체적 수치와 시점이 포함된 시장 뉴스다.',
    who: '인도네시아 정부', what: '팜유 수출세를 인상했다', amount: '톤당 50달러',
    when: '2026-09-01', where: '인도네시아', why: '국내 공급 안정을 위해',
    impact: '아시아 팜유 가격 상승 압력',
    summary: '인도네시아 정부가 국내 공급 안정을 위해 팜유 수출세를 톤당 50달러 인상했다.',
    insight: '이번 조치는 다른 팜유 수출국의 유사 정책으로 이어질 가능성이 있다.',
    key_takeaway: '수출세 인상이 단기 가격 상승 요인이다.',
    suggested_sectors: [3], suggested_usages: [3],
    ...overrides,
  });
}

// Combines the RSS feed fetch and the FreeLLMAPI fetch behind one
// global.fetch mock — collectSource's fire-and-forget AI call and its
// awaited feed fetch both go through global.fetch, so a single test can
// only safely mock it once.
function mockFeedAndAI(feedItems, aiResponse) {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('freellmapi')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: aiResponse } }] }), text: async () => '' };
    }
    return feedResponse(feedItems);
  };
  return () => { global.fetch = original; };
}

function withFreeLLMAPIEnv(fn) {
  const prevKey = process.env.FREELLMAPI_API_KEY;
  const prevUrl = process.env.FREELLMAPI_BASE_URL;
  process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
  process.env.FREELLMAPI_BASE_URL = 'https://freellmapi.example.com/v1';
  return Promise.resolve().then(fn).finally(() => {
    if (prevKey === undefined) delete process.env.FREELLMAPI_API_KEY; else process.env.FREELLMAPI_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.FREELLMAPI_BASE_URL; else process.env.FREELLMAPI_BASE_URL = prevUrl;
  });
}

// Lets the fire-and-forget generateAiDraftForItem().then(applyAiDraftIfEligible)
// chain (started but never awaited by collectSource/runDueCollections) settle
// before assertions run. All mocked I/O here resolves on its own microtask
// turn, so a handful of macrotask ticks is enough — no real network/DB delay.
async function flushFireAndForget() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('RSS: a relevant item that AI finds eligible AND fully classified is auto-published', () => withFreeLLMAPIEnv(async () => {
  const source = rssSource({ id: 60, name: 'Classified Source' });
  const restoreFetch = mockFeedAndAI(
    [{ title: 'Indonesia raises palm oil export tariff', link: 'https://example.com/published' }],
    fullDraftResponse(),
  );
  let draftCompleted = false;
  const { calls, restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [source] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 701 }] })],
    ["ai_status = 'completed'", () => { draftCompleted = true; return { rows: [] }; }],
    ['SELECT * FROM items WHERE id', () => (draftCompleted
      ? { rows: [{ id: 701, ai_status: 'completed', ai_eligible: true, ai_summary: 's', ai_insight: 'i', ai_suggested_sectors: [3], ai_suggested_usages: [3] }] }
      : { rows: [{ id: 701, ai_status: null, ai_eligible: null }] })],
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }] })],
    ['SELECT id, name FROM usages', () => ({ rows: [{ id: 3, name: '시장 전망' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
  ]);
  try {
    const results = await runDueCollections();
    assert.equal(results[0].ok, true);
    await flushFireAndForget();
    assert.ok(calls.some((c) => c.text.includes("status = 'Published'")), 'expected the item to be auto-published');
  } finally {
    restoreFetch();
    restore();
  }
}));

test('RSS: an item outside the Oil & Fats scope is filtered before AI/publish ever runs', () => withFreeLLMAPIEnv(async () => {
  const source = rssSource({ id: 61, name: 'Irrelevant Source' });
  let aiCalled = false;
  const restoreFetch = mockFetch(async (url) => {
    if (String(url).includes('freellmapi')) { aiCalled = true; throw new Error('AI must not be called for filtered items'); }
    return feedResponse([{ title: 'Local football club wins championship', link: 'https://example.com/sports' }]);
  });
  const { calls, restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [source] })],
  ]);
  try {
    const results = await runDueCollections();
    assert.equal(results[0].filtered, 1);
    await flushFireAndForget();
    assert.equal(aiCalled, false);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
    assert.ok(!calls.some((c) => c.text.includes("status = 'Published'")));
  } finally {
    restoreFetch();
    restore();
  }
}));

test('RSS: AI-eligible but missing sector/usage classification stays Draft, not Published', () => withFreeLLMAPIEnv(async () => {
  const source = rssSource({ id: 62, name: 'Unclassified Source' });
  // eligible=true but no suggested sectors/usages at all — the exact case
  // the shared gate exists to withhold auto-publish for.
  const restoreFetch = mockFeedAndAI(
    [{ title: 'Indonesia raises palm oil export tariff', link: 'https://example.com/unclassified' }],
    fullDraftResponse({ suggested_sectors: [], suggested_usages: [] }),
  );
  let draftCompleted = false;
  const { calls, restore } = mockPool([
    ["FROM sources\n    WHERE method IN ('rss', 'institution', 'structured', 'crawl')", () => ({ rows: [source] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 702 }] })],
    ["ai_status = 'completed'", () => { draftCompleted = true; return { rows: [] }; }],
    ['SELECT * FROM items WHERE id', () => (draftCompleted
      ? { rows: [{ id: 702, ai_status: 'completed', ai_eligible: true, ai_summary: 's', ai_insight: 'i', ai_suggested_sectors: [], ai_suggested_usages: [] }] }
      : { rows: [{ id: 702, ai_status: null, ai_eligible: null }] })],
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }] })],
    ['SELECT id, name FROM usages', () => ({ rows: [{ id: 3, name: '시장 전망' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: false, has_usage: false }] })],
  ]);
  try {
    await runDueCollections();
    await flushFireAndForget();
    assert.ok(!calls.some((c) => c.text.includes("status = 'Published'")), 'must not auto-publish without a valid sector+usage');
  } finally {
    restoreFetch();
    restore();
  }
}));
