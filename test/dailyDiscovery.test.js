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

// --- Full autonomous-path regression: an eligible, classified candidate
// reaches Published through collectDailyDiscoveryNow with no mocked
// shortcuts in generateAiDraftForItem/applyAiDraftIfEligible themselves —
// only the FreeLLMAPI HTTP call and taxonomy/classification queries are
// mocked, exactly like aiDraft.test.js's own archive tests. ---

function fullDraftResponse() {
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
  });
}

function mockFreeLLMAPISuccess() {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('freellmapi')) {
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: fullDraftResponse() } }] }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return () => { global.fetch = original; };
}

test('collectDailyDiscoveryNow: an eligible, classified candidate reaches Published end-to-end (autonomous path)', async () => {
  const sourceA = { id: 93, name: 'Query A', url: 'palm oil export tariff regulation', method: 'crawl', frequency_days: 7 };
  const restoreFetch = mockFreeLLMAPISuccess();
  const restoreSearch = mockSearchWeb({
    'palm oil export tariff regulation': [{ title: 'Palm oil export tariff raised', link: 'https://example.org/eligible' }],
  });
  const restoreMeta = mockExtractMetadataAlwaysSucceeds();
  // generateAiDraftForItem reads the item row before the AI call (still
  // ai_status=null) and applyAiDraftIfEligible reads it again right after
  // the 'completed' UPDATE below — this flag flips so the second read
  // reflects that write, instead of returning the same pre-draft row twice.
  let draftCompleted = false;
  const { calls, restore } = mockPool([
    [`method = 'crawl' AND is_daily_discovery = true`, () => ({ rows: [sourceA] })],
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 555 }] })],
    ["ai_status = 'completed'", () => { draftCompleted = true; return { rows: [] }; }],
    ['SELECT * FROM items WHERE id', () => (draftCompleted
      ? { rows: [{ id: 555, ai_status: 'completed', ai_eligible: true, ai_qa_decision: 'PASS', ai_summary: 's', ai_insight: 'i', ai_suggested_sectors: [3], ai_suggested_usages: [3] }] }
      : { rows: [{ id: 555, ai_status: null, ai_eligible: null }] })],
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }] })],
    ['SELECT id, name FROM usages', () => ({ rows: [{ id: 3, name: '시장 전망' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
  ]);
  const prevKey = process.env.FREELLMAPI_API_KEY;
  const prevUrl = process.env.FREELLMAPI_BASE_URL;
  process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
  process.env.FREELLMAPI_BASE_URL = 'https://freellmapi.example.com/v1';
  try {
    const result = await collectDailyDiscoveryNow();
    assert.equal(result.results[0].archived, 1);
    assert.ok(calls.some((c) => c.text.includes("status = 'Published'")));
  } finally {
    restoreFetch();
    restoreSearch();
    restoreMeta();
    restore();
    if (prevKey === undefined) delete process.env.FREELLMAPI_API_KEY; else process.env.FREELLMAPI_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.FREELLMAPI_BASE_URL; else process.env.FREELLMAPI_BASE_URL = prevUrl;
  }
});
