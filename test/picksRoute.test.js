const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const picksRouter = require('../server/routes/picks');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/picks', picksRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/picks`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function mockPool(handlers) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('GET /teams: returns the seeded defaults even with no picks yet', () => withServer(async (base) => {
  const { restore } = mockPool([
    ['SELECT DISTINCT team FROM picks', () => ({ rows: [] })],
  ]);
  try {
    const res = await fetch(`${base}/teams`);
    const body = await res.json();
    assert.deepEqual(body, ['유지Trading팀', '유지투자팀'].sort((a, b) => a.localeCompare(b, 'ko')));
  } finally {
    restore();
  }
}));

test('GET /teams: merges in an ad-hoc team name already used in a pick, deduped against the seed', () => withServer(async (base) => {
  const { restore } = mockPool([
    ['SELECT DISTINCT team FROM picks', () => ({ rows: [{ team: 'C팀' }, { team: '유지투자팀' }] })],
  ]);
  try {
    const res = await fetch(`${base}/teams`);
    const body = await res.json();
    assert.deepEqual(body, ['C팀', '유지Trading팀', '유지투자팀'].sort((a, b) => a.localeCompare(b, 'ko')));
    assert.equal(body.filter((t) => t === '유지투자팀').length, 1);
  } finally {
    restore();
  }
}));

test('POST /: rejects a team pick with no team name', () => withServer(async (base) => {
  const { restore } = mockPool([]);
  try {
    const res = await fetch(`${base}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 1, kind: 'team' }),
    });
    assert.equal(res.status, 400);
  } finally {
    restore();
  }
}));

test('POST /: creates a team pick with the given team name, trimmed', () => withServer(async (base) => {
  const { calls, restore } = mockPool([
    ['INSERT INTO picks', () => ({ rows: [{ id: 9, item_id: 1, kind: 'team', team: '유지Trading팀' }] })],
  ]);
  try {
    const res = await fetch(`${base}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 1, kind: 'team', team: '  유지Trading팀  ' }),
    });
    assert.equal(res.status, 201);
    const insertCall = calls.find((c) => c.text.includes('INSERT INTO picks'));
    assert.deepEqual(insertCall.params, [1, null, 'team', null, '유지Trading팀']);
  } finally {
    restore();
  }
}));

test('POST /: a duplicate team pick (same item, same team) returns 409, not a second row', () => withServer(async (base) => {
  const { restore } = mockPool([
    ['INSERT INTO picks', () => { const err = new Error('duplicate key'); err.code = '23505'; throw err; }],
  ]);
  try {
    const res = await fetch(`${base}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 1, kind: 'team', team: '유지Trading팀' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /이미 해당 팀/);
  } finally {
    restore();
  }
}));

test('POST /: an ad-hoc, never-seeded team name is accepted as-is (no managed roster to validate against)', () => withServer(async (base) => {
  const { calls, restore } = mockPool([
    ['INSERT INTO picks', () => ({ rows: [{ id: 10 }] })],
  ]);
  try {
    const res = await fetch(`${base}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 1, kind: 'team', team: '신규TF' }),
    });
    assert.equal(res.status, 201);
    const insertCall = calls.find((c) => c.text.includes('INSERT INTO picks'));
    assert.equal(insertCall.params[4], '신규TF');
  } finally {
    restore();
  }
}));

test('POST /: a personal pick still works unchanged, with team left NULL', () => withServer(async (base) => {
  const { calls, restore } = mockPool([
    ['INSERT INTO picks', () => ({ rows: [{ id: 11 }] })],
  ]);
  try {
    const res = await fetch(`${base}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 1 }),
    });
    assert.equal(res.status, 201);
    const insertCall = calls.find((c) => c.text.includes('INSERT INTO picks'));
    assert.deepEqual(insertCall.params, [1, null, 'personal', null, null]);
  } finally {
    restore();
  }
}));
