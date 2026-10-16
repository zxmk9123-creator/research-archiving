const test = require('node:test');
const assert = require('node:assert/strict');
const { COMPANIES, buildQueries } = require('../server/lib/companyProfileCollection');

test('company profile collection: 9 workbook companies, each with distinct non-empty queries', () => {
  assert.equal(COMPANIES.length, 9);
  for (const c of COMPANIES) {
    const qs = buildQueries(c);
    assert.ok(qs.length >= 8);
    assert.equal(new Set(qs).size, qs.length);
  }
});

test('company profile collection: watchlist names/aliases are not short substrings that would mis-tag unrelated items', () => {
  for (const c of COMPANIES) for (const n of [c.name, ...c.aliases]) assert.ok(n.trim().length >= (/[가-힣]/.test(n) ? 2 : 3) && n === n.trim(), `${n}`);
  assert.ok(!COMPANIES.some((c) => c.name.toLowerCase() === 'bp' || c.name.toLowerCase() === 'eni'));
});

test('palm set: 10 companies, palm-specific queries, valid aliases', () => {
  const { PALM_COMPANIES } = require('../server/lib/companyProfileCollection');
  assert.equal(PALM_COMPANIES.length, 10);
  for (const c of PALM_COMPANIES) {
    const q = buildQueries({ ...c, palm: true });
    assert.ok(q.length >= 6 && q.some((x) => /refinery/i.test(x)) && q.some((x) => /planted area/i.test(x)), c.name);
    for (const n of c.aliases) assert.ok(n.length >= (/[가-힣]/.test(n) ? 2 : 3) && n === n.trim(), n);
  }
});
