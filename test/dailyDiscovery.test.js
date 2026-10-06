const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const webSearchAdapter = require('../server/lib/adapters/webSearch');
const extractMetadataModule = require('../server/lib/extractMetadata');
const {
  kstPartsOf,
  isDailyDiscoveryHourKst,
  claimDailyDiscoveryRunForToday,
  collectDailyDiscoveryNow,
  maybeRunDailyDiscovery,
} = require('../server/lib/dailyDiscovery');

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
    return { rows: [], rowCount: 0 };
  };
  return { calls, restore: () => { pool.query = original; } };
}

// --- kstPartsOf / isDailyDiscoveryHourKst: pure time-zone math, no I/O ---

test('kstPartsOf: converts a UTC instant to its Asia/Seoul calendar date and hour', () => {
  // 2026-01-14T23:30:00Z is 2026-01-15 08:30 in Asia/Seoul (UTC+9).
  const parts = kstPartsOf(new Date('2026-01-14T23:30:00Z'));
  assert.equal(parts.date, '2026-01-15');
  assert.equal(parts.hour, 8);
});

test('isDailyDiscoveryHourKst: true only during the 08:00-08:59 KST hour', () => {
  assert.equal(isDailyDiscoveryHourKst(new Date('2026-01-14T23:30:00Z')), true); // 08:30 KST
  assert.equal(isDailyDiscoveryHourKst(new Date('2026-01-14T22:59:00Z')), false); // 07:59 KST
  assert.equal(isDailyDiscoveryHourKst(new Date('2026-01-15T00:00:00Z')), false); // 09:00 KST
});

// --- claimDailyDiscoveryRunForToday: the once-per-KST-day guard ---

test('claimDailyDiscoveryRunForToday: claims successfully when no prior run is recorded', async () => {
  const { calls, restore } = mockPool([
    ['INSERT INTO scheduler_jobs', () => ({ rowCount: 1 })],
  ]);
  try {
    const claimed = await claimDailyDiscoveryRunForToday(new Date('2026-01-15T00:00:00Z'));
    assert.equal(claimed, true);
    assert.ok(calls[0].params.includes('2026-01-15'));
  } finally {
    restore();
  }
});

test('claimDailyDiscoveryRunForToday: does not claim again for a date already recorded (rowCount=0)', async () => {
  const { restore } = mockPool([
    ['INSERT INTO scheduler_jobs', () => ({ rowCount: 0 })],
  ]);
  try {
    const claimed = await claimDailyDiscoveryRunForToday(new Date('2026-01-15T00:00:00Z'));
    assert.equal(claimed, false);
  } finally {
    restore();
  }
});

// --- collectDailyDiscoveryNow: only runs is_daily_discovery=true crawl sources ---

function mockSearchWeb(byQuery) {
  const original = webSearchAdapter.searchWeb;
  webSearchAdapter.searchWeb = async (query) => byQuery[query] || [];
  return () => { webSearchAdapter.searchWeb = original; };
}

function mockExtractMetadataAlwaysSucceeds() {
  const original = extractMetadataModule.extractMetadata;
  extractMetadataModule.extractMetadata = async () => ({
    title: null,
    summary: 'Palm oil export tariff and major traders affected by new regulation.',
    thumbnail_url: null,
    published_at: null,
  });
  return () => { extractMetadataModule.extractMetadata = original; };
}

test('collectDailyDiscoveryNow: queries only crawl sources flagged is_daily_discovery=true', () => withNoProviders(async () => {
  const { calls, restore } = mockPool([
    [`method = 'crawl' AND is_daily_discovery = true`, () => ({ rows: [] })],
  ]);
  try {
    const result = await collectDailyDiscoveryNow();
    assert.equal(result.totals.discovered, 0);
    assert.ok(calls.some((c) => c.text.includes("method = 'crawl' AND is_daily_discovery = true")));
  } finally {
    restore();
  }
}));

test('collectDailyDiscoveryNow: runs each flagged source through the existing Web Discovery pipeline and aggregates totals', () => withNoProviders(async () => {
  const sourceA = { id: 90, name: 'Query A', url: 'palm oil soybean oil price market news today', method: 'crawl', frequency_days: 7 };
  const sourceB = { id: 91, name: 'Query B', url: 'EU deforestation regulation palm oil EUDR', method: 'crawl', frequency_days: 7 };

  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  const restoreSearch = mockSearchWeb({
    'palm oil soybean oil price market news today': [{ title: 'Palm oil prices rise', link: 'https://example.org/a' }],
    'EU deforestation regulation palm oil EUDR': [{ title: 'EUDR compliance deadline', link: 'https://example.org/b' }],
  });
  const { calls, restore } = mockPool([
    [`method = 'crawl' AND is_daily_discovery = true`, () => ({ rows: [sourceA, sourceB] })],
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 999 }] })],
    ['SELECT * FROM items WHERE id', () => ({ rows: [{ id: 999, ai_status: null }] })],
  ]);
  try {
    const result = await collectDailyDiscoveryNow();
    assert.equal(result.results.length, 2);
    assert.equal(result.totals.discovered, 2);
    const inserted = calls.filter((c) => c.text.includes('INSERT INTO items'));
    assert.equal(inserted.length, 2);
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

test('collectDailyDiscoveryNow: a candidate already archived (duplicate) is rejected by existing dedup, not re-inserted', () => withNoProviders(async () => {
  const sourceA = { id: 92, name: 'Query A', url: 'palm oil soybean oil price market news today', method: 'crawl', frequency_days: 7 };
  const sharedLink = 'https://example.org/already-archived';

  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  const restoreSearch = mockSearchWeb({
    'palm oil soybean oil price market news today': [{ title: 'Palm oil prices rise', link: sharedLink }],
  });
  const { calls, restore } = mockPool([
    [`method = 'crawl' AND is_daily_discovery = true`, () => ({ rows: [sourceA] })],
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [{ id: 42 }] })],
  ]);
  try {
    const result = await collectDailyDiscoveryNow();
    assert.equal(result.results[0].discovered, 1);
    assert.equal(result.results[0].archived, 0);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
  } finally {
    restoreSearch();
    restoreMeta();
    restore();
  }
}));

// --- maybeRunDailyDiscovery: the scheduler entry point ---

test('maybeRunDailyDiscovery: does nothing outside the 08:00 KST hour', async () => {
  const { calls, restore } = mockPool([]);
  try {
    const result = await maybeRunDailyDiscovery(new Date('2026-01-15T00:00:00Z')); // 09:00 KST
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'not_due_hour');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('maybeRunDailyDiscovery: does nothing if todays run was already claimed', async () => {
  const { restore } = mockPool([
    ['INSERT INTO scheduler_jobs', () => ({ rowCount: 0 })],
  ]);
  try {
    const result = await maybeRunDailyDiscovery(new Date('2026-01-14T23:30:00Z')); // 08:30 KST
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'already_ran_today');
  } finally {
    restore();
  }
});

test('maybeRunDailyDiscovery: claims and runs once during the due hour', () => withNoProviders(async () => {
  const { restore } = mockPool([
    ['INSERT INTO scheduler_jobs', () => ({ rowCount: 1 })],
    [`method = 'crawl' AND is_daily_discovery = true`, () => ({ rows: [] })],
  ]);
  try {
    const result = await maybeRunDailyDiscovery(new Date('2026-01-14T23:30:00Z')); // 08:30 KST
    assert.equal(result.ran, true);
    assert.ok(result.totals);
  } finally {
    restore();
  }
}));
