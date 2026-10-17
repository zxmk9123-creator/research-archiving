const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params) || { rows: [], rowCount: 0 }; };
  return { calls, restore: () => { pool.query = original; } };
}
const withRoutineOn = async (fn) => {
  const saved = process.env.VERIFICATION_ROUTINE;
  delete process.env.VERIFICATION_ROUTINE;
  try { return await fn(require('../server/lib/verificationRoutine')); } finally { process.env.VERIFICATION_ROUTINE = saved; }
};

test('buildQueries: dated, quantity-bearing queries; Korean entities get a Korean query; undated/old add the annual report', async () => {
  await withRoutineOn(async (vr) => {
    const q = vr.buildQueries('TotalEnergies', 'SAF', 'undated');
    assert.ok(q.every((x) => x.includes('TotalEnergies SAF')) && q.some((x) => /2026/.test(x)) && q.some((x) => /annual report/.test(x)));
    assert.ok(vr.buildQueries('SK에너지', 'SAF', 'unconfirmed').some((x) => /생산능력/.test(x)));
    assert.ok(!vr.buildQueries('Neste', '', 'unconfirmed').some((x) => /annual report/.test(x)));
  });
});

test('enqueue: one row per (entity, topic), junk names skipped, off switch honoured', async () => {
  await withRoutineOn(async (vr) => {
    const { calls, restore } = mockPool(() => ({ rows: [{ inserted: true }] }));
    try {
      const r = await vr.enqueue([{ entity: 'TotalEnergies', reason: 'undated' }, { entity: 'x', reason: 'old' }, { entity: '  Eni  S.p.A. ', reason: 'bogus' }], { topic: 'SAF' });
      assert.equal(r.queued, 2);
      const inserts = calls.filter((c) => c.text.includes('INSERT INTO verification_queue'));
      assert.equal(inserts.length, 2);
      assert.deepEqual(inserts[0].params.slice(0, 4), ['totalenergies', 'TotalEnergies', 'SAF', 'undated']);
      assert.deepEqual(inserts[1].params.slice(0, 4), ['eni s.p.a.', 'Eni S.p.A.', 'SAF', 'unconfirmed']); // unknown reason -> unconfirmed
    } finally { restore(); }
  });
  const { calls, restore } = mockPool(() => ({ rows: [{ inserted: true }] }));
  try { assert.deepEqual(await require('../server/lib/verificationRoutine').enqueue([{ entity: 'Neste', reason: 'old' }]), { queued: 0 }); assert.equal(calls.length, 0); } finally { restore(); }
});

test('runQueue: collects for pending entities, records the outcome, respects attempts and the daily limit', async () => {
  await withRoutineOn(async (vr) => {
    const collected = [];
    const { calls, restore } = mockPool((text) => {
      if (text.includes("count(*)::int AS n FROM verification_queue")) return { rows: [{ n: 0 }] };
      if (text.includes("FROM verification_queue\n        WHERE status = 'pending'") || text.includes("WHERE status = 'pending'")) return { rows: [{ id: 1, entity: 'TotalEnergies', topic: 'SAF', reason: 'undated', attempts: 0 }, { id: 2, entity: 'Eni', topic: 'SAF', reason: 'old', attempts: 2 }] };
      return { rows: [] };
    });
    try {
      const out = await vr.runQueue({ max: 3, extractPending: false, collect: async (queries) => { collected.push(queries); return collected.length === 1 ? { archived: 4, failedQueries: 0 } : { archived: 0, failedQueries: 2 }; } });
      assert.deepEqual(out.processed.map((p) => [p.entity, p.archived, p.failed]), [['TotalEnergies', 4, false], ['Eni', 0, true]]);
      const updates = calls.filter((c) => c.text.includes('UPDATE verification_queue SET status = $2'));
      assert.deepEqual(updates.map((u) => [u.params[1], u.params[2]]), [['done', 1], ['gave_up', 3]]); // 3rd failed attempt gives up
    } finally { restore(); }
    const lim = mockPool((text) => (text.includes('count(*)::int AS n') ? { rows: [{ n: 24 }] } : { rows: [] }));
    try { assert.equal((await vr.runQueue({ collect: async () => ({}) })).skipped, 'daily_limit'); } finally { lim.restore(); }
  });
});

test('datasets report uncertain entities (undated / old current figures) for the routine', () => {
  const dp = require('../server/lib/datasetPipeline');
  const Y = new Date().getFullYear();
  const r = (entity, amount, extra = {}) => ({ entity, site: null, status: '가동', year: Y, source: 1, group: 'mass', amount, basis: '직접', original: `${amount} 톤`, tons: amount, metric: '생산능력', etype: '기업', ...extra });
  const rank = dp.buildDataset([r('A', 3e6), r('B', 2e6), r('Undated Co', 5e6, { year: null })], [], { topN: 5, only: true });
  assert.deepEqual(rank.uncertain, [{ entity: 'Undated Co', reason: 'undated' }]);
  const table = dp.buildDataset([r('A', 3e6), r('B', 2e6), r('Old Co', 5e6, { year: Y - 3 })], [], {});
  assert.deepEqual(table.uncertain, [{ entity: 'Old Co', reason: 'old' }]);
});
