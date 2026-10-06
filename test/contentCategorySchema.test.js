const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Content-level regression for the Archive / Daily Report split's schema
// change — confirms schema.sql both adds the column (idempotently, with
// the same 2-value CHECK convention as ai_status/type/status) and backfills
// already-Published rows using the exact same type-based rule future
// publishes apply (deriveContentCategory() in classification.js).

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

test('schema: content_category column is added idempotently with an archive/daily_report CHECK', () => {
  assert.match(
    schemaSql,
    /ALTER TABLE items ADD COLUMN IF NOT EXISTS content_category TEXT CHECK \(content_category IN \('archive','daily_report'\)\)/
  );
});

test('schema: existing Published items are backfilled with the same type-based rule, only where still unset', () => {
  const backfillMatch = schemaSql.match(/UPDATE items SET content_category = CASE[^;]+;/);
  assert.ok(backfillMatch, 'expected a content_category backfill UPDATE statement');
  const stmt = backfillMatch[0];
  assert.match(stmt, /WHEN type = '뉴스' THEN 'daily_report'/);
  assert.match(stmt, /ELSE 'archive'/);
  // Guards against ever re-stamping a row a later code path already set,
  // and against touching unpublished (Draft) items.
  assert.match(stmt, /WHERE status = 'Published' AND content_category IS NULL/);
});
