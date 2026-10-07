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
