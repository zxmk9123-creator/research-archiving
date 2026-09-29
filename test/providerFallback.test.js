const test = require('node:test');
const assert = require('node:assert/strict');
const { runProviderChain, buildProviderChain } = require('../server/lib/ai/provider');

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

test('runProviderChain: an empty-response error (application-level) does NOT trigger fallback', async () => {
  let secondCalled = false;
  const emptyErr = new Error('AI provider returned an empty response'); // no .transient flag
  const chain = [
    fakeProvider('groq', async () => { throw emptyErr; }),
    fakeProvider('gemini', async () => { secondCalled = true; return 'gemini response'; }),
  ];
  await assert.rejects(() => runProviderChain(chain), /empty response/);
  assert.equal(secondCalled, false);
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
