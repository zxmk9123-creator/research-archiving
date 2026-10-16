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

test('verifyAgainstPages: ranges need both ends on the page; unverified definition is dropped, figure kept', () => {
  const pages = [{ n: 31, text: 'Palm Oil Mills 34 POMs From 20 to 120 FFB mt/hr Weighted Average Hectarage Total planted area 293,427 ha' }];
  const { kept } = ar.verifyAgainstPages([
    { page: 31, value: 20, value_max: 120, unit: 'FFB mt/hr', definition: null },
    { page: 31, value: 20, value_max: 999, unit: 'FFB mt/hr' },
    { page: 31, value: 293427, unit: 'ha', definition: 'Weighted Average Hectarage' },
    { page: 31, value: 293427, unit: 'ha', definition: 'Made up basis' },
  ], pages);
  assert.equal(kept.length, 3);
  assert.equal(kept[1].definition, 'Weighted Average Hectarage');
  assert.equal(kept[2].definition, null);
});

test('buildReportText states ranges, definitions and pages', () => {
  const { buildReportText } = require('../server/lib/annualReportIngest');
  const t = buildReportText('KLK', 2025, [
    { segment: 'mill', metric: 'capacity', value: 20, value_max: 120, unit: 'FFB mt/hr', page: 31 },
    { segment: 'plantation', metric: 'total planted area', value: 293427, unit: 'ha', definition: 'Weighted Average Hectarage', page: 36 },
  ], 'https://x/ar.pdf');
  assert.match(t, /20~120 FFB mt\/hr/);
  assert.match(t, /293,427 ha \(기준: Weighted Average Hectarage\) — 보고서 p\.36/);
});
