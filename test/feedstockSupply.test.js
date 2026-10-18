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

test('feedstock chain questions (value chain / diagram of UCO) are recognised and expand retrieval', () => {
  assert.ok(f.isFeedstockChainQuestion('UCO 공급 밸류체인을 도식으로 그려줘'));
  assert.ok(f.isFeedstockChainQuestion('폐식용유 공급망 관계도'));
  assert.ok(!f.isFeedstockChainQuestion('팜유의 밸류체인을 그려줘'));
  assert.match(f.retrievalHint('UCO 밸류체인 도식'), /feedstock supplier/);
  assert.match(f.CHAIN_NOTE, /공급업체/);
});
