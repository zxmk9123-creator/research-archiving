const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const fb = require('../server/lib/answerFeedback');
const searchRouter = require('../server/routes/search');
const { issueSessionToken } = require('../server/lib/auth');

const RID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const good = { requestId: RID, rating: 1, question: '팜유 가격 전망은?', answer: '팜유 가격은 재고 증가로 하락했습니다 [1].\n\n| 항목 | 값 |\n|---|---|\n| 가격 | 4,100 |', sourceCount: 3 };

function mockPool({ known = true, rows = [] } = {}) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('FROM ai_search_logs')) return { rows: known ? [{ '?column?': 1 }] : [] };
    if (text.includes('FROM ai_answer_feedback')) return { rows };
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('answerFeatures: measures length, structure, citations and sources on the server', () => {
  const f = fb.answerFeatures(good.answer, 3);
  assert.equal(f.tables, 1);
  assert.equal(f.citations, 1);
  assert.equal(f.sources, 3);
  assert.ok(f.hangulRatio > 0.5 && f.chars === good.answer.length);
  assert.equal(fb.answerFeatures('', 0).chars, 0);
});

test('validateFeedback: rejects bad ids, ratings, reasons; trims and caps text; reason only with a 👎', () => {
  assert.equal(fb.validateFeedback({ ...good, requestId: 'nope' }).error, 'invalid_request_id');
  assert.equal(fb.validateFeedback({ ...good, rating: 5 }).error, 'invalid_rating');
  assert.equal(fb.validateFeedback({ ...good, question: ' ' }).error, 'question_and_answer_required');
  assert.equal(fb.validateFeedback({ ...good, rating: 1, reason: 'inaccurate' }).error, 'invalid_reason', 'a reason on a 👍 is refused');
  assert.equal(fb.validateFeedback({ ...good, rating: -1, reason: 'made_up' }).error, 'invalid_reason');
  assert.equal(fb.validateFeedback({ ...good, rating: -1, reason: 'inaccurate' }).ok, true);
  const big = fb.validateFeedback({ ...good, answer: 'x'.repeat(50000), question: 'q'.repeat(5000) });
  assert.equal(big.value.answer.length, fb.MAX_ANSWER);
  assert.equal(big.value.question.length, fb.MAX_QUESTION);
  assert.equal(fb.validateFeedback({ requestId: RID, rating: 0 }).ok, true, 'withdrawing needs no text');
});

test('saveFeedback: only answers this server produced can be rated; one vote per answer (upsert); rating 0 deletes', async () => {
  const unknown = mockPool({ known: false });
  try {
    const r = await fb.saveFeedback(pool, { ...good, requestId: '11111111-2222-4333-8444-555555555555' });
    assert.deepEqual([r.ok, r.status, r.error], [false, 404, 'unknown_request']);
    assert.ok(!unknown.calls.some((c) => /INSERT INTO ai_answer_feedback/.test(c.text)), 'nothing was stored');
  } finally { unknown.restore(); }

  const m = mockPool();
  try {
    const r = await fb.saveFeedback(pool, { ...good, requestId: '22222222-2222-4333-8444-555555555555' });
    assert.equal(r.saved, true);
    const ins = m.calls.find((c) => /INSERT INTO ai_answer_feedback/.test(c.text));
    assert.match(ins.text, /ON CONFLICT \(request_id\) DO UPDATE/);
    assert.equal(ins.params[1], 1);
    assert.equal(JSON.parse(ins.params[8]).tables, 1, 'features are computed from the answer, not taken from the client');
    const del = await fb.saveFeedback(pool, { requestId: '22222222-2222-4333-8444-555555555555', rating: 0 });
    assert.deepEqual([del.ok, del.saved], [true, false]);
    assert.ok(m.calls.some((c) => /DELETE FROM ai_answer_feedback/.test(c.text)));
  } finally { m.restore(); }
});

const row = (rating, chars, over = {}) => ({ rating, reason: rating === -1 ? 'too_long' : null, is_followup: false, features: { chars, citations: over.citations ?? 2, tables: over.tables ?? 0, charts: 0, paragraphs: 3, bullets: 0, distinctCitations: 1, numbers: 4, sources: 3 }, ...over });

test('analyze: reports comparisons only when both groups are big enough, and says so when the sample is small', () => {
  const tiny = fb.analyze([row(1, 300), row(-1, 2000)]);
  assert.equal(tiny.total, 2);
  assert.match(tiny.findings[0], /표본이 2건으로 적어/);
  assert.equal(tiny.groups.find((g) => g.key === 'short_answer').n, 1);
  assert.ok(!tiny.findings.some((f) => /길이에 따른/.test(f)), 'no length finding from one vote per side');

  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row(1, 300));    // short answers: liked
  for (let i = 0; i < 2; i++) rows.push(row(-1, 300));
  for (let i = 0; i < 3; i++) rows.push(row(1, 2000));    // long answers: mostly disliked
  for (let i = 0; i < 9; i++) rows.push(row(-1, 2000));
  const a = fb.analyze(rows);
  assert.deepEqual([a.liked, a.disliked], [15, 11]);
  assert.ok(a.findings.some((f) => /답변 길이에 따른 호평률 차이: 짧은 답변\(400자 미만\) 86%\(n=14\) vs 긴 답변\(1,500자 이상\) 25%\(n=12\)/.test(f)), a.findings.join('\n'));
  assert.ok(a.findings.some((f) => /싫어요 주된 사유: 너무 김 11건/.test(f)));
  const chars = a.featureMeans.find((m) => m.feature === 'chars');
  assert.ok(chars.liked < chars.disliked, 'liked answers are shorter on average here');
  assert.deepEqual(fb.analyze([]).findings.length, 1);
  assert.equal(fb.analyze(null).total, 0);
});

test('toJsonl: only the requested rating, newest first order kept, one JSON object per line', () => {
  const out = fb.toJsonl([{ rating: 1, question: 'q1', answer: 'a1', features: {}, created_at: 'x' }, { rating: -1, question: 'q2', answer: 'a2' }], 1);
  const lines = out.split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).question, 'q1');
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

test('routes: POST /feedback is open to readers; summary and export need the admin session', async () => {
  process.env.ADMIN_PASSWORD = 'test-admin-password';
  const m = mockPool({ rows: [{ rating: 1, reason: null, is_followup: false, features: { chars: 300, citations: 1 }, question: 'q', answer: 'a', created_at: 't' }] });
  try {
    await withServer(async (base) => {
      const post = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) });
      assert.equal(post.status, 200);
      assert.deepEqual(await post.json(), { ok: true, saved: true });
      const bad = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...good, rating: 9 }) });
      assert.equal(bad.status, 400);

      assert.equal((await fetch(`${base}/feedback/summary`)).status, 401);
      assert.equal((await fetch(`${base}/feedback/export`)).status, 401);

      const cookie = { cookie: `ra_admin_session=${issueSessionToken()}` };
      const sum = await fetch(`${base}/feedback/summary`, { headers: cookie });
      assert.equal(sum.status, 200);
      assert.equal((await sum.json()).liked, 1);
      const exp = await fetch(`${base}/feedback/export`, { headers: cookie });
      assert.equal(exp.status, 200);
      assert.match(exp.headers.get('content-type'), /ndjson/);
      assert.equal(JSON.parse((await exp.text()).split('\n')[0]).question, 'q');
    });
  } finally { m.restore(); }
});

test('routes: every search answer carries X-Request-Id so the page can attach a vote to exactly that answer', async () => {
  const m = mockPool();
  try {
    await withServer(async (base) => {
      const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '' }) });
      assert.equal(res.status, 400, 'an empty question never reaches the handler body that sets the header');
      const ok = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ question: '팜유 가격' }) });
      assert.match(ok.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/i);
    });
  } finally { m.restore(); }
});

test('schema.sql defines ai_answer_feedback with one vote per request id', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '../server/db/schema.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_answer_feedback/);
  assert.match(sql, /request_id UUID NOT NULL UNIQUE/);
  assert.match(sql, /rating SMALLINT NOT NULL CHECK \(rating IN \(-1, 1\)\)/);
});

test('answerQualityCheck: silent on thin data, pass when steady, warn on a drop', () => {
  const { answerQualityCheck } = require('../server/lib/answerFeedback');
  assert.deepEqual(answerQualityCheck(undefined), []);
  assert.deepEqual(answerQualityCheck({ recent: { up: 3, down: 2 }, prior: { up: 20, down: 5 } }), []);
  assert.equal(answerQualityCheck({ recent: { up: 8, down: 4 }, prior: { up: 16, down: 8 } })[0].status, 'pass');
  const w = answerQualityCheck({ recent: { up: 4, down: 8 }, prior: { up: 20, down: 5 } })[0];
  assert.equal(w.status, 'warn'); assert.equal(w.id, 'answer_quality');
});
