const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../server/lib/tradeQuery');

test('parseQuery: defaults; the period is clamped, swapped or shortened instead of failing', () => {
  const b = { min: '202311', max: '202609' };
  const ok = Q.parseQuery({}, b);
  assert.deepEqual(ok.value, { hs: '15', flow: 'imp', from: '202410', to: '202609' }); assert.deepEqual(ok.adjusted, []);
  assert.equal(Q.parseQuery({ hs: '151' }, b).error, 'invalid_hs');
  const late = Q.parseQuery({ from: '202501', to: '203001' }, b);
  assert.deepEqual([late.value.from, late.value.to, late.adjusted], ['202501', '202609', ['to_clamped']]);
  const early = Q.parseQuery({ from: '200001', to: '202401' }, b);
  assert.deepEqual([early.value.from, early.value.to], ['202311', '202401']); assert.ok(early.adjusted.includes('from_clamped'));
  const rev = Q.parseQuery({ from: '202605', to: '202501' }, b);
  assert.deepEqual([rev.value.from, rev.value.to], ['202501', '202605']); assert.ok(rev.adjusted.includes('swapped'));
  const bad = Q.parseQuery({ from: '2025-13', to: 'x' }, b);
  assert.deepEqual([bad.value.from, bad.value.to], ['202410', '202609']); assert.ok(bad.adjusted.includes('to_invalid'));
  const outside = Q.parseQuery({ from: '203001', to: '203006' }, b);
  assert.ok(outside.value.from >= b.min && outside.value.to <= b.max && outside.value.from <= outside.value.to);
  const longB = { min: '200001', max: '202609' };
  const long = Q.parseQuery({ from: '200101', to: '202609' }, longB);
  assert.equal(long.value.from, Q.addMonths('202609', -(Q.MAX_MONTHS - 1))); assert.ok(long.adjusted.includes('range_shortened'));
  assert.equal(Q.parseQuery({ hs: '1511', flow: 'exp', to: '202606' }, b).value.flow, 'exp');
});
test('nextLevel walks 2 -> 4 -> 6 -> 10 and stops', () => {
  assert.deepEqual([2, 4, 6, 8, 10].map(Q.nextLevel), [4, 6, 10, 10, null]);
});
test('buildSeries: tons, unit price, year-over-year; gaps stay null', () => {
  const rows = [{ period: '202501', wgt: 1000000, amt: 1200000 }, { period: '202601', wgt: 2000000, amt: 3000000 }, { period: '202603', wgt: null, amt: null }];
  const s = Q.buildSeries(rows, '202601', '202603');
  assert.equal(s.length, 3);
  assert.equal(s[0].ton, 2000); assert.equal(s[0].price, 1500); assert.equal(s[0].prevTon, 1000);
  assert.equal(Math.round(s[0].yoyTon * 100), 100); assert.equal(Math.round(s[0].yoyPrice * 1000), 250);
  assert.equal(s[1].ton, null); assert.equal(s[1].yoyTon, null);
});
test('buildKpis: latest month, MoM, YoY and trailing 12 vs prior 12', () => {
  const rows = [];
  for (let i = 0; i < 24; i++) { const p = Q.addMonths('202410', i); rows.push({ period: p, wgt: (i < 12 ? 1000 : 2000) * 1000, amt: 1000000 }); }
  const k = Q.buildKpis(rows, '202510', '202609');
  assert.equal(k.period, '202609'); assert.equal(k.ton, 2000); assert.equal(k.momTon, 0);
  assert.equal(k.t12.ton, 24000); assert.equal(k.t12.prevTon, 12000); assert.equal(Math.round(k.t12.changeTon * 100), 100);
  assert.equal(Q.buildKpis([], '202510', '202609'), null);
});
