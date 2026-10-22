const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingBriefFor, kstDate } = require('../server/lib/dailyBrief');

test('pendingBriefFor: the empty state shown from the KST date change until today\'s brief starts', () => {
  const p = pendingBriefFor('2026-10-23', '2026-10-22');
  assert.equal(p.status, 'pending');
  assert.equal(p.brief, null);
  assert.equal(p.brief_date, '2026-10-23');
  assert.equal(p.previous_brief_date, '2026-10-22');
  assert.deepEqual(p.sources, []);
});

test('kstDate rolls over at 15:00 UTC (00:00 KST)', () => {
  assert.equal(kstDate(new Date('2026-10-22T14:59:00Z')), '2026-10-22');
  assert.equal(kstDate(new Date('2026-10-22T15:00:00Z')), '2026-10-23');
});
