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

test('buildDataset: current and future figures are separated per site; a company-wide total is its own row, never a site; recency is shown', () => {
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 0.5, unit: 'Mt', year: 2023, source: 1 }),
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', status: '계획', year: 2026, source: 1 }),
    rec({ entity: 'Neste', site: '싱가포르', value: 1.0, unit: 'Mt', year: 2025, source: 1 }),
    rec({ entity: 'Neste', site: null, scope: 'total', value: 6.8, unit: 'Mt', status: '목표', year: 2027, source: 1 }),
    rec({ entity: 'DGD', site: 'Port Arthur', value: 235, unit: 'million gallons', source: 2 }),
  ], cands, mt, { density: 0.8 });
  const d = dp.buildDataset(v, [{ name: 'Chevron', names: ['chevron'], indices: [2] }], { unitTons: true, density: 0.8, nowYear: 2026 });
  assert.ok(d);
  assert.match(d.table, /수치 \(톤\)/);
  assert.match(d.table, /\| Chevron \| - \| 미공시 \|/);
  assert.match(d.table, /\| Neste \| 로테르담 \| 현재 \| 2023년 \| 500,000 \|/);
  assert.match(d.table, /\| Neste \| 로테르담 \| 계획 \| 2026년 \| 1,200,000 \|/);
  assert.match(d.table, /\| Neste \| 전사 합계 \| 목표 \| 2027년 \| 6,800,000 \|/);
  assert.ok(!/가동(?!률)/.test(d.markdown));
  // two charts: what is true now, and what is planned/targeted — never mixed in one bar
  assert.equal(d.charts.length, 2);
  assert.match(d.charts[0].title, /^현재 /);
  assert.match(d.charts[1].title, /^계획·목표 /);
  assert.deepEqual([...d.charts[0].labels].sort(), ['DGD Port Arthur', 'Neste 로테르담', 'Neste 싱가포르']);
  assert.deepEqual(d.charts[0].series[0].data.slice().sort((a, b) => b - a), [1000000, 711657, 500000]);
  // future chart: the site's furthest-year plan; the 6.8 Mt company total is NOT stacked with the site
  assert.deepEqual(d.charts[1].labels, ['Neste 로테르담 (2026)']);
  assert.deepEqual(d.charts[1].series[0].data, [1200000]);
  assert.match(d.markdown, /밀도 0\.8/);
  assert.equal(dp.buildDataset(v.slice(0, 2), []), null); // too few records: fall back to normal generation
});

test('a plan whose target year has already passed is flagged (기준 경과) and kept out of the future chart', () => {
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 0.5, unit: 'Mt', status: '계획', year: 2023, source: 1 }),
    rec({ entity: 'Neste', site: '싱가포르', value: 1.0, unit: 'Mt', source: 1 }),
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', status: '목표', year: 2027, source: 1 }),
  ], cands, mt, { density: 0.8 });
  const d = dp.buildDataset(v, [], { nowYear: 2026 });
  assert.match(d.table, /\| 계획 · 기준 경과 \| 2023년 \|/);
  assert.deepEqual(d.charts[1].labels, ['Neste 로테르담 (2027)']);
});

test('scope guard: a company-wide total is never attributed to a site, and a site absent from the material is dropped', () => {
  const src = [{ title: 'Neste', summary: 'Neste 로테르담 정제소는 연 50만 톤 SAF를 생산하며, 글로벌 재생 연료 생산 능력을 680만 톤까지 확대한다.' }];
  const v = dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 50, unit: '만 톤', source: 1 }),
    rec({ entity: 'Neste', site: '로테르담', value: 680, unit: '만 톤', status: '목표', year: 2027, source: 1 }), // mislabelled total
    rec({ entity: 'Neste', site: '포르보', value: 55, unit: '만 톤', source: 1 }), // not in the text at all -> dropped (figure absent)
    rec({ entity: 'Neste', site: 'Ulsan', value: 50, unit: '만 톤', source: 1 }), // a Latin site that is not in the material
  ], src, mt, { density: null });
  const bySite = Object.fromEntries(v.map((x) => [`${x.site}|${Math.round(x.amount)}`, x]));
  assert.ok(bySite['로테르담|500000']);
  assert.equal(bySite['null|6800000'].site, null); // demoted to the entity total
  assert.equal(v.find((x) => x.amount === 500000 && x.site === null) !== undefined, true); // the Ulsan-labelled 50 만 톤 lost its site
  // the same guard on a STORED record
  const stored = dp.guardStoredRecord({ entity: 'Neste', site: '로테르담', original: '680 만 톤', amount: 6800000 }, src[0].title + ' ' + src[0].summary);
  assert.equal(stored.site, null);
  const ok = dp.guardStoredRecord({ entity: 'Neste', site: '로테르담', original: '50 만 톤', amount: 500000 }, src[0].title + ' ' + src[0].summary);
  assert.equal(ok.site, '로테르담');
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

test('institutions (IATA) are not charted as companies; type/country carried through', () => {
  const dp = require('../server/lib/datasetPipeline');
  const recs = [
    { entity: 'IATA', etype: '기관', status: '목표', group: 'mass', amount: 1e6, original: '100만 톤', basis: '직접', source: 1 },
    { entity: 'Neste', etype: '기업', country: '핀란드', status: '가동', group: 'mass', amount: 1e6, original: '100만 톤', basis: '직접', source: 1 },
    { entity: 'ICAO', status: '목표', group: 'mass', amount: 1e6, original: '100만 톤', basis: '직접', source: 1 },
  ];
  const out = dp.recordsForQuestion(recs, 'SAF 생산능력 표로 정리', null);
  assert.deepEqual(out.map((r) => r.entity), ['Neste']);
});

test('canonicalizeEntities merges Hangul/Latin roster aliases and suffix variants', () => {
  const dp = require('../server/lib/datasetPipeline');
  const roster = [{ name: 'EcoCeres', rawNames: ['EcoCeres', '에코세레스'] }];
  const out = dp.canonicalizeEntities([{ entity: '에코세레스' }, { entity: 'ecoceres' }, { entity: 'Neste Oyj' }, { entity: 'NESTE' }], roster);
  assert.deepEqual(out.map((r) => r.entity), ['EcoCeres', 'EcoCeres', 'Neste Oyj', 'Neste Oyj']);
});

test('buildDataset: the same figure stated twice is one row; entities list names those with values', () => {
  const dp2 = require('../server/lib/datasetPipeline');
  const r = (entity, amount, extra = {}) => ({ entity, site: null, status: '가동', year: 2025, source: 1, group: 'mass', amount, basis: '직접', original: `${amount} 톤`, tons: amount, ...extra });
  const ds = dp2.buildDataset([r('KLK', 1362787), r('KLK', 1362787, { original: 'dup' }), r('IOI', 660294), r('SD Guthrie', 2224833)], [], {});
  assert.equal(ds.table.split('\n').filter((l) => /^\| KLK /.test(l)).length, 1);
  assert.deepEqual(ds.entities.sort(), ['IOI', 'KLK', 'SD Guthrie']);
});

test('ranking: Top-N companies, one row each (stated total, else site sum, else plan), countries/institutions excluded', () => {
  const dp2 = require('../server/lib/datasetPipeline');
  const rc = require('../server/lib/requestCompliance');
  const q = '글로벌 SAF 플랜트 Capacity 기준 Top3 기업의 생산능력만 도표로 제작해줘';
  const req = rc.parseRequest(q);
  assert.equal(req.topN, 3);
  assert.equal(req.tableOnly, true);
  const r = (entity, amount, extra = {}) => ({ entity, site: null, status: '가동', year: 2025, source: 1, group: 'mass', amount, basis: '직접', original: `${amount} 톤`, tons: amount, metric: '생산능력', etype: '기업', ...extra });
  const recs = [
    r('Neste', 1000000, { site: 'Rotterdam' }), r('Neste', 1000000, { site: 'Singapore' }),
    r('Neste', 6800000, { status: '목표', year: 2027 }),
    r('Eni', 3000000), r('World Energy', 300000),
    r('미국', 9e9, { etype: '국가' }), r('IATA', 9e9, { etype: '기관' }),
    r('Repsol', 500000, { status: '계획', year: 2028 }),
  ];
  const fit = dp2.recordsForQuestion(recs, q, null);
  assert.ok(!fit.some((x) => x.entity === '미국' || x.entity === 'IATA'));
  const ds = dp2.buildDataset(fit, [], { topN: req.topN, only: true });
  const rows = ds.table.split('\n').slice(2);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| 1 \| Eni /);
  assert.match(rows[1], /^\| 2 \| Neste .*거점 합산 2곳/);
  assert.match(rows[1], /2,000,000/);
  assert.equal(ds.only, true);
});

test('canonicalizeEntities: S.p.A. suffix and generic qualifiers map to the roster company', () => {
  const dp2 = require('../server/lib/datasetPipeline');
  const roster = [
    { name: 'Eni S.p.A.', rawNames: ['Eni S.p.A.', 'Enilive'] },
    { name: 'Phillips 66', rawNames: ['Phillips 66'] },
    { name: 'Infinium', rawNames: ['Infinium'] },
  ];
  const out = dp2.canonicalizeEntities([{ entity: 'Eni' }, { entity: 'Eni S.p.A' }, { entity: 'Phillips 66 Aviation' }, { entity: 'Infinium Energy' }, { entity: 'Phillips 667' }], roster).map((r) => r.entity);
  assert.deepEqual(out, ['Eni S.p.A.', 'Eni S.p.A.', 'Phillips 66', 'Infinium', 'Phillips 667']);
});

test('mergeJointVentures: the same facility under a venture and its owner counts once; unrelated equal figures stay', () => {
  const dp2 = require('../server/lib/datasetPipeline');
  const base = { status: '가동', year: 2025, group: 'volume', amount: 4.5e9, original: '12억 갤런', basis: '직접', metric: '생산능력' };
  const texts = {
    1: 'Diamond Green Diesel, a joint venture of Valero and Darling, runs Port Arthur at 1.2 billion gallons',
    2: 'Valero Energy renewable diesel via Diamond Green Diesel: 1.2 billion gallons',
    3: 'Eni plans a plant with 1.2 billion gallons capacity',
  };
  const recs = [
    { ...base, entity: 'Diamond Green Diesel', site: 'Port Arthur', source: 1 },
    { ...base, entity: 'Valero Energy', site: null, source: 2 },
    { ...base, entity: 'Eni S.p.A.', site: null, source: 3 },
  ];
  const out = dp2.mergeJointVentures(recs, (r) => texts[r.source]);
  assert.deepEqual(out.records.map((r) => r.entity).sort(), ['Diamond Green Diesel', 'Eni S.p.A.']);
  assert.deepEqual(out.records.find((r) => r.entity === 'Diamond Green Diesel').partners, ['Valero Energy']);
  assert.equal(out.dropped, 1);
  // different sites are different facilities even with the same figure
  const two = dp2.mergeJointVentures([
    { ...base, entity: 'A Co', site: 'X', source: 1 }, { ...base, entity: 'B Co', site: 'Y', source: 1 },
  ], () => 'A Co and B Co both operate plants');
  assert.equal(two.records.length, 2);
  // the table says so
  const ds = dp2.buildDataset([out.records.find((r) => r.entity === 'Diamond Green Diesel'), { ...base, entity: 'Neste', site: null, source: 3, amount: 1.5e6, group: 'mass', original: '150만 톤', tons: 1.5e6 }, { ...base, entity: 'Chevron', site: null, source: 3, amount: 1e6, group: 'mass', original: '100만 톤', tons: 1e6 }], [], { topN: 3, only: true });
  assert.ok(ds, 'dataset built');
});

test('mergeJointVentures: the venture (parent recorded) stays, its owner is the dropped partner', () => {
  const dp2 = require('../server/lib/datasetPipeline');
  const base = { status: '가동', year: 2025, group: 'volume', amount: 4.5e9, original: '12억 갤런', basis: '직접', site: null };
  const texts = { 1: 'Valero Energy said Valero renewable diesel from Diamond Green Diesel, a Valero and Darling joint venture, is 1.2 billion gallons. Valero Valero', 2: 'Diamond Green Diesel 합작 법인은 12억 갤런 생산능력' };
  const out = dp2.mergeJointVentures([
    { ...base, entity: 'Valero Energy', source: 1 },
    { ...base, entity: 'Diamond Green Diesel', source: 2, parent: 'Valero' },
  ], (r) => texts[r.source]);
  assert.deepEqual(out.records.map((r) => r.entity), ['Diamond Green Diesel']);
  assert.deepEqual(out.records[0].partners, ['Valero Energy']);
});
