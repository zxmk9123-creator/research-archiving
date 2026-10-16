const test = require('node:test');
const assert = require('node:assert/strict');
const nc = require('../server/lib/numberCheck');

const mt = (m) => [m.title, m.summary].filter(Boolean).join(' ');
const cited = (l) => [...l.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
const run = (text, summary) => nc.guardAnswerNumbers(text, [{ title: 'Plant', summary }], cited, mt);

test('numberCheck: extracts scale+unit quantities, including ranges that share one unit', () => {
  const q = nc.extractQuantities('5만 ~ 12만 톤, 120만 톤, 1.2 Mt/a, 340 million gallons, 22,000 b/d, $1.5 billion');
  assert.deepEqual(q.map((x) => [x.value, x.cls]), [[50000, 'mass'], [120000, 'mass'], [1200000, 'mass'], [1200000, 'mass'], [340000000, 'gal'], [22000, 'bpd'], [1500000000, 'usd']]);
});

test('numberCheck: a lost zero (50만 -> 5만 톤) is corrected to the source wording, ranges keep one shared unit', () => {
  const r = run('| 로테르담 | 5만 ~ 12만 톤 | [1]', '로테르담 생산능력은 50만 톤에서 120만 톤으로 확대');
  assert.equal(r.text, '| 로테르담 | 50만 ~ 120만 톤 | [1]');
  assert.equal(r.fixed, 2);
  // same slip across notations: source says Mt
  assert.equal(run('로테르담 5만 톤 [1]', 'Rotterdam capacity 0.5 Mt/a').text, '로테르담 0.5 Mt [1]');
});

test('numberCheck: grounded figures, sums, differences and unit-equivalent notations are left untouched', () => {
  const src = 'Rotterdam 0.5 Mt/a to 1.2 Mt/a; Singapore 1.0 Mt/a';
  for (const line of ['50만 톤 [1]', '120만 톤 [1]', '100만 톤 [1]', '합계 220만 톤 [1]', '증설분 70만 톤 [1]', '1,200 kt [1]']) {
    const r = run(line, src);
    assert.equal(r.text, line, line);
    assert.equal(r.fixed + r.flagged, 0);
  }
});

test('numberCheck: an invented figure with no counterpart is flagged, never shown', () => {
  const r = run('로테르담 77만 톤 [1]', 'Rotterdam 0.5 Mt/a to 1.2 Mt/a');
  assert.match(r.text, /\(원문 수치 확인 필요\)/);
  assert.equal(r.flagged, 1);
});

test('numberCheck: a quantity class the sources never state (model-converted units) cannot be verified and is left alone', () => {
  const r = run('Geismar 약 100만 톤 [1]', 'Geismar 340 million gallons per year');
  assert.equal(r.text, 'Geismar 약 100만 톤 [1]');
});

test('numberCheck: chart values are checked in the chart\'s own unit; slips are fixed, inventions dropped', () => {
  const cands = [{ title: 'x', summary: 'Rotterdam 0.5 Mt/a to 1.2 Mt/a; Singapore 1.0 Mt/a' }];
  const r = nc.guardChartNumbers({ type: 'bar', unit: '만 톤', labels: ['a', 'b', 'c', 'd'], series: [{ name: 's', data: [5, 120, 100, 33] }] }, cands, mt);
  assert.deepEqual(r.chart.series[0].data, [50, 120, 100, null]);
  assert.equal(r.fixed, 1);
  assert.equal(r.dropped, 1);
  // unparseable unit: untouched
  const same = nc.guardChartNumbers({ unit: '점', series: [{ name: 's', data: [1] }] }, cands, mt);
  assert.deepEqual(same.chart.series[0].data, [1]);
});
