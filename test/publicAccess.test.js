const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const itemsRouter = require('../server/routes/items');
const statsRouter = require('../server/routes/stats');
const { SESSION_COOKIE, issueSessionToken } = require('../server/lib/auth');
const { publicView, scopeQueryForAnonymous, INTERNAL_FIELDS } = require('../server/lib/publicItems');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/items', itemsRouter);
  app.use('/api/stats', statsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}/api`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}
const ROW = (over = {}) => ({ id: 1, title: 't', status: 'Published', summary: 's', ai_summary: 'as', ai_insight: 'ai', source_url: 'https://x.example', ai_error: 'provider timeout', gate_hold_reason: 'invalid_source_url', ai_status: 'failed', reviewer_eligible: true, sectors: [], usages: [], companies: [], ...over });
function mockPool(rowsFor) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return { rows: rowsFor(text, params) }; };
  return { calls, restore: () => { pool.query = original; } };
}
const adminHeaders = { Cookie: `${SESSION_COOKIE}=${issueSessionToken()}` };

test('scopeQueryForAnonymous: no status or Published -> Published; any other status is refused', () => {
  assert.deepEqual(scopeQueryForAnonymous({ q: 'x' }), { q: 'x', status: 'Published' });
  assert.deepEqual(scopeQueryForAnonymous({ status: 'Published' }), { status: 'Published' });
  assert.equal(scopeQueryForAnonymous({ status: 'Draft' }), null);
  assert.equal(scopeQueryForAnonymous({ status: 'Archived' }), null);
});

test('publicView removes every internal field and keeps what the public pages use', () => {
  const out = publicView(ROW());
  for (const f of INTERNAL_FIELDS) assert.ok(!(f in out), f);
  assert.equal(out.ai_summary, 'as');
  assert.equal(out.source_url, 'https://x.example');
});

test('anonymous GET /items?status=Draft is refused and never reaches the database; month-counts too', async () => {
  const m = mockPool(() => []);
  try {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/items?status=Draft`)).status, 401);
      assert.equal((await fetch(`${base}/items/month-counts?status=Rejected`)).status, 401);
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('anonymous GET /items without a status is forced to Published and returns no internal fields', async () => {
  const m = mockPool(() => [ROW()]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/items`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!('ai_error' in body[0]) && !('gate_hold_reason' in body[0]));
    });
    const list = m.calls.find((c) => /FROM items i/.test(c.text));
    assert.match(list.text, /i\.status = \$1/);
    assert.equal(list.params[0], 'Published');
  } finally { m.restore(); }
});

test('anonymous GET /items/:id: an unpublished item is a 404; a published one has no internal fields', async () => {
  let m = mockPool(() => [ROW({ status: 'Draft' })]);
  try { await withServer(async (base) => assert.equal((await fetch(`${base}/items/1`)).status, 404)); } finally { m.restore(); }
  m = mockPool(() => [ROW()]);
  try {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/items/1`)).json();
      assert.equal(body.id, 1);
      assert.ok(!('ai_error' in body));
    });
  } finally { m.restore(); }
});

test('an admin session still sees drafts and the internal fields', async () => {
  const m = mockPool(() => [ROW({ status: 'Draft' })]);
  try {
    await withServer(async (base) => {
      const list = await fetch(`${base}/items?status=Draft`, { headers: adminHeaders });
      assert.equal(list.status, 200);
      assert.equal((await list.json())[0].ai_error, 'provider timeout');
      const one = await (await fetch(`${base}/items/1`, { headers: adminHeaders })).json();
      assert.equal(one.status, 'Draft');
      assert.equal(one.gate_hold_reason, 'invalid_source_url');
    });
  } finally { m.restore(); }
});

test('GET /stats/draft-triage requires an admin session', async () => {
  const m = mockPool(() => []);
  try {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/stats/draft-triage`)).status, 401);
    });
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});
