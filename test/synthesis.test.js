const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const searchRouter = require('../server/routes/search');
const synthesis = require('../server/lib/synthesis');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}/api/search`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}
function mockPool(handlers) {
  const original = pool.query;
  pool.query = async (text, params) => {
    for (const [match, handler] of handlers) if (text.includes(match)) return handler(text, params);
    return { rows: [] };
  };
  return () => { pool.query = original; };
}
const row = (id, title, published_at, relevance_score, summary) => ({ id, title, summary, insight: null, ai_summary: null, ai_insight: null, published_at, source_name: 'Src', relevance_score });
const ask = (base, question) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) }).then((r) => r.json());

test('isBroadQuestion: trend/outlook/impact questions are broad; a plain number lookup is not', () => {
  assert.equal(synthesis.isBroadQuestion('최근 팜유 시장 동향 알려줘'), true);
  assert.equal(synthesis.isBroadQuestion('EUDR이 국내 식품업계에 미치는 영향은?'), true);
  assert.equal(synthesis.isBroadQuestion('말레이시아 팜유 재고는 얼마야?'), false);
});

test('rankForSynthesis: a recent, relevant, quantified material outranks an old equally relevant one', () => {
  const now = new Date('2026-10-23').getTime();
  const old = row(1, 'old', '2026-05-01', 10, '내용 요약');
  const fresh = row(2, 'fresh', '2026-10-22', 10, '재고가 351만 톤으로 늘었다');
  assert.deepEqual(synthesis.rankForSynthesis([old, fresh], now).map((m) => m.id), [2, 1]);
});

test('promptBlock: 3+ materials -> issue structure; fewer -> an explicit limit instead of padding', () => {
  assert.match(synthesis.promptBlock('팜유 동향', 5), /# 핵심 이슈[\s\S]*# 종합 판단\n- \*\*인사이트\*\*[\s\S]*# 추가 모니터링/);
  assert.ok(!/\*\*전망\*\*/.test(synthesis.promptBlock('팜유 동향', 5)));
  assert.match(synthesis.promptBlock('팜유 동향', 5), /채우지 않는다/);
  assert.match(synthesis.promptBlock('팜유 동향', 5), /\n  - 확인된 핵심 내용[\s\S]*\n  - 그 의미/);
  assert.match(synthesis.promptBlock('팜유 동향', 5), /라벨 접두어를 붙이지 않고/);
  assert.ok(!/\n\s+- (사실|시사점):/.test(synthesis.promptBlock('팜유 동향', 5)));
  assert.match(synthesis.promptBlock('팜유 동향', 5), /줄글 문단을 쓰지 않는다/);
  assert.match(synthesis.promptBlock('국내 팜유 동향', 5), /해외→국내 영향/);
  const thin = synthesis.promptBlock('팜유 동향', 1);
  assert.match(thin, /1건뿐/);
  assert.ok(!/# 핵심 이슈/.test(thin));
});

test('POST /: several relevant materials -> the writer gets the synthesis structure, priority-ordered, and sources carry date + original link', async () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000); // a Date object, as pg returns DATE columns
  const rows = [
    row(1, '팜유 가격 동향 A', daysAgo(60), 5, '두 달 전 팜유 가격이 올랐다'),
    row(2, '팜유 수출 동향 B', daysAgo(1), 5, '수출이 늘었다'),
    row(3, '팜유 재고 동향 C', daysAgo(3), 5, '재고가 351만 톤이다'),
    row(4, '팜유 정책 동향 D', daysAgo(8), 5, '정책이 바뀌었다'),
  ];
  const restore = mockPool([
    ['FROM items i', () => ({ rows })],
    ['SELECT id, source_url FROM items', () => ({ rows: rows.map((r) => ({ id: r.id, source_url: `https://news.example.com/${r.id}` })) })],
  ]);
  const original = provider.callProviderWithFallback;
  let seen = null;
  provider.callProviderWithFallback = async ({ user }) => { if (!seen && /\[Research Center materials\]/.test(user)) seen = user; return { text: '# 핵심 이슈\n- 수출 증가 [1] (10-22). [2]', provider: 'freellmapi' }; };
  try {
    await withServer(async (base) => {
      const body = await ask(base, '최근 팜유 시장 동향 알려줘');
      assert.match(seen, /핵심 위주 종합 브리핑/);
      // dates reach the writer as ISO yyyy-mm-dd, never "Fri Dec 26"
      assert.match(seen, /발행일: \d{4}-\d{2}-\d{2}\n/);
      assert.ok(!/발행일: [A-Z][a-z]{2} /.test(seen));
      // priority order: the quantified, recent items come first and the oldest (9월) material is last
      assert.match(seen, /자료 1 — 제목: 팜유 재고 동향 C/);
      assert.match(seen, /자료 4 — 제목: 팜유 가격 동향 A/);
      assert.ok(body.sources.length >= 1);
      for (const s of body.sources) {
        assert.match(s.url, /^https:\/\/news\.example\.com\/\d+$/);
        assert.ok(s.published_at);
      }
    });
  } finally { provider.callProviderWithFallback = original; restore(); }
});

test('POST /: a single relevant material -> no padded issue list, the limit is stated in the prompt', async () => {
  const rows = [row(1, '팜유 시장 동향 단일', '2026-10-22', 5, '유일한 자료')];
  const restore = mockPool([['FROM items i', () => ({ rows })]]);
  const original = provider.callProviderWithFallback;
  let seen = null;
  provider.callProviderWithFallback = async ({ user }) => { if (!seen && /\[Research Center materials\]/.test(user)) seen = user; return { text: '답변 [1]', provider: 'freellmapi' }; };
  try {
    await withServer(async (base) => {
      await ask(base, '최근 팜유 시장 동향 알려줘');
      assert.match(seen, /1건뿐/);
      assert.ok(!/# 핵심 이슈/.test(seen));
    });
  } finally { provider.callProviderWithFallback = original; restore(); }
});

test('POST /: a link is only passed on when the stored URL is http(s)', async () => {
  const rows = [row(1, '팜유 가격', '2026-10-22', 5, '요약')];
  const restore = mockPool([
    ['FROM items i', () => ({ rows })],
    ['SELECT id, source_url FROM items', () => ({ rows: [{ id: 1, source_url: 'javascript:alert(1)' }] })],
  ]);
  const original = provider.callProviderWithFallback;
  provider.callProviderWithFallback = async () => ({ text: '답변 [1]', provider: 'freellmapi' });
  try {
    await withServer(async (base) => {
      const body = await ask(base, '팜유 가격이 왜 올랐어?');
      assert.equal(body.sources[0].url, undefined);
    });
  } finally { provider.callProviderWithFallback = original; restore(); }
});

test('selectForSynthesis: stale materials are dropped when 3+ recent ones exist, and at most 8 are kept', () => {
  const now = Date.now();
  const day = (n) => new Date(now - n * 86400000);
  const stale = [row(90, 's1', day(300), 9, 'x'), row(91, 's2', day(400), 9, 'x')];
  const recent = Array.from({ length: 10 }, (_, i) => row(i + 1, `r${i}`, day(i + 1), 5, 'y'));
  const out = synthesis.selectForSynthesis([...stale, ...recent], now);
  assert.equal(out.length, 8);
  assert.ok(out.every((m) => m.id < 90));
  // too few recent -> keep the stale ones rather than answer from almost nothing
  const thin = synthesis.selectForSynthesis([...stale, row(1, 'r', day(2), 5, 'y')], now);
  assert.equal(thin.length, 3);
});

test('isSpotlightQuestion + spotlight ranking: notable-number items outrank a staple report; the answer asks for numbers and issues beyond staples', () => {
  assert.equal(synthesis.isSpotlightQuestion('최근 유망한 품목 알려줘'), true);
  assert.equal(synthesis.isBroadQuestion('최근 유망한 품목 알려줘'), true);
  assert.equal(synthesis.isSpotlightQuestion('팜유 시장 동향'), false);
  const now = Date.now();
  const day = (n) => new Date(now - n * 86400000);
  const staple = row(1, '팜유 시황', day(1), 10, '팜유 가격이 소폭 변동했다');
  const notable = row(2, '쌀겨유 수출 급증', day(2), 4, '쌀겨유 수출이 전년 대비 42% 급증했다');
  assert.equal(synthesis.rankForSynthesis([staple, notable], now, { spotlight: true })[0].id, 2);
  const block = synthesis.promptBlock('최근 유망한 품목', 5, { spotlight: true });
  assert.match(block, /일반 시황은 첫 이슈 한 줄로만/);
  assert.match(block, /제목에 핵심 수치/);
  assert.ok(!/일반 시황은 첫 이슈/.test(synthesis.promptBlock('팜유 동향', 5)));
  const many = Array.from({ length: 14 }, (_, i) => row(i + 1, `r${i}`, day(i + 1), 5, 'y'));
  assert.equal(synthesis.selectForSynthesis(many, now, { spotlight: true }).length, 10);
});

test('POST /: a spotlight question pulls recent items with notable figures into the candidates (domain-filtered) and asks for numbers', async () => {
  const base = row(1, '팜유 시황 일반', new Date(Date.now() - 86400000), 5, '팜유 시황 요약');
  const notable = [row(11, '쌀겨유 수출 급증', new Date(Date.now() - 2 * 86400000), 0, '쌀겨유 수출이 42% 급증했다'), row(12, '아보카도유 가격 급락', new Date(Date.now() - 3 * 86400000), 0, '가격이 30% 급락했다')];
  const sqls = [];
  const restore = mockPool([
    ['i.published_at >= (now()', (text) => { sqls.push(text); return { rows: notable }; }],
    ['FROM items i', () => ({ rows: [base, row(2, '팜유 수출', new Date(Date.now() - 2 * 86400000), 5, '수출 증가'), row(3, '팜유 재고', new Date(Date.now() - 3 * 86400000), 5, '재고 351만 톤')] })],
  ]);
  const original = provider.callProviderWithFallback;
  let seen = null;
  provider.callProviderWithFallback = async ({ user }) => { if (!seen && /\[Research Center materials\]/.test(user)) seen = user; return { text: '답변 [1]', provider: 'freellmapi' }; };
  try {
    await withServer(async (b) => { await ask(b, '최근 유망한 품목 알려줘'); });
    assert.ok(sqls.length === 1 && /식용유\|팜유/.test(sqls[0]), 'notable-extras query ran with a domain filter');
    assert.match(seen, /쌀겨유 수출 급증/);
    assert.match(seen, /일반 시황은 첫 이슈 한 줄로만/);
  } finally { provider.callProviderWithFallback = original; restore(); }
});
