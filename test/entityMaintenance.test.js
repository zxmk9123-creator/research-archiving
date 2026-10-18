const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const em = require('../server/lib/entityMaintenance');

test('maybeRunEntityMaintenance: not before 09:00 KST, off switch, and a run within the last 3 days is not repeated', async () => {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push(String(text));
    if (/INSERT INTO scheduler_jobs/.test(text)) return { rowCount: 0, rows: [] };
    return { rows: [], rowCount: 0 };
  };
  try {
    // 2026-10-19 00:00 UTC = 09:00 KST: due. 2026-10-18 23:59 UTC = 08:59 KST: not due yet
    assert.deepEqual(await em.maybeRunEntityMaintenance(new Date('2026-10-18T23:59:00Z')), { ran: false, reason: 'not_due' });
    assert.deepEqual(await em.maybeRunEntityMaintenance(new Date('2026-10-19T00:00:00Z')), { ran: false, reason: 'ran_within_last_3_days' });
    process.env.ENTITY_MAINTENANCE = 'off';
    assert.deepEqual(await em.maybeRunEntityMaintenance(new Date('2026-10-19T00:00:00Z')), { ran: false, reason: 'off' });
  } finally {
    delete process.env.ENTITY_MAINTENANCE;
    pool.query = original;
  }
  assert.ok(calls.some((c) => /INSERT INTO scheduler_jobs/.test(c)));
});

test('maybeRunEntityMaintenance: the claim query compares the last run with a 3-day interval', async () => {
  const original = pool.query;
  let claim = null;
  pool.query = async (text, params) => {
    if (/INSERT INTO scheduler_jobs/.test(text)) { claim = { text: String(text), params }; return { rowCount: 0, rows: [] }; }
    return { rows: [], rowCount: 0 };
  };
  try {
    await em.maybeRunEntityMaintenance(new Date('2026-10-19T00:30:00Z')); // 09:30 KST on 2026-10-19
  } finally { pool.query = original; }
  assert.equal(claim.params[1], '2026-10-19');
  assert.equal(claim.params[2], 3);
  assert.match(claim.text, /last_run_date IS NULL OR scheduler_jobs\.last_run_date <= \(\$2::date - \$3::int\)/);
  assert.equal(em.RUN_HOUR_KST, 9);
  assert.equal(em.INTERVAL_DAYS, 3);
});
