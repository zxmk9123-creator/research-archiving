const test = require('node:test');
const assert = require('node:assert/strict');
const dp = require('../server/lib/datasetPipeline');
const rc = require('../server/lib/requestCompliance');

const mt = (m) => [m.title, m.summary].filter(Boolean).join(' ');
const cands = [
  { title: 'Neste', summary: 'Neste Rotterdam capacity 1.2 Mt/a by 2026 up from 0.5 Mt; Singapore 1.0 Mt/a; Neste total renewable 6.8 Mt' },
  { title: 'DGD', summary: 'Port Arthur SAF 235 million gallons per year' },
  { title: 'P66', summary: 'Rodeo 52,000 b/d complex' },
];
const rec = (o) => ({ site: null, period: '연간', status: '가동', year: null, ...o });

test('isDatasetRequest: quantity-comparison chart/table requests for ANY product or segment; not plain questions, prices or ratios', () => {
  const ask = (q) => dp.isDatasetRequest(rc.parseRequest(q), q);
  assert.equal(ask('SAF Capa를 그래프로'), true);
  assert.equal(ask('국가별 팜유 생산량을 표로 정리해줘'), true);
  assert.equal(ask('주요 업체 투자액 비교 차트'), true);
  assert.equal(ask('SAF Capa 알려줘'), false);
  assert.equal(ask('팜유 가격 그래프'), false);
});

test('productDensity: fuels and edible oils are recognised; unknown products give no density (no guessing)', () => {
  assert.equal(dp.productDensity('글로벌 SAF 플랜트 Capa'), 0.8);
  assert.equal(dp.productDensity('팜유 대두유 생산량 palm oil'), 0.92);
  assert.equal(dp.productDensity('철강 생산량'), null);
});

test('parseRecords: tolerant of fences/prose, empty on garbage', () => {
  assert.deepEqual(dp.parseRecords('```json\n[{"entity":"a"}]\n```'), [{ entity: 'a' }]);
  assert.deepEqual(dp.parseRecords('no json'), []);
});

test('verifyRecords: figures must exist in the cited material; units are grouped (mass / volume / money) and converted exactly', () => {
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', status: '계획', year: 2026, source: 1 }),
    rec({ entity: 'DGD', site: 'Port Arthur', value: 235, unit: 'million gallons', source: 2 }),
    rec({ entity: 'P66', site: 'Rodeo', value: 52000, unit: 'b/d', source: 3 }),
    rec({ entity: 'Neste', site: 'X', value: 999, unit: 'Mt', source: 1 }), // not in the material
    rec({ entity: 'Neste', site: 'Y', value: 1.0, unit: 'Mt', source: 9 }), // bad source index
    rec({ entity: 'Z', value: 800, unit: '달러/톤', source: 1 }), // a price per unit is not a quantity
  ], cands, mt, { density: 0.8 });
  assert.deepEqual(v.map((x) => [x.entity, x.group, Math.round(x.amount), x.tons === null ? null : Math.round(x.tons)]), [
    ['Neste', 'mass', 1200000, 1200000],
    ['DGD', 'volume', Math.round(235e6 * 3.785411784), Math.round((235e6 * 3.785411784 * 0.8) / 1000)],
    ['P66', 'volume', Math.round(52000 * 158.987 * 365), Math.round((52000 * 158.987 * 365 * 0.8) / 1000)],
  ]);
  // unknown product density: volumes never become tons
  const noDensity = dp.verifyRecords([rec({ entity: 'DGD', value: 235, unit: 'million gallons', source: 2 })], cands, mt, { density: null });
  assert.equal(noDensity[0].tons, null);
});

test('buildDataset: one unit, every entity (missing ones as 미공시), latest figure per site, totals not stacked, state wording canonical', () => {
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 0.5, unit: 'Mt', year: 2023, source: 1 }),
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', status: '계획', year: 2026, source: 1 }),
    rec({ entity: 'Neste', site: '싱가포르', value: 1.0, unit: 'Mt', source: 1 }),
    rec({ entity: 'Neste', site: null, value: 6.8, unit: 'Mt', status: '목표', source: 1 }),
    rec({ entity: 'DGD', site: 'Port Arthur', value: 235, unit: 'million gallons', source: 2 }),
  ], cands, mt, { density: 0.8 });
  const d = dp.buildDataset(v, [{ name: 'Chevron', names: ['chevron'], indices: [2] }], { unitTons: true, density: 0.8 });
  assert.ok(d);
  assert.match(d.table, /수치 \(톤\)/);
  assert.match(d.table, /\| Chevron \| - \| 미공시 \|/);
  assert.match(d.table, /\| Neste \| 로테르담 \| 계획 \(2026\) \| 1,200,000 \|/);
  assert.match(d.table, /\| Neste \| 로테르담 \| 현재 \(2023\) \| 500,000 \|/); // the table keeps every figure, wording 현재 (never 가동)
  assert.ok(!/가동(?!률)/.test(d.markdown));
  assert.deepEqual([...d.chart.labels].sort(), ['DGD Port Arthur', 'Neste 로테르담 (계획)', 'Neste 싱가포르']);
  assert.equal(d.chart.unit, '톤');
  assert.equal(d.chart.combine, 'sum');
  assert.match(d.markdown, /밀도 0\.8/);
  assert.equal(dp.buildDataset(v.slice(0, 2), []), null); // too few records: fall back to normal generation
});

test('buildDataset: any quantity — with no known density volumes stay out of a tons chart; money is its own group', () => {
  const money = [
    { title: 'a', summary: 'Alpha invested $850 million in Rodeo; Beta invested $315 million in Port Arthur; Gamma $600 million Rotterdam' },
  ];
  const v = dp.verifyRecords([
    rec({ entity: 'Alpha', site: 'Rodeo', metric: '투자액', value: 850, unit: 'million 달러', source: 1 }),
    rec({ entity: 'Beta', site: 'Port Arthur', metric: '투자액', value: 315, unit: 'million USD', source: 1 }),
    rec({ entity: 'Gamma', site: 'Rotterdam', metric: '투자액', value: 600, unit: 'million USD', source: 1 }),
  ], money, mt, { density: null });
  const d = dp.buildDataset(v, [], {});
  assert.equal(d.chart.unit, '달러');
  assert.match(d.chart.title, /투자액/);
  assert.deepEqual(d.chart.series[0].data, [850e6, 600e6, 315e6]);
});

test('verifyRecords: per-day/per-month rates are annualised, per-hour rates skipped, liters need no conversion note', () => {
  const src = [{ title: 'a', summary: 'Plant A 750 리터/일; Plant B 500 리터/월; Plant C 40 리터/시간; Plant D 1,000 백만 리터/년' }];
  const v = dp.verifyRecords([
    rec({ entity: 'A', value: 750, unit: '리터/일', source: 1 }),
    rec({ entity: 'B', value: 500, unit: '리터/월', source: 1 }),
    rec({ entity: 'C', value: 40, unit: '리터/시간', source: 1 }),
    rec({ entity: 'D', value: 1000, unit: '백만 리터/년', source: 1 }),
  ], src, mt, { density: null });
  assert.deepEqual(v.map((x) => [x.entity, x.amount, x.basis]), [['A', 750 * 365, '환산(일→연 ×365)'], ['B', 6000, '환산(월→연 ×12)'], ['D', 1e9, '직접']]);
});
