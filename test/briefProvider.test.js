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

test('certainty guard: a claim phrase inside a doubtful clause is not an unsupported assertion, a plain one still is, and the failing text is kept', () => {
  const { assertSupportedCertainty } = require('../server/lib/dailyBrief');
  assert.doesNotThrow(() => assertSupportedCertainty('공장 가동 중단으로 식용유 공급 확보에 차질이 예상된다', '공장이 가동을 멈췄다', 4557));
  assert.doesNotThrow(() => assertSupportedCertainty('장기 공급 확보가 불확실해졌다', '기사 본문', 1));
  assert.throws(() => assertSupportedCertainty('A사는 장기 공급을 확보했다', '기사 본문', 7), (e) => /unsupported_certainty_supply_commitment_item_7/.test(e.message) && /공급을 확보/.test(e.snippet));
  assert.doesNotThrow(() => assertSupportedCertainty('A사는 장기 공급을 확보했다', 'A사가 공급 계약을 체결했다', 7));
});
