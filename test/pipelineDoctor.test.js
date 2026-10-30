const test = require('node:test');
const assert = require('node:assert/strict');
const { runDoctor, diagnose, planRecovery, judgeOutcome, scrub, errorKind, MAX_ROUNDS_PER_DAY, checkApproval, armApproval } = require('../server/lib/pipelineDoctor');
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

// ---- review of the deployed implementation: critical-path regressions ----

test('REVIEW: recovery requires an explicit "recover" request AND DOCTOR_RECOVERY=on, read at call time', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout') });
  const prev = process.env.DOCTOR_RECOVERY;
  try {
    delete process.env.DOCTOR_RECOVERY;
    let ex = exec();
    let r = await runDoctor({ now: NOW, clock: () => NOW.getTime() + 60000, mode: 'recover', gather: gatherSeq(bad), executors: ex, store: memStore() });
    assert.deepEqual([ex.calls.length, r.outcome], [0, 'recovery_not_permitted']);
    process.env.DOCTOR_RECOVERY = 'on';
    ex = exec();
    r = await runDoctor({ now: NOW, clock: () => NOW.getTime() + 60000, mode: 'diagnose', gather: gatherSeq(bad), executors: ex, store: memStore() });
    assert.deepEqual([ex.calls.length, r.outcome], [0, 'recovery_not_permitted'], 'the flag alone never starts recovery: the request must say recover');
    process.env.DOCTOR_RECOVERY = 'yes';
    ex = exec();
    r = await runDoctor({ now: NOW, clock: () => NOW.getTime() + 60000, mode: 'recover', gather: gatherSeq(bad), executors: ex, store: memStore() });
    assert.equal(ex.calls.length, 0, 'only the exact value "on" enables it');
    process.env.DOCTOR_RECOVERY = 'on';
    ex = exec();
    await runDoctor({ now: NOW, clock: () => NOW.getTime() + 60000, mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store: memStore() });
    assert.equal(ex.calls.length, 1);
  } finally { if (prev === undefined) delete process.env.DOCTOR_RECOVERY; else process.env.DOCTOR_RECOVERY = prev; }
});

test('REVIEW: two doctors started at the same moment execute the recovery exactly once', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout') });
  const ex = exec(); const store = memStore();
  const results = await Promise.all([1, 2, 3].map(() => run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store })));
  assert.equal(ex.calls.length, 1);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ['locked', 'locked', 'unresolved']);
  assert.equal(store.doc.days['2026-10-30'].rounds, 1);
});

test('REVIEW: if the lease/limits cannot be stored, NOTHING is executed (an unstored lease protects nothing)', async () => {
  const bad = base({ brief: failedBrief('AI provider timeout') });
  const ex = exec();
  const flaky = { doc: {}, async read() { return {}; }, async mutate() { return false; } };
  const r = await run({ mode: 'recover', gather: gatherSeq(bad), executors: ex, store: flaky });
  assert.deepEqual([ex.calls.length, r.outcome, r.humanNeeded], [0, 'state_unavailable', true]);
});

test('REVIEW: the run stays inside its time budget — a second action is skipped when too little time is left, and executors get a deadline', async () => {
  const stalled = base({ discovery: { state: 'stalled', completedToday: false, progress: { done: 10, total: 84 }, lastProgressAt: iso('2026-10-30T00:10:00Z') }, brief: failedBrief('AI provider timeout') });
  let t = NOW.getTime();
  const deadlines = [];
  const executors = {
    kick_pipeline: async ({ deadlineAt }) => { deadlines.push(deadlineAt - Date.now()); t += 230000; return { kicked: true }; }, // deadlineAt is a wall-clock instant; this action consumes almost the whole budget
    retry_headline: async ({ deadlineAt }) => { deadlines.push(deadlineAt); return { ran: true }; },
  };
  const r = await runDoctor({ now: NOW, clock: () => t, recoveryEnabled: true, mode: 'recover', gather: gatherSeq(stalled, stalled), executors, store: memStore() });
  assert.equal(r.actions.length, 2);
  assert.ok(deadlines[0] > 0 && deadlines[0] <= 200000, `the first executor was bounded (${deadlines[0]} ms)`);
  const skipped = r.actions.find((a) => a.action === 'retry_headline');
  assert.equal(skipped.error, 'skipped_no_time_left');
  assert.equal(deadlines.length, 1, 'the second executor never started');
});

test('REVIEW: the classification looks at the cause, not at the model answer quoted after "| head=" ("network"/"503" inside an answer is not a network failure)', () => {
  assert.equal(errorKind('brief_placeholder_output | head=Let me think about the network timeout 503 situation'), 'model_output_invalid');
  assert.equal(errorKind('No AI provider configured'), 'unknown', 'a configuration problem is not a transient one');
  const ctx = base({ brief: failedBrief('mystery | head=timeout network 503'), attempts: [{ error: 'mystery | head=timeout network 503', created_at: iso('2026-10-30T00:29:00Z') }] });
  const f = diagnose(evaluateHealth(ctx, NOW.getTime()), ctx, NOW.getTime()).find((x) => x.checkId === 'headline');
  assert.deepEqual([f.cause, f.classification, f.action], ['unknown_generation_error', 'needs_human', null]);
});

test('REVIEW: a recovery that could not be applied (kick not needed / headline guard declined) is "not_applied" and a person is told; it is not counted as an unresolved failure', async () => {
  const stalled = base({ discovery: { state: 'stalled', completedToday: false, progress: { done: 10, total: 84 }, lastProgressAt: iso('2026-10-30T00:10:00Z') }, brief: null });
  const store = memStore();
  const ex = { kick_pipeline: async () => ({ kicked: false, reason: 'not_needed' }) };
  const r = await run({ mode: 'recover', gather: gatherSeq(stalled, stalled), executors: ex, store });
  assert.deepEqual([r.outcome, r.humanNeeded], ['not_applied', true]);
  const key = Object.keys(store.doc.days['2026-10-30'].byKey)[0];
  assert.equal(store.doc.days['2026-10-30'].byKey[key].unresolved, undefined);
});

test('REVIEW: the headline executor goes through the guard — a READY headline is never reclaimed or overwritten (no INSERT/UPDATE is issued)', async () => {
  const pool = require('../server/db/pool');
  const { defaultExecutors } = require('../server/lib/pipelineDoctor');
  const orig = pool.query;
  const statements = [];
  pool.query = async (text) => {
    statements.push(String(text).trim().split(/\s+/)[0].toUpperCase());
    if (/FROM daily_briefs WHERE brief_date/.test(text)) return { rows: [{ status: 'ready' }] };
    return { rows: [] };
  };
  try {
    const result = await defaultExecutors.retry_headline({ deadlineAt: Date.now() + 120000 });
    assert.deepEqual(result, { ran: false, reason: 'up_to_date', stillRunning: 0, modelCalls: 0, maxModelCalls: 2, budgetExhausted: false, timeBudgetExceeded: false });
    assert.ok(!statements.includes('INSERT') && !statements.includes('UPDATE') && !statements.includes('DELETE'), `only reads happened: ${statements}`);
  } finally { pool.query = orig; }
});

test('REVIEW: redaction also covers key/value secrets and auth headers, and the stored report holds none of them', async () => {
  const text = 'x-subscription-token: ABCDEF123456 api_key=abc123456xyz password: hunter22222 Authorization: Bearer abcdefghijkl1234';
  const out = JSON.stringify(scrub({ t: text }));
  for (const secret of ['ABCDEF123456', 'abc123456xyz', 'hunter22222', 'abcdefghijkl1234']) assert.ok(!out.includes(secret));
  const store = memStore();
  await run({ mode: 'diagnose', gather: gatherSeq(base({ brief: failedBrief(`AI provider timeout ${text}`) })), executors: exec(), store });
  for (const secret of ['ABCDEF123456', 'abc123456xyz', 'hunter22222', 'abcdefghijkl1234']) assert.ok(!JSON.stringify(store.doc).includes(secret), `${secret} not persisted`);
});

// ---- defects demonstrated by the integration test (test/doctorRecovery.integration.test.js) ----

test('DEFECT FIX: a headline that is still generating after the recovery is "improving", never "recovered"', () => {
  const bad = evaluateHealth(base({ brief: failedBrief('AI provider timeout') }), NOW.getTime());
  const generating = evaluateHealth(base({ brief: { ...readyBrief, status: 'generating', completed_at: null, updated_at: iso(NOW.getTime() - 60000), attempt_count: 4 } }), NOW.getTime());
  assert.equal(generating.checks.find((c) => c.id === 'headline').status, 'pass');
  assert.equal(judgeOutcome(bad, generating, [{ action: 'retry_headline', result: { ran: true, stillRunning: 1 } }]), 'improving');
  const ready = evaluateHealth(base({ brief: { ...readyBrief, attempt_count: 4 } }), NOW.getTime());
  assert.equal(judgeOutcome(bad, ready, [{ action: 'retry_headline', result: { ran: true, stillRunning: 0 } }]), 'recovered');
});

test('DEFECT FIX: the kick executor judges the doctor\'s moment (it passes `now` to the guard), not the wall clock', async () => {
  const guardian = require('../server/lib/pipelineGuardian');
  const orig = guardian.maybeKickStalledPipeline;
  let seen;
  guardian.maybeKickStalledPipeline = async (o) => { seen = o; return { kicked: false, reason: 'not_needed' }; };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0); // the executor pauses 15 s before its re-check: not needed here
  try {
    const at = new Date('2026-10-30T00:10:00Z');
    await require('../server/lib/pipelineDoctor').defaultExecutors.kick_pipeline({ now: at });
    assert.equal(seen.now.getTime(), at.getTime());
  } finally { guardian.maybeKickStalledPipeline = orig; global.setTimeout = realSetTimeout; }
});

test('DEFECT FIX: background.drain leaves no timer behind when everything finished early', async () => {
  const bg = require('../server/lib/background');
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before = timers();
  bg.track(new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(await bg.drain(60000), 0);
  assert.ok(timers() <= before, `a finished drain must not keep its 60 s timer alive (before ${before}, after ${timers()})`);
});

// ---------- autonomy policy boundaries: real provider/HTTP failures, database contention, honest still-running reports ----------
const failedWith = (err) => base({ brief: failedBrief(err), attempts: [{ error: err, created_at: iso('2026-10-30T00:29:00Z') }] });
const headlineFinding = (ctx) => diagnose(evaluateHealth(ctx, NOW.getTime()), ctx, NOW.getTime()).find((f) => f.checkId === 'headline');

test('policy: real provider/HTTP failures — transient ones are retryable, key/quota ones are never retried and need a person', () => {
  for (const e of ['AI provider returned 500', 'upstream 503 Service Unavailable', 'HTTP 429 rate limit', 'ETIMEDOUT', 'socket hang up', 'error code: 522', 'The model is overloaded']) {
    assert.equal(errorKind(e), 'ai_provider_transient', e);
    const f = headlineFinding(failedWith(e));
    assert.deepEqual([f.classification, f.action], ['retryable', 'retry_headline'], e);
  }
  for (const e of ['AI provider returned 401 Unauthorized', 'HTTP 402 insufficient_quota', 'You exceeded your current quota', 'Invalid API key']) {
    assert.equal(errorKind(e), 'provider_unavailable', e);
    const f = headlineFinding(failedWith(e));
    assert.deepEqual([f.cause, f.classification, f.action, f.humanUrgency], ['provider_unavailable', 'needs_human', null, 'now'], e);
  }
  assert.equal(errorKind('brief_placeholder_output | head=the 401 and 503 numbers'), 'model_output_invalid', 'the model\'s own text never steers the classification');
});

test('policy: database pool contention is its own cause with a LONGER cooldown than other retries', () => {
  const e = 'timeout exceeded when trying to connect';
  assert.equal(errorKind(e), 'db_pool_contention');
  assert.equal(errorKind('sorry, too many clients already'), 'db_pool_contention');
  const f = headlineFinding(failedWith(e));
  assert.deepEqual([f.cause, f.classification, f.action], ['db_pool_contention', 'retryable', 'retry_headline']);
  const at = NOW.getTime();
  const plan = (key, minutes) => planRecovery([f.key === key ? f : f], { days: { '2026-10-30': { byKey: { [key]: { count: 1, lastAt: at - minutes * 60000 } } } } }, { now: at, mode: 'recover', recoveryEnabled: true });
  assert.equal(plan(f.key, 15).actions.length, 0, '15 min is past the normal cooldown but not the contention one');
  assert.equal(plan(f.key, 15).skipped[0].reason, 'cooldown');
  assert.equal(plan(f.key, 31).actions.length, 1, 'after 30 min it may try again');
  const other = headlineFinding(failedWith('AI provider timeout'));
  assert.equal(planRecovery([other], { days: { '2026-10-30': { byKey: { [other.key]: { count: 1, lastAt: at - 15 * 60000 } } } } }, { now: at, mode: 'recover', recoveryEnabled: true }).actions.length, 1, 'ordinary causes keep the 10 min cooldown');
});

test('preflight: an unhealthy database defers the round BEFORE the lease — nothing executed, nothing counted, no human paged', async () => {
  const bad = failedWith('AI provider timeout'); const ex = exec(); const store = memStore();
  const r = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store, preflight: async () => ({ ok: false, reason: 'pool_saturated' }) });
  assert.equal(r.outcome, 'deferred_db_unhealthy');
  assert.deepEqual([ex.calls, r.actions, r.humanNeeded], [[], [], false]);
  assert.equal(store.doc.days, undefined, 'no round or attempt was counted');
  assert.equal(store.doc.lock, undefined, 'no lease was taken');
  assert.match(r.summary, /deferred: database not ready \(pool_saturated\)/);
  const thrown = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store: memStore(), preflight: async () => { throw new Error('boom'); } });
  assert.equal(thrown.outcome, 'deferred_db_unhealthy', 'a failing preflight is treated as unhealthy, never as "go"');
  const ok = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store: memStore(), preflight: async () => ({ ok: true }) });
  assert.deepEqual(ex.calls, ['retry_headline'], 'a healthy database proceeds as before');
  assert.notEqual(ok.outcome, 'deferred_db_unhealthy');
});

test('preflight: dbPreflight itself reports a saturated or failing pool as not ok and a working one as ok', async () => {
  const pool = require('../server/db/pool'); const { dbPreflight } = require('../server/lib/pipelineDoctor');
  const orig = { query: pool.query, wc: Object.getOwnPropertyDescriptor(pool, 'waitingCount') };
  try {
    Object.defineProperty(pool, 'waitingCount', { value: 2, configurable: true });
    assert.deepEqual(await dbPreflight(), { ok: false, reason: 'pool_saturated' });
    Object.defineProperty(pool, 'waitingCount', { value: 0, configurable: true });
    pool.query = async () => { throw new Error('connection terminated'); };
    assert.match((await dbPreflight()).reason, /db_unhealthy: connection terminated/);
    pool.query = async () => ({ rows: [{}] });
    assert.deepEqual(await dbPreflight(), { ok: true });
  } finally { pool.query = orig.query; if (orig.wc) Object.defineProperty(pool, 'waitingCount', orig.wc); else delete pool.waitingCount; }
});

test('escalation: when the automatic limits are used up while the pipeline still FAILS, a person is needed; a mere warning is not escalated', async () => {
  const bad = failedWith('AI provider timeout'); const ex = exec();
  const used = { days: { '2026-10-30': { rounds: MAX_ROUNDS_PER_DAY } } };
  const r = await run({ mode: 'recover', gather: gatherSeq(bad), executors: ex, store: memStore(used) });
  assert.deepEqual([r.outcome, r.humanNeeded, ex.calls], ['limit_reached', true, []]);
  const warnOnly = base({ discovery: { ...doneDiscovery, failedSources: [1] , totals: { discovered: 100, archived: 11, failedSources: 1 } }, trace: [{ at: iso('2026-10-30T00:00:00Z'), kind: 'cron_call', chained: 'hop_1_http_508_gave_up' }] });
  const w = await run({ mode: 'recover', gather: gatherSeq(warnOnly), executors: ex, store: memStore(used) });
  assert.equal(w.humanNeeded, false);
});

test('reporting: a recovery that left work running is "improving" with stillRunning=true and an explicit not-yet-fixed line; a finished one is not', async () => {
  const bad = failedWith('AI provider timeout');
  const generating = base({ brief: { status: 'generating', attempt_count: 4, error: null, updated_at: iso('2026-10-30T00:40:30Z'), completed_at: null, item_count: 0 } });
  const r = await run({ mode: 'recover', gather: gatherSeq(bad, generating), executors: { retry_headline: async () => ({ ran: true, stillRunning: 1 }) }, store: memStore() });
  assert.deepEqual([r.outcome, r.stillRunning, r.humanNeeded], ['improving', true, false]);
  assert.match(r.summary, /still running.*NOT yet confirmed fixed/);
  const done = await run({ mode: 'recover', gather: gatherSeq(bad, base({ brief: { ...readyBrief, attempt_count: 4, completed_at: iso('2026-10-30T00:41:00Z') } })), executors: exec(), store: memStore() });
  assert.deepEqual([done.outcome, done.stillRunning], ['recovered', false]);
});

test('boundaries: diagnose mode and DOCTOR_RECOVERY off still execute nothing, whatever the new causes', async () => {
  for (const e of ['timeout exceeded when trying to connect', 'AI provider returned 503']) {
    const bad = failedWith(e);
    for (const opts of [{ mode: 'diagnose', recoveryEnabled: true }, { mode: 'recover', recoveryEnabled: false }]) {
      const ex = exec();
      const r = await run({ gather: gatherSeq(bad), executors: ex, store: memStore(), ...opts });
      assert.deepEqual([ex.calls, r.actions, r.outcome], [[], [], 'recovery_not_permitted']);
    }
  }
});

// ---------- "improving" is never "recovered" ----------
const hc = (...c) => ({ status: c.some((x) => x[1] === 'fail') ? 'failed' : c.some((x) => x[1] === 'warn') ? 'warn' : 'ok', checks: c.map(([id, status, detail]) => ({ id, status, detail: detail || '' })) });

test('judgeOutcome: a failed check that is only DOWNGRADED (fail -> warn) or still running is improving; only fail -> PASS is recovered', () => {
  assert.equal(judgeOutcome(hc(['discovery_run', 'fail']), hc(['discovery_run', 'warn', 'still in progress 54/84 past 10:00 KST']), [{ action: 'kick_pipeline', result: { kicked: true } }]), 'improving');
  assert.equal(judgeOutcome(hc(['headline', 'fail']), hc(['headline', 'warn', 'ready with 7 item(s) but 60 min after the 09:00 KST target']), []), 'recovered', 'finished but late is done');
  assert.equal(judgeOutcome(hc(['headline', 'fail']), hc(['headline', 'pass', 'generating (attempt 4)']), []), 'improving');
  assert.equal(judgeOutcome(hc(['headline', 'fail']), hc(['headline', 'pass', 'ready with 7 item(s)']), []), 'recovered');
  assert.equal(judgeOutcome(hc(['headline', 'fail']), hc(['headline', 'pass', 'ready'], ['recovery', 'warn']), []), 'recovered', 'an unrelated informational warning does not block a real fix');
});

test('improving is only ever confirmed by a LATER health run: while the work is still running the next run neither acts nor claims recovery; a later run reports only what it sees (healthy only on a real PASS)', async () => {
  const bad = failedWith('AI provider returned 503');
  const generating = base({ brief: { status: 'generating', attempt_count: 4, error: null, updated_at: iso('2026-10-30T00:40:30Z'), completed_at: null, item_count: 0 } });
  const store = memStore(); const ex = exec();
  const first = await run({ mode: 'recover', gather: gatherSeq(bad, generating), executors: ex, store });
  assert.deepEqual([first.outcome, first.stillRunning], ['improving', true]);
  const stillGenerating = await run({ mode: 'recover', gather: gatherSeq(generating), executors: ex, store });
  assert.equal(stillGenerating.outcome, 'in_progress', 'a PASS that only says "generating" is not a confirmation');
  assert.deepEqual(ex.calls, ['retry_headline'], 'no second action while the first is running');
  const ready = base({ brief: { ...readyBrief, attempt_count: 4, completed_at: iso('2026-10-30T00:41:00Z') } });
  const later = await run({ mode: 'recover', gather: gatherSeq(ready), executors: ex, store });
  // 09:41 KST completion is after the 09:00 target: the later run sees only that permanent warning — it never claims "recovered" or "improving"
  assert.deepEqual([later.outcome, later.humanNeeded], ['review_only', false]);
  const onTime = await run({ mode: 'recover', gather: gatherSeq(base()), executors: ex, store });
  assert.equal(onTime.outcome, 'healthy', 'a later health run that really PASSES reports healthy');
  assert.deepEqual(ex.calls, ['retry_headline']);
});

// ---------- recovery decision + execution through runDoctor (the real planner, lease, limits, re-check) for each failure class ----------
test('provider/HTTP transient (503) and DB contention: planned, executed once, re-checked; a persisting failure is unresolved, escalated and NOT retried on the next run', async () => {
  for (const err of ['AI provider returned 503', 'HTTP 429 rate limit', 'timeout exceeded when trying to connect']) {
    const bad = failedWith(err); const store = memStore(); const ex = exec();
    const r = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store });
    assert.deepEqual([ex.calls, r.outcome, r.humanNeeded], [['retry_headline'], 'unresolved', true], err);
    const again = await runDoctor({ now: new Date(NOW.getTime() + 3600000), clock: () => NOW.getTime() + 3660000, recoveryEnabled: true, mode: 'recover', gather: gatherSeq(bad), executors: ex, store });
    assert.deepEqual([ex.calls.length, again.outcome], [1, 'limit_reached'], `${err}: no retry of a problem the first retry did not fix`);
  }
});

test('provider key/quota failure (401/402): nothing is executed, a person is needed, and no round or attempt is consumed', async () => {
  for (const err of ['AI provider returned 401 Unauthorized', 'HTTP 402 insufficient_quota']) {
    const store = memStore(); const ex = exec();
    const r = await run({ mode: 'recover', gather: gatherSeq(failedWith(err)), executors: ex, store });
    assert.deepEqual([ex.calls, r.outcome, r.humanNeeded, store.doc.days], [[], 'needs_human', true, undefined], err);
  }
});

test('cooldown through runDoctor: a transient failure inside its cooldown is not retried (contention waits 30 min), and afterwards it is', async () => {
  const bad = failedWith('timeout exceeded when trying to connect'); const key = 'headline:db_pool_contention';
  const doc = (agoMin) => ({ days: { '2026-10-30': { rounds: 1, byKey: { [key]: { count: 1, lastAt: NOW.getTime() - agoMin * 60000 } } } } });
  const ex = exec();
  const inside = await run({ mode: 'recover', gather: gatherSeq(bad), executors: ex, store: memStore(doc(15)) });
  assert.deepEqual([ex.calls, inside.plan.skipped.map((s) => s.reason)], [[], ['cooldown']]);
  assert.ok(!['recovered', 'improving'].includes(inside.outcome));
  const after = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store: memStore(doc(31)) });
  assert.deepEqual(ex.calls, ['retry_headline']);
  assert.ok(after.actions.length === 1);
});

test('attempt limits through runDoctor: the per-problem cap and the daily round cap stop execution and escalate while it still FAILS', async () => {
  const bad = failedWith('AI provider returned 503'); const ex = exec();
  const capped = await run({ mode: 'recover', gather: gatherSeq(bad), executors: ex, store: memStore({ days: { '2026-10-30': { rounds: 1, byKey: { 'headline:ai_provider_transient': { count: 2, lastAt: NOW.getTime() - 3 * 3600000 } } } } }) });
  assert.deepEqual([ex.calls, capped.outcome, capped.humanNeeded], [[], 'limit_reached', true]);
});

test('concurrent doctors: two runs that diagnosed the same failure at once execute exactly one recovery; the other reports locked and claims nothing', async () => {
  const bad = failedWith('AI provider returned 503'); const store = memStore(); const ex = exec();
  const mk = () => run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: ex, store });
  const [a, b] = await Promise.all([mk(), mk()]);
  assert.deepEqual(ex.calls, ['retry_headline']);
  const locked = [a, b].find((r) => r.outcome === 'locked');
  assert.ok(locked, 'one run lost the lease');
  assert.deepEqual([locked.actions, locked.after, locked.stillRunning || false], [[], null, false]);
  assert.equal(store.doc.days['2026-10-30'].rounds, 1);
});

test('re-check honesty: an action that did not run (no-op) is not_applied, never recovered, while the failure is still there', async () => {
  const bad = failedWith('AI provider returned 503');
  const r = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: { retry_headline: async () => ({ ran: false, reason: 'not_due' }) }, store: memStore() });
  assert.deepEqual([r.outcome, r.humanNeeded], ['not_applied', true]);
});

// ---------- bounded cost ----------
test('cost budget: the Doctor-triggered recovery has explicit, tighter limits than the guard alone (calls) and than the executor timeout (time)', () => {
  const d = require('../server/lib/pipelineDoctor');
  assert.equal(d.MAX_MODEL_CALLS_PER_RECOVERY, 2);
  assert.ok(d.MAX_MODEL_CALLS_PER_RECOVERY < 1 + 5, 'the guard alone allows 1 + MAX_AUTOMATIC_RETRIES = 6');
  assert.ok(d.RECOVERY_TIME_BUDGET_MS <= 150000 && d.RECOVERY_TIME_BUDGET_MS < 200000);
});

test('cost budget exhausted: the round is reported unresolved with a person needed — never recovered — and the same problem is not retried', async () => {
  const bad = failedWith('AI provider returned 503'); const store = memStore();
  const spent = { retry_headline: async () => ({ ran: true, stillRunning: 0, modelCalls: 2, maxModelCalls: 2, budgetExhausted: true }) };
  const r = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: spent, store });
  assert.deepEqual([r.outcome, r.humanNeeded, r.stillRunning], ['unresolved', true, false]);
  assert.match(r.summary, /budgetExhausted":true/, 'the report shows that the budget ran out');
  const again = await runDoctor({ now: new Date(NOW.getTime() + 3600000), clock: () => NOW.getTime() + 3660000, recoveryEnabled: true, mode: 'recover', gather: gatherSeq(bad), executors: spent, store });
  assert.equal(again.outcome, 'limit_reached');
});

test('no recovery claim without post-action confirmation: an executor that says success while the re-check still FAILS is unresolved; one that left work running is improving', async () => {
  const bad = failedWith('AI provider returned 503');
  const claimsSuccess = { retry_headline: async () => ({ ran: true, stillRunning: 0, modelCalls: 1, maxModelCalls: 2, budgetExhausted: false, timeBudgetExceeded: false }) };
  const r = await run({ mode: 'recover', gather: gatherSeq(bad, bad), executors: claimsSuccess, store: memStore() });
  assert.deepEqual([r.outcome, r.humanNeeded], ['unresolved', true]);
  const generating = base({ brief: { status: 'generating', attempt_count: 4, error: null, updated_at: iso('2026-10-30T00:40:30Z'), completed_at: null, item_count: 0 } });
  const timedOut = { retry_headline: async () => ({ ran: true, stillRunning: 1, modelCalls: 1, maxModelCalls: 2, budgetExhausted: false, timeBudgetExceeded: true }) };
  const i = await run({ mode: 'recover', gather: gatherSeq(bad, generating), executors: timedOut, store: memStore() });
  assert.deepEqual([i.outcome, i.stillRunning], ['improving', true]);
});

// ---------- one-run approval: pure gate + atomicity on the in-memory store ----------
const KEY = 'headline:ai_provider_transient';
const approvalAt = (over = {}) => ({ id: 'a1', action: 'retry_headline', key: KEY, createdAt: NOW.getTime() - 60000, expiresAt: NOW.getTime() + 14 * 60000, status: 'pending', ...over });
const headlineFindings = () => diagnose(evaluateHealth(failedWith('AI provider returned 503'), NOW.getTime()), failedWith('AI provider returned 503'), NOW.getTime());

test('checkApproval fails closed on every malformed, used, expired, mismatching or ambiguous case', () => {
  const f = headlineFindings(); const t = NOW.getTime();
  assert.equal(checkApproval(f, { approval: approvalAt() }, t).ok, true);
  const bad = [
    [undefined, 'no_approval'], [approvalAt({ status: 'consumed' }), 'already_used'], [approvalAt({ status: 'revoked' }), 'already_used'],
    [approvalAt({ action: 'kick_pipeline' }), 'wrong_action'], [approvalAt({ id: undefined }), 'malformed'], [approvalAt({ key: '' }), 'malformed'],
    [approvalAt({ expiresAt: 'soon' }), 'malformed'], [approvalAt({ expiresAt: t }), 'expired'], [approvalAt({ expiresAt: t - 1 }), 'expired'],
    [approvalAt({ expiresAt: t + 3600000 }), 'ttl_invalid'], [approvalAt({ createdAt: t + 600000, expiresAt: t + 900000 }), 'created_in_the_future'],
    [approvalAt({ key: 'headline:model_output_invalid' }), 'finding_does_not_match_approval'],
  ];
  for (const [a, reason] of bad) assert.equal(checkApproval(f, { approval: a }, t).reason, reason, JSON.stringify(a));
  assert.equal(checkApproval([], { approval: approvalAt() }, t).reason, 'ambiguous_eligibility', 'no eligible finding');
  assert.equal(checkApproval([...f, ...f.map((x) => ({ ...x, key: 'x:y' }))], { approval: approvalAt() }, t).reason, 'ambiguous_eligibility', 'two eligible findings');
  assert.equal(checkApproval([{ ...f[0], action: 'kick_pipeline', key: 'discovery_run:continuation_lost' }], { approval: approvalAt({ key: 'discovery_run:continuation_lost' }) }, t).reason, 'wrong_action');
});

test('approval through runDoctor (env flag OFF): executes once and is consumed; replay and concurrent runs cannot execute twice; a rejected approval is never consumed', async () => {
  const bad = failedWith('AI provider returned 503'); const ex = exec();
  const store = memStore({ approval: approvalAt() });
  const results = await Promise.all([1, 2, 3].map(() => run({ mode: 'recover', recoveryEnabled: false, gather: gatherSeq(bad, bad), executors: ex, store })));
  assert.deepEqual(ex.calls, ['retry_headline'], 'exactly one execution');
  assert.equal(results.filter((r) => r.actions.length === 1).length, 1);
  assert.equal(store.doc.approval.status, 'consumed');
  const again = await run({ mode: 'recover', recoveryEnabled: false, gather: gatherSeq(bad, bad), executors: ex, store });
  assert.deepEqual([ex.calls.length, again.approval.reason], [1, 'already_used']);
  const expired = memStore({ approval: approvalAt({ expiresAt: NOW.getTime() - 1 }) });
  const r = await run({ mode: 'recover', recoveryEnabled: false, gather: gatherSeq(bad), executors: ex, store: expired });
  assert.deepEqual([ex.calls.length, r.outcome, expired.doc.approval.status], [1, 'recovery_not_permitted', 'pending']);
  // the cooldown / earlier-failure limits still apply: an approval cannot override them
  const limited = memStore({ approval: approvalAt(), days: { '2026-10-30': { rounds: 1, byKey: { [KEY]: { count: 1, unresolved: 1, lastAt: NOW.getTime() - 3600000 } } } } });
  const l = await run({ mode: 'recover', recoveryEnabled: false, gather: gatherSeq(bad), executors: ex, store: limited });
  assert.deepEqual([ex.calls.length, l.approval.reason, limited.doc.approval.status], [1, 'plan_is_not_exactly_the_approved_action', 'pending']);
});

test('armApproval: headline findings only, one pending at a time, TTL within bounds', async () => {
  const store = memStore();
  assert.equal((await armApproval(store, { key: 'discovery_run:continuation_lost' })).reason, 'only_headline_findings_can_be_approved');
  assert.equal((await armApproval(store, { key: KEY, ttlMs: 3600000 })).reason, 'ttl_out_of_range');
  const a = await armApproval(store, { key: KEY, now: NOW.getTime(), by: 'me' });
  assert.deepEqual([a.armed, a.approval.expiresAt - a.approval.createdAt, store.doc.approval.status], [true, 15 * 60000, 'pending']);
  assert.equal((await armApproval(store, { key: KEY, now: NOW.getTime() + 1000 })).reason, 'another_approval_still_pending');
  assert.equal((await armApproval(store, { key: KEY, now: NOW.getTime() + 16 * 60000 })).armed, true, 'an expired one may be replaced');
});
