const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../server/lib/feedstockSupply');

test('feedstock-supply questions are recognised and expanded; producer questions are not', () => {
  assert.ok(f.isFeedstockSupplyQuestion('UCO 주요 수거업체 알려줘'));
  assert.ok(f.isFeedstockSupplyQuestion('폐식용유 원료 공급업체 리스트'));
  assert.ok(!f.isFeedstockSupplyQuestion('글로벌 SAF 생산업체 Top10'));
  assert.ok(!f.isFeedstockSupplyQuestion('수거 일정 알려줘'));
  assert.match(f.retrievalHint('UCO 수거업체'), /feedstock supplier/);
  assert.equal(f.retrievalHint('SAF 생산업체'), 'SAF 생산업체');
});
