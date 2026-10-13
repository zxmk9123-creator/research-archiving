const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const searchRouter = require('../server/routes/search');

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

function mockStreamingProvider(behavior) {
  const original = provider.callProviderWithFallbackStreaming;
  provider.callProviderWithFallbackStreaming = behavior;
  return () => { provider.callProviderWithFallbackStreaming = original; };
}

const SAMPLE_ROW = {
  id: 7, title: '팜유 가격 상승 보고서', summary: '인도네시아 수출 정책 변화로 팜유 가격이 상승했습니다.',
  insight: null, ai_summary: null, ai_insight: null, published_at: '2026-09-15', source_name: 'MPOB',
};

// Parses the raw SSE body text into [{event, data}] — good enough for
// assertions without needing a real EventSource/streaming reader.
function parseSse(raw) {
  return raw.split('\n\n').filter(Boolean).map((block) => {
    const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    return { event: eventLine ? eventLine.slice(6).trim() : null, data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : null };
  });
}

async function postStreaming(base, body) {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
}

test('wantsStream: true only when Accept includes text/event-stream', () => {
  assert.equal(searchRouter.wantsStream({ get: () => 'text/event-stream' }), true);
  assert.equal(searchRouter.wantsStream({ get: () => 'application/json' }), false);
  assert.equal(searchRouter.wantsStream({ get: () => undefined }), false);
});

test('POST / (streaming): sends a token event per delta, then a done event with the finalized answer/sources', () => withServer(async (base) => {
  const { restore } = mockPool([['FROM items i', () => ({ rows: [SAMPLE_ROW] })]]);
  const restoreProvider = mockStreamingProvider(async ({ system, user }, onToken) => {
    onToken('팜유 가격이');
    onToken(' 상승했다 [1].');
    return { text: '팜유 가격이 상승했다 [1].', ttftMs: 42, model: 'auto' };
  });
  try {
    const res = await postStreaming(base, { question: '팜유 가격이 왜 올랐어?' });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const events = parseSse(await res.text());
    const tokenEvents = events.filter((e) => e.event === 'token');
    assert.deepEqual(tokenEvents.map((e) => e.data.delta), ['팜유 가격이', ' 상승했다 [1].']);
    const doneEvent = events.find((e) => e.event === 'done');
    assert.ok(doneEvent);
    assert.equal(doneEvent.data.insufficient, false);
    assert.match(doneEvent.data.answer, /\[1\]/);
    assert.equal(doneEvent.data.sources.length, 1);
    assert.equal(doneEvent.data.sources[0].id, SAMPLE_ROW.id);
  } finally {
    restore();
    restoreProvider();
  }
}));

test('POST / (streaming): a provider failure sends an error event instead of crashing the stream', () => withServer(async (base) => {
  const { restore } = mockPool([['FROM items i', () => ({ rows: [SAMPLE_ROW] })]]);
  const restoreProvider = mockStreamingProvider(async () => {
    const err = new Error('AI provider unavailable (first_token_timeout)');
    err.failureType = 'first_token_timeout';
    throw err;
  });
  try {
    const res = await postStreaming(base, { question: '팜유 가격이 왜 올랐어?' });
    const events = parseSse(await res.text());
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'error');
    assert.ok(events[0].data.message);
  } finally {
    restore();
    restoreProvider();
  }
}));

test('POST / (streaming): insufficient evidence never opens a stream — plain JSON, same as the non-streaming path', () => withServer(async (base) => {
  const { restore } = mockPool([['FROM items i', () => ({ rows: [] })]]);
  try {
    const res = await postStreaming(base, { question: '전혀 무관한 질문입니다' });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.equal(body.insufficient, true);
  } finally {
    restore();
  }
}));

test('POST / (streaming): citation verification still runs before the done event (finalizeAnswer applied to the raw streamed text)', () => withServer(async (base) => {
  const ROW_A = { ...SAMPLE_ROW, id: 7 };
  const ROW_B = { ...SAMPLE_ROW, id: 8, title: '다른 자료' };
  const { restore } = mockPool([['FROM items i', () => ({ rows: [ROW_A, ROW_B] })]]);
  const restoreProvider = mockStreamingProvider(async ({ system, user }, onToken) => {
    const text = 'B에 근거한 문장입니다. [2]';
    onToken(text);
    return { text, ttftMs: 10, model: 'auto' };
  });
  try {
    const res = await postStreaming(base, { question: '질문' });
    const events = parseSse(await res.text());
    const doneEvent = events.find((e) => e.event === 'done');
    assert.equal(doneEvent.data.sources.length, 1);
    assert.equal(doneEvent.data.sources[0].id, ROW_B.id);
  } finally {
    restore();
    restoreProvider();
  }
}));

test('POST / (streaming): records ttft_ms and streamed=true in telemetry', () => withServer(async (base) => {
  let insertedParams = null;
  const { restore } = mockPool([
    ['FROM items i', () => ({ rows: [SAMPLE_ROW] })],
    ['INSERT INTO ai_search_logs', (text, params) => { insertedParams = params; return { rows: [] }; }],
  ]);
  const restoreProvider = mockStreamingProvider(async ({ system, user }, onToken) => {
    onToken('답변');
    return { text: '답변', ttftMs: 123, model: 'auto' };
  });
  try {
    await postStreaming(base, { question: '질문' });
    assert.ok(insertedParams, 'expected a telemetry row to be inserted');
    // [requestId, operation, outcome, http_status, latency_ms, candidate_count,
    //  source_count, provider, failure_type, is_followup, question_fingerprint,
    //  ttft_ms, streamed, model_used]
    assert.equal(insertedParams[2], 'success');
    assert.equal(insertedParams[11], 123);
    assert.equal(insertedParams[12], true);
  } finally {
    restore();
    restoreProvider();
  }
}));
