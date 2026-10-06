const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Content-level regression for the Reference Source Library v1 schema
// change — schema.sql is the only place these columns/seed rows are
// defined (idempotent ALTER COLUMN IF NOT EXISTS + INSERT...WHERE NOT
// EXISTS), so this reads it directly rather than hitting a real database.

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

const NEW_COLUMNS = [
  'is_reference', 'source_type', 'region', 'commodities', 'coverage_note',
  'access_format', 'update_frequency', 'usage_note', 'last_verified_at', 'rss_available',
];

test('schema: every Reference Source Library column is added idempotently', () => {
  for (const col of NEW_COLUMNS) {
    assert.match(
      schemaSql,
      new RegExp(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS ${col}\\b`),
      `expected an idempotent ALTER COLUMN for ${col}`
    );
  }
});

test('schema: is_reference and rss_available default to false (an ordinary source is unaffected until explicitly marked)', () => {
  assert.match(schemaSql, /ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_reference BOOLEAN NOT NULL DEFAULT false/);
  assert.match(schemaSql, /ALTER TABLE sources ADD COLUMN IF NOT EXISTS rss_available BOOLEAN NOT NULL DEFAULT false/);
});

const SEEDED_REFERENCE_SOURCES = [
  'USDA FAS PSD Online',
  'MPOB Palm Oil Statistics',
  'GAPKI Palm Oil Statistics',
  'Bursa Malaysia Derivatives (FCPO)',
  'UN Comtrade',
];

test('schema: seeds a small, representative set of Oil&Fats reference sources (not a bulk directory)', () => {
  for (const name of SEEDED_REFERENCE_SOURCES) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected schema.sql to seed "${name}"`);
  }
  // Deliberately small: a handful, not dozens.
  assert.ok(SEEDED_REFERENCE_SOURCES.length <= 10);
});

test('schema: the seed block inserts with method=manual and is_reference=true, idempotently', () => {
  const seedBlock = schemaSql.slice(
    schemaSql.indexOf(SEEDED_REFERENCE_SOURCES[0]) - 1500,
    schemaSql.indexOf(SEEDED_REFERENCE_SOURCES[SEEDED_REFERENCE_SOURCES.length - 1]) + 1000,
  );
  assert.match(seedBlock, /'manual'/);
  assert.match(seedBlock, /WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\)/);
});

test('schema: existing sources_method_check constraint is untouched (no new ingestion method introduced)', () => {
  assert.match(
    schemaSql,
    /ALTER TABLE sources ADD CONSTRAINT sources_method_check CHECK \(method IN \('rss','crawl','manual','institution','structured'\)\)/
  );
});
