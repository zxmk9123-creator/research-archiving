const test = require('node:test');
const assert = require('node:assert/strict');
const ar = require('../server/lib/annualReport');

test('selectPages keeps a facilities/capacity page and a statistics table, skips prose', () => {
  const stats = { n: 36, text: '5-YEAR PLANTATION STATISTICS FFB Production (mt) 5,616,809 5,473,196 5,253,723 Total planted area (ha) 293,427 291,353 286,208 CPO PK mill' };
  const cap = { n: 31, text: 'PRODUCTION FACILITIES & CAPACITIES Palm Oil Mills 34 POMs 20 to 120 FFB mt/hr 7,700 CPO mt/day' };
  const prose = { n: 5, text: 'Chairman statement about governance and community programmes. '.repeat(20) };
  assert.deepEqual(ar.selectPages([prose, cap, stats]).map((p) => p.n), [31, 36]);
});

test('verifyAgainstPages drops figures that are not printed on the cited page', () => {
  const pages = [{ n: 36, text: 'FFB Production 5,616,809 mt Total planted area 293,427 ha' }];
  const { kept, dropped } = ar.verifyAgainstPages([
    { page: 36, value: 5616809, unit: 'mt' }, { page: 36, value: 293427, unit: 'ha' }, { page: 36, value: 561681, unit: 'mt' }, { page: 7, value: 293427, unit: 'ha' },
  ], pages);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 2);
});
