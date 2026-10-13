const test = require('node:test');
const assert = require('node:assert/strict');
const {
  callProviderWithFallbackStreaming, buildStreamingAttempts, extractSseDeltas,
} = require('../server/lib/ai/provider');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

// Builds a Response-like object whose .body is a real ReadableStream of
// SSE "data: ..." lines, each enqueued after an optional delay — lets
// tests control exactly when a chunk "arrives" without faking timers.
// Honors `signal` the same way a real fetch()'s body stream would: once
// aborted, pending reads never resolve with further data (the delay
// below just rejects instead), matching production where
// controller.abort() actually cuts off the in-flight request.
function sseResponse(events, { status = 200, signal } = {}) {
  const body = new ReadableStream({
    async start(controller) {
      for (const ev of events) {
        if (ev.delayMs) {
          await new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
            const t = setTimeout(resolve, ev.delayMs);
            if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
          });
        }
        if (signal && signal.aborted) return;
        controller.enqueue(new TextEncoder().encode(ev.chunk));
      }
      controller.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, body, text: async () => '' };
}

function deltaChunk(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}
// The chunk that carries finish_reason (e.g. 'length' when max_tokens cuts
// the answer off mid-sentence) — no delta.content of its own, same shape
// FreeLLMAPI's real OpenAI-compatible stream sends on its last event.
function finishReasonChunk(reason) {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
}
const DONE_CHUNK = 'data: [DONE]\n\n';

// --- extractSseDeltas ---

test('extractSseDeltas: parses one complete SSE line into its delta', () => {
  const { deltas, remainder, done } = extractSseDeltas(deltaChunk('안녕'));
  assert.deepEqual(deltas, ['안녕']);
  assert.equal(remainder, '');
  assert.equal(done, false);
});

test('extractSseDeltas: recognizes [DONE] and sets done=true', () => {
  const { deltas, done } = extractSseDeltas(DONE_CHUNK);
  assert.deepEqual(deltas, []);
  assert.equal(done, true);
});

test('extractSseDeltas: keeps an incomplete trailing line as remainder, not a parsed delta', () => {
  const full = deltaChunk('완전');
  const incompleteTail = 'data: {"choices":[{"delta":{"con';
  const { deltas, remainder } = extractSseDeltas(full + incompleteTail);
  assert.deepEqual(deltas, ['완전']);
  assert.equal(remainder, incompleteTail);
});

test('extractSseDeltas: a malformed line is skipped, not thrown', () => {
  const { deltas } = extractSseDeltas('data: not json at all\n\n' + deltaChunk('ok'));
  assert.deepEqual(deltas, ['ok']);
});

// --- callProviderWithFallbackStreaming ---

const BASE_ENV = { FREELLMAPI_API_KEY: 'test-key', FREELLMAPI_BASE_URL: 'https://freellmapi.example.com/v1', FREELLMAPI_FAST_MODEL: undefined, FREELLMAPI_MODEL: undefined };

test('callProviderWithFallbackStreaming: streams every delta via onToken and resolves with the full text + ttftMs', () => withEnv(BASE_ENV, async () => {
  const restore = mockFetch(async () => sseResponse([
    { chunk: deltaChunk('안녕'), delayMs: 5 },
    { chunk: deltaChunk('하세요') },
    { chunk: DONE_CHUNK },
  ]));
  const tokens = [];
  try {
    const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, (t) => tokens.push(t));
    assert.deepEqual(tokens, ['안녕', '하세요']);
    assert.equal(result.text, '안녕하세요');
    assert.ok(result.ttftMs >= 0);
    assert.equal(result.model, 'auto');
  } finally {
    restore();
  }
}));

// Production incident: a streamed answer cut off mid-sentence by
// max_tokens looked identical to a clean finish — nothing read
// finish_reason:'length' on the stream's final chunk, so the truncated
// text was finalized and shown to the user as if it were complete.
test('callProviderWithFallbackStreaming: finish_reason="length" mid-stream appends a visible Korean notice to the resolved text', () => withEnv(BASE_ENV, async () => {
  const restore = mockFetch(async () => sseResponse([
    { chunk: deltaChunk('...기존 주요 원료인 폐식용유는') },
    { chunk: finishReasonChunk('length') },
    { chunk: DONE_CHUNK },
  ]));
  const tokens = [];
  try {
    const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, (t) => tokens.push(t));
    // onToken only ever streamed the raw (unmodified) deltas as they
    // arrived — the notice is appended once, to the final resolved text.
    assert.deepEqual(tokens, ['...기존 주요 원료인 폐식용유는']);
    assert.match(result.text, /폐식용유는/);
    assert.match(result.text, /길이 제한으로 인해 중간에 잘렸습니다/);
  } finally {
    restore();
  }
}));

test('callProviderWithFallbackStreaming: finish_reason="stop" (a clean completion) never appends the truncation notice', () => withEnv(BASE_ENV, async () => {
  const restore = mockFetch(async () => sseResponse([
    { chunk: deltaChunk('완결된 답변입니다.') },
    { chunk: finishReasonChunk('stop') },
    { chunk: DONE_CHUNK },
  ]));
  try {
    const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, () => {});
    assert.equal(result.text, '완결된 답변입니다.');
  } finally {
    restore();
  }
}));

test('callProviderWithFallbackStreaming: no FREELLMAPI_FAST_MODEL configured means only the default model is tried (today\'s behavior, unchanged)', () => withEnv(BASE_ENV, async () => {
  let callCount = 0;
  const restore = mockFetch(async () => {
    callCount++;
    return sseResponse([{ chunk: deltaChunk('answer') }, { chunk: DONE_CHUNK }]);
  });
  try {
    const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, () => {});
    assert.equal(callCount, 1);
    assert.equal(result.model, 'auto');
  } finally {
    restore();
  }
}));

test('callProviderWithFallbackStreaming: a stalled fast-model attempt falls back to the default model', () => withEnv(
  { ...BASE_ENV, FREELLMAPI_FAST_MODEL: 'fast-model', FREELLMAPI_FAST_MODEL_TIMEOUT_MS: '30' },
  async () => {
    let call = 0;
    const restore = mockFetch(async (url, init) => {
      call++;
      const body = JSON.parse(init.body);
      if (body.model === 'fast-model') {
        // Never emits a first token within the 30ms budget.
        return sseResponse([{ chunk: deltaChunk('too late'), delayMs: 200 }, { chunk: DONE_CHUNK }], { signal: init.signal });
      }
      return sseResponse([{ chunk: deltaChunk('fallback answer') }, { chunk: DONE_CHUNK }]);
    });
    const tokens = [];
    try {
      const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, (t) => tokens.push(t));
      assert.equal(call, 2);
      assert.equal(result.model, 'auto');
      assert.deepEqual(tokens, ['fallback answer'], 'the stalled fast-model attempt must never leak a late/partial token to the caller');
    } finally {
      restore();
    }
  }
));

test('callProviderWithFallbackStreaming: a fast model that answers in time is used as-is, no fallback call', () => withEnv(
  { ...BASE_ENV, FREELLMAPI_FAST_MODEL: 'fast-model', FREELLMAPI_FAST_MODEL_TIMEOUT_MS: '5000' },
  async () => {
    let call = 0;
    const restore = mockFetch(async (url, init) => {
      call++;
      return sseResponse([{ chunk: deltaChunk('quick answer') }, { chunk: DONE_CHUNK }]);
    });
    try {
      const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, () => {});
      assert.equal(call, 1);
      assert.equal(result.model, 'fast-model');
      assert.equal(result.text, 'quick answer');
    } finally {
      restore();
    }
  }
));

test('callProviderWithFallbackStreaming: a non-ok HTTP status is treated as transient and falls back', () => withEnv(
  { ...BASE_ENV, FREELLMAPI_FAST_MODEL: 'fast-model', FREELLMAPI_FAST_MODEL_TIMEOUT_MS: '5000' },
  async () => {
    const restore = mockFetch(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'fast-model') return { ok: false, status: 503, text: async () => 'down' };
      return sseResponse([{ chunk: deltaChunk('ok') }, { chunk: DONE_CHUNK }]);
    });
    try {
      const result = await callProviderWithFallbackStreaming({ system: 's', user: 'u' }, () => {});
      assert.equal(result.text, 'ok');
    } finally {
      restore();
    }
  }
));

test('callProviderWithFallbackStreaming: an empty accumulated response is rejected, same as the non-streaming path', () => withEnv(BASE_ENV, async () => {
  const restore = mockFetch(async () => sseResponse([{ chunk: DONE_CHUNK }]));
  try {
    await assert.rejects(() => callProviderWithFallbackStreaming({ system: 's', user: 'u' }, () => {}), /empty response/);
  } finally {
    restore();
  }
}));

test('buildStreamingAttempts: only the default model attempt exists when FREELLMAPI_FAST_MODEL is unset', () => withEnv(BASE_ENV, () => {
  const attempts = buildStreamingAttempts();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].model, 'auto');
  assert.equal(attempts[0].firstTokenTimeoutMs, null);
}));

test('buildStreamingAttempts: the fast-model attempt comes first and carries a first-token timeout; the default attempt has none', () => withEnv(
  { ...BASE_ENV, FREELLMAPI_FAST_MODEL: 'fast-model', FREELLMAPI_FAST_MODEL_TIMEOUT_MS: '3000' },
  () => {
    const attempts = buildStreamingAttempts();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], { model: 'fast-model', firstTokenTimeoutMs: 3000 });
    assert.equal(attempts[1].firstTokenTimeoutMs, null);
  }
));
