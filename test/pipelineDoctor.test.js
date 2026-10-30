const test = require('node:test');
const assert = require('node:assert/strict');
const { runDoctor, diagnose, planRecovery, judgeOutcome, scrub, errorKind, MAX_ROUNDS_PER_DAY } = require('../server/lib/pipelineDoctor');
const { evaluateHealth } = require('../server/lib/pipelineHealth');

const NOW = new Date('2026-10-30T00:40:00Z'); // 09:40 KST
const iso = (s) => new Date(s).toISOString();
const doneDiscovery = { state: 'completed', completedToday: true, completedAt: iso('2026-10-29T23:26:00Z'), totals: { discovered: 120, archived: 11, failedSources: 3 }, failedSources: [1, 2, 3], progress: { done: 84, total: 84 } };
const readyBrief = { status: 'ready', attempt_count: 1, error: null, updated_at: iso('2026-10-29T23:28:00Z'), completed_at: iso('2026-10-29T23:28:00Z'), item_count: 7 };
const base = (over = {}) => ({ discovery: doneDiscovery, brief: readyBrief, evidenceCandidates: 15, attemptsToday: { count: 0 }, trace: [], attempts: [], providers: null, ...over });
const failedBrief = (error, attempts = 3) => ({ status: 'failed', attempt_count: attempts, error, updated_at: iso('2026-10-30T00:30:00Z'), completed_at: iso('2026-10-30T00:30:00Z'), item_count: 0 });

// in-memory stand-in for the ops_doctor document (same read/mutate contract as the real store)
function memStore(initial = {}) {
  const s = { doc: JSON.parse(JSON.stringify(initial)), writes: 0,
    async read() { return JSON.parse(JSON.stringify(s.doc)); },
    async mutate(fn) { const n = fn(JSON.parse(JSON.stringify(s.doc))); if (n !== undefined) { s.doc = JSON.parse(JSON.stringify(n)); s.writes++; } return true; } };
  return s;
}
// gather() returns the given contexts in order (before, then after)
const gatherSeq = (...ctxs) => { let i = 0; return async () => ctxs[Math.min(i++, ctxs.length - 1)]; };
const exec = () => { const calls = []; return { calls, retry_headline: async () => { calls.push('retry_headline'); return { ran: true, reason: 'generated' }; }, kick_pipeline: async () => { calls.push('kick_pipeline'); return { kicked: true, result: 'hop_1_http_202' }; } }; };
const run = (opts) => runDoctor({ now: NOW, clock: () => NOW.getTime() + 60000, recoveryEnabled: true, ...opts });

test('normal: a healthy pipeline is only reported — no finding, no action, no recovery state touched', async () => {
  const ex = exec(); const store = memStore();
  const r = await run({ mode: 'recover', gather: gatherSeq(base()), executors: ex, store });
  assert.equal(r.outcome, 'healthy');
  assert.deepEqual([r.findings.length, r.actions.length, r.humanNeeded], [0, 0, false]);
  assert.deepEqual(ex.calls, []);
  assert.equal(store.doc.days, undefined, 'no recovery round was recorded');
  assert.equal(store.doc.reports.length, 1, 'the run itself is reported');
});

test('transient failure: a bad model answer on the headline is diagnosed with evidence, retried once, re-checked, and recovered', async () => {
  const bad = base({ brief: failedBrief('brief_placeholder_output | head=Let me analyze'), attempts: [{ error: 'brief_placeholder_output | head=Let me analyze', created_at: iso('2026-10-30T00:29:00Z') }] });
  const fixed = base({ brief: { ...readyBrief, attempt_count: 4, completed_at: iso('2026-10-30T00:41:00Z') } });
  const ex = exec(); const store = memStore();
  const r = await run({ mode: 'recover', gather: gatherSeq(bad, fixed), executors: ex, store });
  const f = r.findings.find((x) => x.checkId === 'headline');
  assert.deepEqual([f.cause, f.confidence, f.classification, f.action], ['model_output_invalid', 'confirmed', 'retryable', 'retry_headline']);
  assert.ok(f.evidence.some((e) => /brief_placeholder_output/.test(e)), 'evidence quotes the logged cause');
  assert.deepEqual(ex.calls, ['retry_headline']);
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.humanNeeded, false);
  assert.equal(r.after.status === 'warn' || r.after.status === 'ok', true);
  assert.equal(store.doc.days['2026-10-30'].rounds, 1);
  assert.equal(store.doc.lock.until, 0, 'the lease is released');
});

test('stalled collection: restarted through the existing kick; a started hop that takes its lease counts as improving, not as fixed', async () => {
  const stalled = base({ discovery: { state: 'stalled', completedToday: false, progress: { done: 54, total: 84 }, lastProgressAt: iso('2026-10-30T00:20:00Z') }, brief: null, trace: [{ at: iso('2026-10-30T00:25:00Z'), kind: 'cron_call', chained: 'hop_5_http_508_gave_up' }] });
  const running = base({ discovery: { state: 'running', completedToday: false, progress: { done: 54, total: 84 } }, brief: null });
  const ex = exec();
  const r = await run({ mode: 'recover', gather: gatherSeq(stalled, running), executors: ex, store: memStore() });
  const f = r.findings.find((x) => x.checkId === 'discovery_run');
  assert.deepEqual([f.cause, f.classification, f.action], ['continuation_lost', 'auto_recoverable', 'kick_pipeline']);
  assert.ok(f.evidence.some((e) => /1 continuation hand-off/.test(e)));
  assert.deepEqual(ex.calls, ['kick_pipeline']);
  assert.equal(r.outcome, 'improving');
});

test('unresolved after recovery: the problem is still there -> outcome unresolved, a person is needed, and the SAME problem is not retried on the next run', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout'), attempts: [{ error: 'AI provider timeout', created_at: iso('2026-10-30T00:29:00Z') }] });
  const ex = exec(); const store = memStore();
  const first = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store });
  assert.equal(first.outcome, 'unresolved');
  assert.equal(first.humanNeeded, true);
  assert.deepEqual(ex.calls, ['retry_headline']);
  const second = await runDoctor({ now: new Date(NOW.getTime() + 3600000), clock: () => NOW.getTime() + 3660000, recoveryEnabled: true, mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store });
  assert.deepEqual(ex.calls, ['retry_headline'], 'no second recovery for a problem the first one did not fix');
  assert.equal(second.outcome, 'limit_reached');
  assert.ok(second.plan.skipped.some((s) => /already_failed/.test(s.reason)));
});

test('repeated failure and limits: daily round cap, per-problem attempt cap and cooldown each stop further execution', () => {
  const f = diagnose(evaluateHealth(base({ brief: failedBrief('timeout') }), NOW.getTime()), base({ brief: failedBrief('timeout') }), NOW.getTime());
  const t = NOW.getTime();
  const key = f.find((x) => x.action).key;
  const day = '2026-10-30';
  assert.equal(planRecovery(f, { days: { [day]: { rounds: MAX_ROUNDS_PER_DAY } } }, { now: t, mode: 'recover', recoveryEnabled: true }).skipped[0].reason, 'daily_round_limit');
  assert.match(planRecovery(f, { days: { [day]: { byKey: { [key]: { count: 2 } } } } }, { now: t, mode: 'recover', recoveryEnabled: true }).skipped[0].reason, /attempt_limit/);
  assert.equal(planRecovery(f, { days: { [day]: { byKey: { [key]: { count: 1, lastAt: t - 60000 } } } } }, { now: t, mode: 'recover', recoveryEnabled: true }).skipped[0].reason, 'cooldown');
  assert.equal(planRecovery(f, { days: { [day]: { byKey: { [key]: { count: 1, lastAt: t - 3600000 } } } } }, { now: t, mode: 'recover', recoveryEnabled: true }).actions.length, 1, 'after the cooldown one more attempt is allowed');
});

test('safety: diagnose mode and a missing DOCTOR_RECOVERY flag execute nothing, whatever the finding', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout') });
  for (const opts of [{ mode: 'diagnose', recoveryEnabled: true }, { mode: 'recover', recoveryEnabled: false }]) {
    const ex = exec();
    const r = await runDoctor({ now: NOW, gather: gatherSeq(bad), executors: ex, store: memStore(), ...opts });
    assert.deepEqual(ex.calls, []);
    assert.equal(r.outcome, 'recovery_not_permitted');
    assert.ok(r.findings.some((x) => x.action), 'the diagnosis still says what it WOULD do');
  }
});

test('unclear cause: no action is taken and a person is asked; known-unrecoverable states (attempt cap, inconsistent empty headline, outage) are never acted on', async () => {
  const cases = [
    base({ brief: failedBrief('something nobody has seen before') }),
    base({ brief: failedBrief('timeout', 20) }),
    base({ brief: { ...readyBrief, item_count: 0 }, evidenceCandidates: 9 }),
    base({ discovery: { ...doneDiscovery, totals: { discovered: 0, archived: 0, failedSources: 80 }, failedSources: new Array(80).fill(0) } }),
  ];
  for (const ctx of cases) {
    const ex = exec();
    const r = await run({ mode: 'recover', gather: gatherSeq(ctx), executors: ex, store: memStore() });
    assert.deepEqual(ex.calls, [], 'nothing executed');
    assert.equal(r.humanNeeded, true);
    assert.equal(r.outcome, 'needs_human');
    assert.ok(r.findings.every((x) => x.classification === 'needs_human'));
  }
  assert.equal(diagnose(evaluateHealth(cases[0], NOW.getTime()), cases[0], NOW.getTime())[0].confidence, 'unknown');
});

test('one doctor at a time: a live lease from another run blocks execution; an expired one does not', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout') });
  const ex = exec();
  const held = await run({ mode: 'recover', gather: gatherSeq(bad), executors: ex, store: memStore({ lock: { id: 'other', until: NOW.getTime() + 5 * 60000 } }) });
  assert.equal(held.outcome, 'locked');
  assert.deepEqual(ex.calls, []);
  const expired = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store: memStore({ lock: { id: 'old', until: NOW.getTime() - 1 } }) });
  assert.notEqual(expired.outcome, 'locked');
  assert.deepEqual(ex.calls, ['retry_headline']);
});

test('an executor that throws or hangs is recorded, the re-check still runs, and the run ends unresolved (bounded by a timeout)', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout') });
  const boom = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: { retry_headline: async () => { throw new Error('boom'); } }, store: memStore() });
  assert.equal(boom.actions[0].error, 'boom');
  assert.equal(boom.outcome, 'unresolved');
  const hang = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: { retry_headline: () => new Promise(() => {}) }, executorTimeoutMs: 30, store: memStore() });
  assert.equal(hang.actions[0].error, 'executor_timeout');
  assert.equal(hang.outcome, 'unresolved');
});

test('secrets never reach the stored report or the response', async () => {
  const leak = base({ brief: failedBrief('AI provider timeout Bearer abcdef0123456789abcdef sk-live1234567890abcd postgres://u:p@h/db'), attempts: [{ error: 'tvly-secretsecret12345 failed', created_at: iso('2026-10-30T00:29:00Z') }] });
  const store = memStore();
  const r = await run({ mode: 'diagnose', gather: gatherSeq(leak), executors: exec(), store });
  const all = JSON.stringify(r) + JSON.stringify(store.doc);
  for (const secret of ['abcdef0123456789abcdef', 'sk-live1234567890abcd', 'postgres://u:p@h/db', 'tvly-secretsecret12345']) assert.ok(!all.includes(secret), `${secret} must not appear`);
  assert.ok(all.includes('[redacted]'));
  assert.deepEqual(scrub({ a: 'ok' }), { a: 'ok' });
});

test('classification helpers: error kinds and outcome judgement', () => {
  assert.equal(errorKind('Unexpected token \'.\''), 'model_output_invalid');
  assert.equal(errorKind('retry_deferred: x'), 'insufficient_invocation_time');
  assert.equal(errorKind('fetch failed'), 'ai_provider_transient');
  assert.equal(errorKind('???'), 'unknown');
  const bad = evaluateHealth(base({ brief: failedBrief('timeout') }), NOW.getTime());
  const worse = evaluateHealth(base({ brief: failedBrief('timeout'), discovery: { state: 'stalled', completedToday: false, progress: null } }), NOW.getTime());
  assert.equal(judgeOutcome(bad, worse, []), 'unresolved', 'a new failure after recovery is never "improving"');
});

test('doctor endpoint: bearer auth, default mode is diagnose, recover is only passed through when asked, errors say a person is needed', async () => {
  const { doctorHandler } = require('../server/lib/cronRunner');
  process.env.CRON_SECRET = 'test-secret';
  const call = async (handler, auth, query = {}) => {
    const out = {};
    await handler({ get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined), headers: { authorization: auth }, query }, { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } });
    return out;
  };
  const seen = [];
  const h = doctorHandler({ run: async (o) => { seen.push(o.mode); return { outcome: 'healthy' }; } });
  assert.equal((await call(h, 'Bearer nope')).code, 401);
  await call(h, 'Bearer test-secret');
  await call(h, 'Bearer test-secret', { mode: 'recover' });
  await call(h, 'Bearer test-secret', { mode: 'anything-else' });
  assert.deepEqual(seen, ['diagnose', 'recover', 'diagnose']);
  const err = await call(doctorHandler({ run: async () => { throw new Error('boom'); } }), 'Bearer test-secret');
  assert.deepEqual([err.code, err.body.humanNeeded], [500, true]);
});

test('only two recovery actions exist and each is a described, already-existing safe path', () => {
  const { ACTIONS } = require('../server/lib/pipelineDoctor');
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['kick_pipeline', 'retry_headline']);
  const f = diagnose(evaluateHealth(base({ brief: failedBrief('timeout') }), NOW.getTime()), base({ brief: failedBrief('timeout') }), NOW.getTime());
  const plan = planRecovery(f, {}, { now: NOW.getTime(), mode: 'recover', recoveryEnabled: true });
  assert.match(plan.actions[0].does, /existing headline guard/);
});
