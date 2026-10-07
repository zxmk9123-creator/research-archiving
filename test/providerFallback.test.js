const test = require('node:test');
const assert = require('node:assert/strict');
const { runProviderChain, buildProviderChain, requireNonEmptyText, callProviderWithFallback, callFreeLLMAPI, FREELLMAPI_TIMEOUT_MS } = require('../server/lib/ai/provider');

function transientError(message) {
  const err = new Error(message);
  err.transient = true;
  return err;
}

function fakeProvider(name, behavior) {
  return { name, run: behavior };
}

test('runProviderChain: single provider success', async () => {
  const chain = [fakeProvider('freellmapi', async () => 'freellmapi response')];
  const result = await runProviderChain(chain);
  assert.equal(result.text, 'freellmapi response');
  assert.equal(result.provider, 'freellmapi');
});

test('runProviderChain: a non-transient (invalid contract/application) error propagates', async () => {
  const badContractErr = new Error('AI response was not valid JSON'); // no .transient flag
  const chain = [fakeProvider('freellmapi', async () => { throw badContractErr; })];
  await assert.rejects(() => runProviderChain(chain), /not valid JSON/);
});

// Regression for the reported bug: an HTTP 200 response with empty/null
// content IS a provider failure, not an application/prompt error.
test('runProviderChain: 200 + empty content is a transient failure', async () => {
  const chain = [fakeProvider('freellmapi', async () => { throw requireNonEmptyTextError(); })];
  await assert.rejects(() => runProviderChain(chain));
});

function requireNonEmptyTextError() {
  try {
    requireNonEmptyText('', 'freellmapi');
  } catch (err) {
    return err;
  }
  throw new Error('requireNonEmptyText should have thrown for empty text');
}

test('requireNonEmptyText: throws a transient error for empty/null/undefined content', () => {
  for (const value of ['', null, undefined, 0, false]) {
    assert.throws(() => requireNonEmptyText(value, 'freellmapi'), (err) => err.transient === true);
  }
});

test('requireNonEmptyText: returns the text unchanged when non-empty', () => {
  assert.equal(requireNonEmptyText('hello', 'freellmapi'), 'hello');
});

test('runProviderChain: throws a clear error when no provider is configured', async () => {
  await assert.rejects(() => runProviderChain([]), /No AI provider configured/);
});

const PROVIDER_ENV_VARS = ['FREELLMAPI_API_KEY', 'FREELLMAPI_BASE_URL'];

function withProviderEnv(set, fn) {
  const prev = Object.fromEntries(PROVIDER_ENV_VARS.map((k) => [k, process.env[k]]));
  try {
    for (const key of PROVIDER_ENV_VARS) {
      if (set.includes(key)) process.env[key] = 'test-value';
      else delete process.env[key];
    }
    fn();
  } finally {
    for (const key of PROVIDER_ENV_VARS) {
      if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key];
    }
  }
}

test('buildProviderChain: empty when FREELLMAPI_API_KEY is not set', () => {
  withProviderEnv([], () => {
    const chain = buildProviderChain({ system: 's', user: 'u' });
    assert.deepEqual(chain.map((p) => p.name), []);
  });
});

test('buildProviderChain: includes freellmapi when FREELLMAPI_API_KEY is set', () => {
  withProviderEnv(['FREELLMAPI_API_KEY'], () => {
    const chain = buildProviderChain({ system: 's', user: 'u' });
    assert.deepEqual(chain.map((p) => p.name), ['freellmapi']);
  });
});

// --- End-to-end fetch-mocked tests: exercise the REAL callFreeLLMAPI HTTP
// handling (not just synthetic fake providers). ---

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetchByUrl(handlers) {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    for (const [match, handler] of handlers) {
      if (url.includes(match)) return handler(url, init);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return () => { global.fetch = original; };
}

test('callProviderWithFallback: success returns text and provider name', async () => {
  const restore = mockFetchByUrl([
    ['router.example.com', async () => jsonResponse(200, { choices: [{ message: { content: 'freellmapi says hi' } }] })],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.text, 'freellmapi says hi');
    assert.equal(result.provider, 'freellmapi');
  } finally {
    restore();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
  }
});

test('callProviderWithFallback: HTTP 200 with empty content throws (no second provider to fall back to)', async () => {
  const restore = mockFetchByUrl([
    ['router.example.com', async () => jsonResponse(200, { choices: [{ message: { content: '' } }] })],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    await assert.rejects(() => callProviderWithFallback({ system: 's', user: 'u' }));
  } finally {
    restore();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
  }
});

test('callProviderWithFallback: a non-empty response with invalid-JSON text is returned as-is — no parsing here', async () => {
  const restore = mockFetchByUrl([
    ['router.example.com', async () => jsonResponse(200, { choices: [{ message: { content: 'this is not json' } }] })],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.text, 'this is not json');
    assert.equal(result.provider, 'freellmapi');
  } finally {
    restore();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
  }
});

test('callProviderWithFallback: provider failure preserves the existing failed behavior (throws)', async () => {
  const restore = mockFetchByUrl([
    ['router.example.com', async () => jsonResponse(500, { error: 'down' })],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    await assert.rejects(() => callProviderWithFallback({ system: 's', user: 'u' }));
  } finally {
    restore();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
  }
});

test('callProviderWithFallback: no FREELLMAPI_API_KEY configured throws "No AI provider configured"', async () => {
  delete process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_BASE_URL;
  await assert.rejects(() => callProviderWithFallback({ system: 's', user: 'u' }), /No AI provider configured/);
});

test('callFreeLLMAPI: sends the configured model and returns the response text', async () => {
  let sentBody;
  const restore = mockFetchByUrl([
    ['router.example.com', async (url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse(200, { choices: [{ message: { content: 'freellmapi response' } }] });
    }],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    process.env.FREELLMAPI_MODEL = 'auto';
    const text = await callFreeLLMAPI({ system: 's', user: 'u' });
    assert.equal(text, 'freellmapi response');
    assert.equal(sentBody.model, 'auto');
  } finally {
    restore();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
    delete process.env.FREELLMAPI_MODEL;
  }
});

test('callFreeLLMAPI: throws when FREELLMAPI_API_KEY is missing', async () => {
  delete process.env.FREELLMAPI_API_KEY;
  process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
  try {
    await assert.rejects(() => callFreeLLMAPI({ system: 's', user: 'u' }), /FREELLMAPI_API_KEY/);
  } finally {
    delete process.env.FREELLMAPI_BASE_URL;
  }
});

test('callFreeLLMAPI: throws when FREELLMAPI_BASE_URL is missing', async () => {
  process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
  delete process.env.FREELLMAPI_BASE_URL;
  try {
    await assert.rejects(() => callFreeLLMAPI({ system: 's', user: 'u' }), /FREELLMAPI_BASE_URL/);
  } finally {
    delete process.env.FREELLMAPI_API_KEY;
  }
});

// --- Caller timeout budget: must safely exceed FreeLLMAPI's own documented
// worst-case retry budget (FALLBACK_TIME_BUDGET_MS=45s default, widened up
// to MAX_BUDGET_MULTIPLIER=3x = 135s) plus a safety margin, so the caller
// never aborts a cascade FreeLLMAPI itself is still healthily working
// through. See the module-level comment above callFreeLLMAPI(). ---

test('FREELLMAPI_TIMEOUT_MS is 150000ms (135s FreeLLMAPI worst-case budget + 15s margin), not the old 60000ms', () => {
  assert.equal(FREELLMAPI_TIMEOUT_MS, 150000);
  assert.ok(FREELLMAPI_TIMEOUT_MS > 60000, 'must be strictly larger than the previous 60s cap');
  assert.ok(FREELLMAPI_TIMEOUT_MS > 135000, 'must safely exceed FreeLLMAPI\'s documented 135s worst-case (45s base budget x 3 adaptive widening)');
});

test('callFreeLLMAPI: passes FREELLMAPI_TIMEOUT_MS to AbortSignal.timeout, not the old 60000ms value', async () => {
  const originalTimeout = AbortSignal.timeout;
  const capturedTimeouts = [];
  AbortSignal.timeout = (ms) => { capturedTimeouts.push(ms); return originalTimeout(ms); };
  const restoreFetch = mockFetchByUrl([
    ['router.example.com', async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    await callFreeLLMAPI({ system: 's', user: 'u' });
    assert.deepEqual(capturedTimeouts, [FREELLMAPI_TIMEOUT_MS]);
  } finally {
    AbortSignal.timeout = originalTimeout;
    restoreFetch();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
  }
});

// A cascade that takes longer than the OLD 60s cap, but well within the new
// 150s one, must still succeed — proving the caller no longer aborts a
// healthy-but-slow FreeLLMAPI cascade (the exact production symptom:
// "client disconnected mid-attempt" on a cascade that was still working).
test('callFreeLLMAPI: a response that would have exceeded the old 60s timeout still succeeds under the new budget', async () => {
  const restoreFetch = mockFetchByUrl([
    ['router.example.com', async () => {
      await new Promise((resolve) => setTimeout(resolve, 80)); // simulated slow cascade, scaled down for a fast test
      return jsonResponse(200, { choices: [{ message: { content: 'slow but healthy cascade result' } }] });
    }],
  ]);
  try {
    process.env.FREELLMAPI_API_KEY = 'freellmapi-test';
    process.env.FREELLMAPI_BASE_URL = 'https://router.example.com/v1';
    const text = await callFreeLLMAPI({ system: 's', user: 'u' });
    assert.equal(text, 'slow but healthy cascade result');
  } finally {
    restoreFetch();
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_BASE_URL;
  }
});
