const test = require('node:test');
const assert = require('node:assert/strict');
const arr = require('../server/lib/annualReportRecords');
const dp = require('../server/lib/datasetPipeline');

const row = (o) => ({ entity: 'KLK', fiscal_year: 2025, scope: 'group', location: null, unit: 'mt', published_at: new Date().toISOString().slice(0, 10), source_url: 'u', ...o });

test('familyOf separates FFB / CPO / PK / area and rejects rates, rubber, mature-only', () => {
  assert.equal(arr.familyOf('FFB Production - Own estates'), 'ffb');
  assert.equal(arr.familyOf('CPO Production'), 'cpo');
  assert.equal(arr.familyOf('PK Production'), 'pk');
  assert.equal(arr.familyOf('total planted area'), 'area');
  assert.equal(arr.familyOf('planted area - mature'), null);
  assert.equal(arr.familyOf('rubber planted area'), null);
  assert.equal(arr.familyOf('Oil Extraction Rate - CPO'), null);
  assert.equal(arr.familyOf('FFB yield per mature hectare'), null);
});

test('familyForQuestion picks one family per question', () => {
  assert.equal(arr.familyForQuestion('팜유 업체 식재 면적 비교'), 'area');
  assert.equal(arr.familyForQuestion('FFB 생산량 비교 표'), 'ffb');
  assert.equal(arr.familyForQuestion('팜유 생산업체 CPO 생산량 그래프'), 'cpo');
  assert.equal(arr.familyForQuestion('Neste 업체 소개'), null);
});

test('toRecord: tonnes and hectares become verified-unit records; ranges, daily capacity and other units are skipped', () => {
  const a = arr.toRecord(row({ metric: 'CPO Production', value: 1362787, unit: 'mt' }));
  assert.equal(a.group, 'mass'); assert.equal(a.amount, 1362787); assert.equal(a.tons, 1362787);
  const h = arr.toRecord(row({ metric: 'total planted area', value: 293427, unit: 'ha', definition: 'Weighted Average Hectarage' }));
  assert.equal(h.group, 'area'); assert.match(h.original, /Weighted Average Hectarage/);
  assert.equal(arr.toRecord(row({ metric: 'CPO Production', value: 7700, unit: 'CPO mt/day' })), null);
  assert.equal(arr.toRecord(row({ metric: 'CPO Production', value: 20, value_max: 120, unit: 'mt' })), null);
  assert.equal(arr.toRecord(row({ metric: 'total planted area', value: 5, unit: 'mt' })), null);
});

test('onePerEntity prefers the year-end basis over weighted average', () => {
  const recs = [
    arr.toRecord(row({ metric: 'total planted area', value: 293427, unit: 'ha', definition: 'Weighted Average Hectarage' })),
    arr.toRecord(row({ metric: 'planted area', value: 301090, unit: 'hectares', definition: 'as at 30 September 2025' })),
  ];
  const out = arr.onePerEntity(recs);
  assert.equal(out.length, 1);
  assert.equal(out[0].amount, 301090);
});

test('dataset: an area question builds a hectare table + chart from annual records only', () => {
  const mk = (entity, v) => ({ ...arr.toRecord(row({ entity, metric: 'total planted area', value: v, unit: 'ha' })), source: 1 });
  const recs = dp.recordsForQuestion([mk('KLK', 301090), mk('IOI', 214335), mk('SD Guthrie', 600000)], '팜유 업체 식재 면적 표로 비교', null);
  assert.equal(recs.length, 3);
  const ds = dp.buildDataset(recs, [], {});
  assert.match(ds.table, /수치 \(헥타르\)/);
  assert.equal(ds.chart.unit, '헥타르');
  // a production question drops area records
  assert.equal(dp.recordsForQuestion([mk('KLK', 1)], '팜유 생산량 표', null).length, 0);
});
