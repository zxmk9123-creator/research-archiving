const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { hasGroundedClassification } = require('../server/lib/classificationSanity');

function mockPool(handlers) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('hasGroundedClassification: passes when no sectors were suggested (hasValidClassification already covers this)', async () => {
  assert.equal(await hasGroundedClassification({ ai_suggested_sectors: [], title: 't', ai_summary: 's' }), true);
});

test('hasGroundedClassification: passes when the suggested sector name appears in the title/summary', async () => {
  const { restore } = mockPool([
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }] })],
  ]);
  try {
    const item = { ai_suggested_sectors: [3], title: 'Indonesia raises palm oil export tariff', ai_summary: '인도네시아가 팜유 수출세를 인상했다.' };
    assert.equal(await hasGroundedClassification(item), true);
  } finally {
    restore();
  }
});

test('hasGroundedClassification: fails when the only suggested sector has zero textual support', async () => {
  const { restore } = mockPool([
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }] })],
  ]);
  try {
    // An article entirely about soybean oil, mistakenly tagged with only 팜유.
    const item = { ai_suggested_sectors: [3], title: 'ADM expands soybean oil crushing capacity', ai_summary: '대두유 압착 시설을 확장한다.' };
    assert.equal(await hasGroundedClassification(item), false);
  } finally {
    restore();
  }
});

test('hasGroundedClassification: passes if ANY of several suggested sectors is grounded, even if others are not', async () => {
  const { restore } = mockPool([
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }, { id: 4, name: '대두유' }] })],
  ]);
  try {
    const item = { ai_suggested_sectors: [3, 4], title: 'Indonesia raises palm oil export tariff', ai_summary: '인도네시아가 팜유 수출세를 인상했다.' };
    assert.equal(await hasGroundedClassification(item), true);
  } finally {
    restore();
  }
});

test('hasGroundedClassification: a catch-all bucket (e.g. 물류) always passes — there is no specific commodity to ground it against', async () => {
  const { restore } = mockPool([
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 12, name: '물류' }] })],
  ]);
  try {
    const item = { ai_suggested_sectors: [12], title: 'Completely unrelated text', ai_summary: 'nothing to do with any commodity' };
    assert.equal(await hasGroundedClassification(item), true);
  } finally {
    restore();
  }
});

test('hasGroundedClassification: an unmapped/unknown sector name is never penalized', async () => {
  const { restore } = mockPool([
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 99, name: '새로운섹터' }] })],
  ]);
  try {
    const item = { ai_suggested_sectors: [99], title: 'anything', ai_summary: 'anything' };
    assert.equal(await hasGroundedClassification(item), true);
  } finally {
    restore();
  }
});

test('umbrella oils/fats tags need an oils/fats/biofuel term in the item text; crude-oil and shipping news do not qualify', () => {
  const { pruneUngroundedParents, OIL_FAT_TERMS } = require('../server/lib/classificationSanity');
  assert.ok(!OIL_FAT_TERMS.test('Record tanker freight rates signal strain in global oil markets'));
  assert.ok(!OIL_FAT_TERMS.test('OPEC+ agrees to keep November oil output targets steady'));
  assert.ok(OIL_FAT_TERMS.test('Malaysia palm oil exports rise'));
  assert.ok(OIL_FAT_TERMS.test('SAF 혼합의무 확정 요구'));
  const rows = [{ id: 1, name: '식용유지' }, { id: 2, name: '비식용유지' }, { id: 2548, name: '운임료' }];
  // ungrounded: the umbrellas go, the real tag stays
  assert.deepEqual(pruneUngroundedParents(rows, '유조선 운임이 사상 최고치'), [2548]);
  // grounded: nothing is dropped
  assert.deepEqual(pruneUngroundedParents(rows, '팜유 수출 운임이 올랐다'), [1, 2, 2548]);
  // only umbrellas suggested and nothing grounded: kept as is (the grounding gate holds the item instead)
  assert.deepEqual(pruneUngroundedParents([{ id: 1, name: '식용유지' }], '유조선 운임'), [1]);
});

test('hasGroundedClassification: only umbrella tags + no oils/fats term fails the gate; with a real tag it passes', async () => {
  const pool = require('../server/db/pool');
  const original = pool.query;
  const { hasGroundedClassification } = require('../server/lib/classificationSanity');
  try {
    pool.query = async () => ({ rows: [{ id: 1, name: '식용유지' }, { id: 2, name: '비식용유지' }] });
    assert.equal(await hasGroundedClassification({ title: 'Tanker rates hit record', ai_summary: '유조선 운임 급등', ai_suggested_sectors: [1, 2] }), false);
    assert.equal(await hasGroundedClassification({ title: 'Palm oil exports', ai_summary: '팜유 수출', ai_suggested_sectors: [1, 2] }), true);
    pool.query = async () => ({ rows: [{ id: 1, name: '식용유지' }, { id: 2548, name: '운임료' }] });
    assert.equal(await hasGroundedClassification({ title: 'Tanker rates hit record', ai_summary: '유조선 운임 급등', ai_suggested_sectors: [1, 2548] }), true);
  } finally { pool.query = original; }
});
