const test = require('node:test');
const assert = require('node:assert/strict');
const { hasValidClassification } = require('../server/lib/classification');
const pool = require('../server/db/pool');

function mockPool(handler) {
  const original = pool.query;
  pool.query = handler;
  return () => { pool.query = original; };
}

test('hasValidClassification: true only when both a sector and a usage row exist', async () => {
  const restore = mockPool(async () => ({ rows: [{ has_sector: true, has_usage: true }] }));
  try {
    assert.equal(await hasValidClassification(1), true);
  } finally {
    restore();
  }
});

test('hasValidClassification: false when a sector exists but no usage does', async () => {
  const restore = mockPool(async () => ({ rows: [{ has_sector: true, has_usage: false }] }));
  try {
    assert.equal(await hasValidClassification(1), false);
  } finally {
    restore();
  }
});

test('hasValidClassification: false when a usage exists but no sector does', async () => {
  const restore = mockPool(async () => ({ rows: [{ has_sector: false, has_usage: true }] }));
  try {
    assert.equal(await hasValidClassification(1), false);
  } finally {
    restore();
  }
});

test('hasValidClassification: false when neither exists', async () => {
  const restore = mockPool(async () => ({ rows: [{ has_sector: false, has_usage: false }] }));
  try {
    assert.equal(await hasValidClassification(1), false);
  } finally {
    restore();
  }
});

test('hasValidClassification: queries by the given item id', async () => {
  let capturedParams;
  const restore = mockPool(async (text, params) => {
    capturedParams = params;
    return { rows: [{ has_sector: false, has_usage: false }] };
  });
  try {
    await hasValidClassification(99);
    assert.deepEqual(capturedParams, [99]);
  } finally {
    restore();
  }
});
