const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHealth, collectHealthInput } = require('../server/lib/pipelineHealth');

const NOW = new Date('2026-10-30T00:40:00Z').getTime(); // 09:40 KST on 2026-10-30
const iso = (s) => new Date(s).toISOString();
const completedDiscovery = (totals = { discovered: 120, archived: 11, failedSources: 3 }, total = 84) => ({
  state: 'completed', completedToday: true, completedAt: iso('2026-10-29T23:26:00Z'), totals,
  failedSources: Array.from({ length: totals.failedSources || 0 }, (_, i) => i), progress: { done: total, total },
});
const readyBrief = (over = {}) => ({ status: 'ready', attempt_count: 1, error: null, updated_at: iso('2026-10-29T23:28:00Z'), completed_at: iso('2026-10-29T23:28:00Z'), item_count: 7, ...over });
const good = (over = {}) => ({
  discovery: completedDiscovery(), brief: readyBrief(), evidenceCandidates: 15, attemptsToday: { count: 0 }, trace: [],
  heartbeat: { since: '2026-10-28T00:00:00Z', last: { github: iso('2026-10-29T22:30:00Z') }, days: { '2026-10-30': { github: { n: 1, first: iso('2026-10-29T22:30:00Z'), last: iso('2026-10-29T22:30:00Z') } } } },
  ...over,
});
const ids = (r, status) => r.checks.filter((c) => c.status === status).map((c) => c.id);

test('successful run: run completed on time, headline ready before 09:00 KST, no recovery needed -> ok', () => {
  const r = evaluateHealth(good(), NOW);
  assert.equal(r.status, 'ok');
  assert.deepEqual(ids(r, 'fail'), []);
  assert.match(r.summary, /^Pipeline healthy/);
  assert.match(r.summary, /\[PASS\] headline: ready with 7 item/);
});

test('valid zero-item run is not a failure: collection completed with nothing new and the headline is an honest empty one', () => {
  const r = evaluateHealth(good({
    discovery: completedDiscovery({ discovered: 0, archived: 0, failedSources: 4 }),
    brief: readyBrief({ item_count: 0 }), evidenceCandidates: 0,
  }), NOW);
  assert.equal(r.status, 'ok');
  assert.match(r.checks.find((c) => c.id === 'discovery_output').detail, /valid zero-item run/);
  assert.match(r.checks.find((c) => c.id === 'headline').detail, /valid zero-item headline/);
});

test('zero items that are NOT valid: every source failed, or an empty headline although eligible items exist', () => {
  const allFailed = evaluateHealth(good({ discovery: completedDiscovery({ discovered: 0, archived: 0, failedSources: 84 }) }), NOW);
  assert.equal(allFailed.status, 'failed');
  assert.deepEqual(ids(allFailed, 'fail'), ['discovery_output']);
  const wrongEmpty = evaluateHealth(good({ brief: readyBrief({ item_count: 0 }), evidenceCandidates: 9 }), NOW);
  assert.equal(wrongEmpty.status, 'failed');
  assert.match(wrongEmpty.checks.find((c) => c.id === 'headline').detail, /empty headline although 9 eligible/);
  const unknownCount = evaluateHealth(good({ brief: readyBrief({ item_count: 0 }), evidenceCandidates: null }), NOW);
  assert.equal(unknownCount.checks.find((c) => c.id === 'headline').status, 'unknown', 'an unknowable fact is not a pass');
});

test('missing run, and a run stalled part-way, are failures; before 08:00 KST a not-yet-started run is fine', () => {
  const missing = evaluateHealth(good({ discovery: { state: 'stalled', completedToday: false, progress: null }, brief: null }), NOW);
  assert.equal(missing.status, 'failed');
  assert.match(missing.checks.find((c) => c.id === 'discovery_run').detail, /missing scheduled run/);
  const stalled = evaluateHealth(good({ discovery: { state: 'stalled', completedToday: false, progress: { done: 54, total: 84 }, lastProgressAt: iso('2026-10-29T23:10:00Z') }, brief: null }), NOW);
  assert.match(stalled.checks.find((c) => c.id === 'discovery_run').detail, /stalled at 54\/84/);
  assert.equal(stalled.status, 'failed');
  const early = evaluateHealth(good({ discovery: { state: 'waiting', completedToday: false, progress: null }, brief: null }), new Date('2026-10-29T21:30:00Z').getTime()); // 06:30 KST
  assert.equal(early.checks.find((c) => c.id === 'discovery_run').status, 'pass');
});

test('headline in a non-terminal state: fresh generating passes, generating that went silent fails as stuck', () => {
  const fresh = evaluateHealth(good({ brief: readyBrief({ status: 'generating', completed_at: null, updated_at: iso(NOW - 2 * 60000) }) }), NOW);
  assert.equal(fresh.checks.find((c) => c.id === 'headline').status, 'pass');
  const stuck = evaluateHealth(good({ brief: readyBrief({ status: 'generating', completed_at: null, updated_at: iso(NOW - 20 * 60000), attempt_count: 6, error: 'Unexpected token' }) }), NOW);
  assert.equal(stuck.status, 'failed');
  assert.match(stuck.checks.find((c) => c.id === 'headline').detail, /stuck: generating but no update for 20 min.*worker lost.*Unexpected token/);
});

test('headline failed / missing: reported with attempts and cause; the automatic limit is called out; a just-finished collection is given a grace period', () => {
  const failed = evaluateHealth(good({ brief: readyBrief({ status: 'failed', attempt_count: 9, error: 'brief_placeholder_output | head=Let me analyze' }), attemptsToday: { count: 5 } }), NOW);
  assert.equal(failed.status, 'failed');
  assert.match(failed.checks.find((c) => c.id === 'headline').detail, /failed after 9 attempt.*next trigger.*brief_placeholder_output.*5 failure/);
  const exhausted = evaluateHealth(good({ brief: readyBrief({ status: 'failed', attempt_count: 20 }) }), NOW);
  assert.match(exhausted.checks.find((c) => c.id === 'headline').detail, /needs a person/);
  const missing = evaluateHealth(good({ brief: null }), NOW);
  assert.match(missing.checks.find((c) => c.id === 'headline').detail, /missing/);
  assert.equal(missing.status, 'failed');
  const grace = evaluateHealth(good({ brief: null, discovery: { ...completedDiscovery(), completedAt: iso(NOW - 5 * 60000) } }), NOW);
  assert.equal(grace.checks.find((c) => c.id === 'headline').status, 'pass');
});

test('a headline that is ready but later than the 09:00 KST target is a warning, not a failure', () => {
  const late = evaluateHealth(good({ brief: readyBrief({ completed_at: iso('2026-10-30T00:31:00Z'), attempt_count: 12 }) }), NOW); // 09:31 KST
  assert.equal(late.status, 'warn');
  assert.match(late.checks.find((c) => c.id === 'headline').detail, /31 min after the 09:00 KST target/);
});

test('missing telemetry is "unknown", never a pass or a fail: no trace, and a heartbeat that cannot judge', () => {
  const noTrace = evaluateHealth(good({ trace: null }), NOW);
  assert.equal(noTrace.status, 'unknown');
  assert.deepEqual(ids(noTrace, 'unknown'), ['recovery']);
  const noHeartbeatDoc = evaluateHealth(good({ heartbeat: null }), NOW);
  assert.equal(noHeartbeatDoc.status, 'unknown');
  const skipped = evaluateHealth(good({ heartbeat: undefined }), NOW);
  assert.equal(skipped.status, 'ok', 'a heartbeat that was not read is simply not part of the verdict');
});

test('a scheduler trigger that stayed silent and recovery events do not hide behind a successful run (warn)', () => {
  const r = evaluateHealth(good({
    heartbeat: { since: '2026-10-28T00:00:00Z', last: { vercel: iso('2026-10-29T23:00:00Z') }, days: { '2026-10-30': { vercel: { n: 3, first: iso('2026-10-29T22:00:00Z'), last: iso('2026-10-29T23:20:00Z') } } } },
    trace: [{ at: iso('2026-10-29T23:17:00Z'), kind: 'self_heal_kick' }, { at: iso('2026-10-29T23:16:00Z'), kind: 'cron_call', chained: 'hop_5_http_508_gave_up' }, { at: iso('2026-10-29T23:14:00Z'), kind: 'source_timeout', sourceId: 9 }],
  }), NOW);
  assert.equal(r.status, 'warn');
  assert.ok(r.checks.some((c) => c.id === 'trigger_missed' && /GitHub scheduled trigger missed/.test(c.detail)));
  assert.match(r.checks.find((c) => c.id === 'recovery').detail, /1 self-heal kick.*1 failed continuation.*1 source timeout/);
});

test('collectHealthInput is read-only (only SELECTs) and reports an unreadable piece as missing instead of guessing', async () => {
  const pool = require('../server/db/pool');
  const orig = pool.query;
  const seen = [];
  pool.query = async (text) => {
    seen.push(String(text));
    if (/FROM daily_briefs/.test(text)) throw new Error('db hiccup');
    return { rows: [] };
  };
  try {
    const input = await collectHealthInput(new Date(NOW));
    assert.ok(seen.length >= 4);
    assert.ok(seen.every((q) => /^\s*SELECT/i.test(q)), 'no statement writes anything');
    assert.equal(input.briefUnreadable, true);
  } finally { pool.query = orig; }
});

test('GET /api/cron/health: requires the cron secret, returns the verdict, and a failure inside is "unknown" with 500, not a false ok', async () => {
  const { healthHandler } = require('../server/lib/cronRunner');
  process.env.CRON_SECRET = 'test-secret';
  const call = async (handler, auth) => {
    const out = {};
    const req = { get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined), headers: { authorization: auth } };
    const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
    await handler(req, res);
    return out;
  };
  assert.equal((await call(healthHandler({ check: async () => ({ status: 'ok' }) }), 'Bearer wrong')).code, 401);
  const ok = await call(healthHandler({ check: async () => ({ status: 'failed', summary: 'x' }) }), 'Bearer test-secret');
  assert.equal(ok.body.status, 'failed');
  const boom = await call(healthHandler({ check: async () => { throw new Error('boom'); } }), 'Bearer test-secret');
  assert.deepEqual([boom.code, boom.body.status], [500, 'unknown']);
});

test('review fixes: nearly-all-sources-failed is an outage not a quiet day, missing totals are unknown, a run still going after 10:00 KST warns', () => {
  const mostFailed = evaluateHealth(good({ discovery: completedDiscovery({ discovered: 0, archived: 0, failedSources: 80 }) }), NOW);
  assert.equal(mostFailed.status, 'failed', '80 of 84 failing with nothing found must not read as a valid zero-item run');
  const mostFailedSome = evaluateHealth(good({ discovery: completedDiscovery({ discovered: 12, archived: 1, failedSources: 50 }) }), NOW);
  assert.equal(mostFailedSome.checks.find((c) => c.id === 'discovery_output').status, 'warn');
  const quiet = evaluateHealth(good({ discovery: completedDiscovery({ discovered: 0, archived: 0, failedSources: 12 }), brief: readyBrief({ item_count: 0 }), evidenceCandidates: 0 }), NOW);
  assert.equal(quiet.status, 'ok', '12 of 84 failing on a quiet day is still a valid zero-item run');
  const noTotals = evaluateHealth(good({ discovery: { ...completedDiscovery(), totals: null } }), NOW);
  assert.equal(noTotals.checks.find((c) => c.id === 'discovery_output').status, 'unknown');
  const late = evaluateHealth(good({ discovery: { state: 'running', completedToday: false, progress: { done: 60, total: 84 } }, brief: null }), new Date('2026-10-30T01:10:00Z').getTime()); // 10:10 KST
  assert.equal(late.checks.find((c) => c.id === 'discovery_run').status, 'warn');
  const onTime = evaluateHealth(good({ discovery: { state: 'running', completedToday: false, progress: { done: 60, total: 84 } }, brief: null }), new Date('2026-10-29T23:30:00Z').getTime()); // 08:30 KST
  assert.equal(onTime.checks.find((c) => c.id === 'discovery_run').status, 'pass');
});

test('no trigger incident -> one PASS row that shows its evidence (latest call and today\'s count per trigger); incidents still produce their own rows', () => {
  const ok = evaluateHealth(good({
    heartbeat: {
      since: '2026-10-29T06:58:22.739Z',
      last: { github: '2026-10-30T00:57:40.775Z', vercel: '2026-10-30T00:57:24.157Z' },
      days: { '2026-10-30': { github: { n: 13, first: '2026-10-29T20:14:06.892Z', last: '2026-10-30T00:57:40.775Z' }, vercel: { n: 3, first: '2026-10-29T22:07:04.640Z', last: '2026-10-30T00:57:24.157Z' } } },
    },
  }), NOW);
  const rows = ok.checks.filter((c) => c.id.startsWith('trigger'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'trigger');
  assert.equal(rows[0].status, 'pass');
  assert.match(rows[0].detail, /github last 2026-10-30T00:57:40\.775Z \(13 call\(s\) today\)/);
  assert.match(rows[0].detail, /vercel last 2026-10-30T00:57:24\.157Z \(3 call\(s\) today\)/);
  assert.equal(ok.status, 'ok', 'a PASS row does not change the verdict');
  assert.match(ok.summary, /\[PASS\] trigger: scheduler triggers on time/);

  // a trigger with no recorded call is stated as such (no invented time)
  const githubOnly = evaluateHealth(good({
    heartbeat: { since: '2026-10-29T00:00:00Z', last: { github: '2026-10-30T00:30:00.000Z' }, days: { '2026-10-30': { github: { n: 2, first: '2026-10-29T22:10:00Z', last: '2026-10-30T00:30:00.000Z' } } } },
  }), NOW);
  assert.match(githubOnly.checks.find((c) => c.id === 'trigger').detail, /vercel no call recorded/);

  // incidents are unchanged: a missed GitHub trigger still warns and there is no PASS row beside it
  const missed = evaluateHealth(good({
    heartbeat: { since: '2026-10-28T00:00:00Z', last: { vercel: '2026-10-30T00:30:00.000Z' }, days: { '2026-10-30': { vercel: { n: 3, first: '2026-10-29T22:00:00Z', last: '2026-10-30T00:30:00.000Z' } } } },
  }), NOW);
  assert.equal(missed.status, 'warn');
  assert.ok(missed.checks.some((c) => c.id === 'trigger_missed'));
  assert.ok(!missed.checks.some((c) => c.id === 'trigger'));

  // not read at all -> still no trigger row; unreadable/absent doc -> still unknown
  assert.equal(evaluateHealth(good({ heartbeat: undefined }), NOW).checks.some((c) => c.id.startsWith('trigger')), false);
  assert.deepEqual(evaluateHealth(good({ heartbeat: null }), NOW).checks.filter((c) => c.id.startsWith('trigger')).map((c) => [c.id, c.status]), [['trigger_telemetry', 'unknown']]);
});
