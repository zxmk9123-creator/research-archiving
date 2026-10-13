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
