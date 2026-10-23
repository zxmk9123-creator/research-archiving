const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const searchRouter = require('../server/routes/search');
const { isNewTopic } = require('../server/lib/topicShift');

const { extractConcepts } = searchRouter;
const history = [{ role: 'user', content: '팜유 시장 동향 알려줘' }, { role: 'assistant', content: '팜유 시장은 ... [1]' }];

test('isNewTopic: an unrelated question with its own terms is a new topic; referential or overlapping ones are not', () => {
  assert.equal(isNewTopic('AtJ 프로젝트 리스트업 해줘', history, { subject: '팜유' }, extractConcepts), true);
  assert.equal(isNewTopic('그럼 AtJ 프로젝트는?', history, { subject: '팜유' }, extractConcepts), false); // refers back
  assert.equal(isNewTopic('팜유 수출 전망은 어때?', history, { subject: '팜유' }, extractConcepts), false); // same subject
  assert.equal(isNewTopic('AtJ', history, null, extractConcepts), false); // too thin to judge
  assert.equal(isNewTopic('AtJ 프로젝트 리스트업 해줘', [], null, extractConcepts), false); // no previous turn
});

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
const ROW = { id: 5, title: 'AtJ 프로젝트 소식', summary: 'LanzaJet AtJ 프로젝트', insight: null, ai_summary: null, ai_insight: null, published_at: '2026-10-20', source_name: 'Src', relevance_score: 3 };
const flat = (params) => JSON.stringify(params || []);

function run(body, { rowsFor }) {
  const original = pool.query;
  const retrievalParams = [];
  pool.query = async (text, params) => {
    if (text.includes('FROM items i') && text.includes('relevance_score')) retrievalParams.push(flat(params));
    if (text.includes('FROM items i')) return { rows: rowsFor(flat(params)) };
    return { rows: [] };
  };
  const originalProvider = provider.callProviderWithFallback;
  let seenUser = null;
  provider.callProviderWithFallback = async ({ user }) => { if (!seenUser && /\[Research Center materials\]/.test(user)) seenUser = user; return { text: '답변 [1]', provider: 'freellmapi' }; };
  return withServer((base) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()))
    .then(() => ({ retrievalParams, seenUser }))
    .finally(() => { pool.query = original; provider.callProviderWithFallback = originalProvider; });
}

test('POST /: an unrelated follow-up is searched on its own — no inherited sector, history or 팜유 in the query', async () => {
  const { retrievalParams, seenUser } = await run(
    { question: 'AtJ 프로젝트 리스트업 해줘', history, context: { subject: '팜유', classification: {}, entities: [] } },
    { rowsFor: (p) => (p.includes('팜유') ? [] : [ROW, { ...ROW, id: 6, title: 'AtJ 두번째' }, { ...ROW, id: 7, title: 'AtJ 세번째' }]) },
  );
  assert.ok(retrievalParams.length && retrievalParams.every((p) => !p.includes('팜유')));
  assert.ok(seenUser && !seenUser.includes('[이전 대화]') && !seenUser.includes('[대상:'));
});

test('POST /: a referential follow-up that finds almost nothing with the conversation falls back to the question alone', async () => {
  const { seenUser } = await run(
    { question: '그럼 AtJ 프로젝트는?', history, context: { subject: '팜유', classification: {}, entities: [] } },
    { rowsFor: (p) => (p.includes('팜유') ? [] : [ROW, { ...ROW, id: 6, title: 'AtJ 두번째' }, { ...ROW, id: 7, title: 'AtJ 세번째' }]) },
  );
  assert.ok(seenUser, 'the question still reached the writer with materials instead of "insufficient"');
  assert.ok(!seenUser.includes('[이전 대화]'));
});
