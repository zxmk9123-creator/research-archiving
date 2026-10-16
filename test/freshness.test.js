const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../server/lib/freshness');
const dp = require('../server/lib/datasetPipeline');

const now = new Date('2026-10-16');
test('isOutdated: older than ~18 months only', () => {
  assert.equal(f.isOutdated('2026-05-01', now), false);
  assert.equal(f.isOutdated('2024-12-01', now), true);
  assert.equal(f.isOutdated(null, now), false);
});
test('wantsHistorical: past year or trend wording only', () => {
  assert.equal(f.wantsHistorical('Neste 생산능력 정리', now), false);
  assert.equal(f.wantsHistorical('2027년 목표 비교', now), false);
  assert.equal(f.wantsHistorical('2019년 팜유 생산량', now), true);
  assert.equal(f.wantsHistorical('팜유 가격 추이', now), true);
});
test('textLooksOutdated: undated page naming only old years', () => {
  assert.equal(f.textLooksOutdated('Annual report 2022 output', now), true);
  assert.equal(f.textLooksOutdated('2022 baseline, 2027 target', now), false);
  assert.equal(f.textLooksOutdated('no year here', now), false);
});
test('datasetPipeline drops outdated facts unless the question is historical', () => {
  const rec = (pubAt) => ({ entity: 'Wilmar', status: '가동', group: 'mass', amount: 1e6, original: '100만 톤', basis: '직접', source: 1, pubAt });
  const old = rec('2023-01-01');
  const fresh = rec(new Date().toISOString().slice(0, 10));
  assert.equal(dp.recordsForQuestion([old, fresh], 'Wilmar 생산능력 표로', null).length, 1);
  assert.equal(dp.recordsForQuestion([old, fresh], '2023년 Wilmar 생산능력 표로', null).length, 2);
});
