const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../server/lib/ai/provider');

function withFetch(reply, fn) {
  const env = { ...process.env }; const orig = global.fetch; const seen = [];
  process.env.FREELLMAPI_BASE_URL = 'https://router.test/v1'; process.env.FREELLMAPI_API_KEY = 'k';
  global.fetch = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }), headers: { get: () => null } }; };
  return fn(seen).finally(() => { global.fetch = orig; process.env = env; });
}

test('callProvider forwards a larger token budget and a pinned model, and drops inlined <think> blocks', async () => {
  await withFetch('<think>step 1... step 2...</think>{"lead":"x"}', async (seen) => {
    const out = await provider.callProvider({ system: 's', user: 'u' }, { maxTokens: 12000, model: 'plain-model' });
    assert.equal(out, '{"lead":"x"}');
    assert.equal(seen[0].max_tokens, 12000); assert.equal(seen[0].model, 'plain-model');
  });
});

test('callProvider keeps its defaults when no override is given', async () => {
  await withFetch('ok', async (seen) => {
    await provider.callProvider({ system: 's', user: 'u' });
    assert.equal(seen[0].max_tokens, 6000);
  });
});
