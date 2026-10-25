const express = require('express');
const { checkPassword, isAuthenticated, setSessionCookie, clearSessionCookie } = require('../lib/auth');

const { createWindowCounter, clientKey } = require('../lib/rateLimit');

const router = express.Router();
// Password guessing: after 5 failed logins from one address, logins from it are refused for 15 minutes (a success clears the count).
const loginFailures = createWindowCounter({ windowMs: 15 * 60 * 1000, max: 5 });

router.post('/login', (req, res) => {
  const key = clientKey(req);
  const blocked = loginFailures.peek(key);
  if (blocked.limited) {
    res.set('Retry-After', String(blocked.retryAfterSec));
    return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  }
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    loginFailures.fail(key);
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  loginFailures.reset(key);
  setSessionCookie(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

module.exports = router;
