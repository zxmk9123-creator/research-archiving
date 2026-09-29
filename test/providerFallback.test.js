const test = require('node:test');
const assert = require('node:assert/strict');
const { runProviderChain, buildProviderChain, requireNonEmptyText, callProviderWithFallback, callNvidia } = require('../server/lib/ai/provider');

function transientError(message) {
  const err = new Error(message);
  err.transient = true;
  return err;
}

function fakeProvider(name, behavior) {
  return { name, run: behavior };
}

test('runProviderChain: first provider success — no fallback needed', async () => {
  let secondCalled = false;
  const chain = [
    fakeProvider('groq', async () => 'groq response'),
    fakeProvider('gemini', async () => { secondCalled = true; return 'gemini response'; }),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.text, 'groq response');
  assert.equal(result.provider, 'groq');
  assert.equal(secondCalled, false);
});

test('runProviderChain: Groq 429 falls back to Gemini', async () => {
  const err429 = transientError('rate limited');
  err429.status = 429;
  const chain = [
    fakeProvider('groq', async () => { throw err429; }),
    fakeProvider('gemini', async () => 'gemini response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.text, 'gemini response');
  assert.equal(result.provider, 'gemini');
});

test('runProviderChain: Groq 503 falls back to Gemini', async () => {
  const err503 = transientError('server overloaded');
  err503.status = 503;
  const chain = [
    fakeProvider('groq', async () => { throw err503; }),
    fakeProvider('gemini', async () => 'gemini response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'gemini');
});

test('runProviderChain: Groq timeout falls back to Gemini', async () => {
  const timeoutErr = transientError('AI provider unavailable (timeout)');
  const chain = [
    fakeProvider('groq', async () => { throw timeoutErr; }),
    fakeProvider('gemini', async () => 'gemini response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'gemini');
});

test('runProviderChain: falls through Groq and Gemini to OpenRouter', async () => {
  const chain = [
    fakeProvider('groq', async () => { throw transientError('groq down'); }),
    fakeProvider('gemini', async () => { throw transientError('gemini down'); }),
    fakeProvider('openrouter', async () => 'openrouter response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'openrouter');
});

test('runProviderChain: all providers failing transiently preserves the existing failed behavior (throws)', async () => {
  const chain = [
    fakeProvider('groq', async () => { throw transientError('groq down'); }),
    fakeProvider('gemini', async () => { throw transientError('gemini down'); }),
    fakeProvider('openrouter', async () => { throw transientError('openrouter down'); }),
  ];
  await assert.rejects(() => runProviderChain(chain), /openrouter down/);
});

test('runProviderChain: a non-transient (invalid contract/application) error does NOT trigger fallback', async () => {
  let secondCalled = false;
  const badContractErr = new Error('AI response was not valid JSON'); // no .transient flag
  const chain = [
    fakeProvider('groq', async () => { throw badContractErr; }),
    fakeProvider('gemini', async () => { secondCalled = true; return 'gemini response'; }),
  ];
  await assert.rejects(() => runProviderChain(chain), /not valid JSON/);
  assert.equal(secondCalled, false);
});

// Regression for the reported bug: an HTTP 200 response with empty/null
// content IS a provider failure and MUST trigger fallback — it must never
// terminate the chain as if it were an application/prompt error.
test('runProviderChain: Groq 200 + empty content falls back to Gemini', async () => {
  const chain = [
    fakeProvider('groq', async () => { throw requireNonEmptyTextError(); }),
    fakeProvider('gemini', async () => 'gemini response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'gemini');
});

function requireNonEmptyTextError() {
  try {
    requireNonEmptyText('', 'groq');
  } catch (err) {
    return err;
  }
  throw new Error('requireNonEmptyText should have thrown for empty text');
}

test('requireNonEmptyText: throws a transient error for empty/null/undefined content', () => {
  for (const value of ['', null, undefined, 0, false]) {
    assert.throws(() => requireNonEmptyText(value, 'groq'), (err) => err.transient === true);
  }
});

test('requireNonEmptyText: returns the text unchanged when non-empty', () => {
  assert.equal(requireNonEmptyText('hello', 'groq'), 'hello');
});

test('runProviderChain: throws a clear error when no provider is configured', async () => {
  await assert.rejects(() => runProviderChain([]), /No AI provider configured/);
});

const PROVIDER_ENV_VARS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'LLAMA_API_KEY', 'NVIDIA_API_KEY'];

function withProviderEnv(set, fn) {
  const prev = Object.fromEntries(PROVIDER_ENV_VARS.map((k) => [k, process.env[k]]));
  try {
    for (const key of PROVIDER_ENV_VARS) {
      if (set.includes(key)) process.env[key] = 'test-key';
      else delete process.env[key];
    }
    fn();
  } finally {
    for (const key of PROVIDER_ENV_VARS) {
      if (prev[key] === undefined) delete process.env[key]; else process.env[key] = prev[key];
    }
  }
}

test('buildProviderChain: only includes providers whose API key env var is set', () => {
  withProviderEnv(['GROQ_API_KEY'], () => {
    const chain = buildProviderChain({ system: 's', user: 'u' });
    assert.deepEqual(chain.map((p) => p.name), ['groq']);
  });
});

test('buildProviderChain: builds the full Groq -> Gemini -> Llama -> NVIDIA -> OpenRouter order when all keys are set', () => {
  withProviderEnv(PROVIDER_ENV_VARS, () => {
    const chain = buildProviderChain({ system: 's', user: 'u' });
    assert.deepEqual(chain.map((p) => p.name), ['groq', 'gemini', 'llama', 'nvidia', 'openrouter']);
  });
});

test('buildProviderChain: falls through to Llama/NVIDIA when only those keys are set', () => {
  withProviderEnv(['LLAMA_API_KEY', 'NVIDIA_API_KEY'], () => {
    const chain = buildProviderChain({ system: 's', user: 'u' });
    assert.deepEqual(chain.map((p) => p.name), ['llama', 'nvidia']);
  });
});

// --- End-to-end fetch-mocked tests: exercise the REAL callGroq/callGemini
// HTTP handling (not just synthetic fake providers), the same code path
// that had the empty-response bug. ---

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

test('callProviderWithFallback: Groq success — Gemini is NOT called', async () => {
  let geminiCalled = false;
  const restore = mockFetchByUrl([
    ['api.groq.com', async () => jsonResponse(200, { choices: [{ message: { content: 'groq says hi' } }] })],
    ['generativelanguage.googleapis.com', async () => { geminiCalled = true; return jsonResponse(200, {}); }],
  ]);
  try {
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.text, 'groq says hi');
    assert.equal(result.provider, 'groq');
    assert.equal(geminiCalled, false);
  } finally {
    restore();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
});

test('callProviderWithFallback: Groq HTTP 200 with empty content falls back to Gemini (the reported bug, fixed)', async () => {
  const restore = mockFetchByUrl([
    ['api.groq.com', async () => jsonResponse(200, { choices: [{ message: { content: '' } }] })],
    ['generativelanguage.googleapis.com', async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'gemini filled in' }] } }] })],
  ]);
  try {
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.text, 'gemini filled in');
    assert.equal(result.provider, 'gemini');
  } finally {
    restore();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
});

test('callProviderWithFallback: Groq 429 falls back to Gemini (real HTTP path)', async () => {
  const restore = mockFetchByUrl([
    ['api.groq.com', async () => jsonResponse(429, { error: { message: 'rate limited' } })],
    ['generativelanguage.googleapis.com', async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'gemini response' }] } }] })],
  ]);
  try {
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.provider, 'gemini');
  } finally {
    restore();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
});

test('callProviderWithFallback: a non-empty Groq response with invalid-JSON text is returned as-is — no fallback, no parsing here', async () => {
  // runProviderChain's job stops at "got non-empty text"; JSON validity is
  // parseDraftResponse's concern later in aiDraft.js, entirely outside this
  // module. This proves a successful-but-unparseable response never causes
  // a second provider to be called.
  let geminiCalled = false;
  const restore = mockFetchByUrl([
    ['api.groq.com', async () => jsonResponse(200, { choices: [{ message: { content: 'this is not json' } }] })],
    ['generativelanguage.googleapis.com', async () => { geminiCalled = true; return jsonResponse(200, {}); }],
  ]);
  try {
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.text, 'this is not json');
    assert.equal(result.provider, 'groq');
    assert.equal(geminiCalled, false);
  } finally {
    restore();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
});

test('callProviderWithFallback: all configured providers failing preserves the existing failed behavior (throws)', async () => {
  const restore = mockFetchByUrl([
    ['api.groq.com', async () => jsonResponse(500, { error: 'down' })],
    ['generativelanguage.googleapis.com', async () => jsonResponse(503, { error: { message: 'overloaded' } })],
  ]);
  try {
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    await assert.rejects(() => callProviderWithFallback({ system: 's', user: 'u' }));
  } finally {
    restore();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
});

// --- Auth/config failures (401/403): a misconfigured provider must be
// skipped, never retried, and must not take the whole chain down. ---

function authError(status) {
  const err = new Error(`AI provider request failed (${status})`);
  err.status = status;
  err.transient = true;
  err.failureType = 'auth';
  return err;
}

test('runProviderChain: Gemini 429 falls back to Llama', async () => {
  const err429 = transientError('rate limited');
  err429.status = 429;
  err429.failureType = 'rate_limit';
  const chain = [
    fakeProvider('gemini', async () => { throw err429; }),
    fakeProvider('llama', async () => 'llama response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'llama');
});

test('runProviderChain: Llama 401 (auth failure) is skipped, falls back to NVIDIA — does not terminate the chain', async () => {
  const chain = [
    fakeProvider('llama', async () => { throw authError(401); }),
    fakeProvider('nvidia', async () => 'nvidia response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'nvidia');
});

test('runProviderChain: Llama 403 (auth failure) is skipped, falls back to NVIDIA', async () => {
  const chain = [
    fakeProvider('llama', async () => { throw authError(403); }),
    fakeProvider('nvidia', async () => 'nvidia response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'nvidia');
});

test('runProviderChain: an auth failure is never retried on the same provider — the failing provider is called exactly once', async () => {
  let llamaCallCount = 0;
  const chain = [
    fakeProvider('llama', async () => { llamaCallCount++; throw authError(401); }),
    fakeProvider('nvidia', async () => 'nvidia response'),
  ];
  await runProviderChain(chain);
  assert.equal(llamaCallCount, 1);
});

test('runProviderChain: a provider 5xx falls back to the next provider', async () => {
  const err500 = transientError('internal error');
  err500.status = 500;
  err500.failureType = 'server_error';
  const chain = [
    fakeProvider('nvidia', async () => { throw err500; }),
    fakeProvider('openrouter', async () => 'openrouter response'),
  ];
  const result = await runProviderChain(chain);
  assert.equal(result.provider, 'openrouter');
});

test('runProviderChain: all providers unavailable (mix of transient/auth) ends in the final failed state', async () => {
  const chain = [
    fakeProvider('groq', async () => { throw transientError('groq rate limited'); }),
    fakeProvider('gemini', async () => { throw transientError('gemini overloaded'); }),
    fakeProvider('llama', async () => { throw authError(401); }),
    fakeProvider('nvidia', async () => { throw authError(403); }),
    fakeProvider('openrouter', async () => { throw transientError('openrouter down'); }),
  ];
  await assert.rejects(() => runProviderChain(chain), /openrouter down/);
});

test('runProviderChain: an application/JSON/Zod-style error (no .transient flag) stops the chain immediately, even mid-way through', async () => {
  let nvidiaCalled = false;
  const appErr = new Error('AI response was not valid JSON'); // no .transient — application/contract error
  const chain = [
    fakeProvider('groq', async () => { throw transientError('groq down'); }),
    fakeProvider('gemini', async () => { throw appErr; }),
    fakeProvider('llama', async () => { nvidiaCalled = true; return 'should never be reached'; }),
  ];
  await assert.rejects(() => runProviderChain(chain), /not valid JSON/);
  assert.equal(nvidiaCalled, false);
});

test('callNvidia: sends the currently supported model, not the EOL meta/llama-3.1-70b-instruct', async () => {
  let sentBody;
  const restore = mockFetchByUrl([
    ['integrate.api.nvidia.com', async (url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse(200, { choices: [{ message: { content: 'nvidia response' } }] });
    }],
  ]);
  try {
    process.env.NVIDIA_API_KEY = 'test';
    delete process.env.NVIDIA_MODEL;
    await callNvidia({ system: 's', user: 'u' });
    assert.notEqual(sentBody.model, 'meta/llama-3.1-70b-instruct');
    assert.equal(sentBody.model, 'meta/llama-3.3-70b-instruct');
  } finally {
    restore();
    delete process.env.NVIDIA_API_KEY;
  }
});

// --- The most important regression from this task: the exact reported
// production sequence must now end in success instead of stopping at
// Llama's 401. Uses real HTTP mocking through the actual provider
// functions (callGroq/callGemini/callLlama/callNvidia), not fakes. ---
test('callProviderWithFallback: Groq 429 -> Gemini 503/429 -> Llama 401 -> NVIDIA succeeds (exact production regression)', async () => {
  let geminiCallCount = 0;
  const restore = mockFetchByUrl([
    ['api.groq.com', async () => jsonResponse(429, { error: { message: 'rate limited' } })],
    ['generativelanguage.googleapis.com', async () => {
      geminiCallCount++;
      return geminiCallCount === 1
        ? jsonResponse(503, { error: { code: 503, message: 'overloaded' } })
        : jsonResponse(429, { error: { code: 429, message: 'quota exceeded' } });
    }],
    ['api.llama.com', async () => jsonResponse(401, { title: 'Authentication Error', status: 401 })],
    ['integrate.api.nvidia.com', async () => jsonResponse(200, { choices: [{ message: { content: 'nvidia success' } }] })],
  ]);
  try {
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    process.env.LLAMA_API_KEY = 'test';
    process.env.NVIDIA_API_KEY = 'test';
    delete process.env.OPENROUTER_API_KEY;
    const result = await callProviderWithFallback({ system: 's', user: 'u' });
    assert.equal(result.text, 'nvidia success');
    assert.equal(result.provider, 'nvidia');
  } finally {
    restore();
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.LLAMA_API_KEY;
    delete process.env.NVIDIA_API_KEY;
  }
});
