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
  assert.match(synthesis.promptBlock('팜유 동향', 5), /# 핵심 이슈[\s\S]*# 종합 판단[\s\S]*# 추가 모니터링/);
  assert.match(synthesis.promptBlock('팜유 동향', 5), /억지로 채우지 않는다/);
  assert.match(synthesis.promptBlock('국내 팜유 동향', 5), /해외 이슈/);
  const thin = synthesis.promptBlock('팜유 동향', 1);
  assert.match(thin, /1건뿐/);
  assert.ok(!/# 핵심 이슈/.test(thin));
});

test('POST /: several relevant materials -> the writer gets the synthesis structure, priority-ordered, and sources carry date + original link', async () => {
  const rows = [
    row(1, '팜유 가격 동향 A', '2026-09-01', 5, '9월 팜유 가격이 올랐다'),
    row(2, '팜유 수출 동향 B', '2026-10-22', 5, '수출이 늘었다'),
    row(3, '팜유 재고 동향 C', '2026-10-20', 5, '재고가 351만 톤이다'),
    row(4, '팜유 정책 동향 D', '2026-10-15', 5, '정책이 바뀌었다'),
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
      assert.match(seen, /아카이브 종합 분석/);
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
