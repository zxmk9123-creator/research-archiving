const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const itemFacts = require('../server/lib/itemFacts');
const dp = require('../server/lib/datasetPipeline');

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params) || { rows: [], rowCount: 0 }; };
  return { calls, restore: () => { pool.query = original; } };
}
function mockProvider(fn) {
  const original = provider.callProviderWithFallback;
  provider.callProviderWithFallback = fn;
  return () => { provider.callProviderWithFallback = original; };
}
const item = (o = {}) => ({ id: 5, title: 'Neste Rotterdam', summary: null, ai_summary: 'Neste 로테르담 정제소는 연 120만 톤 SAF를, 싱가포르는 100만 톤을 생산한다.', insight: null, ai_insight: null, ...o });

test('extractFactsForItem: an item with no quantity is marked "none" with NO AI call', async () => {
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  let aiCalls = 0;
  const restoreProvider = mockProvider(async () => { aiCalls++; return { text: '[]' }; });
  try {
    const r = await itemFacts.extractFactsForItem(item({ ai_summary: 'Neste가 ASAFA에 가입했다.', title: 'Neste joins ASAFA' }));
    assert.equal(r.status, 'none');
    assert.equal(aiCalls, 0);
    assert.ok(calls.some((c) => c.text.includes('UPDATE items SET facts_status') && c.params[0] === 'none'));
  } finally { restore(); restoreProvider(); }
});

test('extractFactsForItem: figures are verified against the item text, stored, and the item is marked done', async () => {
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  const restoreProvider = mockProvider(async () => ({ text: JSON.stringify([
    { entity: 'Neste', site: '로테르담', metric: '생산능력', value: 120, unit: '만 톤', period: '연간', status: '계획', year: 2026, source: 1 },
    { entity: 'Neste', site: '싱가포르', metric: '생산능력', value: 100, unit: '만 톤', period: '연간', status: '가동', year: null, source: 1 },
    { entity: 'Neste', site: '포르보', metric: '생산능력', value: 55, unit: '만 톤', status: '가동', source: 1 }, // not in the text: dropped
  ]) }));
  try {
    const r = await itemFacts.extractFactsForItem(item());
    assert.deepEqual([r.status, r.facts], ['done', 2]);
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO item_facts'));
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts.map((c) => [c.params[1], c.params[2], c.params[6], c.params[7]]), [['Neste', '로테르담', 'mass', 1200000], ['Neste', '싱가포르', 'mass', 1000000]]);
    assert.ok(calls.some((c) => c.text.includes('UPDATE items SET facts_status') && c.params[0] === 'done'));
  } finally { restore(); restoreProvider(); }
});

test('extractFactsForItem: a provider failure never throws and leaves the item unprocessed (retried by the backfill)', async () => {
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  const restoreProvider = mockProvider(async () => { throw new Error('router down'); });
  try {
    const r = await itemFacts.extractFactsForItem(item());
    assert.equal(r.status, 'error');
    assert.ok(!calls.some((c) => c.text.includes('UPDATE items SET facts_status')));
  } finally { restore(); restoreProvider(); }
});

test('loadFactRecords: stored facts come back as dataset records keyed by candidate position', async () => {
  const { restore } = mockPool((text) => {
    if (text.includes('FROM item_facts')) return { rows: [{ item_id: 20, entity: 'Neste', site: '싱가포르', metric: '생산능력', status: '가동', year: null, grp: 'mass', amount: 1000000, basis: '직접', original: '100 만 톤' }] };
    if (text.includes('facts_status FROM items')) return { rows: [{ id: 10, facts_status: 'none' }, { id: 20, facts_status: 'done' }] };
    return { rows: [] };
  });
  try {
    const { records, statusById } = await itemFacts.loadFactRecords([{ id: 10 }, { id: 20 }]);
    assert.equal(records.length, 1);
    assert.equal(records[0].source, 2);
    assert.equal(records[0].amount, 1000000);
    assert.equal(statusById.get(10), 'none');
  } finally { restore(); }
});

test('recordsForQuestion: only the kind of quantity the question asks about; tons only with a known density', () => {
  const recs = [
    { entity: 'A', metric: '생산능력', group: 'mass', amount: 100 },
    { entity: 'B', metric: '투자액', group: 'usd', amount: 5e8 },
    { entity: 'C', metric: '판매량', group: 'mass', amount: 50 },
    { entity: 'D', metric: null, group: 'volume', amount: 1e6 },
  ];
  assert.deepEqual(dp.recordsForQuestion(recs, 'SAF 생산능력을 그래프로').map((r) => r.entity), ['A', 'D']);
  assert.deepEqual(dp.recordsForQuestion(recs, '투자액 비교 차트').map((r) => r.entity), ['B']);
  assert.deepEqual(dp.recordsForQuestion(recs, '판매량 표로').map((r) => r.entity), ['C', 'D']);
  const withDensity = dp.recordsForQuestion(recs, '생산능력 그래프', 0.8);
  assert.equal(withDensity.find((r) => r.entity === 'D').tons, (1e6 * 0.8) / 1000);
  assert.equal(dp.recordsForQuestion(recs, '생산능력 그래프', null).find((r) => r.entity === 'D').tons, null);
});

test('hasQuantity: only unit-bearing quantities count (years, percentages and bare numbers do not)', () => {
  assert.equal(itemFacts.hasQuantity('2026년에 50% 확대'), false);
  assert.equal(itemFacts.hasQuantity('연 120만 톤'), true);
  assert.equal(itemFacts.hasQuantity('투자 $850 million'), true);
});

test('loadFactsByTopic: the whole archive\'s stored facts for a topic, numbered after the chat candidates', async () => {
  const { calls, restore } = mockPool((text) => {
    if (text.includes('FROM items i LEFT JOIN sources')) return { rows: [{ id: 70, title: 'Chevron Geismar', summary: 's' }, { id: 71, title: 'Total Grandpuits', summary: 's' }] };
    if (text.includes('FROM item_facts WHERE item_id = ANY')) return { rows: [
      { item_id: 70, entity: 'Chevron', site: 'Geismar', metric: '생산능력', status: '가동', year: null, grp: 'volume', amount: 1.28e9, basis: '환산(갤런→리터)', original: '340 million gallons' },
      { item_id: 71, entity: 'TotalEnergies', site: 'Grandpuits', metric: '생산능력', status: '계획', year: 2026, grp: 'mass', amount: 230000, basis: '직접', original: '230 kt' },
    ] };
    return { rows: [] };
  });
  try {
    const r = await itemFacts.loadFactsByTopic(['saf'], { excludeIds: [1, 2], baseIndex: 12 });
    assert.deepEqual(r.records.map((x) => [x.entity, x.source]), [['Chevron', 13], ['TotalEnergies', 14]]);
    assert.deepEqual(r.items.map((i) => i.id), [70, 71]);
    assert.deepEqual(calls[0].params[0], ['%saf%']);
    assert.deepEqual(calls[0].params[1], [1, 2]);
    assert.deepEqual((await itemFacts.loadFactsByTopic([], {})).records, []);
  } finally { restore(); }
});
