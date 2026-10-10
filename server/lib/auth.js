const crypto = require('crypto');

// Single-admin session auth — no accounts/roles, matches the app's current
// 1-operator reality. No new dependency (cookie-parser/express-session):
// sessions are a stateless HMAC-signed token in a cookie, verified on each
// request, so nothing is stored server-side and a restart never logs
// anyone out early.
//
// The session secret is derived from ADMIN_PASSWORD itself (HMAC is
// one-way, so this never exposes the password) rather than requiring a
// second env var — one secret to configure, not two.
const SESSION_COOKIE = 'ra_admin_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

function getSessionSecret() {
  return crypto.createHash('sha256').update(`ra-session:${getAdminPassword()}`).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
}

function issueSessionToken() {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `admin:${expires}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const [, expiresStr] = payload.split(':');
  const expires = Number(expiresStr);
  return Number.isFinite(expires) && Date.now() < expires;
}

// Constant-time password check — a plain === would let response timing
// leak how many leading characters matched.
function checkPassword(candidate) {
  const actual = getAdminPassword();
  if (!actual) return false; // ADMIN_PASSWORD unset: no one can log in, not "anyone can".
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((p) => {
      const idx = p.indexOf('=');
      if (idx === -1) return [p.trim(), ''];
      return [p.slice(0, idx).trim(), decodeURIComponent(p.slice(idx + 1).trim())];
    })
  );
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[SESSION_COOKIE]);
}

// Applied only to mutating admin routes (POST/PATCH/DELETE for sources,
// items, companies) — GET/read routes and the end-user-facing picks/search
// routes are deliberately left off this middleware.
function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '로그인이 필요합니다. 관리자 비밀번호로 로그인해주세요.' });
  }
  next();
}

function setSessionCookie(res) {
  res.cookie(SESSION_COOKIE, issueSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

module.exports = {
  SESSION_COOKIE,
  checkPassword,
  isAuthenticated,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  issueSessionToken,
};
