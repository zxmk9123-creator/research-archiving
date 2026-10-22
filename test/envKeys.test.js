const test = require('node:test');
const assert = require('node:assert/strict');
const { collectKeys } = require('../server/lib/adapters/envKeys');

test('collectKeys: plain, plural list, _N and N suffixes are merged in order without duplicates', () => {
  const env = { BRAVE_SEARCH_API_KEY: 'a', BRAVE_SEARCH_API_KEYS: 'b, c', BRAVE_SEARCH_API_KEY_3: 'e', BRAVE_SEARCH_API_KEY2: 'd', BRAVE_SEARCH_API_KEY4: 'a', OTHER: 'z' };
  assert.deepEqual(collectKeys('BRAVE_SEARCH_API_KEY', env), ['a', 'd', 'e', 'b', 'c']);
  assert.deepEqual(collectKeys('SERPAPI_API_KEY', { SERPAPI_API_KEY1: ' x ', SERPAPI_API_KEY2: '' }), ['x']);
  assert.deepEqual(collectKeys('TAVILY_API_KEY', {}), []);
});
