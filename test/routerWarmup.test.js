const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { warmRouter, pingUrl, MIN_GAP_MS, _reset } = require('../server/lib/routerWarmup');

test('pingUrl: the router host plus /api/ping (the /v1 path is dropped); not configured or not http(s) gives null', () => {
  assert.equal(pingUrl('https://freellmapi-router-57z7.onrender.com/v1'), 'https://freellmapi-router-57z7.onrender.com/api/ping');
  assert.equal(pingUrl('http://localhost:3001/v1/'), 'http://localhost:3001/api/ping');
  assert.equal(pingUrl(''), null);
  assert.equal(pingUrl('not a url'), null);
  assert.equal(pingUrl('ftp://x.example/v1'), null);
});

test('warmRouter: pings once, then not again within the gap; a failed ping can be retried by the next visitor; it never throws', async () => {
  _reset();
  const calls = [];
  const ok = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const base = 'https://r.example.com/v1';
  const t0 = 1_000_000;
  const first = warmRouter({ now: t0, fetchImpl: ok, baseUrl: base });
  assert.equal(first.started, true);
  assert.deepEqual(await first.done, { ok: true });
  assert.equal(calls[0].url, 'https://r.example.com/api/ping');
  assert.ok(calls[0].opts.signal, 'bounded by a timeout');
  const second = warmRouter({ now: t0 + 1000, fetchImpl: ok, baseUrl: base });
  assert.deepEqual([second.started, second.reason], [false, 'recent']);
  assert.equal(calls.length, 1);
  assert.equal(warmRouter({ now: t0 + MIN_GAP_MS + 1, fetchImpl: ok, baseUrl: base }).started, true);

  _reset();
  const boom = async () => { throw new Error('connection reset'); };
  const failed = warmRouter({ now: t0, fetchImpl: boom, baseUrl: base });
  assert.equal((await failed.done).ok, false);
  assert.equal(warmRouter({ now: t0 + 1000, fetchImpl: ok, baseUrl: base }).started, true, 'retry allowed after a failure');
  assert.deepEqual([warmRouter({ now: t0, fetchImpl: ok, baseUrl: '' }).started, warmRouter({ now: t0, fetchImpl: ok, baseUrl: '' }).reason], [false, 'not_configured']);
});

function serve() {
  const searchRouter = require('../server/routes/search');
  const app = express();
  app.use('/api/search', searchRouter);
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ base: `http://127.0.0.1:${s.address().port}/api/search`, close: () => s.close() })); });
}

test('GET /api/search/warm answers 202 at once, reports whether a wake-up started, never exposes the router address, and is rate-limited per address', async () => {
  _reset();
  const prev = process.env.FREELLMAPI_BASE_URL;
  process.env.FREELLMAPI_BASE_URL = 'https://secret-router.example.invalid/v1';
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => { if (String(url).includes('secret-router')) { seen.push(String(url)); return { ok: true }; } return originalFetch(url, opts); };
  const s = await serve();
  try {
    const ip = { 'x-forwarded-for': '5.5.5.5' };
    const first = await fetch(`${s.base}/warm`, { headers: ip });
    assert.equal(first.status, 202);
    const body = await first.json();
    assert.deepEqual(body, { warming: true });
    assert.ok(!JSON.stringify(body).includes('secret-router'));
    assert.deepEqual(seen, ['https://secret-router.example.invalid/api/ping']);
    const again = await (await fetch(`${s.base}/warm`, { headers: ip })).json();
    assert.deepEqual(again, { warming: false });
    assert.equal(seen.length, 1);
    let limited = 0;
    for (let i = 0; i < 8; i++) if ((await fetch(`${s.base}/warm`, { headers: ip })).status === 429) limited += 1;
    assert.ok(limited >= 1, 'a flood from one address is refused');
  } finally {
    s.close(); global.fetch = originalFetch;
    if (prev === undefined) delete process.env.FREELLMAPI_BASE_URL; else process.env.FREELLMAPI_BASE_URL = prev;
  }
});
