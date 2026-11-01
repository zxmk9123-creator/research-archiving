const test = require('node:test');
const assert = require('node:assert/strict');
const { keyFor, tradeKeysStatus, normalizeKey, APIS } = require('../server/lib/tradeApiConfig');

test('own key wins over the shared key; shared key covers the rest; nothing set = none', () => {
  const env = { DATA_GO_KR_KEY: 'shared', DATA_GO_KR_TRADE_ITEM_KEY: 'own' };
  assert.equal(keyFor('trade_item', env), 'own');
  assert.equal(keyFor('hs_search', env), 'shared');
  assert.equal(keyFor('hs_search', {}), '');
  assert.equal(keyFor('unknown_api', env), '');
});
test('an Encoding key is decoded once; a Decoding key is left alone', () => {
  assert.equal(normalizeKey('abc%2Bdef%3D%3D'), 'abc+def==');
  assert.equal(normalizeKey('abc+def=='), 'abc+def==');
  assert.equal(normalizeKey('  k  '), 'k');
});
test('status reports booleans and sources, never a key value', () => {
  const s = tradeKeysStatus({ DATA_GO_KR_HS_NAVI_KEY: 'SECRETVALUE', DATA_GO_KR_KEY: 'OTHERSECRET' });
  assert.deepEqual(Object.keys(s), Object.keys(APIS));
  assert.equal(s.hs_navigation.source, 'own');
  assert.equal(s.trade_item.source, 'shared');
  assert.ok(Object.values(s).every((x) => x.configured));
  assert.doesNotMatch(JSON.stringify(s), /SECRETVALUE|OTHERSECRET/);
  assert.equal(tradeKeysStatus({}).hs_search.configured, false);
});
