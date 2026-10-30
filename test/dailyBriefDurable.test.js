const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const dailyBrief = require('../server/lib/dailyBrief');

const today = dailyBrief.kstDate();
const item = { id: 101, title: 'Indonesia raises palm oil export levy', source_name: 'Reuters', published_at: new Date(), collected_at: new Date(), summary: 'Indonesia raised the palm oil export levy.', insight: '' };
const GOOD = JSON.stringify({
  lead: '인도네시아가 팜유 수출 부과금을 인상했다',
  market_summary: '수출 부과금 인상으로 팜유 공급 부담이 커졌다. 가격 상승 압력이 이어진다.',
  developments: [{ item_id: 101, importance: 4, summary: '인도네시아가 팜유 수출 부과금을 인상', significance: '공급 부담으로 가격 상승 압력' }],
  watchpoints: ['후속 조치 여부'],
});

function harness(outputs) {
  const origQuery = pool.query;
  const origCall = provider.callProvider;
  const state = { updates: [], attempts: [], prompts: [], limits: [], ready: false };
  pool.query = async (text, params) => {
    if (/FROM items i/.test(text)) { state.limits.push(params[4]); return { rows: [item] }; }
    if (/INSERT INTO daily_brief_attempts/.test(text)) { state.attempts.push(params[3]); return { rows: [] }; }
    if (/SET attempt_count = attempt_count \+ 1/.test(text)) { state.updates.push({ status: params[2] ? 'failed' : 'generating', error: params[1] }); return { rows: [] }; }
    if (/SET status = 'ready'/.test(text)) { state.ready = true; return { rows: [] }; }
    return { rows: [] };
  };
  let n = 0;
  provider.callProvider = async ({ user }) => { state.prompts.push(user); const o = outputs[Math.min(n++, outputs.length - 1)]; if (o instanceof Error) throw o; return o; };
  return { state, restore: () => { pool.query = origQuery; provider.callProvider = origCall; } };
}

test('placeholder output (`"item_id":int`, `[...]`) is recognised, and the next attempt tells the model why and succeeds', async () => {
  assert.ok(dailyBrief.PLACEHOLDER_OUTPUT_RE.test('{"developments":[...],"watchpoints":[]}'));
  assert.ok(dailyBrief.PLACEHOLDER_OUTPUT_RE.test('{"developments":[{"item_id":int,"importance":3}]}'));
  assert.ok(!dailyBrief.PLACEHOLDER_OUTPUT_RE.test(GOOD));
  const h = harness(['{"lead":"x","developments":[...],"watchpoints":[]}', GOOD]);
  try {
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.equal(h.state.ready, true);
    assert.equal(h.state.attempts.length, 1);
    assert.match(h.state.attempts[0], /brief_placeholder_output/);
    assert.ok(!/재시도 안내/.test(h.state.prompts[0]), 'the first prompt is unchanged');
    assert.match(h.state.prompts[1], /재시도 안내/, 'the retry says the previous answer held placeholders');
  } finally { h.restore(); }
});

test('prompt carries a concrete example and forbids placeholders (no bare type words as the only format)', async () => {
  const h = harness([GOOD]);
  let system = '';
  provider.callProvider = async (m) => { system = m.system; return GOOD; };
  try {
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.match(system, /자리표시자/);
    assert.match(system, /"item_id":101/);
    assert.ok(!/"item_id":정수/.test(system));
  } finally { h.restore(); }
});

test('retries do not outlive the invocation: when the next delay + attempt cannot fit, the row is released as failed (retry_deferred) and nothing sleeps', async () => {
  const h = harness([new Error('invalid_brief_json')]);
  let slept = 0;
  try {
    await dailyBrief.buildDailyBrief(today, { budgetMs: 60_000, attemptMs: 60_000, sleep: async (ms) => { slept += ms; } });
    assert.equal(slept, 0, 'it did not sleep towards a kill');
    assert.equal(h.state.updates.length, 1);
    assert.equal(h.state.updates[0].status, 'failed', 'released for the next cron call, not left generating');
    assert.match(h.state.updates[0].error, /^retry_deferred: invalid_brief_json/);
    assert.equal(h.state.ready, false);
  } finally { h.restore(); }
});

test('with time to spare it keeps retrying up to the automatic limit and then ends failed (never ready)', async () => {
  const h = harness([new Error('invalid_brief_json')]);
  try {
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.equal(h.state.updates.length, 6);
    assert.equal(h.state.updates.slice(0, 5).every((u) => u.status === 'generating'), true);
    assert.equal(h.state.updates[5].status, 'failed');
    assert.equal(h.state.ready, false);
  } finally { h.restore(); }
});

test('reclaim policy: a silent generation is reclaimed after minutes (not 25), and automatic claims are capped per day', async () => {
  assert.ok(dailyBrief.GENERATION_STALE_AFTER_MINUTES <= 6);
  const origQuery = pool.query;
  let seen;
  pool.query = async (text, params) => { if (/INSERT INTO daily_briefs/.test(text)) seen = { text, params }; return { rows: [] }; };
  try {
    await dailyBrief.queueDailyBriefGeneration(new Date(), {});
    assert.match(seen.text, /attempt_count < \$7/);
    assert.equal(seen.params[6], dailyBrief.MAX_AUTO_DAILY_ATTEMPTS);
    assert.equal(seen.params[3], dailyBrief.GENERATION_STALE_AFTER_MINUTES);
  } finally { pool.query = origQuery; }
});

test('the retry after an unusable answer uses a shorter input, and the log keeps the start of the bad answer', async () => {
  const h = harness(['{"lead":"x","developments":[...],"watchpoints":[]}', GOOD]);
  try {
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.deepEqual(h.state.limits, [24, 12], 'first try uses the full evidence set, the repair try the freshest 12');
    assert.match(h.state.attempts[0], /\| head=\{"lead":"x","developments":\[\.\.\.\]/);
  } finally { h.restore(); }
});

test('inside an invocation deadline the retry loop uses the time really left, not its own start time', async () => {
  const h = harness([new Error('invalid_brief_json')]);
  let slept = 0;
  try {
    // generous own budget, but only 30 s of the invocation left: a 60 s attempt cannot fit, so the row is released at once
    await dailyBrief.runWithDeadline(Date.now() + 30_000, () => dailyBrief.buildDailyBrief(today, { budgetMs: 10 * 60_000, attemptMs: 60_000, sleep: async (ms) => { slept += ms; } }));
    assert.equal(slept, 0);
    assert.equal(h.state.updates.length, 1);
    assert.match(h.state.updates[0].error, /^retry_deferred/);
    h.state.updates.length = 0;
    // plenty left: it retries as before
    await dailyBrief.runWithDeadline(Date.now() + 10 * 60_000, () => dailyBrief.buildDailyBrief(today, { sleep: async () => {} }));
    assert.equal(h.state.updates.length, 6);
  } finally { h.restore(); }
});

test('review autopilot: no new AI review starts after the deadline (the rest stays queued), so later steps such as the headline are reached', async () => {
  const autopilot = require('../server/lib/reviewAutopilot');
  const rows = [1, 2, 3, 4].map((id) => ({ id, title: `t${id}`, status: 'Draft', ai_status: 'completed', ai_eligible: true, reviewer_eligible: null }));
  const origQuery = pool.query;
  const prevAuto = process.env.AUTO_REVIEW;
  delete process.env.AUTO_REVIEW; // the test setup switches the routine off
  pool.query = async (text) => (/FROM items i LEFT JOIN sources/.test(text) ? { rows } : { rows: [] });
  const seen = [];
  const review = async (it) => { seen.push(it.id); return { id: it.id, action: 'human' }; };
  try {
    const late = await autopilot.runAutopilot({ aiBudget: 8, deadlineAt: Date.now() - 1, review });
    assert.deepEqual(seen, [], 'past the deadline nothing new starts');
    assert.equal(late.deferred, 4);
    const open = await autopilot.runAutopilot({ aiBudget: 3, deadlineAt: Date.now() + 60_000, review });
    assert.deepEqual(seen, [1, 2, 3], 'before the deadline the normal AI budget applies');
    assert.equal(open.human, 3);
  } finally { pool.query = origQuery; if (prevAuto !== undefined) process.env.AUTO_REVIEW = prevAuto; }
});

test('ensureDailyBrief does not claim or start a generation when too little of the invocation is left', async () => {
  const origQuery = pool.query;
  let queried = 0;
  pool.query = async () => { queried++; return { rows: [] }; };
  try {
    const r = await dailyBrief.runWithDeadline(Date.now() + 10_000, () => dailyBrief.ensureDailyBrief(new Date(), { discoveryDone: true }));
    assert.deepEqual(r, { ran: false, reason: 'insufficient_time' });
    assert.equal(queried, 0, 'nothing was claimed in the database');
  } finally { pool.query = origQuery; }
});

test('a model that thinks out loud before the real JSON still yields the real JSON (the last object with a lead wins)', async () => {
  const thinking = `Let me analyze the task carefully. I need to create a Korean daily brief. The format is {"lead":"한 문장","developments":[...],"watchpoints":[...]}.\nNow the final answer:\n${GOOD}`;
  assert.equal(dailyBrief.parseJsonObject(thinking).lead, '인도네시아가 팜유 수출 부과금을 인상했다');
  const h = harness([thinking]);
  try {
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.equal(h.state.ready, true);
    assert.equal(h.state.attempts.length, 0, 'no failed attempt was needed');
  } finally { h.restore(); }
  assert.equal(JSON.stringify(dailyBrief.parseJsonObject('```json\n{"a":1}\n```')), '{"a":1}', 'objects without a lead behave as before (first object)');
  assert.throws(() => dailyBrief.parseJsonObject('no json here'), /invalid_brief_json/);
  assert.throws(() => dailyBrief.parseJsonObject('{"a":[...]}'), /Unexpected token/);
});

test('failure names its cause: truncated by the token limit vs. format description echoed', async () => {
  const cut = '{"lead":"x","developments":[{"item_id"\n\n⚠ 답변이 길이 제한으로 인해 중간에 잘렸습니다. 더 좁은 질문으로';
  const h = harness([cut]);
  try {
    await dailyBrief.buildDailyBrief(today, { budgetMs: 60_000, attemptMs: 60_000, sleep: async () => {} });
    assert.match(h.state.attempts[0], /^brief_truncated_by_max_tokens \| head=/);
  } finally { h.restore(); }
});

// ---------- bounded cost: a caller-supplied model-call budget (Pipeline Doctor recovery) ----------

test('call budget: without a budget the guard makes its full 6 attempts (unchanged); with max=2 it makes exactly 2, then releases the row as failed with a visible reason', async () => {
  const unbudgeted = harness([new Error('AI provider returned 503')]);
  try {
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.equal(unbudgeted.state.prompts.length, 6, 'existing behaviour: 1 + MAX_AUTOMATIC_RETRIES');
  } finally { unbudgeted.restore(); }

  const h = harness([new Error('AI provider returned 503')]);
  const budget = { max: 2, used: 0, exhausted: false };
  let slept = 0;
  try {
    await dailyBrief.runWithCallBudget(budget, () => dailyBrief.buildDailyBrief(today, { sleep: async (ms) => { slept += ms; } }));
    assert.equal(h.state.prompts.length, 2, 'two model calls, no more');
    assert.deepEqual([budget.used, budget.exhausted], [2, true]);
    assert.equal(slept, 5000, 'slept only between the two attempts');
    const last = h.state.updates[h.state.updates.length - 1];
    assert.equal(last.status, 'failed', 'released for a person/next cycle, not left generating');
    assert.match(last.error, /^call_budget_exhausted: AI provider returned 503/);
    assert.equal(h.state.ready, false, 'no false ready');
  } finally { h.restore(); }
});

test('call budget: success within the budget is untouched — a transient failure then a good answer uses 2 calls, is ready, and the budget is not exhausted', async () => {
  const h = harness([new Error('AI provider returned 503'), GOOD]);
  const budget = { max: 2, used: 0, exhausted: false };
  try {
    await dailyBrief.runWithCallBudget(budget, () => dailyBrief.buildDailyBrief(today, { sleep: async () => {} }));
    assert.deepEqual([h.state.ready, budget.used, budget.exhausted, h.state.prompts.length], [true, 2, false, 2]);
  } finally { h.restore(); }
  const first = harness([GOOD]); const b1 = { max: 2, used: 0, exhausted: false };
  try {
    await dailyBrief.runWithCallBudget(b1, () => dailyBrief.buildDailyBrief(today, { sleep: async () => {} }));
    assert.deepEqual([first.state.ready, b1.used], [true, 1]);
  } finally { first.restore(); }
});

test('call budget: the time limit still wins when it is tighter — out of time stops at ONE call with retry_deferred, budget not blamed', async () => {
  const h = harness([new Error('invalid_brief_json')]);
  const budget = { max: 5, used: 0, exhausted: false };
  try {
    await dailyBrief.runWithCallBudget(budget, () => dailyBrief.buildDailyBrief(today, { budgetMs: 60_000, attemptMs: 60_000, sleep: async () => {} }));
    assert.deepEqual([budget.used, budget.exhausted, h.state.prompts.length], [1, false, 1]);
    assert.match(h.state.updates[0].error, /^retry_deferred:/);
  } finally { h.restore(); }
});

test('time budget is enforced IN FLIGHT: a budgeted attempt that outlives the deadline is abandoned (row released as failed), cannot publish later, and no further call starts', async () => {
  const h = harness([GOOD]);
  const slow = async () => { h.state.prompts.push('x'); await new Promise((r) => setTimeout(r, 700)); return GOOD; };
  provider.callProvider = slow;
  const budget = { max: 5, used: 0, exhausted: false };
  const t0 = Date.now();
  try {
    await dailyBrief.runWithCallBudget(budget, () => dailyBrief.runWithDeadline(Date.now() + 250, () => dailyBrief.buildDailyBrief(today, { attemptMs: 10, sleep: async () => {} })));
    assert.ok(Date.now() - t0 < 600, `returned at the deadline, not after the slow call (${Date.now() - t0} ms)`);
    assert.equal(h.state.prompts.length, 1, 'no second call after the deadline');
    const last = h.state.updates[h.state.updates.length - 1];
    assert.equal(last.status, 'failed');
    assert.match(last.error, /attempt_exceeded_time_budget/);
    assert.equal(budget.timedOut, true);
    await new Promise((r) => setTimeout(r, 700)); // the abandoned call finishes now
    assert.equal(h.state.ready, false, 'a late answer must not publish after the budget ended');
  } finally { h.restore(); }
});

test('budget cannot be bypassed by a nested/second build under the same budget: once spent, no further model call starts', async () => {
  const h = harness([new Error('AI provider returned 503')]);
  const budget = { max: 2, used: 0, exhausted: false };
  try {
    await dailyBrief.runWithCallBudget(budget, async () => {
      await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
      await dailyBrief.buildDailyBrief(today, { sleep: async () => {} }); // e.g. a second claim inside the same recovery
    });
    assert.equal(h.state.prompts.length, 2, 'two calls in total across both builds');
    assert.equal(budget.used, 2);
    assert.match(h.state.updates[h.state.updates.length - 1].error, /call_budget_exhausted: no_model_call_left/);
  } finally { h.restore(); }
});

test('time budget: the abandoned model call is ABORTED at the provider (signal), not just ignored; unbudgeted callers get no signal', async () => {
  const h = harness([GOOD]);
  const seen = [];
  provider.callProvider = async (m, opts) => {
    seen.push(opts && opts.signal);
    if (!opts || !opts.signal) return GOOD;
    await new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  };
  const budget = { max: 3, used: 0, exhausted: false };
  try {
    await dailyBrief.runWithCallBudget(budget, () => dailyBrief.runWithDeadline(Date.now() + 200, () => dailyBrief.buildDailyBrief(today, { attemptMs: 10, sleep: async () => {} })));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].aborted, true, 'the in-flight call was aborted when the budget ended');
    assert.equal(budget.timedOut, true);
    seen.length = 0;
    await dailyBrief.buildDailyBrief(today, { sleep: async () => {} });
    assert.deepEqual(seen, [undefined], 'without a budget nothing changes: no signal is passed');
  } finally { h.restore(); }
});
