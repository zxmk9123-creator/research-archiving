const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { collectStructuredSource, buildSnapshotText } = require('../server/lib/structuredDataIngest');
const structuredDataAdapter = require('../server/lib/adapters/structuredData');

// Same no-provider guard collector.test.js uses: with no AI provider env
// vars set, generateAiDraftForItem's outbound call fails fast and
// deterministically instead of hitting a real network, so the "AI
// screening ran but failed" branch is exercised without mocking aiDraft.js
// itself.
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

// Same substring-matched pool.query dispatcher convention as
// collector.test.js / aiDraft.test.js.
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

function mockFetchAndParse(result) {
  const original = structuredDataAdapter.fetchAndParse;
  structuredDataAdapter.fetchAndParse = async () => result;
  return () => { structuredDataAdapter.fetchAndParse = original; };
}

const SAMPLE_PARSED = {
  latestPeriod: '2025-12',
  previousPeriod: '2025-11',
  series: [
    { key: 'crude_oil', label: 'Crude oil, average', unit: '($/bbl)', latest: 60.9, previous: 62.3, deltaPct: -2.25 },
    { key: 'palm_oil', label: 'Palm oil', unit: '($/mt)', latest: 1119.4, previous: 1128.4, deltaPct: -0.8 },
  ],
};

function structuredSource(overrides) {
  return {
    id: 30,
    name: 'World Bank Pink Sheet',
    url: 'https://example.org/CMO-Historical-Data-Monthly.xlsx',
    method: 'structured',
    frequency_days: 30,
    ...overrides,
  };
}

test('buildSnapshotText: formats each series line with unit, previous value, and signed delta', () => {
  const text = buildSnapshotText('2025-12', '2025-11', SAMPLE_PARSED.series);
  assert.match(text, /2025-12/);
  assert.match(text, /전월 2025-11/);
  assert.match(text, /Crude oil, average: 60\.9 \(\$\/bbl\) \(전월 62\.3 \(\$\/bbl\), 전월 대비 -2\.3%\)/);
  assert.match(text, /Palm oil: 1119\.4 \(\$\/mt\)/);
});

test('buildSnapshotText: a null latest value is reported as 미확보, not a blank or "null"', () => {
  const text = buildSnapshotText('2025-12', '2025-11', [
    { key: 'coconut_oil', label: 'Coconut oil', unit: '($/mt)', latest: null, previous: null, deltaPct: null },
  ]);
  assert.match(text, /Coconut oil: 미확보/);
});

test('collectStructuredSource: a new period creates one type=통계 item and marks the source healthy', () => withNoProviders(async () => {
  const restoreFetch = mockFetchAndParse(SAMPLE_PARSED);
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 555 }] })],
    ['SELECT \\* FROM items WHERE id', () => ({ rows: [{ id: 555, ai_status: null }] })],
  ]);
  try {
    const source = structuredSource();
    const result = await collectStructuredSource(source);

    assert.equal(result.ok, true);
    assert.equal(result.itemId, 555);
    assert.equal(result.latestPeriod, '2025-12');
    assert.equal(result.archived, false); // no AI provider configured in this test

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO items'));
    assert.ok(insertCall, 'expected an INSERT INTO items call');
    assert.match(insertCall.params[0], /2025-12/); // title includes the period
    assert.equal(insertCall.params[1], 'https://example.org/CMO-Historical-Data-Monthly.xlsx#period=2025-12');
    assert.equal(insertCall.params[2], 30); // source_id
    // 4th bound param is the item type — verifies this ingestion path uses
    // '통계' (statistics), the type this milestone exists to exercise,
    // never '보고서' (report) like the institutional PDF path.
    assert.match(insertCall.text, /'통계'/);

    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_collected_at')));
  } finally {
    restoreFetch();
    restore();
  }
}));

test('collectStructuredSource: a period already ingested is skipped — no duplicate item, no AI call attempted', () => withNoProviders(async () => {
  const restoreFetch = mockFetchAndParse(SAMPLE_PARSED);
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [{ id: 999 }] })],
  ]);
  try {
    const result = await collectStructuredSource(structuredSource());

    assert.equal(result.ok, true);
    assert.equal(result.alreadyIngested, true);
    assert.equal(result.itemId, 999);
    assert.equal(result.fetched, 0);
    assert.equal(result.count, 0);

    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_collected_at')));
  } finally {
    restoreFetch();
    restore();
  }
}));

test('collectStructuredSource: the same source_url dedup key is built from the file URL plus the exact period', () => withNoProviders(async () => {
  const restoreFetch = mockFetchAndParse({ ...SAMPLE_PARSED, latestPeriod: '2026-01', previousPeriod: '2025-12' });
  const { calls, restore } = mockPool([
    ['SELECT id FROM items WHERE source_url', () => ({ rows: [] })],
    ['INSERT INTO items', () => ({ rows: [{ id: 556 }] })],
    ['SELECT \\* FROM items WHERE id', () => ({ rows: [{ id: 556, ai_status: null }] })],
  ]);
  try {
    await collectStructuredSource(structuredSource());
    const dedupCheck = calls.find((c) => c.text.includes('SELECT id FROM items WHERE source_url'));
    assert.equal(dedupCheck.params[0], 'https://example.org/CMO-Historical-Data-Monthly.xlsx#period=2026-01');
  } finally {
    restoreFetch();
    restore();
  }
}));

test('collectStructuredSource: acquisition/parsing failure records last_error and never creates an item', async () => {
  const original = structuredDataAdapter.fetchAndParse;
  structuredDataAdapter.fetchAndParse = async () => { throw new Error('fetch failed: 500'); };
  const restoreFetch = () => { structuredDataAdapter.fetchAndParse = original; };
  const { calls, restore } = mockPool([]);
  try {
    const result = await collectStructuredSource(structuredSource());
    assert.equal(result.ok, false);
    assert.match(result.error, /fetch failed: 500/);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO items')));
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_error')));
  } finally {
    restoreFetch();
    restore();
  }
});

test('collectStructuredSource: a unique-violation on INSERT (an overlapping run already ingested this exact period) is treated as alreadyIngested, not a failure', () => withNoProviders(async () => {
  const restoreFetch = mockFetchAndParse(SAMPLE_PARSED);
  // The pre-insert dedup SELECT finds nothing (no overlapping run has
  // committed yet); the INSERT itself then races and hits the UNIQUE
  // constraint; the recovery SELECT (after catching 23505) finds the row
  // the other, overlapping run just committed.
  let insertAttempted = false;
  const { calls, restore } = mockPool([
    ['INSERT INTO items', () => {
      insertAttempted = true;
      const err = new Error('duplicate key value violates unique constraint "idx_items_source_url_unique"');
      err.code = '23505';
      throw err;
    }],
    ['SELECT id FROM items WHERE source_url', () => ({ rows: insertAttempted ? [{ id: 999 }] : [] })],
  ]);
  try {
    const result = await collectStructuredSource(structuredSource());
    assert.equal(result.ok, true, 'a raced duplicate must not fail the whole collection run');
    assert.equal(result.alreadyIngested, true);
    assert.equal(result.itemId, 999);
    assert.ok(calls.some((c) => c.text.includes('UPDATE sources SET last_collected_at')));
  } finally {
    restoreFetch();
    restore();
  }
}));
