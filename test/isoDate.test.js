const test = require('node:test');
const assert = require('node:assert/strict');
const { isoDate } = require('../server/lib/isoDate');

test('isoDate: Date objects and strings become yyyy-mm-dd; garbage and empty become ""', () => {
  assert.equal(isoDate(new Date('2025-12-26T00:00:00Z')), '2025-12-26');
  assert.equal(isoDate('2026-10-22T00:00:00.000Z'), '2026-10-22');
  assert.equal(isoDate('Fri Dec 26 2025 00:00:00 GMT+0000'), '2025-12-26');
  assert.equal(isoDate(null), '');
  assert.equal(isoDate('not a date'), '');
});
