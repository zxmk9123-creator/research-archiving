// INTEGRATION TEST of the Pipeline Doctor's REAL recovery paths against a REAL PostgreSQL with the production schema.
//
// Not part of the normal suite: it runs only when DOCTOR_TEST_DATABASE_URL points at a LOCAL throw-away database (it truncates tables).
//   su postgres -c "createdb doctor_test" && DATABASE_URL=<local url> node server/db/init.js
//   DOCTOR_TEST_DATABASE_URL=postgres://doctor_test:doctor_test@127.0.0.1:5432/doctor_test node --require ./test/_setup.js --test test/doctorRecovery.integration.test.js
//
// What is real: runDoctor, health collection, diagnosis, planning, the lease/limit store (scheduler_jobs 'ops_doctor'), kick_pipeline (the real
// self-heal kick incl. its claim row), retry_headline (the real ensureDailyBrief -> queueDailyBriefGeneration -> buildDailyBrief), every SQL
// statement. What is faked, because it is outside the system: the LLM answer (provider.callProvider) and the HTTP hand-off to the next hop
// (global fetch), plus the doctor's clock (so the run is at a fixed 09:10 KST regardless of when the test is executed).
const test = require('node:test');
const assert = require('node:assert/strict');

const URL_ = process.env.DOCTOR_TEST_DATABASE_URL;
if (URL_) {
  const parsed = new globalThis.URL(URL_);
  const host = parsed.hostname;
  if (!/test/i.test(parsed.pathname)) throw new Error('refusing to run: the database name must contain "test" (this suite TRUNCATEs tables)');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`refusing to run against a non-local database (${host})`);
  process.env.DATABASE_URL = URL_;
  process.env.PGSSL = 'false';
  process.env.VERCEL_URL = 'doctor-test.invalid';
  process.env.CRON_SECRET = 'doctor-test-secret-value';
  delete process.env.DOCTOR_RECOVERY; // the flag is passed explicitly per scenario, never ambient
}
const opts = { skip: URL_ ? false : 'set DOCTOR_TEST_DATABASE_URL to a local test database to run' };

let pool, provider, dailyBrief, doctor;
if (URL_) {
  pool = require('../server/db/pool');
  provider = require('../server/lib/ai/provider');
  dailyBrief = require('../server/lib/dailyBrief');
  doctor = require('../server/lib/pipelineDoctor');
}

const todayKst = () => dailyBrief.kstDate(new Date());
const at910 = () => new Date(`${todayKst()}T09:10:00+09:00`);
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const iso = (ms) => new Date(ms).toISOString();

async function reset() {
  await q('TRUNCATE items, daily_briefs, daily_brief_attempts, scheduler_jobs RESTART IDENTITY CASCADE');
  await q('DROP TRIGGER IF EXISTS fail_doctor_writes ON scheduler_jobs');
}
async function seedItems(n) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const r = await q(
      `INSERT INTO items (title, source_url, published_at, type, status, collected_at, summary, insight)
       VALUES ($1, $2, $3::date, '뉴스', 'Published', $4::timestamptz, $5, $6) RETURNING id`,
      [`Palm oil export levy ${i}`, `https://example.org/doctor/${i}`, todayKst(), `${todayKst()}T08:00:00+09:00`, `인도네시아가 팜유 수출 부과금을 ${i}% 인상했다.`, `수출 부과금 인상으로 팜유 공급 부담이 커진다.`]
    );
    ids.push(r[0].id);
  }
  return ids;
}
async function seedDiscoveryCompleted(v) {
  await q(
    `INSERT INTO scheduler_jobs (job_name, last_run_date, last_completed_at, last_totals, last_failed_sources)
     VALUES ('daily_discovery', $1::date, $2::timestamptz, $3::jsonb, '[]'::jsonb)`,
    [todayKst(), iso(v.getTime() - 30 * 60000), JSON.stringify({ discovered: 120, archived: 11, filtered: 20, failed: 2, failedSources: 0 })]
  );
}
async function seedCursorStalled(v) {
  await q(
    `INSERT INTO scheduler_jobs (job_name, last_run_date, last_totals) VALUES ('daily_discovery_cursor', $1::date, $2::jsonb)`,
    [todayKst(), JSON.stringify({ total: 84, offset: 30, results: [], savedAt: v.getTime() - 20 * 60000, leaseUntil: 0 })]
  );
}
async function seedBrief(v, { status, attempts = 3, error = null, brief = null, items = 0 }) {
  await q(
    `INSERT INTO daily_briefs (brief_date, status, window_start, window_end, attempt_count, error, brief, item_count, updated_at, completed_at)
     VALUES ($1::date, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7::jsonb, $8, $9::timestamptz, $9::timestamptz)`,
    [todayKst(), status, `${todayKst()}T00:00:00+09:00`, iso(v.getTime() - 40 * 60000), attempts, error, brief && JSON.stringify(brief), items, iso(v.getTime() - 20 * 60000)]
  );
}
const briefRow = async () => (await q("SELECT status, attempt_count, error, item_count, md5(brief::text) AS brief_md5, updated_at FROM daily_briefs WHERE brief_date = $1::date", [todayKst()]))[0];
const attemptRows = async () => q('SELECT failure_count, error FROM daily_brief_attempts ORDER BY id');
const doctorDoc = async () => (await q("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'ops_doctor'"))[0]?.last_totals || null;

// ---- fakes at the system edge ----
function fakeFetch({ status = 202, throwError = false, onCall = async () => {} } = {}) {
  const calls = [];
  const prev = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), depth: init && init.headers && init.headers['x-cron-chain'], hasAuth: Boolean(init && init.headers && init.headers.authorization) });
    if (throwError) throw new Error('network down');
    await onCall();
    return { status, ok: status < 400 };
  };
  return { calls, restore: () => { global.fetch = prev; } };
}
function fakeProvider(behaviour) {
  const calls = { n: 0 };
  const prev = provider.callProvider;
  provider.callProvider = async (m) => { calls.n++; return behaviour(m, calls.n); };
  return { calls, restore: () => { provider.callProvider = prev; } };
}
const goodAnswer = (ids) => JSON.stringify({
  lead: '인도네시아가 팜유 수출 부과금을 인상했다',
  market_summary: '수출 부과금 인상으로 팜유 공급 부담이 커진다. 가격 상승 압력이 이어진다.',
  developments: ids.slice(0, 3).map((id, i) => ({ item_id: id, importance: 4, summary: `인도네시아가 팜유 수출 부과금을 ${i + 1}% 인상`, significance: '공급 부담으로 가격 상승 압력' })),
  watchpoints: ['후속 조치 여부'],
});
const badAnswer = 'Let me analyze the task. The format is {"lead":"x","developments":[...],"watchpoints":[...]}';

const base = (v) => ({ mode: 'recover', recoveryEnabled: true, now: v, clock: () => v.getTime() + 30000 });

test('SETUP: the database is local and has the production tables', opts, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new globalThis.URL(URL_).hostname));
  const t = await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('items','daily_briefs','daily_brief_attempts','scheduler_jobs')");
  assert.equal(t[0].n, 4);
});

// ===================== kick_pipeline =====================

test('kick_pipeline SUCCESS: a stalled collection is restarted through the real kick (claim row + hand-off), re-checked, and reported as improving', opts, async () => {
  await reset(); const v = at910();
  await seedCursorStalled(v);
  // the "next hop" starts working: it takes the lease on the cursor, exactly what a real hop does
  const net = fakeFetch({ onCall: async () => { await q(`UPDATE scheduler_jobs SET last_totals = jsonb_set(jsonb_set(last_totals, '{leaseUntil}', to_jsonb($1::bigint)), '{savedAt}', to_jsonb($2::bigint)) WHERE job_name = 'daily_discovery_cursor'`, [v.getTime() + 600000, v.getTime() + 25000]); } });
  try {
    const r = await doctor.runDoctor(base(v));
    assert.equal(r.before.failing.includes('discovery_run:fail'), true);
    assert.deepEqual(r.findings.find((f) => f.checkId === 'discovery_run').action, 'kick_pipeline');
    assert.equal(net.calls.length, 1, 'exactly one hand-off');
    assert.match(net.calls[0].url, /\/api\/cron\/daily$/);
    assert.equal(net.calls[0].depth, '1');
    assert.equal(net.calls[0].hasAuth, true);
    assert.equal(r.actions[0].result.kicked, true);
    assert.equal(r.outcome, 'improving');
    assert.equal(r.after.failing.includes('discovery_run:fail'), false);
    assert.equal(r.humanNeeded, false);
    assert.equal((await q("SELECT count(*)::int AS n FROM scheduler_jobs WHERE job_name = 'pipeline_kick'"))[0].n, 1, 'the kick claim row exists');
    const d = await doctorDoc();
    assert.equal(d.days[todayKst()].rounds, 1);
    assert.equal(d.reports.length, 1);
    assert.equal(d.reports[0].outcome, 'improving');
    assert.equal(d.lock.until, 0, 'lease released');
    assert.ok(!JSON.stringify(d).includes('doctor-test-secret-value'), 'the cron secret is not stored');
    assert.ok(!JSON.stringify(r).includes('doctor-test-secret-value'), 'nor returned');
  } finally { net.restore(); }
});

test('kick_pipeline UNRECOVERABLE: the hop is accepted but nothing moves -> unresolved + a person is told, and the next run does NOT kick again', opts, async () => {
  await reset(); const v = at910();
  await seedCursorStalled(v);
  const net = fakeFetch({ status: 202 }); // accepted, never works
  try {
    const first = await doctor.runDoctor(base(v));
    assert.equal(first.outcome, 'unresolved');
    assert.equal(first.humanNeeded, true);
    assert.equal(first.after.failing.includes('discovery_run:fail'), true);
    assert.equal(net.calls.length, 1);
    const later = new Date(v.getTime() + 15 * 60000); // past the cooldown, same day
    const second = await doctor.runDoctor({ ...base(later), clock: () => later.getTime() + 30000 });
    assert.equal(net.calls.length, 1, 'no second hand-off for a problem the first one did not fix');
    assert.equal(second.outcome, 'limit_reached');
    assert.ok(second.plan.skipped.some((s) => /already_failed/.test(s.reason)));
    const d = await doctorDoc();
    assert.equal(d.days[todayKst()].rounds, 1, 'the skipped run consumed no round');
    assert.equal(Object.values(d.days[todayKst()].byKey)[0].unresolved, 1);
    assert.equal(d.reports.length, 2);
  } finally { net.restore(); }
});

test('kick_pipeline FAULT: the hand-off itself fails (network down) -> the real retry runs, the failure is reported, nothing is invented', opts, async () => {
  await reset(); const v = at910();
  await seedCursorStalled(v);
  const net = fakeFetch({ throwError: true });
  try {
    const r = await doctor.runDoctor(base(v));
    assert.equal(net.calls.length, 3, 'the hand-off was tried 3 times by the existing retry');
    assert.match(String(r.actions[0].result.result), /hop_1_failed_network down/);
    assert.equal(r.outcome, 'unresolved');
    assert.equal(r.humanNeeded, true);
  } finally { net.restore(); }
});

test('kick_pipeline consistency: the executor judges the same moment as the diagnosis (the doctor clock), not the wall clock', opts, async () => {
  await reset(); const v = at910();
  await seedCursorStalled(v);
  const net = fakeFetch({ onCall: async () => { await q(`UPDATE scheduler_jobs SET last_totals = jsonb_set(last_totals, '{leaseUntil}', to_jsonb($1::bigint)) WHERE job_name = 'daily_discovery_cursor'`, [v.getTime() + 600000]); } });
  try {
    const r = await doctor.runDoctor(base(v));
    // 09:10 KST is inside the kick window (07:00-12:00 KST) whatever the real time of day is
    assert.equal(r.actions[0].result.kicked, true, `the kick was judged at ${new Date(v).toISOString()}, got ${JSON.stringify(r.actions[0].result)}`);
  } finally { net.restore(); }
});

// ===================== retry_headline =====================

test('retry_headline SUCCESS: a failed headline is regenerated once through the real guard, re-checked, and reported as recovered; DB agrees with the report', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3);
  await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  const llm = fakeProvider(() => goodAnswer(ids));
  try {
    const r = await doctor.runDoctor(base(v));
    const f = r.findings.find((x) => x.checkId === 'headline');
    assert.deepEqual([f.cause, f.classification, f.action], ['ai_provider_transient', 'retryable', 'retry_headline']);
    assert.equal(r.actions[0].result.ran, true);
    assert.equal(llm.calls.n, 1, 'one model call');
    assert.equal(r.outcome, 'recovered');
    assert.equal(r.humanNeeded, false);
    const row = await briefRow();
    assert.equal(row.status, 'ready');
    assert.equal(row.attempt_count, 4, 'one claim');
    assert.equal(row.item_count, 3);
    assert.equal((await q('SELECT count(*)::int AS n FROM daily_briefs'))[0].n, 1, 'no duplicate headline row');
    assert.deepEqual(await attemptRows(), [], 'no failed attempt was logged');
    const d = await doctorDoc();
    assert.equal(d.days[todayKst()].rounds, 1);
    assert.equal(d.reports[0].outcome, 'recovered');
    assert.equal(r.after.failing.includes('headline:fail'), false);
  } finally { llm.restore(); }
});

test('retry_headline UNRECOVERABLE: the model keeps answering with a format description -> bounded attempts, unresolved, a person is told, next run does not retry', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'brief_placeholder_output | head=Let me analyze' });
  const llm = fakeProvider(() => badAnswer);
  try {
    // 75 s of invocation time: enough for the first attempt and one retry (5 s wait), then the guard releases the row for the next call
    const r = await doctor.runDoctor({ ...base(v), executorTimeoutMs: 75000 });
    assert.equal(r.findings.find((f) => f.checkId === 'headline').cause, 'model_output_invalid');
    assert.equal(r.outcome, 'unresolved');
    assert.equal(r.humanNeeded, true);
    assert.ok(llm.calls.n >= 1 && llm.calls.n <= doctor.MAX_MODEL_CALLS_PER_RECOVERY, `bounded model calls, got ${llm.calls.n}`);
    const row = await briefRow();
    assert.equal(row.status, 'failed', 'the row is released, never left generating');
    assert.match(row.error, /^(call_budget_exhausted|retry_deferred): brief_placeholder_output/);
    const attempts = await attemptRows();
    assert.equal(attempts.length, llm.calls.n, 'every model call has a logged failure');
    const callsBefore = llm.calls.n;
    const later = new Date(v.getTime() + 15 * 60000);
    const second = await doctor.runDoctor({ ...base(later), clock: () => later.getTime() + 30000, executorTimeoutMs: 75000 });
    assert.equal(llm.calls.n, callsBefore, 'no further model call for a problem recovery already failed to fix');
    assert.equal(second.outcome, 'limit_reached');
  } finally { llm.restore(); }
}, { ...opts, timeout: 120000 });

test('retry_headline LIMIT: with the automatic attempt cap reached nothing is executed — a person is needed and the model is never called', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 20, error: 'AI provider timeout' });
  const llm = fakeProvider(() => { throw new Error('must not be called'); });
  try {
    const r = await doctor.runDoctor(base(v));
    assert.equal(r.findings.find((f) => f.checkId === 'headline').cause, 'attempt_cap_reached');
    assert.equal(r.outcome, 'needs_human');
    assert.equal(r.humanNeeded, true);
    assert.equal(llm.calls.n, 0);
    assert.equal((await briefRow()).attempt_count, 20, 'row untouched');
  } finally { llm.restore(); }
});

test('retry_headline SAFETY: the executor never touches a READY headline (row unchanged, no model call)', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'ready', attempts: 2, items: 3, brief: { lead: 'x', market_summary: 'y', developments: [], watchpoints: [] } });
  const before = await briefRow();
  const llm = fakeProvider(() => { throw new Error('must not be called'); });
  try {
    const res = await doctor.defaultExecutors.retry_headline({ deadlineAt: Date.now() + 120000 });
    assert.deepEqual(res, { ran: false, reason: 'up_to_date', stillRunning: 0, modelCalls: 0, maxModelCalls: 2, budgetExhausted: false, timeBudgetExceeded: false });
    assert.deepEqual(await briefRow(), before);
    assert.equal(llm.calls.n, 0);
  } finally { llm.restore(); }
});

// ===================== concurrency, persistence failure, time limits =====================

test('CONCURRENT: three doctors that all diagnosed the same failure and start together -> exactly one executes (one lease, one model call, one claim); the others report "locked"', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  const llm = fakeProvider(async () => { await new Promise((r) => setTimeout(r, 300)); return goodAnswer(ids); });
  // barrier: nobody may act before all three have read the failed state (otherwise a late doctor would simply see the repair in progress)
  let arrived = 0; let open; const gate = new Promise((res) => { open = res; });
  try {
    const mk = () => { let used = false; return doctor.runDoctor({ ...base(v), gather: async (now) => { const ctx = await doctor.collectContext(now); if (!used) { used = true; arrived++; if (arrived === 3) open(); await gate; } return ctx; } }); };
    const results = await Promise.all([mk(), mk(), mk()]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['locked', 'locked', 'recovered']);
    assert.equal(llm.calls.n, 1, 'one model call in total');
    assert.equal((await briefRow()).attempt_count, 4, 'one claim in total');
    const d = await doctorDoc();
    assert.equal(d.days[todayKst()].rounds, 1);
    assert.equal(d.lock.until, 0);
    assert.equal(results.filter((r) => r.actions.length).length, 1);
  } finally { llm.restore(); }
});

test('CONCURRENT (late doctor): a doctor that starts after the repair began sees it in progress and does nothing — the headline guard is the second line of defence', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  const llm = fakeProvider(async () => { await new Promise((r) => setTimeout(r, 400)); return goodAnswer(ids); });
  try {
    const first = doctor.runDoctor(base(v));
    await new Promise((r) => setTimeout(r, 150)); // the first doctor has claimed the headline by now
    const late = await doctor.runDoctor(base(v));
    assert.equal(late.actions.length, 0);
    assert.notEqual(late.outcome, 'recovered');
    await first;
    assert.equal(llm.calls.n, 1);
    assert.equal((await briefRow()).attempt_count, 4);
  } finally { llm.restore(); }
});

test('STATE PERSISTENCE FAILURE: when the doctor cannot store its lease (database rejects the write), nothing is executed and a person is told', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  await q(`CREATE OR REPLACE FUNCTION fail_doctor_writes_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$ LANGUAGE plpgsql`);
  await q(`CREATE TRIGGER fail_doctor_writes BEFORE INSERT OR UPDATE ON scheduler_jobs FOR EACH ROW WHEN (NEW.job_name = 'ops_doctor') EXECUTE FUNCTION fail_doctor_writes_fn()`);
  const llm = fakeProvider(() => { throw new Error('must not be called'); });
  try {
    const r = await doctor.runDoctor(base(v));
    assert.equal(r.outcome, 'state_unavailable');
    assert.equal(r.humanNeeded, true);
    assert.equal(llm.calls.n, 0, 'no recovery without a stored lease');
    const row = await briefRow();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt_count, 3, 'headline row untouched');
    assert.equal(await doctorDoc(), null, 'nothing was stored');
  } finally { llm.restore(); await q('DROP TRIGGER IF EXISTS fail_doctor_writes ON scheduler_jobs'); }
});

test('TIME LIMIT (invocation): with too little time left the headline guard declines, the row is untouched, and the outcome is not_applied (not a false "recovered")', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  const before = await briefRow();
  const llm = fakeProvider(() => { throw new Error('must not be called'); });
  try {
    const r = await doctor.runDoctor({ ...base(v), executorTimeoutMs: 40000 }); // deadline = 40 s < the 60 s one attempt needs
    assert.deepEqual(r.actions[0].result, { ran: false, reason: 'insufficient_time', stillRunning: 0, modelCalls: 0, maxModelCalls: 2, budgetExhausted: false, timeBudgetExceeded: false });
    assert.equal(r.outcome, 'not_applied');
    assert.equal(r.humanNeeded, true);
    assert.equal(llm.calls.n, 0);
    assert.deepEqual(await briefRow(), before);
    const d = await doctorDoc();
    assert.equal(Object.values(d.days[todayKst()].byKey)[0].unresolved, undefined, 'a declined recovery is not counted as a failed one');
  } finally { llm.restore(); }
});

test('TIME LIMIT (run budget): when earlier work used the budget, the next action is skipped with a clear reason and the lease is still released', opts, async () => {
  await reset(); const v = at910();
  await seedCursorStalled(v);
  const net = fakeFetch();
  try {
    let t = v.getTime();
    const r = await doctor.runDoctor({ ...base(v), clock: () => { const x = t; t += 240000; return x; } }); // every clock read burns 4 minutes
    assert.equal(r.actions[0].error, 'skipped_no_time_left');
    assert.equal(net.calls.length, 0, 'the action did not start');
    assert.equal((await doctorDoc()).lock.until, 0);
  } finally { net.restore(); }
});

test('TIME LIMIT (slow generation): a generation that outlives the doctor\'s wait is reported as in progress — never as recovered — and no second attempt is started', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  let release; const hang = new Promise((res) => { release = res; });
  const llm = fakeProvider(() => hang);
  // enough invocation time for the guard to allow the attempt (>= 60 s), but the doctor's wait for the background generation is cut to 0.5 s
  const bg = require('../server/lib/background'); const realDrain = bg.drain; bg.drain = () => realDrain(500);
  try {
    const r = await doctor.runDoctor({ ...base(v), executorTimeoutMs: 70000 });
    assert.ok(r.actions[0].result.stillRunning >= 1, `the action says the generation is still running: ${JSON.stringify(r.actions[0])}`);
    assert.equal(r.outcome, 'improving');
    assert.notEqual(r.outcome, 'recovered', 'an unfinished generation is never reported as a success');
    assert.equal(r.humanNeeded, false);
    assert.equal(llm.calls.n, 1);
    assert.equal((await briefRow()).status, 'generating', 'the database says the same');
  } finally { bg.drain = realDrain; release(JSON.stringify({ lead: 'x', market_summary: 'y', developments: [], watchpoints: [] })); llm.restore(); await new Promise((res) => setTimeout(res, 300)); }
});

test('TIME LIMIT (executor timeout): an executor that does not return at all is cut off, recorded as executor_timeout, and not reported as a success', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  const r = await doctor.runDoctor({ ...base(v), executorTimeoutMs: 800, executors: { retry_headline: () => new Promise(() => {}) } });
  assert.equal(r.actions[0].error, 'executor_timeout');
  assert.equal(r.outcome, 'unresolved');
  assert.equal(r.humanNeeded, true);
  assert.equal((await doctorDoc()).lock.until, 0, 'the lease is released even after a timeout');
});

test('REPORT ACCURACY: the stored report matches what actually happened (actions, counters, outcome) after a mixed day', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  const llm = fakeProvider(() => goodAnswer(ids));
  try {
    const r = await doctor.runDoctor(base(v));
    const d = await doctorDoc();
    const stored = d.reports[d.reports.length - 1];
    assert.equal(stored.outcome, r.outcome);
    assert.deepEqual(stored.actions, [{ action: 'retry_headline', error: null }]);
    assert.equal(llm.calls.n, 1);
    assert.deepEqual(stored.before, ['headline:fail']);
    assert.equal(d.days[todayKst()].rounds, 1);
    assert.equal(Object.values(d.days[todayKst()].byKey)[0].count, 1);
    assert.equal(Object.values(d.days[todayKst()].byKey)[0].lastResult, 'recovered');
  } finally { llm.restore(); }
});

test.after(async () => { if (pool) { try { await reset(); } catch (_) { /* best effort */ } await pool.end(); } });

// ===================== hardening: provider/HTTP failures, pool contention, preflight, honest outcomes (real DB, real executors) =====================

const httpError = (msg) => { throw new Error(msg); };

test('PROVIDER 503 then healthy: the real retry regenerates once and the DB agrees with a recovered report', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 503' });
  const llm = fakeProvider(() => goodAnswer(ids));
  try {
    const r = await doctor.runDoctor(base(v));
    assert.deepEqual([r.findings.find((f) => f.checkId === 'headline').cause, llm.calls.n, r.outcome, r.humanNeeded], ['ai_provider_transient', 1, 'recovered', false]);
    assert.equal((await briefRow()).status, 'ready');
  } finally { llm.restore(); }
});

test('PROVIDER 503 persists: bounded to ONE model call, unresolved + person needed, and the next run (past cooldown) makes no further call', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 503' });
  const llm = fakeProvider(() => httpError('AI provider returned 503'));
  try {
    const first = await doctor.runDoctor(base(v));
    // ONE doctor attempt = one claim of the guard under an explicit budget of MAX_MODEL_CALLS_PER_RECOVERY model calls (the guard alone allows 6)
    const used = llm.calls.n;
    assert.deepEqual([first.outcome, first.humanNeeded, used], ['unresolved', true, doctor.MAX_MODEL_CALLS_PER_RECOVERY]);
    assert.deepEqual([first.actions[0].result.modelCalls, first.actions[0].result.budgetExhausted], [used, true], 'the report says how many calls were spent and that the budget ran out');
    const row = await briefRow();
    assert.notEqual(row.status, 'ready', 'no false ready');
    assert.equal(row.status, 'failed');
    assert.match(row.error, /^call_budget_exhausted: /);
    const later = new Date(v.getTime() + 45 * 60000);
    const second = await doctor.runDoctor({ ...base(later), clock: () => later.getTime() + 30000 });
    assert.deepEqual([llm.calls.n, second.outcome], [used, 'limit_reached'], 'no further model call for a problem the first retry did not fix');
    assert.equal((await doctorDoc()).days[todayKst()].rounds, 1);
  } finally { llm.restore(); }
});

test('PROVIDER 401 (rejected key): the model is never called, nothing is claimed or counted, a person is told', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 401 Unauthorized' });
  const before = await briefRow();
  const llm = fakeProvider(() => httpError('must not be called'));
  try {
    const r = await doctor.runDoctor(base(v));
    assert.deepEqual([r.outcome, r.humanNeeded, llm.calls.n, r.actions], ['needs_human', true, 0, []]);
    assert.equal((await briefRow()).attempt_count, before.attempt_count);
    assert.equal((await doctorDoc()).days, undefined, 'no round or attempt was consumed');
  } finally { llm.restore(); }
});

test('DB POOL CONTENTION: inside the 30 min contention cooldown nothing runs; after it the retry runs once; a deferred round (preflight) costs nothing', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'timeout exceeded when trying to connect' });
  await q(`INSERT INTO scheduler_jobs (job_name, last_run_date, last_totals) VALUES ('ops_doctor', $1::date, $2::jsonb)`,
    [todayKst(), JSON.stringify({ days: { [todayKst()]: { rounds: 1, byKey: { 'headline:db_pool_contention': { count: 1, lastAt: v.getTime() - 15 * 60000 } } } } })]);
  const llm = fakeProvider(() => goodAnswer([1, 2, 3]));
  try {
    const inside = await doctor.runDoctor(base(v));
    assert.deepEqual([llm.calls.n, inside.plan.skipped.map((s) => s.reason)], [0, ['cooldown']]);
    const later = new Date(v.getTime() + 20 * 60000); // 35 min after the first attempt
    const deferred = await doctor.runDoctor({ ...base(later), clock: () => later.getTime() + 30000, preflight: async () => ({ ok: false, reason: 'pool_saturated' }) });
    assert.deepEqual([deferred.outcome, llm.calls.n, (await doctorDoc()).days[todayKst()].rounds], ['deferred_db_unhealthy', 0, 1]);
    assert.equal((await doctorDoc()).days[todayKst()].byKey['headline:db_pool_contention'].count, 1, 'the deferred round counted no attempt');
    const ids = (await q('SELECT id FROM items ORDER BY id')).map((r) => r.id);
    llm.restore(); const llm2 = fakeProvider(() => goodAnswer(ids));
    try {
      const ran = await doctor.runDoctor({ ...base(later), clock: () => later.getTime() + 30000 });
      assert.deepEqual([llm2.calls.n, ran.outcome], [1, 'recovered']);
    } finally { llm2.restore(); }
  } finally { llm.restore(); }
});

test('REAL PREFLIGHT: with the real pool the preflight passes; a saturated pool defers the round with the real executors untouched', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider timeout' });
  assert.deepEqual(await doctor.dbPreflight(), { ok: true });
  const llm = fakeProvider(() => httpError('must not be called'));
  const desc = Object.getOwnPropertyDescriptor(pool, 'waitingCount');
  try {
    Object.defineProperty(pool, 'waitingCount', { value: 3, configurable: true });
    const r = await doctor.runDoctor(base(v));
    assert.deepEqual([r.outcome, r.humanNeeded, llm.calls.n, await doctorDoc().then((d) => d && d.lock)], ['deferred_db_unhealthy', false, 0, undefined]);
  } finally { if (desc) Object.defineProperty(pool, 'waitingCount', desc); else delete pool.waitingCount; llm.restore(); }
});

test('BUDGET success: one transient 503 then a good answer is recovered inside the budget (2 calls), verified by the re-check, budget not exhausted', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 503' });
  const llm = fakeProvider((m, n) => (n === 1 ? httpError('AI provider returned 503') : goodAnswer(ids)));
  try {
    const r = await doctor.runDoctor(base(v));
    assert.deepEqual([llm.calls.n, r.actions[0].result.modelCalls, r.actions[0].result.budgetExhausted], [2, 2, false]);
    assert.deepEqual([r.outcome, r.humanNeeded, r.after.status === 'ok' || r.after.status === 'warn'], ['recovered', false, true]);
    assert.equal((await briefRow()).status, 'ready');
  } finally { llm.restore(); }
});

test('BUDGET time: the executor cannot be given more than RECOVERY_TIME_BUDGET_MS — with a tiny deadline the model is never called and nothing is claimed', opts, async () => {
  await reset(); const v = at910();
  await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 503' });
  const before = await briefRow();
  const llm = fakeProvider(() => httpError('must not be called'));
  try {
    const res = await doctor.defaultExecutors.retry_headline({ deadlineAt: Date.now() + 20000, now: v });
    assert.deepEqual([res.ran, res.reason, llm.calls.n, res.modelCalls], [false, 'insufficient_time', 0, 0]);
    assert.equal((await briefRow()).attempt_count, before.attempt_count);
    assert.ok(doctor.RECOVERY_TIME_BUDGET_MS < 200000, 'tighter than the executor timeout');
  } finally { llm.restore(); }
});

test('SHARED DAILY CAP: the Doctor\'s headline claim and the pipeline\'s own completion-path generation (the one a kick_pipeline restart leads to) draw on ONE daily attempt counter — at the cap neither can start a model call', opts, async () => {
  await reset(); const v = at910();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: dailyBrief.MAX_AUTO_DAILY_ATTEMPTS - 1, error: 'AI provider returned 503' });
  const llm = fakeProvider(() => goodAnswer(ids));
  try {
    // one attempt left: the Doctor takes it (attempt_count -> cap) and the headline is generated
    const r = await doctor.runDoctor(base(v));
    assert.equal(llm.calls.n, 1);
    assert.equal((await briefRow()).attempt_count, dailyBrief.MAX_AUTO_DAILY_ATTEMPTS);
    assert.equal(r.outcome, 'recovered');
    // the completion path (what a restarted collection triggers) is now refused on the same counter, even for a failed row
    await q("UPDATE daily_briefs SET status = 'failed' WHERE brief_date = $1::date", [todayKst()]);
    const q2 = await dailyBrief.queueDailyBriefGeneration(v);
    assert.equal(q2.started, false, JSON.stringify(q2));
    assert.equal(llm.calls.n, 1, 'no model call from the completion path at the cap');
    // and the Doctor, in turn, reports the cap and asks for a person instead of calling the model
    const later = new Date(v.getTime() + 45 * 60000);
    const r2 = await doctor.runDoctor({ ...base(later), clock: () => later.getTime() + 30000 });
    assert.equal(llm.calls.n, 1);
    assert.equal(r2.findings.find((f) => f.checkId === 'headline').cause, 'attempt_cap_reached');
    assert.equal(r2.humanNeeded, true);
  } finally { llm.restore(); }
});

// ===================== scripts/doctor-trial.js (backup / restore / trial-day check) — same file so the suites never share the database concurrently =====================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const trial = URL_ ? require('../scripts/doctor-trial') : null;
const seedDoctor = (totals) => q(`INSERT INTO scheduler_jobs (job_name, last_run_date, last_totals) VALUES ('ops_doctor', $1::date, $2::jsonb)`, [todayKst(), JSON.stringify(totals)]);

test('TRIAL SCRIPT backup -> damage -> restore: dry run changes nothing; --apply puts back EXACTLY the two rows (jsonb-identical) and leaves everything else alone', opts, async () => {
  await reset(); const v = at910();
  await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 503' });
  await seedDoctor({ days: { [todayKst()]: { rounds: 0 } }, reports: [{ at: 'x', mode: 'diagnose' }] });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trial-')), 'b.json');
  const saved = await trial.backup(pool, { date: todayKst(), file });
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'backup file is private');
  // what a recovery could do
  await q("UPDATE daily_briefs SET status = 'ready', attempt_count = 7, error = NULL, brief = '{\"lead\":\"x\"}'::jsonb, item_count = 5 WHERE brief_date = $1::date", [todayKst()]);
  await q("UPDATE scheduler_jobs SET last_totals = '{\"days\":{},\"reports\":[1,2,3]}'::jsonb WHERE job_name = 'ops_doctor'");
  const discoveryBefore = await q("SELECT to_jsonb(t) AS r FROM scheduler_jobs t WHERE job_name = 'daily_discovery'");
  const attemptsBefore = await q('SELECT count(*)::int AS n FROM daily_brief_attempts');
  const dry = await trial.restore(pool, saved);
  assert.deepEqual(dry, { daily_briefs: 'differs from backup (dry run)', ops_doctor: 'differs from backup (dry run)' });
  assert.equal((await q('SELECT status FROM daily_briefs'))[0].status, 'ready', 'dry run wrote nothing');
  const done = await trial.restore(pool, JSON.parse(fs.readFileSync(file, 'utf8')), { apply: true });
  assert.deepEqual(done, { daily_briefs: 'restored', ops_doctor: 'restored' });
  const again = await trial.restore(pool, saved);
  assert.deepEqual(again, { daily_briefs: 'identical to backup', ops_doctor: 'identical to backup' });
  const b = (await q('SELECT status, attempt_count, error, item_count FROM daily_briefs'))[0];
  assert.deepEqual([b.status, b.attempt_count, b.error, b.item_count], ['failed', 3, 'AI provider returned 503', 0]);
  assert.deepEqual(await q("SELECT to_jsonb(t) AS r FROM scheduler_jobs t WHERE job_name = 'daily_discovery'"), discoveryBefore, 'other rows untouched');
  assert.deepEqual(await q('SELECT count(*)::int AS n FROM daily_brief_attempts'), attemptsBefore);
});

test('TRIAL SCRIPT restore never invents or deletes: a row that did not exist at backup time is left for a human', opts, async () => {
  await reset();
  const saved = await trial.backup(pool, { date: todayKst() });
  assert.deepEqual([saved.rows.daily_briefs, saved.rows.ops_doctor], [null, null]);
  await seedBrief(at910(), { status: 'failed', attempts: 1 });
  const r = await trial.restore(pool, saved, { apply: true });
  assert.match(r.daily_briefs, /no row existed at backup time/);
  assert.equal((await q('SELECT count(*)::int AS n FROM daily_briefs'))[0].n, 1, 'nothing was deleted');
});

test('TRIAL SCRIPT check: GO only when exactly one retry_headline finding, attempts left, planner would run it, and a fresh backup exists; each missing item flips it to NO-GO', opts, async () => {
  await reset(); const v = at910();
  await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error: 'AI provider returned 503' });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trial-')), 'b.json');
  const noBackup = await trial.check(pool, { now: v, date: todayKst(), backupFile: path.join(os.tmpdir(), 'does-not-exist.json') });
  assert.equal(noBackup.go, false);
  assert.deepEqual(noBackup.checks.filter((c) => !c.ok).map((c) => c.name.slice(0, 20)), ['a backup of ' + todayKst()].map((s) => s.slice(0, 20)));
  await trial.backup(pool, { date: todayKst(), file });
  const go = await trial.check(pool, { now: v, date: todayKst(), backupFile: file });
  assert.equal(go.go, true, JSON.stringify(go.checks.filter((c) => !c.ok)));
  assert.deepEqual(go.eligible.map((e) => e.action), ['retry_headline']);
  assert.ok(go.manual.length === 2);
  // not enough attempts left today
  await q('UPDATE daily_briefs SET attempt_count = $1 WHERE brief_date = $2::date', [dailyBrief.MAX_AUTO_DAILY_ATTEMPTS - 2, todayKst()]);
  const low = await trial.check(pool, { now: v, date: todayKst(), backupFile: file });
  assert.deepEqual([low.go, low.checks.find((c) => /attempts left/.test(c.name)).ok], [false, false]);
  // a problem the Doctor already failed to fix today is not a trial candidate
  await q('UPDATE daily_briefs SET attempt_count = 3 WHERE brief_date = $1::date', [todayKst()]);
  await seedDoctor({ days: { [todayKst()]: { rounds: 1, byKey: { 'headline:ai_provider_transient': { count: 1, unresolved: 1, lastAt: v.getTime() - 3600000 } } } } });
  const failedBefore = await trial.check(pool, { now: v, date: todayKst(), backupFile: file });
  assert.equal(failedBefore.go, false);
  assert.equal(failedBefore.checks.find((c) => /planner would run/.test(c.name)).ok, false);
});

test('TRIAL SCRIPT check: a healthy/ready pipeline (what today looks like) is NO-GO — no eligible finding', opts, async () => {
  await reset(); const v = at910();
  await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'ready', attempts: 1, items: 3, brief: { lead: 'x', market_summary: 'y', developments: [], watchpoints: [] } });
  const r = await trial.check(pool, { now: v, date: todayKst(), backupFile: '/nonexistent' });
  assert.equal(r.go, false);
  assert.equal(r.checks.find((c) => /exactly one/.test(c.name)).ok, false);
});

// ===================== one-run approval (DOCTOR_RECOVERY stays OFF in every one of these) =====================
const approvalStore = { mutate: (fn) => require('../server/lib/jobState').mutateJobState('ops_doctor', fn) };
const KEY = 'headline:ai_provider_transient';
const noEnv = (v, extra = {}) => ({ ...base(v), recoveryEnabled: false, ...extra }); // the env flag is off: only an approval can permit recovery
const approvalRow = async () => (await doctorDoc())?.approval || null;
async function arm(v, over = {}) {
  const r = await doctor.armApproval(approvalStore, { key: KEY, now: v.getTime() - 60000, by: 'test', ...over });
  assert.equal(r.armed, true, JSON.stringify(r));
  return r.approval;
}
async function failedHeadlineDay(v, error = 'AI provider returned 503') {
  await reset();
  const ids = await seedItems(3); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'failed', attempts: 3, error });
  return ids;
}

test('APPROVAL happy path: with the env flag OFF, one valid approval permits exactly one retry_headline (budgeted, verified), and is consumed', opts, async () => {
  const v = at910(); const ids = await failedHeadlineDay(v);
  const a = await arm(v);
  assert.equal(a.expiresAt - a.createdAt, 15 * 60000);
  const llm = fakeProvider(() => goodAnswer(ids));
  try {
    const r = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([r.recoveryEnabled, r.actions.map((x) => x.action), llm.calls.n, r.outcome, r.humanNeeded], [false, ['retry_headline'], 1, 'recovered', false]);
    assert.equal(r.actions[0].result.maxModelCalls, doctor.MAX_MODEL_CALLS_PER_RECOVERY, 'the cost budget still applies');
    assert.equal(r.approval.status, 'consumed');
    assert.match(r.summary, /one-run approval .* consumed/);
    const ap = await approvalRow();
    assert.deepEqual([ap.status, ap.id, typeof ap.consumedAt, Boolean(ap.consumedBy)], ['consumed', a.id, 'number', true]);
    assert.equal((await briefRow()).status, 'ready');
    assert.equal((await doctorDoc()).days[todayKst()].rounds, 1);
  } finally { llm.restore(); }
});

test('APPROVAL replay: a consumed approval cannot authorise a second run — even when the headline fails again', opts, async () => {
  const v = at910(); const ids = await failedHeadlineDay(v);
  await arm(v);
  const llm = fakeProvider(() => goodAnswer(ids));
  try {
    await doctor.runDoctor(noEnv(v));
    await q("UPDATE daily_briefs SET status = 'failed', error = 'AI provider returned 503' WHERE brief_date = $1::date", [todayKst()]);
    const later = new Date(v.getTime() + 45 * 60000);
    const r = await doctor.runDoctor(noEnv(later, { clock: () => later.getTime() + 30000 }));
    assert.deepEqual([r.actions, llm.calls.n, r.outcome, r.approval.reason], [[], 1, 'recovery_not_permitted', 'already_used']);
  } finally { llm.restore(); }
});

test('APPROVAL expiry: an approval older than its ~15 min life permits nothing, and a stored life longer than 20 min is treated as tampered', opts, async () => {
  const v = at910(); await failedHeadlineDay(v);
  await arm(v, { now: v.getTime() - 16 * 60000 }); // expired a minute ago
  const llm = fakeProvider(() => httpError('must not be called'));
  try {
    const r = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([r.actions, llm.calls.n, r.approval.reason], [[], 0, 'expired']);
    assert.equal((await approvalRow()).status, 'pending', 'a rejected approval is not consumed');
    await q(`UPDATE scheduler_jobs SET last_totals = jsonb_set(last_totals, '{approval,expiresAt}', to_jsonb($1::bigint)) WHERE job_name = 'ops_doctor'`, [v.getTime() + 3 * 3600000]);
    const t = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([t.actions, llm.calls.n, t.approval.reason], [[], 0, 'ttl_invalid']);
  } finally { llm.restore(); }
});

test('APPROVAL wrong action / wrong key / ambiguity: kick_pipeline is never permitted, a mismatching key is rejected, and two eligible findings reject everything', opts, async () => {
  const v = at910();
  await reset(); await seedCursorStalled(v); // a stalled collection: the only eligible finding is kick_pipeline
  await arm(v);
  const net = fakeFetch({ status: 202 });
  try {
    const r = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([net.calls.length, r.actions, r.approval.reason], [0, [], 'wrong_action']);
    assert.equal((await approvalRow()).status, 'pending');
  } finally { net.restore(); }
  assert.equal((await doctor.armApproval(approvalStore, { key: 'discovery_run:continuation_lost', now: v.getTime() })).reason, 'only_headline_findings_can_be_approved');
  assert.equal((await doctor.armApproval(approvalStore, { key: 'kick_pipeline', now: v.getTime() })).reason, 'only_headline_findings_can_be_approved');
  // an approval whose stored action was edited to kick_pipeline is rejected as well
  await q(`UPDATE scheduler_jobs SET last_totals = jsonb_set(last_totals, '{approval,action}', '"kick_pipeline"') WHERE job_name = 'ops_doctor'`);
  const k = await doctor.runDoctor(noEnv(v));
  assert.equal(k.approval.reason, 'wrong_action');

  const w = at910(); await failedHeadlineDay(w, 'brief_placeholder_output | head=x'); // cause model_output_invalid, approval is for ai_provider_transient
  await arm(w);
  const llm = fakeProvider(() => httpError('must not be called'));
  const net2 = fakeFetch({ status: 202 });
  try {
    const m = await doctor.runDoctor(noEnv(w));
    assert.deepEqual([m.actions, llm.calls.n, m.approval.reason], [[], 0, 'finding_does_not_match_approval']);
    // ambiguity: a failed headline AND a stalled collection are both eligible -> neither runs
    await seedCursorStalled(w);
    await q("UPDATE scheduler_jobs SET last_completed_at = NULL, last_totals = '{}'::jsonb WHERE job_name = 'daily_discovery'");
    await q("UPDATE daily_briefs SET error = 'AI provider returned 503'");
    const amb = await doctor.runDoctor(noEnv(w));
    assert.deepEqual([amb.actions, llm.calls.n, net2.calls.length], [[], 0, 0]);
    assert.ok(['ambiguous_eligibility', 'finding_does_not_match_approval', 'wrong_action'].includes(amb.approval.reason), amb.approval.reason);
  } finally { llm.restore(); net2.restore(); }
});

test('APPROVAL concurrency: three doctors that all see a valid approval -> exactly one consumes it and executes; the others execute nothing', opts, async () => {
  const v = at910(); const ids = await failedHeadlineDay(v);
  const a = await arm(v);
  const llm = fakeProvider(async () => { await new Promise((r) => setTimeout(r, 300)); return goodAnswer(ids); });
  let arrived = 0; let open; const gate = new Promise((res) => { open = res; });
  try {
    const mk = () => { let used = false; return doctor.runDoctor({ ...noEnv(v), gather: async (now) => { const ctx = await doctor.collectContext(now); if (!used) { used = true; arrived++; if (arrived === 3) open(); await gate; } return ctx; } }); };
    const results = await Promise.all([mk(), mk(), mk()]);
    assert.equal(results.filter((r) => r.actions.length).length, 1);
    assert.equal(results.filter((r) => r.outcome === 'recovered').length, 1);
    assert.ok(results.every((r) => ['recovered', 'locked', 'approval_rejected'].includes(r.outcome)), results.map((r) => r.outcome).join());
    assert.equal(llm.calls.n, 1, 'one model call in total');
    assert.equal((await briefRow()).attempt_count, 4, 'one claim in total');
    const ap = await approvalRow();
    assert.deepEqual([ap.status, ap.id], ['consumed', a.id]);
    assert.equal((await doctorDoc()).days[todayKst()].rounds, 1);
  } finally { llm.restore(); }
});

test('APPROVAL failure during claim: when the consuming write cannot be stored, nothing is executed and the approval is NOT consumed (fail closed, no half state)', opts, async () => {
  const v = at910(); await failedHeadlineDay(v);
  await arm(v);
  await q(`CREATE OR REPLACE FUNCTION fail_doctor_writes_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$ LANGUAGE plpgsql`);
  await q(`CREATE TRIGGER fail_doctor_writes BEFORE UPDATE ON scheduler_jobs FOR EACH ROW WHEN (NEW.job_name = 'ops_doctor') EXECUTE FUNCTION fail_doctor_writes_fn()`);
  const llm = fakeProvider(() => httpError('must not be called'));
  try {
    const r = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([r.outcome, r.humanNeeded, llm.calls.n, r.actions], ['state_unavailable', true, 0, []]);
    assert.equal((await briefRow()).attempt_count, 3, 'headline untouched');
  } finally { llm.restore(); await q('DROP TRIGGER IF EXISTS fail_doctor_writes ON scheduler_jobs'); }
  assert.equal((await approvalRow()).status, 'pending', 'still pending: the write that would consume it never happened');
});

test('APPROVAL failure after consumption: a failed/unresolved recovery keeps the approval consumed (no replay), is unresolved and escalated — never recovered without verification', opts, async () => {
  const v = at910(); await failedHeadlineDay(v);
  await arm(v);
  const llm = fakeProvider(() => httpError('AI provider returned 503'));
  try {
    const r = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([r.outcome, r.humanNeeded, llm.calls.n <= doctor.MAX_MODEL_CALLS_PER_RECOVERY], ['unresolved', true, true]);
    assert.equal((await approvalRow()).status, 'consumed');
    const later = new Date(v.getTime() + 45 * 60000);
    const again = await doctor.runDoctor(noEnv(later, { clock: () => later.getTime() + 30000 }));
    assert.deepEqual([again.actions, again.approval.reason], [[], 'already_used']);
  } finally { llm.restore(); }
}, { ...opts, timeout: 120000 });

test('APPROVAL arm/revoke: only one pending approval at a time; revoke makes it unusable; env-flag behaviour is unchanged by an unused approval', opts, async () => {
  const v = at910(); await failedHeadlineDay(v);
  await arm(v);
  const second = await doctor.armApproval(approvalStore, { key: KEY, now: v.getTime() });
  assert.deepEqual([second.armed, second.reason], [false, 'another_approval_still_pending']);
  await doctor.revokeApproval(approvalStore, { now: v.getTime() });
  const llm = fakeProvider(() => httpError('must not be called'));
  try {
    const r = await doctor.runDoctor(noEnv(v));
    assert.deepEqual([r.actions, llm.calls.n, r.approval.reason], [[], 0, 'already_used']);
    // diagnose mode never looks at approvals at all
    await arm(v);
    const d = await doctor.runDoctor({ ...base(v), mode: 'diagnose', recoveryEnabled: false });
    assert.deepEqual([d.actions, d.approval, (await approvalRow()).status], [[], undefined, 'pending']);
  } finally { llm.restore(); }
});

test('APPROVAL via the trial script: arm refuses unless check is GO and the key is the single eligible finding; a GO arm stores one headline-bound approval', opts, async () => {
  const v = at910();
  await reset(); await seedDiscoveryCompleted(v);
  await seedBrief(v, { status: 'ready', attempts: 1, items: 3, brief: { lead: 'x', market_summary: 'y', developments: [], watchpoints: [] } });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trial-')), 'b.json');
  await trial.backup(pool, { date: todayKst(), file });
  const healthy = await trial.arm(pool, { key: KEY, backupFile: file, date: todayKst(), by: 't', now: v, store: approvalStore });
  assert.deepEqual([healthy.armed, healthy.reason], [false, 'check_is_no_go']);
  assert.equal(await approvalRow(), null, 'nothing stored');
  await q("UPDATE daily_briefs SET status = 'failed', error = 'AI provider returned 503', attempt_count = 3 WHERE brief_date = $1::date", [todayKst()]);
  await trial.backup(pool, { date: todayKst(), file });
  const wrong = await trial.arm(pool, { key: 'headline:model_output_invalid', backupFile: file, date: todayKst(), by: 't', now: v, store: approvalStore });
  assert.deepEqual([wrong.armed, wrong.reason], [false, 'key_is_not_the_single_eligible_finding']);
  const ok = await trial.arm(pool, { key: KEY, backupFile: file, date: todayKst(), by: 'tester', now: v, store: approvalStore });
  assert.equal(ok.armed, true, JSON.stringify(ok));
  assert.deepEqual([(await approvalRow()).key, (await approvalRow()).action, (await approvalRow()).status, (await trial.status(pool)).approval.by], [KEY, 'retry_headline', 'pending', 'tester']);
});
