const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDateOnly } = require('../public/dateFormat');

test('formatDateOnly: converts an ISO timestamp to date-only dotted format', () => {
  assert.equal(formatDateOnly('2026-09-28T00:00:00.000Z'), '2026.09.28');
});

test('formatDateOnly: converts a plain date-only string the same way', () => {
  assert.equal(formatDateOnly('2026-09-28'), '2026.09.28');
});

test('formatDateOnly: never includes time or timezone', () => {
  const result = formatDateOnly('2026-09-28T13:45:30.123+09:00');
  assert.equal(result, '2026.09.28');
  assert.ok(!/[T:+Z]/.test(result));
});

test('formatDateOnly: falsy/invalid input returns an empty string', () => {
  assert.equal(formatDateOnly(null), '');
  assert.equal(formatDateOnly(undefined), '');
  assert.equal(formatDateOnly(''), '');
  assert.equal(formatDateOnly('not a date'), '');
});
