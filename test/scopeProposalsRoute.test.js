const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const scopeAnalysis = require('../server/lib/scopeAnalysis');
const router = require('../server/routes/scopeProposals');
const { SESSION_COOKIE, issueSessionToken } = require('../server/lib/auth');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/scope-proposals', router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}/api/scope-proposals`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}
const auth = () => ({ Cookie: `${SESSION_COOKIE}=${issueSessionToken()}` });
function swap(name, fn) { const o = scopeAnalysis[name]; scopeAnalysis[name] = fn; return () => { scopeAnalysis[name] = o; }; }

test('every state-changing endpoint rejects an unauthenticated caller', () => withServer(async (base) => {
  const calls = [];
  const restores = ['runScopeAnalysis', 'applyProposal', 'rejectProposal', 'revokeScopeTerm'].map((n) => swap(n, async () => { calls.push(n); return { ok: true }; }));
  try {
    for (const path of ['/run', '/1/approve', '/1/reject']) {
      const res = await fetch(base + path, { method: 'POST' });
      assert.equal(res.status, 401, path);
    }
    {
      const res = await fetch(`${base}/terms/1`, { method: 'DELETE' });
      assert.equal(res.status, 401, 'DELETE /terms/:id');
    }
    for (const path of []) {
      const res = await fetch(base + path, { method: 'POST' });
      assert.equal(res.status, 401, path);
    }
    assert.deepEqual(calls, []);
  } finally {
    restores.forEach((r) => r());
  }
}));

test('GET / is a public read and returns proposals + active terms', () => withServer(async (base) => {
  const original = pool.query;
  pool.query = async (text) => (text.includes('FROM scope_proposals')
    ? { rows: [{ id: 1, kind: 'add_query', term: 'q', status: 'pending' }] }
    : { rows: [{ term: 'e-saf', mode: 'include' }] });
  try {
    const body = await (await fetch(base)).json();
    assert.equal(body.proposals.length, 1);
    assert.equal(body.activeTerms[0].term, 'e-saf');
  } finally {
    pool.query = original;
  }
}));

test('approve/reject map service results to HTTP and validate the id', () => withServer(async (base) => {
  const r1 = swap('applyProposal', async (id) => (id === 9 ? { ok: false, status: 409, error: 'already applied' } : { ok: true }));
  const r2 = swap('rejectProposal', async () => ({ ok: true }));
  try {
    assert.equal((await fetch(`${base}/2/approve`, { method: 'POST', headers: auth() })).status, 200);
    assert.equal((await fetch(`${base}/9/approve`, { method: 'POST', headers: auth() })).status, 409);
    assert.equal((await fetch(`${base}/abc/approve`, { method: 'POST', headers: auth() })).status, 400);
    assert.equal((await fetch(`${base}/2/reject`, { method: 'POST', headers: auth() })).status, 200);
  } finally {
    r1(); r2();
  }
}));

test('POST /run starts the analysis in the background (202) and refuses a concurrent second start', () => withServer(async (base) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const restore = swap('runScopeAnalysis', () => gate.then(() => ({ ran: true })));
  try {
    assert.equal((await (await fetch(`${base}/run`, { method: 'POST', headers: auth() })).json()).started, true);
    const second = await (await fetch(`${base}/run`, { method: 'POST', headers: auth() })).json();
    assert.equal(second.started, false);
    assert.equal(second.reason, 'already_running');
  } finally {
    release();
    await new Promise((r) => setTimeout(r, 20));
    restore();
  }
}));
