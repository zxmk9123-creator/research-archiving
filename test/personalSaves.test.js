const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSavedIds, serializeSavedIds, toggleSavedId } = require('../public/personalSaves');

test('parseSavedIds: parses a JSON array of ids into a Set of numbers', () => {
  assert.deepEqual(parseSavedIds('[1,2,3]'), new Set([1, 2, 3]));
});

test('parseSavedIds: missing/invalid/non-array JSON all fall back to an empty Set', () => {
  assert.deepEqual(parseSavedIds(null), new Set());
  assert.deepEqual(parseSavedIds(undefined), new Set());
  assert.deepEqual(parseSavedIds('not json'), new Set());
  assert.deepEqual(parseSavedIds('{"a":1}'), new Set());
});

test('serializeSavedIds/parseSavedIds round-trip', () => {
  const ids = new Set([5, 9, 12]);
  assert.deepEqual(parseSavedIds(serializeSavedIds(ids)), ids);
});

test('toggleSavedId: adds an id not present, removes one that is, without mutating the input Set', () => {
  const original = new Set([1, 2]);
  const added = toggleSavedId(original, 3);
  assert.deepEqual(added, new Set([1, 2, 3]));
  assert.deepEqual(original, new Set([1, 2]));

  const removed = toggleSavedId(original, 1);
  assert.deepEqual(removed, new Set([2]));
});
