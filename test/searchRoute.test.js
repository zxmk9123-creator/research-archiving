const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const searchRouter = require('../server/routes/search');

// Same live-server harness convention as itemsRoute.test.js/sourcesRoute.test.js.
function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/search`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function mockPool(handlers) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

function mockProvider(behavior) {
  const original = provider.callProviderWithFallback;
  provider.callProviderWithFallback = behavior;
  return () => { provider.callProviderWithFallback = original; };
}

const SAMPLE_ROW = {
  id: 7,
  title: '팜유 가격 상승 보고서',
  summary: '인도네시아 수출 정책 변화로 팜유 가격이 상승했습니다.',
  insight: null,
  ai_summary: null,
  ai_insight: null,
  published_at: '2026-09-15',
  source_name: 'MPOB',
};

test('POST /: empty query returns 400 without touching the DB or the AI provider', async () => {
  const { calls, restore } = mockPool([]);
  const restoreProvider = mockProvider(async () => { throw new Error('should not be called'); });
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '   ' }),
      });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: retrieval only queries Published items and is bounded', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async () => ({ text: '팜유 가격은 인도네시아 수출 정책 변화로 상승했습니다. [1]', provider: 'freellmapi' }));
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.insufficient, false);
      assert.match(body.answer, /인도네시아/);

      const selectCall = calls.find((c) => c.text.includes('FROM items i'));
      assert.ok(selectCall);
      assert.match(selectCall.text, /i\.status = 'Published'/);
      assert.match(selectCall.text, /LIMIT 8/);
      assert.ok(!selectCall.text.includes('Draft'));
      assert.ok(!selectCall.text.includes('Rejected'));
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: citations are built from the retrieved DB rows, never from the AI text', async () => {
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async () => ({
    text: '답변 본문 [1]. 가짜출처: https://evil.example.com/fake',
    provider: 'freellmapi',
  }));
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      const body = await res.json();
      assert.equal(body.sources.length, 1);
      assert.deepEqual(body.sources[0], {
        id: SAMPLE_ROW.id,
        title: SAMPLE_ROW.title,
        source: SAMPLE_ROW.source_name,
        published_at: SAMPLE_ROW.published_at,
      });
      // The fabricated URL in the model's own text is never surfaced as a source.
      assert.ok(!JSON.stringify(body.sources).includes('evil.example.com'));
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: no matching Published materials returns an explicit insufficient-evidence response without calling the AI provider', async () => {
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  let providerCalled = false;
  const restoreProvider = mockProvider(async () => { providerCalled = true; return { text: 'x', provider: 'freellmapi' }; });
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '존재하지않는아주희귀한질문어휘조합' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.insufficient, true);
      assert.deepEqual(body.sources, []);
      assert.match(body.answer, /근거가 부족/);
      assert.equal(providerCalled, false);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: AI provider failure returns a generic 502 without leaking provider error details', async () => {
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async () => {
    const err = new Error('AI provider request failed (401): Bearer sk-secret-abc123');
    err.transient = false;
    throw err;
  });
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.ok(!JSON.stringify(body).includes('sk-secret-abc123'));
      assert.ok(body.error);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: a successful request writes exactly one ai_search_logs row, with metadata only — no raw question/answer', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async () => ({ text: '답변 본문입니다.', provider: 'freellmapi' }));
  try {
    await withServer(async (base) => {
      const question = '팜유 가격이 왜 올랐어?';
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      assert.equal(res.status, 200);

      const logCalls = calls.filter((c) => c.text.includes('INSERT INTO ai_search_logs'));
      assert.equal(logCalls.length, 1);
      const params = logCalls[0].params;
      const serialized = JSON.stringify(params);
      assert.ok(!serialized.includes(question), 'raw question must never be persisted');
      assert.ok(!serialized.includes('답변 본문입니다'), 'raw answer must never be persisted');
      // outcome, http_status, latency_ms, candidate_count, source_count,
      // provider, failure_type, is_followup, question_fingerprint — see
      // the INSERT column order in recordSearchTelemetry().
      assert.equal(params[1], 'ai_search');
      assert.equal(params[2], 'success');
      assert.equal(params[3], 200);
      assert.ok(typeof params[4] === 'number' && params[4] >= 0);
      assert.equal(params[5], 1); // candidate_count
      assert.equal(params[6], 1); // source_count
      assert.equal(params[7], 'freellmapi');
      assert.equal(params[9], false); // is_followup
      assert.equal(typeof params[10], 'string');
      assert.equal(params[10].length, 32); // one-way hash, not the raw question
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: insufficient-evidence requests also get exactly one terminal ai_search_logs row', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  const restoreProvider = mockProvider(async () => { throw new Error('should not be called'); });
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '존재하지않는아주희귀한질문어휘조합' }),
      });
      const logCalls = calls.filter((c) => c.text.includes('INSERT INTO ai_search_logs'));
      assert.equal(logCalls.length, 1);
      assert.equal(logCalls[0].params[2], 'insufficient_evidence');
      assert.equal(logCalls[0].params[3], 200);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: provider failures also get exactly one terminal ai_search_logs row, with the failure type but no credential text', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async () => {
    const err = new Error('AI provider request failed (401): Bearer sk-secret-abc123');
    err.failureType = 'auth';
    throw err;
  });
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      const logCalls = calls.filter((c) => c.text.includes('INSERT INTO ai_search_logs'));
      assert.equal(logCalls.length, 1);
      assert.equal(logCalls[0].params[2], 'provider_error');
      assert.equal(logCalls[0].params[3], 502);
      assert.equal(logCalls[0].params[8], 'auth'); // failure_type
      assert.ok(!JSON.stringify(logCalls[0].params).includes('sk-secret-abc123'));
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('POST /: retrieval failures also get exactly one terminal ai_search_logs row', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => { throw new Error('connection reset'); }],
  ]);
  const restoreProvider = mockProvider(async () => { throw new Error('should not be called'); });
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      assert.equal(res.status, 500);
      const logCalls = calls.filter((c) => c.text.includes('INSERT INTO ai_search_logs'));
      assert.equal(logCalls.length, 1);
      assert.equal(logCalls[0].params[2], 'retrieval_error');
      assert.equal(logCalls[0].params[3], 500);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('extractCitedIndices: returns distinct in-range indices in first-appearance order', () => {
  assert.deepEqual(searchRouter.extractCitedIndices('첫 문장 [3]. 둘째 문장 [1][3]. 셋째 [9].', 5), [3, 1]);
  assert.deepEqual(searchRouter.extractCitedIndices('근거 없는 답변입니다.', 5), []);
  // [9] is out of range (only 5 candidates exist) and must be ignored, not treated as cited.
  assert.deepEqual(searchRouter.extractCitedIndices('[9]만 있는 답변', 5), []);
});

test('remapCitationMarkers: rewrites markers to the cited set\'s own 1..k order, dropping anything uncited', () => {
  const text = '첫 문장 [3]. 둘째 문장 [1][3]. 안쓴 자료 [9].';
  const remapped = searchRouter.remapCitationMarkers(text, [3, 1]); // 3 -> 1, 1 -> 2
  assert.equal(remapped, '첫 문장 [1]. 둘째 문장 [2][1]. 안쓴 자료 .');
});

test('POST /: sources are narrowed to only the candidates the model actually cited with [N]', async () => {
  const ROW_A = { ...SAMPLE_ROW, id: 7, title: 'A' };
  const ROW_B = { ...SAMPLE_ROW, id: 8, title: 'B' };
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [ROW_A, ROW_B] })],
  ]);
  // Only 자료 2 (ROW_B) is actually cited — 자료 1 (ROW_A) was retrieved but
  // never used, so it must not appear in `sources` or the rendered answer.
  const restoreProvider = mockProvider(async () => ({ text: 'B에 근거한 문장입니다. [2]', provider: 'freellmapi' }));
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      const body = await res.json();
      assert.equal(body.sources.length, 1);
      assert.equal(body.sources[0].id, ROW_B.id);
      // The marker is remapped to [1] to match the single remaining source.
      assert.match(body.answer, /\[1\]/);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('questionFingerprint: one-way hash, stable for the same question, different for different questions', () => {
  const a = searchRouter.questionFingerprint('팜유 가격이 왜 올랐어?');
  const b = searchRouter.questionFingerprint('팜유 가격이 왜 올랐어?');
  const c = searchRouter.questionFingerprint('다른 질문입니다');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes('팜유'));
});

test('SYSTEM_PROMPT requires a [N] citation marker on every claim, for per-claim traceability', () => {
  const prompt = searchRouter.SYSTEM_PROMPT;
  assert.match(prompt, /Citations are REQUIRED/);
  assert.match(prompt, /\[N\]/);
  assert.match(prompt, /marked with its \[N\] citation/);
});

test('buildMaterialsBlock labels retrieved materials without bracket-style numbering (so the model has no bracket syntax to copy)', () => {
  const block = searchRouter.buildMaterialsBlock([
    { title: '팜유 가격 동향', source_name: 'MPOB', published_at: '2026-09-01', summary: '요약 내용', insight: null, ai_summary: null, ai_insight: null },
  ]);
  assert.match(block, /자료 1 — 제목: 팜유 가격 동향/);
  assert.ok(!block.includes('[1]'));
});

test('POST /: conversation history is folded into the provider prompt as prior turns', async () => {
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  let capturedUser = '';
  const restoreProvider = mockProvider(async ({ user }) => {
    capturedUser = user;
    return { text: '후속 답변입니다.', provider: 'freellmapi' };
  });
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: '인도네시아 요인을 더 자세히 설명해줘',
          history: [
            { role: 'user', content: '팜유 가격이 왜 올랐어?' },
            { role: 'assistant', content: '인도네시아 수출 정책 변화 때문입니다.' },
          ],
        }),
      });
      assert.match(capturedUser, /이전 대화/);
      assert.match(capturedUser, /팜유 가격이 왜 올랐어\?/);
      assert.match(capturedUser, /인도네시아 요인을 더 자세히 설명해줘/);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

// --- Follow-up retrieval resolution: a context-dependent follow-up ("그
//요인을 더 자세히 설명해줘") has almost no retrieval signal of its own, so
// without folding in the prior turn, retrieval would find nothing relevant
// even though the user is clearly still asking about the same topic. ---

test('resolveRetrievalQuery: a low-signal follow-up is combined with the most recent prior user turn', () => {
  const history = [
    { role: 'user', content: '팜유 가격이 왜 올랐어?' },
    { role: 'assistant', content: '인도네시아 수출 정책 변화 때문입니다.' },
  ];
  const resolved = searchRouter.resolveRetrievalQuery('더 자세히 설명해줘', history);
  assert.match(resolved, /팜유 가격이 왜 올랐어/);
  assert.match(resolved, /더 자세히 설명해줘/);
});

test('resolveRetrievalQuery: a question with enough of its own keywords is left unchanged, even with history present', () => {
  const history = [
    { role: 'user', content: '팜유 가격이 왜 올랐어?' },
    { role: 'assistant', content: '인도네시아 수출 정책 변화 때문입니다.' },
  ];
  const resolved = searchRouter.resolveRetrievalQuery('대두유 수입 관세율 변경 내용을 알려줘', history);
  assert.equal(resolved, '대두유 수입 관세율 변경 내용을 알려줘');
});

test('resolveRetrievalQuery: no history (first question) always returns the question unchanged', () => {
  assert.equal(searchRouter.resolveRetrievalQuery('더 자세히', []), '더 자세히');
  assert.equal(searchRouter.resolveRetrievalQuery('더 자세히', undefined), '더 자세히');
});

test('POST /: a low-signal follow-up still retrieves relevant materials by folding in the prior turn for retrieval', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async () => ({ text: '후속 답변입니다.', provider: 'freellmapi' }));
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: '더 자세히 설명해줘',
          history: [
            { role: 'user', content: '팜유 가격이 왜 올랐어?' },
            { role: 'assistant', content: '인도네시아 수출 정책 변화 때문입니다.' },
          ],
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.insufficient, false);
      assert.equal(body.sources.length, 1);
      const selectCall = calls.find((c) => c.text.includes('FROM items i'));
      // "팜유" from the prior turn must be among the ILIKE params used for retrieval.
      assert.ok(selectCall.params.some((p) => p.includes('팜유')));
    });
  } finally {
    restore();
    restoreProvider();
  }
});

// Production incident: an item clearly on-topic for a specific multi-
// keyword question (a Shell/SAF long-term purchase deal) never reached the
// chatbot. Root cause, confirmed directly against production data: ORDER BY
// published_at DESC NULLS LAST was the ONLY sort key — this item's
// published_at happened to be NULL (sorts dead last), and ~26 other items
// shared just the one keyword "SAF" with a real published_at, so LIMIT 8
// cut it off entirely regardless of how relevant it actually was (it
// matched 4-5 of the question's 5 keywords; the competing items matched
// only 1). mockPool returns canned rows and can't exercise real SQL
// ordering, so — consistent with how every other retrieval test in this
// file verifies behavior — these assert on the generated SQL/params
// directly rather than on which rows a mock "returns".

test('retrieveCandidates SQL: ranks by a computed per-keyword relevance score before published_at', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '쉘 SAF 장기 구매 계약' }),
      });
      const selectCall = calls.find((c) => c.text.includes('FROM items i'));
      assert.ok(selectCall);
      // relevance_score (a CASE WHEN per keyword, summed) is the primary
      // sort key; published_at only breaks ties among equally-relevant rows.
      assert.match(selectCall.text, /ORDER BY \(.*CASE WHEN.*\) DESC, i\.published_at DESC NULLS LAST/s);
      // One CASE WHEN per extracted keyword (saf/장기/구매/계약 — "쉘" alone
      // is 1 char and dropped by extractKeywords' length >= 2 filter).
      const caseWhenCount = (selectCall.text.match(/CASE WHEN/g) || []).length;
      assert.equal(caseWhenCount, 4);
    });
  } finally {
    restore();
  }
});

test('retrieveCandidates SQL: the relevance expression reuses the same bound params as the WHERE clause (no duplicate params)', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 수출 정책 변화' }),
      });
      const selectCall = calls.find((c) => c.text.includes('FROM items i'));
      assert.ok(selectCall);
      // 4 keywords (팜유/수출/정책/변화) -> 4 bound params, even though each
      // $N now appears twice in the query text (once for scoring, once in
      // WHERE) — reusing the same placeholder, not adding new ones.
      assert.equal(selectCall.params.length, 4);
    });
  } finally {
    restore();
  }
});
