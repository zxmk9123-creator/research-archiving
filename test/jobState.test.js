const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { mutateJobState } = require('../server/lib/jobState');

// a tiny in-memory scheduler_jobs that honours the compare-and-swap UPDATE and the ON CONFLICT DO NOTHING INSERT
function fakePool(initial, interfere) {
  const rows = new Map(initial === undefined ? [] : [['j', initial]]);
  let updates = 0;
  const orig = pool.query;
  pool.query = async (text, params) => {
    if (/^SELECT/.test(text)) return { rows: rows.has(params[0]) ? [{ last_totals: JSON.parse(JSON.stringify(rows.get(params[0]))) }] : [] };
    if (/^INSERT/.test(text)) { if (rows.has(params[0])) return { rows: [] }; rows.set(params[0], JSON.parse(params[1])); return { rows: [{}] }; }
    updates++;
    if (interfere && updates === 1) interfere(rows);
    const cur = rows.get(params[0]);
    if (JSON.stringify(cur) !== params[2]) return { rows: [] };
    rows.set(params[0], JSON.parse(params[1]));
    return { rows: [{}] };
  };
  return { rows, restore: () => { pool.query = orig; } };
}

test('mutateJobState: creates a missing row, and a concurrent writer between read and write is merged, not overwritten', async () => {
  const f = fakePool(undefined);
  try {
    assert.equal(await mutateJobState('j', (d) => ({ ...d, a: 1 })), true);
    assert.deepEqual(f.rows.get('j'), { a: 1 });
  } finally { f.restore(); }
  const g = fakePool({ n: 1 }, (rows) => rows.set('j', { n: 5 })); // another instance writes after our read
  try {
    assert.equal(await mutateJobState('j', (d) => ({ n: d.n + 1 })), true);
    assert.equal(g.rows.get('j').n, 6, 'the other writer\'s 5 was kept and our +1 applied on top');
  } finally { g.restore(); }
});

test('mutateJobState: gives up (false) instead of throwing on a database error', async () => {
  const orig = pool.query;
  pool.query = async () => { throw new Error('db down'); };
  try { assert.equal(await mutateJobState('j', (d) => d), false); } finally { pool.query = orig; }
});
