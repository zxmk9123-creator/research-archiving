const test = require('node:test');
const assert = require('node:assert/strict');
const { expandConcepts, filterForms } = require('../server/lib/termGroups');

const ALL = ['유채씨유', '카놀라유', '채종유', 'rapeseed oil', 'canola oil'];

test('filterForms: any member of the 유채씨유 group expands to all five spellings; other queries are untouched', () => {
  for (const q of ['카놀라유', '유채씨유', '채종유', 'Rapeseed Oil', 'canola oil', '카놀라']) {
    assert.deepEqual([...filterForms(q)].sort(), [...ALL].sort(), q);
  }
  assert.deepEqual(filterForms('팜유'), ['팜유']);
});

test('expandConcepts: a Korean member becomes one concept carrying every spelling', () => {
  const out = expandConcepts([['카놀라유'], ['가격']], '카놀라유 가격');
  assert.deepEqual([...out[0]].sort(), [...ALL].sort());
  assert.deepEqual(out[1], ['가격']);
});

test('expandConcepts: the phrase "canola oil" (two tokens) adds the group as one concept', () => {
  const out = expandConcepts([['canola'], ['oil']], 'canola oil outlook');
  assert.ok(out.some((forms) => ALL.every((f) => forms.includes(f))));
});

test('expandConcepts: unrelated questions are unchanged', () => {
  assert.deepEqual(expandConcepts([['팜유'], ['수출']], '팜유 수출'), [['팜유'], ['수출']]);
});

test('expandConcepts: "비주류 식용유" adds the minor oils as one concept; "비주류 기업" does not', () => {
  const { MINOR_OILS } = require('../server/lib/termGroups');
  const out = expandConcepts([['비주류'], ['식용유']], '비주류 식용유');
  assert.ok(out.some((forms) => MINOR_OILS.every((o) => forms.includes(o))));
  assert.equal(expandConcepts([['비주류'], ['기업']], '비주류 기업').length, 2);
});
