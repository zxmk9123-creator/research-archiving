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
