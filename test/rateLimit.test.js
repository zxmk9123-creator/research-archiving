const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const { createWindowCounter, clientKey, securityHeaders } = require('../server/lib/rateLimit');
const authRouter = require('../server/routes/auth');
const searchRouter = require('../server/routes/search');

test('window counter: allows max hits per window, then limits with a Retry-After, then recovers', () => {
  let t = 1000;
  const c = createWindowCounter({ windowMs: 60000, max: 3, now: () => t });
  assert.deepEqual([c.hit('a').limited, c.hit('a').limited, c.hit('a').limited], [false, false, false]);
  const blocked = c.hit('a');
  assert.equal(blocked.limited, true);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  assert.equal(c.hit('b').limited, false); // another address is unaffected
  t += 60001;
  assert.equal(c.hit('a').limited, false);
});

test('window counter: failure counting locks only after max failures and a reset clears it; memory stays bounded', () => {
  let t = 0;
  const c = createWindowCounter({ windowMs: 1000, max: 2, now: () => t });
  c.fail('x'); assert.equal(c.peek('x').limited, false);
  c.fail('x'); assert.equal(c.peek('x').limited, true);
  c.reset('x'); assert.equal(c.peek('x').limited, false);
  for (let i = 0; i < 6000; i++) c.hit(`k${i}`);
  assert.ok(c.size() <= 5000);
});

test('clientKey prefers the first x-forwarded-for hop', () => {
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} }), '1.2.3.4');
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});

function serve(mount) {
  const app = express();
  app.use(securityHeaders);
  app.use(express.json());
  mount(app);
  return new Promise((resolve) => { const server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })); });
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('login: 5 wrong passwords lock the address out (429 + Retry-After), even for the right password; a success before that clears the count', async () => {
  process.env.ADMIN_PASSWORD = 'correct-horse';
  const s = await serve((app) => app.use('/api/auth', authRouter));
  try {
    const ip = { 'x-forwarded-for': '9.9.9.9' };
    for (let i = 0; i < 4; i++) assert.equal((await post(`${s.base}/api/auth/login`, { password: 'nope' }, ip)).status, 401);
    assert.equal((await post(`${s.base}/api/auth/login`, { password: 'correct-horse' }, ip)).status, 200); // success resets
    for (let i = 0; i < 5; i++) assert.equal((await post(`${s.base}/api/auth/login`, { password: 'nope' }, ip)).status, 401);
    const locked = await post(`${s.base}/api/auth/login`, { password: 'correct-horse' }, ip);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    // another address is not affected
    assert.equal((await post(`${s.base}/api/auth/login`, { password: 'correct-horse' }, { 'x-forwarded-for': '8.8.8.8' })).status, 200);
  } finally { s.close(); delete process.env.ADMIN_PASSWORD; }
});

test('search: a question over 1000 characters is refused before any database or model work; the per-address limit answers 429', async () => {
  const original = pool.query;
  let queries = 0;
  pool.query = async () => { queries += 1; return { rows: [] }; };
  const s = await serve((app) => app.use('/api/search', searchRouter));
  const prevMax = process.env.AI_SEARCH_RATE_MAX;
  try {
    const long = await post(`${s.base}/api/search`, { question: '가'.repeat(1001) });
    assert.equal(long.status, 400);
    assert.equal(queries, 0);
    process.env.AI_SEARCH_RATE_MAX = '2';
    searchRouter.searchRateCounter.reset('7.7.7.7');
    const ip = { 'x-forwarded-for': '7.7.7.7' };
    assert.notEqual((await post(`${s.base}/api/search`, { question: '' }, ip)).status, 429);
    assert.notEqual((await post(`${s.base}/api/search`, { question: '' }, ip)).status, 429);
    const limited = await post(`${s.base}/api/search`, { question: '' }, ip);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
  } finally {
    s.close(); pool.query = original;
    if (prevMax === undefined) delete process.env.AI_SEARCH_RATE_MAX; else process.env.AI_SEARCH_RATE_MAX = prevMax;
    searchRouter.searchRateCounter.reset('7.7.7.7');
  }
});

test('security headers are set on every response', async () => {
  const s = await serve((app) => app.get('/ping', (req, res) => res.json({ ok: true })));
  try {
    const res = await fetch(`${s.base}/ping`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  } finally { s.close(); }
});
