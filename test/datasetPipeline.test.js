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

test('isDatasetRequest: only quantitative capacity-style visualization requests', () => {
  assert.equal(dp.isDatasetRequest(rc.parseRequest('SAF Capa를 그래프로'), 'SAF Capa를 그래프로'), true);
  assert.equal(dp.isDatasetRequest(rc.parseRequest('SAF Capa 알려줘'), 'SAF Capa 알려줘'), false);
  assert.equal(dp.isDatasetRequest(rc.parseRequest('팜유 가격 그래프'), '팜유 가격 그래프'), false);
});

test('parseRecords: tolerant of fences/prose, empty on garbage', () => {
  assert.deepEqual(dp.parseRecords('```json\n[{"entity":"a"}]\n```'), [{ entity: 'a' }]);
  assert.deepEqual(dp.parseRecords('no json'), []);
});

test('verifyRecords: figures must exist in the cited material; units are converted to tons exactly', () => {
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', status: '계획', year: 2026, source: 1 }),
    rec({ entity: 'DGD', site: 'Port Arthur', value: 235, unit: 'million gallons', source: 2 }),
    rec({ entity: 'P66', site: 'Rodeo', value: 52000, unit: 'b/d', source: 3 }),
    rec({ entity: 'Neste', site: 'X', value: 999, unit: 'Mt', source: 1 }), // not in the material
    rec({ entity: 'Neste', site: 'Y', value: 1.0, unit: 'Mt', source: 9 }), // bad source index
    rec({ entity: 'Z', value: 1, unit: '달러', source: 1 }), // not a capacity unit
  ], cands, mt);
  assert.deepEqual(v.map((x) => [x.entity, Math.round(x.tons), x.basis]), [['Neste', 1200000, '직접(톤)'], ['DGD', 711657, '환산(갤런)'], ['P66', 2414059, '환산(b/d×365)']]);
});

test('buildDataset: one unit, every entity (missing ones as 미공시), latest figure per site, totals not stacked with parts', () => {
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 0.5, unit: 'Mt', year: 2023, source: 1 }),
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', status: '계획', year: 2026, source: 1 }),
    rec({ entity: 'Neste', site: '싱가포르', value: 1.0, unit: 'Mt', source: 1 }),
    rec({ entity: 'Neste', site: null, value: 6.8, unit: 'Mt', status: '목표', source: 1 }),
    rec({ entity: 'DGD', site: 'Port Arthur', value: 235, unit: 'million gallons', source: 2 }),
  ], cands, mt);
  const d = dp.buildDataset(v, [{ name: 'Chevron', names: ['chevron'], indices: [2] }]);
  assert.ok(d);
  assert.match(d.table, /\| Chevron \| - \| 미공시 \|/);
  assert.match(d.table, /\| Neste \| 로테르담 \| 계획 \(2026\) \| 1,200,000 \|/);
  assert.match(d.table, /\| Neste \| 로테르담 \| 가동 \(2023\) \| 500,000 \|/); // the table keeps every figure
  assert.deepEqual([...d.chart.labels].sort(), ['DGD Port Arthur', 'Neste 로테르담 (계획)', 'Neste 싱가포르']);
  // 로테르담 once (latest), 싱가포르, DGD; the 6.8 Mt corporate total is not a bar
  assert.ok(d.chart.labels.includes('Neste 로테르담 (계획)'));
  assert.deepEqual(d.chart.groups.filter((g) => g === 'Neste').length, 2);
  assert.equal(d.chart.combine, 'sum');
  assert.match(d.markdown, /환산 기준/);
  assert.equal(dp.buildDataset(v.slice(0, 2), []), null); // too few records: fall back to normal generation
});
