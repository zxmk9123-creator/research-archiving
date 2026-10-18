const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const em = require('../server/lib/entityMaintenance');

test('maybeRunEntityMaintenance: not before 03:00 KST, off switch, and a day already claimed is not run again', async () => {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push(String(text));
    if (/INSERT INTO scheduler_jobs/.test(text)) return { rowCount: 0, rows: [] };
    return { rows: [], rowCount: 0 };
  };
  try {
    // 2026-10-18 17:00 UTC = 02:00 KST next day -> not due
    assert.deepEqual(await em.maybeRunEntityMaintenance(new Date('2026-10-18T17:00:00Z')), { ran: false, reason: 'not_due' });
    // 2026-10-18 19:00 UTC = 04:00 KST: due, but the claim row already exists
    assert.deepEqual(await em.maybeRunEntityMaintenance(new Date('2026-10-18T19:00:00Z')), { ran: false, reason: 'already_ran_today' });
    process.env.ENTITY_MAINTENANCE = 'off';
    assert.deepEqual(await em.maybeRunEntityMaintenance(new Date('2026-10-18T19:00:00Z')), { ran: false, reason: 'off' });
  } finally {
    delete process.env.ENTITY_MAINTENANCE;
    pool.query = original;
  }
  assert.ok(calls.some((c) => /INSERT INTO scheduler_jobs/.test(c)));
});
