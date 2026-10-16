const test = require('node:test');
const assert = require('node:assert/strict');
const rc = require('../server/lib/requestCompliance');
const nc = require('../server/lib/numberCheck');
const searchRouter = require('../server/routes/search');

test('parseRequest: chart kind, unit unification, completeness and chart-wanted are read from the question', () => {
  const r = rc.parseRequest('글로벌 SAF 플랜트의 Capa를 누락없이 톤 단위로 통일해서 가로 막대그래프 시각화로 정리해줘');
  assert.deepEqual(r, { wantsChart: true, chartType: 'hbar', unitTons: true, completeness: true });
  assert.equal(rc.parseRequest('식용유지 생산량 꺾은선 그래프').chartType, 'line');
  assert.equal(rc.parseRequest('비중을 원형으로').chartType, 'pie');
  assert.deepEqual(rc.parseRequest('팜유 수출 정책 알려줘'), { wantsChart: false, chartType: null, unitTons: false, completeness: false });
});

test('applyChartCompliance: requested chart kind and ton unit are enforced on the model\'s chart', () => {
  const req = rc.parseRequest('톤 단위로 가로 막대 그래프');
  const r = rc.applyChartCompliance({ type: 'bar', unit: '만 톤', labels: ['a', 'b'], series: [{ name: 's', data: [5, 120] }] }, req);
  assert.equal(r.chart.type, 'hbar');
  assert.equal(r.chart.unit, '톤');
  assert.deepEqual(r.chart.series[0].data, [50000, 1200000]);
  // a pie request cannot be forced onto a two-series chart
  const multi = rc.applyChartCompliance({ type: 'bar', labels: ['a'], series: [{ name: 'x', data: [1] }, { name: 'y', data: [2] }] }, rc.parseRequest('원형 그래프'));
  assert.equal(multi.chart.type, 'bar');
});

test('ensureChartPresent: a requested chart that the model omitted is built from the answer\'s own table', () => {
  const text = '| 기업 | 생산능력 |\n| --- | --- |\n| Neste | 100만 톤 |\n| Eni | 40만 톤 |\n| X | 5만 톤 |\n| Y | - |';
  const r = rc.ensureChartPresent(text, rc.parseRequest('막대 그래프로 톤 단위로 통일'));
  assert.equal(r.built, true);
  const chart = JSON.parse(r.text.match(/```chart\n(.*)\n```/)[1]);
  assert.deepEqual(chart.labels, ['Neste', 'Eni', 'X']);
  assert.deepEqual(chart.series[0].data, [1000000, 400000, 50000]);
  assert.equal(chart.unit, '톤');
  assert.equal(rc.ensureChartPresent(text, rc.parseRequest('팜유 정책')).built, false);
  assert.equal(rc.ensureChartPresent('```chart\n{}\n```\n' + text, rc.parseRequest('그래프')).built, false);
});

test('composite Korean numerals ("2만 5,000톤") are one figure, and nothing is flagged for them', () => {
  const q = nc.extractQuantities('기존 2만 5,000톤에서 4만 2,000톤으로');
  assert.deepEqual(q.map((x) => x.value), [25000, 42000]);
  const mt = (m) => m.summary;
  const r = nc.guardAnswerNumbers('기존 2만 5,000톤에서 4만 2,000톤으로 [1]', [{ summary: 'capacity from 25,000 tonnes to 42,000 tonnes' }], (l) => [1], mt);
  assert.equal(r.text, '기존 2만 5,000톤에서 4만 2,000톤으로 [1]');
});

test('unit conversion to tons (stated factors) is accepted as grounded; an unrelated figure is still flagged', () => {
  const mt = (m) => m.summary;
  const cands = [{ summary: 'Freedom Pines 9 million gallons SAF per year; Geismar 22,000 b/d' }];
  const cited = () => [1];
  // 9 million gal * 0.003028 = 27,252 t ; 22,000 b/d * 365 * 0.1272 = 1,021,000 t
  assert.equal(nc.guardAnswerNumbers('프리덤 파인스 2.7만 톤 [1]', cands, cited, mt).flagged, 0);
  assert.equal(nc.guardAnswerNumbers('제게이스마 102만 톤 [1]', cands, cited, mt).flagged, 0);
  assert.equal(nc.guardAnswerNumbers('프리덤 파인스 55만 톤 [1]', cands, cited, mt).flagged, 1);
});

test('plant/facility and completeness questions are collective: company coverage runs for them', () => {
  const roster = [{ name: 'Alpha', names: ['alpha'] }];
  const cands = [{ title: 'Alpha plant', summary: 'x' }];
  assert.equal(searchRouter.requiredCompanies('글로벌 SAF 플랜트 Capa 정리', cands, roster).length, 1);
  assert.equal(searchRouter.requiredCompanies('SAF Capa를 누락없이 알려줘', cands, roster).length, 1);
  assert.equal(searchRouter.requiredCompanies('팜유 수출 정책', cands, roster).length, 0);
});
