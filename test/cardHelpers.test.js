const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeImportantIds } = require('../public/cardHelpers');

test('normalizeImportantIds: returns the Set unchanged when already a Set', () => {
  const s = new Set([1, 2]);
  assert.equal(normalizeImportantIds(s), s);
});

// Regression for the production crash: itemCard(item, importantIds) was
// used directly as an Array.map() callback (related.map(itemCard)), so
// Array.map passed the numeric index as importantIds. index 1 reproduces
// the original "importantIds.has is not a function" TypeError.
test('normalizeImportantIds: a Number (e.g. an Array.map index) normalizes to an empty Set instead of throwing', () => {
  const normalized = normalizeImportantIds(1);
  assert.ok(normalized instanceof Set);
  assert.doesNotThrow(() => normalized.has(42));
  assert.equal(normalized.has(42), false);
});

test('normalizeImportantIds: undefined/null/array all normalize to an empty Set', () => {
  for (const value of [undefined, null, [1, 2, 3], 'x', {}]) {
    const normalized = normalizeImportantIds(value);
    assert.ok(normalized instanceof Set);
    assert.doesNotThrow(() => normalized.has(1));
  }
});
