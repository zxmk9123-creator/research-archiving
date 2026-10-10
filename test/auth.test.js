const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  checkPassword,
  isAuthenticated,
  requireAuth,
  issueSessionToken,
  SESSION_COOKIE,
} = require('../server/lib/auth');

// Awaits fn before restoring — critical for the async withAuthServer(...)
// callers below: without the await, this returned the inner promise
// immediately and restored ADMIN_PASSWORD before the HTTP round trip
// inside it ever ran, making every login look like it used the old value.
async function withEnv(key, value, fn) {
  const original = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

test('checkPassword: rejects any candidate when ADMIN_PASSWORD is unset', async () => {
  await withEnv('ADMIN_PASSWORD', '', () => {
    assert.equal(checkPassword(''), false);
    assert.equal(checkPassword('anything'), false);
  });
});

test('checkPassword: accepts only the exact configured password', async () => {
  await withEnv('ADMIN_PASSWORD', 'correct-horse-battery-staple', () => {
    assert.equal(checkPassword('correct-horse-battery-staple'), true);
    assert.equal(checkPassword('wrong'), false);
    assert.equal(checkPassword(''), false);
    assert.equal(checkPassword(undefined), false);
  });
});

test('issueSessionToken/isAuthenticated: a freshly issued token authenticates via the cookie header', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => {
    const token = issueSessionToken();
    const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
    assert.equal(isAuthenticated(req), true);
  });
});

test('isAuthenticated: no cookie header at all is not authenticated', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => {
    assert.equal(isAuthenticated({ headers: {} }), false);
  });
});

test('isAuthenticated: a tampered token is rejected', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => {
    const token = issueSessionToken();
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    const req = { headers: { cookie: `${SESSION_COOKIE}=${tampered}` } };
    assert.equal(isAuthenticated(req), false);
  });
});

test('isAuthenticated: a token signed under a different ADMIN_PASSWORD no longer verifies', async () => {
  const token = await withEnv('ADMIN_PASSWORD', 'old-password', () => issueSessionToken());
  await withEnv('ADMIN_PASSWORD', 'new-password', () => {
    const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
    assert.equal(isAuthenticated(req), false);
  });
});

test('isAuthenticated: an expired token is rejected', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => {
    // Construct an already-expired token the same way issueSessionToken
    // does, just with a past expiry, to exercise the expiry check without
    // waiting 7 days.
    const crypto = require('crypto');
    const secret = crypto.createHash('sha256').update('ra-session:pw').digest();
    const payload = `admin:${Date.now() - 1000}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const req = { headers: { cookie: `${SESSION_COOKIE}=${payload}.${sig}` } };
    assert.equal(isAuthenticated(req), false);
  });
});

test('requireAuth middleware: calls next() when authenticated', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => {
    const token = issueSessionToken();
    const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
    let nextCalled = false;
    requireAuth(req, { status: () => ({ json: () => {} }) }, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});

test('requireAuth middleware: responds 401 with a Korean message when not authenticated', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => {
    const req = { headers: {} };
    let statusCode, body;
    const res = {
      status: (code) => { statusCode = code; return { json: (b) => { body = b; } }; },
    };
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.match(body.error, /로그인/);
  });
});

// --- /api/auth route (login/logout/status) ---

function withAuthServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../server/routes/auth'));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/auth`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('POST /login: wrong password returns 401, status stays unauthenticated', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => withAuthServer(async (base) => {
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(res.status, 401);

    const statusRes = await fetch(`${base}/status`);
    const status = await statusRes.json();
    assert.equal(status.authenticated, false);
  }));
});

test('POST /login: correct password sets a cookie that /status then reports as authenticated', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => withAuthServer(async (base) => {
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes(SESSION_COOKIE));

    const cookie = setCookie.split(';')[0];
    const statusRes = await fetch(`${base}/status`, { headers: { Cookie: cookie } });
    const status = await statusRes.json();
    assert.equal(status.authenticated, true);
  }));
});

test('POST /logout: clears the session so /status reports unauthenticated again', async () => {
  await withEnv('ADMIN_PASSWORD', 'pw', () => withAuthServer(async (base) => {
    const loginRes = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const logoutRes = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logoutRes.status, 200);
    const clearedCookie = logoutRes.headers.get('set-cookie');
    // clearCookie sends an already-expired cookie with the same name —
    // using it on the next request must not still authenticate.
    const statusRes = await fetch(`${base}/status`, { headers: { Cookie: clearedCookie ? clearedCookie.split(';')[0] : cookie } });
    const status = await statusRes.json();
    assert.equal(status.authenticated, false);
  }));
});
