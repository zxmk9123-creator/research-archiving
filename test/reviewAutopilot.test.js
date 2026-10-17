const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const ra = require('../server/lib/reviewAutopilot');

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params) || { rows: [], rowCount: 0 }; };
  return { calls, restore: () => { pool.query = original; } };
}
const item = (o = {}) => ({ id: 1, title: 'Some page', source_url: 'https://x.com/a', type: '뉴스', status: 'Draft', ai_status: 'completed', ai_eligible: false, ai_qa_decision: 'REJECT', ai_summary: '요약', auto_review_attempts: 0, ...o });

test('isClearReject: two negative signals, or a reviewer already said no', () => {
  assert.equal(ra.isClearReject(item()), true);
  assert.equal(ra.isClearReject(item({ ai_eligible: true })), false);
  assert.equal(ra.isClearReject(item({ ai_qa_decision: 'HOLD' })), false);
  assert.equal(ra.isClearReject(item({ ai_eligible: true, ai_qa_decision: 'PASS', reviewer_eligible: false })), true);
});

test('looksValuable: a watched company AND a figure; promo-looking rejects without either are not', () => {
  const names = ['neste', 'diamond green diesel'];
  assert.equal(ra.looksValuable(item({ title: 'Neste expands to 1.5 Mt', ai_summary: '' }), names), true);
  assert.equal(ra.looksValuable(item({ title: 'Neste homepage', ai_summary: 'about us' }), names), false);
  assert.equal(ra.looksValuable(item({ title: 'Webinar 2026', ai_summary: 'register now' }), names), false);
});

test('parseDecision: strict JSON, unknown decision / garbage fall back to human', () => {
  assert.deepEqual(ra.parseDecision('{"decision":"archive","confidence":0.9,"reason":"홍보 페이지"}'), { decision: 'archive', confidence: 0.9, reason: '홍보 페이지' });
  assert.equal(ra.parseDecision('{"decision":"maybe","confidence":0.9,"reason":"x"}').decision, 'human');
  assert.equal(ra.parseDecision('nonsense').decision, 'human');
  assert.equal(ra.parseDecision('{"decision":"archive","confidence":7,"reason":"x"}').confidence, 1);
});

test('reviewOne: a clear reject is archived with NO model call; dry run writes nothing', async () => {
  let arbiterCalls = 0;
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  try {
    const r = await ra.reviewOne(item(), { names: [], arbiter: async () => { arbiterCalls++; return {}; } });
    assert.equal(r.action, 'archived');
    assert.equal(arbiterCalls, 0);
    const upd = calls.find((c) => c.text.includes('UPDATE items SET auto_review'));
    assert.deepEqual([upd.params[1], upd.params[3]], ['archived', 'Archived']);
    calls.length = 0;
    const dry = await ra.reviewOne(item(), { names: [], dryRun: true });
    assert.equal(dry.action, 'archived');
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('reviewOne: arbiter archive / publish / low confidence -> archived / published (via the normal gates) / human', async () => {
  const hold = item({ ai_eligible: true, ai_qa_decision: 'HOLD', ai_qa_reason: '본문 부족' });
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  const fetchOff = async () => '';
  try {
    // the arbiter path fetches the page; stub the network by making fetchFullText fail fast (invalid host in tests)
    const a1 = await ra.reviewOne(hold, { names: [], fetcher: async () => 'Plant expansion news. '.repeat(60), arbiter: async () => ({ decision: 'archive', confidence: 0.8, reason: '홍보' }) });
    assert.equal(a1.action, 'archived');
    let redrafts = 0;
    const a2 = await ra.reviewOne(hold, { names: [], fetcher: async () => 'Plant expansion news. '.repeat(60), arbiter: async () => ({ decision: 'publish', confidence: 0.9, reason: '구체적 사건' }), redraft: async () => { redrafts++; return { archived: true }; } });
    assert.equal(a2.action, 'published');
    assert.equal(redrafts, 1);
    const a3 = await ra.reviewOne(hold, { names: [], fetcher: async () => 'Plant expansion news. '.repeat(60), arbiter: async () => ({ decision: 'publish', confidence: 0.9, reason: '사건' }), redraft: async () => ({ archived: false }) });
    assert.equal(a3.action, 'human'); // the gates still said no: a person decides
    assert.match(a3.reason, /자동 점검을 통과하지 못했습니다/);
    const a4 = await ra.reviewOne(hold, { names: [], fetcher: async () => 'Plant expansion news. '.repeat(60), arbiter: async () => ({ decision: 'archive', confidence: 0.4, reason: '애매' }) });
    assert.equal(a4.action, 'human');
    const archivedUpdate = calls.filter((c) => c.text.includes('UPDATE items SET auto_review')).map((c) => [c.params[1], c.params[3]]);
    assert.deepEqual(archivedUpdate[0], ['archived', 'Archived']);
    assert.ok(archivedUpdate.every((u) => u[1] === 'Archived' || u[1] === null));
  } finally { restore(); }
});

test('reviewOne: a failed draft is retried (max 2 attempts) before the arbiter is asked', async () => {
  const failed = item({ ai_status: 'failed', ai_eligible: null, ai_qa_decision: null });
  const { restore } = mockPool(() => ({ rows: [] }));
  try {
    let redrafts = 0;
    const r1 = await ra.reviewOne(failed, { names: [], redraft: async () => { redrafts++; return { archived: false }; }, arbiter: async () => { throw new Error('should not be asked yet'); } });
    assert.equal(r1.action, 'retry');
    assert.equal(redrafts, 1);
    const dry = await ra.reviewOne(failed, { names: [], dryRun: true });
    assert.equal(dry.action, 'retry');
  } finally { restore(); }
});

test('reviewOne: paywall / empty body goes to human, never archived', async () => {
  const hold = { id: 9, title: 'Repsol targets 400kt of SAF', status: 'Draft', ai_eligible: true, reviewer_eligible: null };
  const r = await ra.reviewOne(hold, { names: [], dryRun: true, fetcher: async () => 'Subscribe to read the full article. Sign in.', arbiter: async () => { throw new Error('no model call'); } });
  assert.equal(r.action, 'human');
  const rej = await ra.reviewOne({ id: 10, title: 'x', status: 'Draft', ai_eligible: false, ai_qa_decision: 'REJECT', ai_eligibility_reason: '본문이 메뉴·안내 문구뿐이라 판단 불가' }, { names: [], dryRun: true });
  assert.equal(rej.action, 'human');
});
