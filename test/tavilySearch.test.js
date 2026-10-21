const test = require('node:test');
const assert = require('node:assert/strict');
const tavily = require('../server/lib/adapters/tavilySearch');

function withKey(key, fn) {
  const prev = process.env.TAVILY_API_KEY;
  if (key === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = key;
  tavily._resetKeyState();
  return Promise.resolve().then(fn).finally(() => { if (prev === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = prev; tavily._resetKeyState(); });
}
const mock = (h) => { const o = global.fetch; global.fetch = h; return () => { global.fetch = o; }; };

test('tavily: throws when no key is configured', () => withKey(undefined, async () => {
  await assert.rejects(() => tavily.searchWeb('q'), /no TAVILY_API_KEY/);
}));

test('tavily: maps results to {title, link}, sends the week filter for freshness "pw"', () => withKey('tvly-test', async () => {
  let sent;
  const restore = mock(async (url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ title: ' A ', url: 'https://a.example' }, { title: '', url: 'https://b.example' }] }), headers: new Headers() }; });
  try {
    const out = await tavily.searchWeb('palm oil', { freshness: 'pw' });
    assert.deepEqual(out, [{ title: 'A', link: 'https://a.example' }]);
    assert.equal(sent.time_range, 'week');
  } finally { restore(); }
}));

test('tavily: 429 pauses the key briefly, 432 parks it for hours, and a parked key is not called again', () => withKey('tvly-park', async () => {
  let calls = 0;
  let status = 429;
  const restore = mock(async () => { calls++; return { ok: false, status, text: async () => 'limit', headers: new Headers() }; });
  try {
    await assert.rejects(() => tavily.searchWeb('q'), /429/);
    assert.equal(tavily.getKeyStatus().reasons[0].reason, 'rate');
    await assert.rejects(() => tavily.searchWeb('q'), /cooling down/);
    assert.equal(calls, 1);
    assert.equal(tavily.getKeyStatus(Date.now() + 3 * 60 * 1000).parked, 0);
    tavily._resetKeyState(); status = 432;
    await assert.rejects(() => tavily.searchWeb('q'), /432/);
    assert.equal(tavily.getKeyStatus(Date.now() + 2 * 60 * 60 * 1000).parked, 1);
  } finally { restore(); }
}));
