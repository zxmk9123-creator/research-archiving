const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// VERCEL=1 so requiring the app starts no listener and no in-process timers
process.env.VERCEL = '1';
const app = require('../server/index.js');

function get(server, headers) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: '/api/cron/daily', headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('cron route: refuses calls without the CRON_SECRET bearer token', async () => {
  const prev = process.env.CRON_SECRET;
  const server = app.listen(0);
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await get(server, {})).status, 401, 'no secret configured -> closed');
    process.env.CRON_SECRET = 's3cret';
    assert.equal((await get(server, {})).status, 401);
    assert.equal((await get(server, { authorization: 'Bearer wrong' })).status, 401);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    await new Promise((r) => server.close(r));
  }
});
