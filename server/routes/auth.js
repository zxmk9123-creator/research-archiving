const express = require('express');
const { checkPassword, isAuthenticated, setSessionCookie, clearSessionCookie } = require('../lib/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  // TEMP DIAGNOSTIC — never logs the actual secret values, only lengths/
  // whitespace, to debug a production-only login failure. Remove once
  // resolved.
  console.log('AUTH_DEBUG envLen=%d envHasWs=%s candLen=%d candHasWs=%s',
    (process.env.ADMIN_PASSWORD || '').length,
    /^\s|\s$/.test(process.env.ADMIN_PASSWORD || ''),
    String(password || '').length,
    /^\s|\s$/.test(String(password || '')));
  if (!checkPassword(password)) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
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
