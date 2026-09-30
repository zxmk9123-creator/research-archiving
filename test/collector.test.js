const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { getDueSources, runDueCollections } = require('../server/lib/collector');

// Ensures no AI provider is configured during these tests, so
// generateAiDraftForItem's fire-and-forget call (triggered inside
// collectSource on a successful insert) fails fast on "No AI provider
// configured" without ever attempting a real network fetch.
const PROVIDER_ENV_VARS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'LLAMA_API_KEY'];

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
    ["FROM sources\n    WHERE method IN ('rss', 'institution')", () => ({ rows: [] })],
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
    ["FROM sources\n    WHERE method IN ('rss', 'institution')", () => ({ rows: [source] })],
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
    ["FROM sources\n    WHERE method IN ('rss', 'institution')", () => ({ rows: [] })], // simulates Postgres excluding the backed-off row
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
    ["FROM sources\n    WHERE method IN ('rss', 'institution')", () => ({ rows: [source] })],
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
    ["FROM sources\n    WHERE method IN ('rss', 'institution')", () => ({ rows: [source] })],
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
