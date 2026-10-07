const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Content-level regression for the items.source_url exact-URL dedup fix —
// schema.sql is the only place the cleanup/constraint are defined, so this
// reads it directly rather than hitting a real database (same convention
// as the other *Schema.test.js files in this suite).

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

test('schema: a UNIQUE index on items.source_url exists, created idempotently', () => {
  assert.match(schemaSql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_url_unique ON items\(source_url\)/);
});

test('schema: the duplicate cleanup runs before the UNIQUE index is created', () => {
  const deleteIdx = schemaSql.indexOf('DELETE FROM items a');
  const indexIdx = schemaSql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_url_unique');
  assert.ok(deleteIdx !== -1, 'expected a cleanup DELETE before the unique index');
  assert.ok(indexIdx !== -1, 'expected the unique index to exist');
  assert.ok(deleteIdx < indexIdx, 'cleanup must run before the UNIQUE constraint is added, or the migration would fail on existing duplicates');
});

test('schema: the cleanup DELETE only matches byte-for-byte source_url duplicates, keeping the lowest id, and is naturally idempotent (re-running matches zero rows once clean)', () => {
  const block = schemaSql.slice(schemaSql.indexOf('DELETE FROM items a'), schemaSql.indexOf(';', schemaSql.indexOf('DELETE FROM items a')) + 1);
  assert.match(block, /a\.source_url IS NOT NULL/);
  assert.match(block, /a\.source_url = b\.source_url/);
  assert.match(block, /a\.id > b\.id/, 'must keep the lowest id per duplicate source_url group');
});
