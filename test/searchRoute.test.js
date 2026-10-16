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

      const selectCall = calls.find((c) => c.text.includes('ORDER BY ('));
      assert.ok(selectCall);
      assert.match(selectCall.text, /i\.status = 'Published'/);
      assert.match(selectCall.text, /LIMIT 60/);
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

test('moveCitationsAfterPunctuation: moves a marker (or run of markers) from before the closing punctuation to after it', () => {
  assert.equal(
    searchRouter.moveCitationsAfterPunctuation('정책이 변경되었다 [1].'),
    '정책이 변경되었다. [1]'
  );
  // no space before the marker, and multiple markers together
  assert.equal(
    searchRouter.moveCitationsAfterPunctuation('완료되었다[1][3].'),
    '완료되었다. [1][3]'
  );
  // already-correct placement (punctuation before the marker) is left alone
  assert.equal(
    searchRouter.moveCitationsAfterPunctuation('완료되었다. [1]'),
    '완료되었다. [1]'
  );
  // a marker with nothing after it (no sentence-ending punctuation) is untouched
  assert.equal(
    searchRouter.moveCitationsAfterPunctuation('근거 자료 [1]'),
    '근거 자료 [1]'
  );
});

test('POST /: a citation marker placed before the sentence\'s closing punctuation is moved to after it', async () => {
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) return { text: '[]', provider: 'freellmapi' };
    return { text: '팜유 공급 정책이 변경되었다 [1].', provider: 'freellmapi' };
  });
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 가격이 왜 올랐어?' }),
      });
      const body = await res.json();
      assert.equal(body.answer, '팜유 공급 정책이 변경되었다. [1]');
    });
  } finally {
    restore();
    restoreProvider();
  }
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

test('splitClaimLines: keeps only lines that actually cite something, in-range', () => {
  const text = '인용 없는 문장.\n인용 있는 문장 [1].\n범위 밖 인용 [9].';
  assert.deepEqual(searchRouter.splitClaimLines(text, 3), [
    { line: '인용 있는 문장 [1].', indices: [1] },
  ]);
});

test('parseUnsupportedClaimNumbers: parses a bracketed list, out-of-range/non-integer entries dropped', () => {
  assert.deepEqual(searchRouter.parseUnsupportedClaimNumbers('[2, 5]', 5), [2, 5]);
  assert.deepEqual(searchRouter.parseUnsupportedClaimNumbers('[]', 5), []);
  assert.deepEqual(searchRouter.parseUnsupportedClaimNumbers('[1, 9]', 5), [1]); // 9 is out of range
});

test('parseUnsupportedClaimNumbers: fails open (returns []) on an unparseable response', () => {
  assert.deepEqual(searchRouter.parseUnsupportedClaimNumbers('근거가 부족해서 판단할 수 없습니다.', 5), []);
  assert.deepEqual(searchRouter.parseUnsupportedClaimNumbers('', 5), []);
});

test('POST /: a citation the verification pass flags as unsupported is stripped — the claim stays, the citation does not', async () => {
  const ROW_A = { ...SAMPLE_ROW, id: 7, title: '바이오연료 정책 자료' };
  const ROW_B = { ...SAMPLE_ROW, id: 8, title: '해운 운임 자료' };
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [ROW_A, ROW_B] })],
  ]);
  // Two claims, each citing one material. The second call (verification,
  // identified by its system prompt) flags claim 2 as unsupported — its
  // cited 자료 2 (해운 운임) doesn't actually back a biofuel-policy claim.
  const restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) {
      return { text: '[2]', provider: 'freellmapi' };
    }
    return {
      text: '인도네시아 바이오연료 정책이 변경되었습니다. [1]\n해운 운임도 함께 언급됩니다. [2]',
      provider: 'freellmapi',
    };
  });
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '팜유 공급 변수가 뭐야?' }),
      });
      const body = await res.json();
      // Claim 2's marker was stripped, so only 자료 1 (ROW_A) remains cited.
      assert.equal(body.sources.length, 1);
      assert.equal(body.sources[0].id, ROW_A.id);
      assert.match(body.answer, /해운 운임도 함께 언급됩니다\./);
      assert.ok(!body.answer.includes('해운 운임도 함께 언급됩니다. [2]'));
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('withTimeout: resolves with the original promise\'s value when it finishes first', async () => {
  const result = await searchRouter.withTimeout(Promise.resolve('fast'), 50, () => { throw new Error('must not fire'); });
  assert.equal(result, 'fast');
});

test('withTimeout: rejects with onTimeout\'s thrown error when the timeout fires first, not an uncaught exception', async () => {
  const neverResolves = new Promise(() => {});
  await assert.rejects(
    () => searchRouter.withTimeout(neverResolves, 10, () => { throw new Error('timed out'); }),
    /timed out/
  );
});

test('POST /: a citation-verification call that exceeds the timeout fails open (unverified text, not a crash or a long wait)', async () => {
  const prevTimeout = process.env.AI_SEARCH_VERIFICATION_TIMEOUT_MS;
  process.env.AI_SEARCH_VERIFICATION_TIMEOUT_MS = '20';
  const { restore } = mockPool([['FROM items i', () => ({ rows: [SAMPLE_ROW] })]]);
  const restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) {
      // Never resolves within the 20ms test budget.
      await new Promise((r) => setTimeout(r, 5000));
      return { text: '[1]', provider: 'freellmapi' };
    }
    return { text: '답변 본문입니다. [1]', provider: 'freellmapi' };
  });
  try {
    await withServer(async (base) => {
      const startedAt = Date.now();
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '질문' }),
      });
      const body = await res.json();
      assert.ok(Date.now() - startedAt < 2000, 'must not wait anywhere near the full verification attempt');
      assert.match(body.answer, /\[1\]/, 'citation is kept as-is when verification times out, not stripped');
    });
  } finally {
    restore();
    restoreProvider();
    if (prevTimeout === undefined) delete process.env.AI_SEARCH_VERIFICATION_TIMEOUT_MS;
    else process.env.AI_SEARCH_VERIFICATION_TIMEOUT_MS = prevTimeout;
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

test('buildMaterialsBlock: truncates an unusually long summary/insight so prompt size stays bounded', () => {
  const longSummary = '가'.repeat(1000);
  const longInsight = '나'.repeat(1000);
  const block = searchRouter.buildMaterialsBlock([
    { title: 't', source_name: 's', published_at: null, summary: longSummary, insight: longInsight, ai_summary: null, ai_insight: null },
  ]);
  const summaryLine = block.split('\n').find((l) => l.startsWith('요약:'));
  const insightLine = block.split('\n').find((l) => l.startsWith('인사이트:'));
  assert.ok(summaryLine.length < longSummary.length);
  assert.ok(summaryLine.endsWith('…'));
  assert.ok(insightLine.length < longInsight.length);
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
      const selectCall = calls.find((c) => c.text.includes('ORDER BY ('));
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
      const selectCall = calls.find((c) => c.text.includes('ORDER BY ('));
      assert.ok(selectCall);
      // relevance_score (a CASE WHEN per keyword, summed) is the primary
      // sort key; published_at only breaks ties among equally-relevant rows.
      assert.match(selectCall.text, /ORDER BY \(.*CASE WHEN.*\) DESC, i\.published_at DESC NULLS LAST/s);
      // One CASE WHEN per extracted keyword (saf/장기/구매/계약 — "쉘" alone
      // is 1 char and dropped by extractKeywords' length >= 2 filter).
      const caseWhenCount = (selectCall.text.match(/CASE WHEN/g) || []).length;
      // (each concept appears in the SELECTed relevance_score and in ORDER BY)
      assert.equal(caseWhenCount, 4 * 2);
    });
  } finally {
    restore();
  }
});

test('retrieveCandidates SQL: an inflected question keyword also matches a candidate\'s differently-conjugated wording via its stem', async () => {
  // The reported bug: "국내 e-SAF 생산에 참여하는 기관 및 기업들" found nothing,
  // while a question whose own text happened to contain "e-SAF 생산"
  // verbatim did — because "참여하는"/"기업들" never literally appear in a
  // candidate that instead says "참여"/"기업". extractKeywords must add
  // each token's stem ("참여하는" -> "참여", "기업들" -> "기업") as its own
  // keyword, not just the exact inflected token.
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '국내 e-SAF 생산에 참여하는 기관 및 기업들' }),
      });
      const selectCall = calls.find((c) => c.text.includes('ORDER BY ('));
      assert.ok(selectCall);
      assert.ok(selectCall.params.includes('%참여하는%'));
      assert.ok(selectCall.params.includes('%참여%')); // the stem, as its own keyword
      assert.ok(selectCall.params.includes('%기업들%'));
      assert.ok(selectCall.params.includes('%기업%'));
      // Production incident #2 on this exact question: the single-char
      // particle "에" ("생산에") was missing from the suffix list, so
      // "생산" (100+ matching Published items) was invisible to this
      // query — only "생산에" (12 items) was ever searched.
      assert.ok(selectCall.params.includes('%생산에%'));
      assert.ok(selectCall.params.includes('%생산%'));
      // Production incident #3 on this exact question: the old tokenizer
      // stripped the hyphen in "e-SAF" before splitting on whitespace,
      // turning it into "e" + "SAF" — then dropped the 1-char "e",
      // collapsing "e-SAF" down to the same generic "saf" keyword a plain
      // "SAF" question produces. With the distinguishing "e-" prefix gone,
      // the chatbot could never rank e-SAF-specific material above the far
      // more numerous AtJ/ethanol-based SAF articles — confirmed live: it
      // answered with AtJ/ethanol SAF sources and reported no e-SAF data,
      // despite e-SAF-tagged Published items existing in the archive.
      assert.ok(selectCall.params.includes('%e-saf%'));
    });
  } finally {
    restore();
  }
});

test('extractKeywords (via retrieveCandidates SQL): a hyphenated technical term keeps its hyphen as a distinct, specific keyword alongside its stripped-down fallback', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'e-SAF production status' }),
      });
      const selectCall = calls.find((c) => c.text.includes('ORDER BY ('));
      assert.ok(selectCall);
      // Both the specific compound ("e-saf") and its generic fallback
      // ("saf") are searched — the specific one gets the higher IDF
      // weight (rarer in the corpus), so e-SAF-tagged material outranks
      // plain SAF material when both match, but a broader SAF question
      // still finds broader material via the fallback.
      assert.ok(selectCall.params.includes('%e-saf%'));
      assert.ok(selectCall.params.includes('%saf%'));
    });
  } finally {
    restore();
  }
});

async function keywordParamsFor(question) {
  const { calls, restore } = mockPool([['FROM items i', () => ({ rows: [] })]]);
  try {
    let params;
    await withServer(async (base) => {
      await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
      params = calls.find((c) => c.text.includes('ORDER BY ('))?.params;
    });
    return params;
  } finally {
    restore();
  }
}

test('keywords: a Korean particle glued to a Latin term is split off ("e-SAF에" -> e-saf, never "e-saf에"/"saf에")', async () => {
  // Production incident: "e-SAF에 대해 구체적으로 알려줘" searched "e-saf에" and
  // "saf에" (matching 0 and 3 items), so no e-SAF article reached the model
  // and it answered "근거가 부족합니다" despite ~20 e-SAF items in the archive.
  const params = await keywordParamsFor('e-SAF에 대해 구체적으로 알려줘');
  assert.ok(params.includes('%e-saf%'));
  assert.ok(params.includes('%saf%'));
  assert.ok(!params.includes('%e-saf에%'));
  assert.ok(!params.includes('%saf에%'));
});

test('keywords: question-framing words (대해/구체적으로/알려줘) are not searched', async () => {
  // They are rare in the archive's own text, so IDF weighting scored them as
  // "specific" and they out-ranked the real topic, filling all 8 slots with
  // unrelated articles.
  const params = await keywordParamsFor('e-SAF에 대해 구체적으로 알려줘');
  for (const framing of ['%대해%', '%구체적으로%', '%구체적%', '%알려줘%']) {
    assert.ok(!params.includes(framing), `${framing} must not be a search keyword`);
  }
});

test('P2 concepts: spelling variants of a hyphenated term are ONE concept (single CASE per concept, any topic)', async () => {
  for (const [q, variants] of [['e-SAF 생산 기술', ['%e-saf%', '%esaf%', '%e saf%']], ['bio-diesel 수출', ['%bio-diesel%', '%biodiesel%', '%bio diesel%']]]) {
    const params = await keywordParamsFor(q);
    for (const v of variants) assert.ok(params.includes(v), `${v} expected for "${q}"`);
  }
});

test('P2/P3: no hand-written semantic aliases — a term is never expanded to different words', async () => {
  const params = await keywordParamsFor('SAF 의무혼합');
  assert.ok(!params.some((p) => /power-to-liquid|e-fuel|synthetic/.test(p)));
});

test('P1: request endings and about-constructions are filtered for any topic, topic words are kept', () => {
  const { extractConcepts } = require('../server/routes/search');
  const flat = (q) => extractConcepts(q).flat();
  for (const q of ['팜유 수출 규제에 대해 정리해줘', '대두유 가격 전망 보여주세요', '바이오디젤 관련 자세히 알려줘']) {
    const f = flat(q);
    assert.ok(!f.some((t) => /줘|주세요|대해|관련|자세히/.test(t)), `framing leaked: ${f}`);
    assert.ok(f.length > 0);
  }
  assert.ok(flat('팜유 수출 규제에 대해 정리해줘').includes('팜유'));
});

test('P4: candidate selection keeps Korean and non-Korean relevant rows (any topic)', () => {
  const { selectDiverseCandidates } = require('../server/routes/search');
  const en = Array.from({ length: 24 }, (_, i) => ({ id: i, title: `English article ${i}`, relevance_score: 5 - i * 0.1 }));
  const ko = [{ id: 100, title: '국내 메가프로젝트 소식', relevance_score: 3 }, { id: 101, title: '국내 정책 동향', relevance_score: 2.5 }];
  const out = selectDiverseCandidates([...en, ...ko]);
  assert.equal(out.length, 12);
  assert.ok(out.some((r) => r.id === 100) && out.some((r) => r.id === 101));
  assert.deepEqual(out.map((r) => r.relevance_score), [...out.map((r) => r.relevance_score)].sort((a, b) => b - a));
  // irrelevant Korean rows (below floor) are not forced in
  const weak = selectDiverseCandidates([...en, { id: 200, title: '무관한 기사', relevance_score: 0.1 }]);
  assert.ok(!weak.some((r) => r.id === 200));
});

test('keywords: a question made ONLY of framing words still searches something (no empty retrieval)', async () => {
  const params = await keywordParamsFor('자세히 알려줘');
  assert.ok(params && params.length > 0);
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
      const selectCall = calls.find((c) => c.text.includes('ORDER BY ('));
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

test('P7: a parent-sector term is expanded to its member sectors, each retrieved separately (any group)', async () => {
  const { calls, restore } = mockPool([
    ['FROM sectors p JOIN sectors c', () => ({ rows: [{ name: '팜유' }, { name: '대두유' }] })],
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '식용유지 생산량을 그래프로 비교분석해줘' }) });
    });
    const perTarget = calls.filter((c) => c.text.includes('LIMIT 2'));
    assert.deepEqual(perTarget.map((c) => c.params[0]), ['%팜유%', '%대두유%']);
    // visualization/analysis request words are framing, not topic keywords
    const main = calls.find((c) => c.text.includes('LIMIT 60'));
    for (const w of ['%그래프%', '%비교분석%', '%비교%', '%분석%']) assert.ok(!main.params.includes(w), w);
  } finally {
    restore();
  }
});

test('SYSTEM_PROMPT: compact — a hard length rule that forces a complete ending, number fidelity, and chart/table format', () => {
  const p = searchRouter.SYSTEM_PROMPT;
  assert.match(p, /Length \(hard rule\)/);
  assert.match(p, /END COMPLETE/);
  assert.match(p, /NUMBER FIDELITY/);
  assert.match(p, /"combine":"sum"/);
  // the bloated protocols were rolled back (the system enforces these in code instead)
  for (const gone of ['Thoroughness protocol', 'Layout discipline for data answers', 'COMPLETENESS REQUESTS', 'UNIT UNIFICATION REQUESTS', 'Visualization process']) assert.ok(!p.includes(gone), gone);
  assert.ok(p.length < 9500, `prompt length ${p.length}`);
});


test('citation markers: [1, 2] / [1-3] / [자료 3] are normalised and [이전 답변] is dropped', () => {
  const n = searchRouter.normalizeCitationMarkers;
  assert.equal(n('A [1, 2]. B [1-3]. C [자료 3]. D [이전 답변] E [자료 1, 2]'), 'A [1][2]. B [1][2][3]. C [3]. D  E [1][2]');
  assert.equal(n('범위 [1-30]'), '범위 [1-30]'); // not a plausible range: untouched
});

test('citation verification guard: a flagged claim keeps its footnote when it shares numbers or body terms with the cited material', () => {
  const cands = [{ title: 'x', summary: 'Neste plans 1.2 Mt SAF in Rotterdam by 2027', insight: null }];
  assert.equal(searchRouter.claimOverlapsMaterials('로테르담 2027년 1.2 Mt 증설 [1]', [1], cands), true);
  assert.equal(searchRouter.claimOverlapsMaterials('팜유 가격이 상승했다 [1]', [1], cands), false);
});

test('P8: each specific subject of a multi-subject question gets its own retrieval slot (any entities)', async () => {
  const { calls, restore } = mockPool([
    ['SELECT count(*)', () => ({ rows: [{ cnt: 20 }] })],
    ['FROM sectors p JOIN sectors c', () => ({ rows: [] })],
    ['LIMIT 2', () => ({ rows: [] })],
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Neste, Eni, Chevron의 생산능력 비교' }) });
    });
    const perSubject = calls.filter((c) => c.text.includes('LIMIT 2')).map((c) => c.params[0]);
    for (const w of ['%neste%', '%eni%', '%chevron%']) assert.ok(perSubject.includes(w), `${w} needs its own slot`);
  } finally {
    restore();
  }
});

test('P9: a question about companies in general covers every watchlist company (any roster)', async () => {
  const { calls, restore } = mockPool([
    ['SELECT count(*)', () => ({ rows: [{ cnt: 20 }] })],
    ['FROM companies WHERE watched', () => ({ rows: [{ id: 1, name: 'Alpha Oil', aliases: ['Alpha'] }, { id: 2, name: 'Beta Fuels', aliases: [] }] })],
    ['FROM sectors p JOIN sectors c', () => ({ rows: [] })],
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '글로벌 정유업체의 전체 SAF Capa 데이터를 가져와서 시각화해줘' }) });
    });
    const perCompany = calls.filter((c) => c.text.includes('item_companies ic WHERE')).map((c) => c.params[0]);
    assert.deepEqual(perCompany.map((p) => p[0]), ['%Alpha Oil%', '%Beta Fuels%']);
    // a company-specific question does not trigger the roster sweep
    const before = calls.length;
    await withServer(async (base) => {
      await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '팜유 수출 정책 변화' }) });
    });
    assert.ok(!calls.slice(before).some((c) => c.text.includes('item_companies ic WHERE')));
  } finally {
    restore();
  }
});

test('chart safety net: parts of one known company are grouped; scenario-like parts and unknown names are left alone', () => {
  const roster = [{ name: 'Neste', names: ['neste', '네스테'] }, { name: 'Eni', names: ['enilive'] }];
  const chart = { type: 'hbar', labels: ['Neste 싱가포르', 'Neste 로테르담', 'Chevron Geismar', 'Neste Porvoo'], series: [{ name: 'c', data: [1, 2, 3, 4] }] };
  const out = searchRouter.enrichChartJson(chart, roster);
  assert.equal(out.combine, 'sum');
  assert.deepEqual(out.groups, ['Neste', 'Neste', 'Chevron Geismar', 'Neste']);
  const scen = { ...chart, labels: ['Enilive 현재', 'Enilive 2030', 'Neste 로테르담'] };
  assert.equal(searchRouter.enrichChartJson(scen, roster).combine, undefined);
  assert.equal(searchRouter.enrichChartJson({ ...chart, combine: 'sum' }, roster).groups, undefined);
});

test('enforced coverage: companies with supplied materials cannot be omitted from a collective answer (any roster)', () => {
  const roster = [{ name: 'Alpha Oil', names: ['alpha oil', 'alpha'] }, { name: 'Beta Fuels', names: ['beta fuels', 'beta'] }, { name: 'Gamma', names: ['gamma'] }];
  const cands = [
    { title: 'Alpha Oil plans SAF plant', summary: 'Alpha Oil 40 kt capacity', ai_summary: null },
    { title: 'Beta Fuels expansion', summary: 'Beta Fuels adds 60 kt', ai_summary: null },
    { title: 'Unrelated', summary: 'palm oil', ai_summary: null },
  ];
  assert.deepEqual(searchRouter.requiredCompanies('글로벌 업체별 SAF 능력', cands, roster).map((c) => [c.name, c.indices]), [['Alpha Oil', [1]], ['Beta Fuels', [2]]]);
  assert.deepEqual(searchRouter.requiredCompanies('팜유 수출 정책', cands, roster), []); // not a collective question
  const req = searchRouter.requiredCompanies('글로벌 업체별 SAF 능력', cands, roster);
  assert.match(searchRouter.buildCoverageBlock(req), /Alpha Oil \(자료 1\)[\s\S]*Beta Fuels \(자료 2\)/);
  // answer mentions Alpha only -> Beta is appended with its own footnote; nothing appended when all present
  const out = searchRouter.ensureCompanyCoverage('Alpha Oil은 40 kt [1]', req, cands);
  assert.match(out, /추가 확인된 업체[\s\S]*\*\*Beta Fuels\*\*: Beta Fuels adds 60 kt \[2\]/);
  assert.equal(searchRouter.ensureCompanyCoverage('Alpha Oil [1] Beta Fuels [2]', req, cands), 'Alpha Oil [1] Beta Fuels [2]');
});

test('finalizeAnswer with a verified dataset: the system table+chart lead, the model\'s own table/chart are dropped, footnotes cover the dataset sources', async () => {
  const dp = require('../server/lib/datasetPipeline');
  const mt = (m) => [m.title, m.summary].filter(Boolean).join(' ');
  const cands = [
    { id: 11, title: 'Neste', summary: 'Neste Rotterdam 1.2 Mt/a; Singapore 1.0 Mt/a', source_name: 's' },
    { id: 12, title: 'DGD', summary: 'Port Arthur SAF 235 million gallons per year', source_name: 's' },
    { id: 13, title: 'Eni', summary: 'Gela 400 kt per year', source_name: 's' },
  ];
  const rec = (o) => ({ site: null, period: '연간', status: '가동', year: null, ...o });
  const dataset = dp.buildDataset(dp.verifyRecords([
    rec({ entity: 'Neste', site: '로테르담', value: 1.2, unit: 'Mt', source: 1 }),
    rec({ entity: 'DGD', site: 'Port Arthur', value: 235, unit: 'million gallons', source: 2 }),
    rec({ entity: 'Eni', site: 'Gela', value: 400, unit: 'kt', source: 3 }),
  ], cands, mt, { density: 0.8 }), [], { unitTons: true, density: 0.8 });
  const restoreProvider = mockProvider(async () => ({ text: '[]', provider: 'freellmapi' }));
  try {
    const model = '핵심 해석입니다. [1]\n| 모델표 | 값 |\n| --- | --- |\n| a | 1 |\n```chart\n{"type":"bar","labels":["a","b"],"series":[{"name":"x","data":[1,2]}]}\n```\nEni도 큽니다. [3]';
    const { answer, sources } = await searchRouter.finalizeAnswer(model, cands, undefined, [], 'SAF Capa를 그래프로', dataset);
    assert.ok(answer.startsWith('| 대상 | 거점·범위 | 상태 | 기준 |'));
    assert.equal((answer.match(/```chart/g) || []).length, 1);
    assert.ok(!answer.includes('모델표'));
    assert.match(answer, /핵심 해석입니다\./);
    assert.deepEqual(sources.map((s) => s.id).sort(), [11, 12, 13]);
  } finally {
    restoreProvider();
  }
});

test('callHedged: a stalled first attempt is hedged by a second; first valid answer wins and the loser is aborted', async () => {
  let calls = 0;
  let loserAborted = false;
  const restoreProvider = mockProvider((msgs, { signal }) => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve, reject) => { signal.addEventListener('abort', () => { loserAborted = true; reject(new Error('aborted')); }); }); // stalls forever
    }
    return Promise.resolve({ text: 'fast second', provider: 'p' });
  });
  try {
    const r = await searchRouter.callHedged({ system: 's', user: 'u' }, { hedgeAfterMs: 20 });
    assert.equal(r.text, 'fast second');
    assert.equal(calls, 2);
    assert.equal(loserAborted, true);
  } finally {
    restoreProvider();
  }
});

test('callHedged: a fast failure retries once immediately; two failures reject; a fast success never hedges', async () => {
  let calls = 0;
  let restoreProvider = mockProvider(() => { calls++; return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ text: 'ok' }); });
  try {
    assert.equal((await searchRouter.callHedged({}, { hedgeAfterMs: 5000 })).text, 'ok');
    assert.equal(calls, 2);
  } finally { restoreProvider(); }
  calls = 0;
  restoreProvider = mockProvider(() => { calls++; return Promise.reject(new Error('down')); });
  try {
    await assert.rejects(searchRouter.callHedged({}, { hedgeAfterMs: 5000 }), /down/);
    assert.equal(calls, 2);
  } finally { restoreProvider(); }
  calls = 0;
  restoreProvider = mockProvider(() => { calls++; return Promise.resolve({ text: 'quick' }); });
  try {
    await searchRouter.callHedged({}, { hedgeAfterMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 1);
  } finally { restoreProvider(); }
});

test('verification is deterministic-first: concretely grounded claims trigger NO verifier call', async () => {
  const cands = [{ id: 1, title: 'Neste Rotterdam', summary: 'Neste Rotterdam refinery SAF capacity 1.2 Mt per year 2026 expansion', source_name: 's' }];
  let verifierCalls = 0;
  const restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) verifierCalls++;
    return { text: '[]', provider: 'p' };
  });
  try {
    await searchRouter.finalizeAnswer('Neste 로테르담은 2026년 1.2 Mt SAF capacity 증설 [1]', cands, undefined, [], '', null);
    assert.equal(verifierCalls, 0);
    await searchRouter.finalizeAnswer('팜유 가격이 크게 상승했다 [1]', cands, undefined, [], '', null);
    assert.equal(verifierCalls, 1); // an ungrounded claim still goes to the judge
  } finally {
    restoreProvider();
  }
});

test('answer cache: the same question over the same evidence is served without calling the provider again', async () => {
  const prev = process.env.AI_SEARCH_CACHE;
  process.env.AI_SEARCH_CACHE = 'on';
  searchRouter._clearAnswerCache();
  const { restore } = mockPool([['FROM items i', () => ({ rows: [SAMPLE_ROW] })]]);
  let providerCalls = 0;
  const restoreProvider = mockProvider(async () => { providerCalls++; return { text: '인도네시아 수출 정책으로 팜유 가격이 상승했습니다. [1]', provider: 'p' }; });
  try {
    await withServer(async (base) => {
      const ask = () => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '팜유 가격 이유' }) }).then((r) => r.json());
      const a = await ask();
      const callsAfterFirst = providerCalls;
      const b = await ask();
      assert.equal(b.answer, a.answer);
      assert.equal(providerCalls, callsAfterFirst); // no new provider call
      const withHistory = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '팜유 가격 이유', history: [{ role: 'user', content: 'x' }] }) }).then((r) => r.json());
      assert.ok(withHistory.answer);
      assert.ok(providerCalls > callsAfterFirst); // follow-ups are never cached
    });
  } finally {
    restore();
    restoreProvider();
    searchRouter._clearAnswerCache();
    if (prev === undefined) process.env.AI_SEARCH_CACHE = 'off'; else process.env.AI_SEARCH_CACHE = prev;
  }
});

test('guide card: a heavy request returns a scope plan first and starts NO AI work until confirmed', async () => {
  const { restore } = mockPool([['FROM items i', () => ({ rows: [SAMPLE_ROW] })]]);
  let providerCalls = 0;
  const restoreProvider = mockProvider(async () => { providerCalls++; return { text: '답변 [1]', provider: 'p' }; });
  try {
    await withServer(async (base) => {
      const post = (body) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      const card = await post({ question: '글로벌 SAF 플랜트 Capa를 그래프로 정리해줘' });
      assert.equal(card.needsConfirmation, true);
      assert.equal(providerCalls, 0);
      assert.deepEqual(card.plan.options.map((o) => o.id), ['quick', 'full']);
      assert.equal(card.plan.recommended, 'quick'); // the lighter, faster scope is recommended
      for (const o of card.plan.options) assert.ok(o.tokens > 0 && o.aiCalls && o.seconds && o.tokensText);
      assert.ok(card.plan.options[0].tokens < card.plan.options[1].tokens || card.plan.options[0].aiCalls === '1회');
      // confirmed: the work runs
      const done = await post({ question: '글로벌 SAF 플랜트 Capa를 그래프로 정리해줘', scope: { confirmed: true, mode: 'full' } });
      assert.ok(done.answer);
      assert.ok(providerCalls > 0);
      // an ordinary question never shows a card
      providerCalls = 0;
      const plain = await post({ question: '팜유 가격 이유' });
      assert.ok(plain.answer && !plain.needsConfirmation);
    });
  } finally {
    restore();
    restoreProvider();
  }
});

test('guide card: the quick scope skips the dataset extraction and the roster sweep', async () => {
  const { calls, restore } = mockPool([
    ['FROM companies WHERE watched', () => ({ rows: [{ id: 1, name: 'Alpha', aliases: [] }] })],
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
  ]);
  const seenSystems = [];
  const restoreProvider = mockProvider(async ({ system }) => { seenSystems.push(system === searchRouter.VERIFICATION_SYSTEM_PROMPT ? 'verify' : /extract a structured dataset/i.test(system) ? 'extract' : 'write'); return { text: '요약 [1]', provider: 'p' }; });
  try {
    await withServer(async (base) => {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '글로벌 SAF 플랜트 Capa를 누락없이 그래프로', scope: { confirmed: true, mode: 'quick' } }) }).then((x) => x.json());
      assert.ok(r.answer);
    });
    assert.ok(!seenSystems.includes('extract'));
    assert.ok(!calls.some((c) => c.text.includes('item_companies ic WHERE')), 'no roster sweep in quick mode');
  } finally {
    restore();
    restoreProvider();
  }
});

test('workloadPlan: light requests are never heavy; dataset and whole-roster requests are', () => {
  const wp = require('../server/lib/workloadPlan');
  const base = { candidates: [{ id: 1 }, { id: 2 }], required: [], systemChars: 9000, materialsChars: 20000, extractionChars: 8000 };
  assert.equal(wp.assessWorkload({ ...base, question: '팜유 가격 이유' }).heavy, false);
  assert.equal(wp.assessWorkload({ ...base, question: 'SAF Capa 알려줘' }).heavy, false);
  assert.equal(wp.assessWorkload({ ...base, question: 'SAF Capa를 그래프로' }).heavy, true);
  const roster = [1, 2, 3].map((i) => ({ name: `C${i}` }));
  assert.equal(wp.assessWorkload({ ...base, required: roster, question: '모든 업체 현황을 누락 없이' }).heavy, true);
});

test('"Neste 업체에 대해 알려줘": a focused company profile — profile instructions, no roster sweep, no appended roster companies', async () => {
  const { calls, restore } = mockPool([
    ['FROM companies WHERE watched', () => ({ rows: [{ id: 1, name: 'Neste', aliases: ['네스테'] }, { id: 2, name: 'Eni', aliases: [] }, { id: 3, name: 'Infinium', aliases: [] }] })],
    ['FROM items i', () => ({ rows: [
      { ...SAMPLE_ROW, id: 21, title: 'Neste opens Singapore refinery', summary: 'Neste 싱가포르 정제소 연 100만 톤 SAF 생산.' },
      { ...SAMPLE_ROW, id: 22, title: 'Infinium Texas eSAF', summary: 'Infinium 텍사스 eSAF 연 10만 톤 프로젝트.' },
    ] })],
  ]);
  let writerPrompt = '';
  const restoreProvider = mockProvider(async ({ system, user }) => {
    if (system === searchRouter.SYSTEM_PROMPT) writerPrompt = user;
    return { text: '# 개요\nNeste는 SAF 선도 기업이다. [1]', provider: 'p' };
  });
  try {
    await withServer(async (base) => {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Neste 업체에 대해 알려줘' }) }).then((x) => x.json());
      assert.ok(r.answer && !r.needsConfirmation);
      assert.ok(!r.answer.includes('추가 확인된 업체'));
    });
    assert.match(writerPrompt, /질의 유형: 기업 프로파일 — Neste/);
    assert.ok(!/필수 포함 업체/.test(writerPrompt));
    assert.ok(!calls.some((c) => c.text.includes('item_companies ic WHERE')), 'no roster sweep');
  } finally {
    restore();
    restoreProvider();
  }
});

test('truncation: the provider notice is never shown — the answer is continued once, or trimmed to its last complete block', async () => {
  const NOTICE = '\n\n⚠ 답변이 길이 제한으로 인해 중간에 잘렸습니다. 더 좁은 질문으로 다시 물어보시면 전체 답변을 받을 수 있습니다.';
  const cands = [{ id: 1, title: 'Neste', summary: 'Neste 싱가포르 연 100만 톤 SAF', source_name: 's' }];
  const cut = '# 개요\nNeste는 SAF 선도 기업이다. [1]\n- 싱가포르 연 100만 톤 SAF를 생산하며 이는 세계 최대 규모이고 아시아 공급의 핵심이므로 향후 확장이';
  // 1) continuation succeeds
  let restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) return { text: '[]', provider: 'p' };
    return { text: ' 기대된다. [1]', provider: 'p' };
  });
  try {
    const { answer } = await searchRouter.finalizeAnswer(cut + NOTICE, cands, undefined, [], '', null);
    assert.ok(!answer.includes('길이 제한'));
    assert.match(answer, /확장이 기대된다\./);
  } finally { restoreProvider(); }
  // 2) continuation fails -> trimmed back to the last complete sentence, still no notice
  restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) return { text: '[]', provider: 'p' };
    throw new Error('provider down');
  });
  try {
    const { answer } = await searchRouter.finalizeAnswer(cut + NOTICE, cands, undefined, [], '', null);
    assert.ok(!answer.includes('길이 제한'));
    assert.ok(!answer.includes('향후 확장이'));
    assert.match(answer, /Neste는 SAF 선도 기업이다\./);
  } finally { restoreProvider(); }
});

test('trimToCompleteBlock: drops half a table row, an unfinished chart fence and a cut-off sentence', () => {
  const t = searchRouter.trimToCompleteBlock;
  assert.equal(t('문장 하나다.\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |'), '문장 하나다.\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(t('요약이다.\n```chart\n{"type":"bar","labels":["a'), '요약이다.');
  assert.equal(t('첫 문장이다. 두 번째 문장은 길어지다가 끊기는 부분이 있어서 이렇게'), '첫 문장이다.');
  assert.equal(t('# 제목\n- 짧은 항목 [1]'), '# 제목\n- 짧은 항목 [1]');
});

test('stray foreign-script characters are removed from Korean prose unless the materials contain them', () => {
  const s = searchRouter.stripStrayScripts;
  assert.equal(s('재생 디زل, SAF', [{ title: 't', summary: 'x' }]), '재생 디, SAF');
  assert.equal(s('Роснефть와 협력', [{ title: 'Роснефть', summary: 'x' }]), 'Роснефть와 협력');
  assert.equal(s('plain english text', []), 'plain english text');
});

test('a grounded-less derived figure in parentheses is dropped with its parenthesis, not shown as a warning', () => {
  const nc = require('../server/lib/numberCheck');
  const r = nc.guardAnswerNumbers('일일 48,000배럴 (연간 약 999만 톤) 가동 [1]', [{ summary: 'Martinez 48,000 b/d capacity' }], () => [1], (m) => m.summary);
  assert.equal(r.text, '일일 48,000배럴 가동 [1]');
});

test('chart labels: different plants of one known company merge into one stacked row; state wording is canonical (현대/기존/가동 -> 현재)', () => {
  const roster = [{ name: 'Neste', names: ['neste'] }, { name: 'Chevron', names: ['chevron'] }, { name: 'Phillips 66', names: ['phillips 66'] }];
  const chart = {
    type: 'hbar', unit: '톤',
    labels: ['Neste Rotterdam (2026)', 'Neste Singapore (현대)', 'Chevron (2030 목표, 10만 b/d)', 'Chevron Geismar (기존)', 'Phillips 66 Rodeo'],
    series: [{ name: 's', data: [1200000, 1000000, 4646000, 1030000, 2310000] }],
  };
  const out = searchRouter.enrichChartJson(chart, roster);
  assert.equal(out.combine, 'sum');
  assert.deepEqual(out.groups.slice(0, 2), ['Neste', 'Neste']); // plants with their own site names merge
  assert.notEqual(out.groups[2], 'Chevron'); // a corporate target (no site) is never summed with a plant
  assert.equal(out.labels[1], 'Neste Singapore (현재)');
  assert.equal(out.labels[3], 'Chevron Geismar (현재)');
  assert.equal(out.labels[2], 'Chevron (2030 목표, 10만 b/d)'); // unrecognised detail text is left as written
  assert.equal(out.notes[0], '2026');
  assert.equal(searchRouter.normalizeStatusLabel('Eco (2030 신규 SAF 플랜트)'), 'Eco (2030 계획)'); // long status wording is shortened to the canonical term
  assert.equal(searchRouter.normalizeStatusLabel('Eco (2030 신규)'), 'Eco (2030 계획)');
  assert.equal(searchRouter.normalizeStatusLabel('Eco (기존 재생 연료)'), 'Eco (기존 재생 연료)');
  assert.equal(searchRouter.normalizeStatusLabel('Eco (기존)'), 'Eco (현재)');
});

test('proper-noun canonicalization: a near-misspelling of a name in the materials is restored (Ecoseas -> EcoCeres)', () => {
  const nf = require('../server/lib/nameFix');
  const mats = ['EcoCeres plans a SAF plant in Dongguan', 'Neste Rotterdam Singapore'];
  const roster = [{ name: '에코세레스', rawNames: ['EcoCeres'] }];
  assert.equal(nf.canonicalizeProperNouns('Ecoseas는 Neste와 Singapore에 있다', mats, roster), 'EcoCeres는 Neste와 Singapore에 있다');
  assert.equal(nf.canonicalizeProperNouns('Neste Rotterdam', mats, roster), 'Neste Rotterdam');
  assert.equal(nf.canonicalizeProperNouns('Zzzzzzzz stays', mats, roster), 'Zzzzzzzz stays');
});

test('item_facts: a quantity dataset is built from stored facts with NO extraction call', async () => {
  const rows = [
    { ...SAMPLE_ROW, id: 31, title: 'Neste Rotterdam', summary: 'Neste 로테르담 정제소 연 120만 톤 SAF 생산 계획.' },
    { ...SAMPLE_ROW, id: 32, title: 'Neste Singapore', summary: 'Neste 싱가포르 연 100만 톤 SAF 생산.' },
    { ...SAMPLE_ROW, id: 33, title: 'Eni Gela', summary: 'Eni Gela 400 kt 연간 SAF.' },
  ];
  const { restore } = mockPool([
    ['FROM item_facts', () => ({ rows: [
      { item_id: 31, entity: 'Neste', site: '로테르담', metric: '생산능력', status: '계획', year: 2026, grp: 'mass', amount: 1200000, basis: '직접', original: '120 만 톤' },
      { item_id: 32, entity: 'Neste', site: '싱가포르', metric: '생산능력', status: '가동', year: null, grp: 'mass', amount: 1000000, basis: '직접', original: '100 만 톤' },
      { item_id: 33, entity: 'Eni', site: 'Gela', metric: '생산능력', status: '가동', year: null, grp: 'mass', amount: 400000, basis: '직접', original: '400 kt' },
    ] })],
    ['facts_status FROM items', () => ({ rows: [{ id: 31, facts_status: 'done' }, { id: 32, facts_status: 'done' }, { id: 33, facts_status: 'done' }] })],
    ['FROM companies WHERE watched', () => ({ rows: [] })],
    ['FROM items i', () => ({ rows: rows })],
  ]);
  let extractionCalls = 0;
  const restoreProvider = mockProvider(async ({ system }) => {
    if (/extract a structured dataset/i.test(system)) { extractionCalls++; return { text: '[]', provider: 'p' }; }
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) return { text: '[]', provider: 'p' };
    return { text: '핵심 해석이다. [1]', provider: 'p' };
  });
  try {
    await withServer(async (base) => {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'SAF 생산능력을 그래프로 정리해줘', scope: { confirmed: true, mode: 'full' } }) }).then((x) => x.json());
      assert.ok(r.answer.startsWith('| 대상 | 거점·범위 | 상태 | 기준 |'));
      assert.match(r.answer, /\| Neste \| 로테르담 \| 계획 \| 2026년 \| 1,200,000 \|/);
      assert.ok((r.answer.match(/```chart/g) || []).length >= 1);
    });
    assert.equal(extractionCalls, 0, 'stored facts replace the extraction call');
  } finally {
    restore();
    restoreProvider();
  }
});

test('visual requests always end with a table or a chart: an answer with neither is condensed into one table', async () => {
  const cands = [{ id: 1, title: 'a', summary: 'x', source_name: 's' }];
  const restoreProvider = mockProvider(async ({ system }) => {
    if (system === searchRouter.VERIFICATION_SYSTEM_PROMPT) return { text: '[]', provider: 'p' };
    return { text: '| 항목 | 내용 |\n| --- | --- |\n| 구조 | 요약 [1] |', provider: 'p' };
  });
  try {
    const out = await searchRouter.finalizeAnswer('시장 구조는 이렇다. [1]', cands, undefined, [], '시장 구조를 도식화해줘', null);
    assert.match(out.answer, /\| 항목 \| 내용 \|/);
    // not a visual request: nothing is added
    const plain = await searchRouter.finalizeAnswer('시장 구조는 이렇다. [1]', cands, undefined, [], '시장 구조 알려줘', null);
    assert.ok(!plain.answer.includes('|'));
  } finally {
    restoreProvider();
  }
});

test('with a verified dataset the writer\'s own unit-conversion remarks are dropped (the dataset states the basis)', async () => {
  const dpm = require('../server/lib/datasetPipeline');
  const mt = (m) => [m.title, m.summary].filter(Boolean).join(' ');
  const cands = [
    { id: 1, title: 'a', summary: 'Alpha 1.2 Mt; Beta 1.0 Mt; Gamma 0.5 Mt', source_name: 's' },
  ];
  const rec = (o) => ({ site: null, period: '연간', status: '가동', year: null, ...o });
  const dataset = dpm.buildDataset(dpm.verifyRecords([
    rec({ entity: 'Alpha', value: 1.2, unit: 'Mt', source: 1 }), rec({ entity: 'Beta', value: 1.0, unit: 'Mt', source: 1 }), rec({ entity: 'Gamma', value: 0.5, unit: 'Mt', source: 1 }),
  ], cands, mt, { density: null }), [], {});
  const restoreProvider = mockProvider(async () => ({ text: '[]', provider: 'p' }));
  try {
    const out = await searchRouter.finalizeAnswer('핵심 해석이다. [1]\n단위 변환 참고: 1억 갤런 = 0.003 인치 [1]', cands, undefined, [], 'Capa를 그래프로', dataset);
    assert.ok(!out.answer.includes('단위 변환 참고'));
    assert.match(out.answer, /핵심 해석이다\./);
  } finally {
    restoreProvider();
  }
});
