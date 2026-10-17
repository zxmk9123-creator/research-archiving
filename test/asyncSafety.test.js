const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { patchAsyncRoutes, errorHandler } = require('../server/lib/asyncSafety');

test('a rejected async route handler becomes a JSON 500 instead of an unhandled rejection', async () => {
  patchAsyncRoutes();
  const app = express();
  app.get('/boom', async () => { throw new Error('db down'); });
  app.get('/ok', async (req, res) => { res.json({ ok: true }); });
  app.get('/sync', () => { throw new Error('sync boom'); });
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origError = console.error;
  console.error = () => {};
  try {
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    const r1 = await fetch(`${base}/boom`);
    assert.equal(r1.status, 500);
    assert.deepEqual(await r1.json(), { error: '서버 오류가 발생했습니다.' });
    assert.equal((await fetch(`${base}/sync`)).status, 500);
    assert.deepEqual(await (await fetch(`${base}/ok`)).json(), { ok: true });
    await new Promise((r) => setTimeout(r, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    assert.equal(unhandled, 0);
  } finally {
    console.error = origError;
    await new Promise((r) => server.close(r));
  }
});
