const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Content-level regression for the ai_search_logs table — schema.sql is
// the only place it's defined, so this reads it directly rather than
// hitting a real database (same convention as referenceSourceLibrarySchema.test.js).

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

test('schema: ai_search_logs is created idempotently', () => {
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS ai_search_logs/);
});

test('schema: ai_search_logs never stores the raw question or AI answer — metadata columns only', () => {
  const tableBlock = schemaSql.slice(
    schemaSql.indexOf('CREATE TABLE IF NOT EXISTS ai_search_logs'),
    schemaSql.indexOf(');', schemaSql.indexOf('CREATE TABLE IF NOT EXISTS ai_search_logs')) + 2
  );
  for (const forbidden of ['question TEXT', 'answer TEXT', 'api_key', 'authorization', 'cookie']) {
    assert.ok(
      !new RegExp(forbidden, 'i').test(tableBlock),
      `ai_search_logs must not have a column suggesting "${forbidden}" is stored`
    );
  }
  for (const expectedColumn of [
    'request_id', 'created_at', 'operation', 'outcome', 'http_status', 'latency_ms',
    'candidate_count', 'source_count', 'provider', 'failure_type', 'is_followup', 'question_fingerprint',
  ]) {
    assert.ok(tableBlock.includes(expectedColumn), `expected ai_search_logs to have a "${expectedColumn}" column`);
  }
});

test('schema: ai_search_logs.outcome is constrained to the known terminal states', () => {
  assert.match(
    schemaSql,
    /outcome TEXT NOT NULL CHECK \(outcome IN \('success', 'insufficient_evidence', 'invalid_request', 'retrieval_error', 'provider_error'\)\)/
  );
});

test('schema: ai_search_logs has a created_at index for querying recent telemetry', () => {
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS idx_ai_search_logs_created_at ON ai_search_logs\(created_at\)/);
});
