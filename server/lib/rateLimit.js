// Small in-memory rate limiting + safe default headers (no new dependency).
// Limits are per server instance: on a serverless host each warm instance counts separately, so this is a brake on abuse (password guessing,
// LLM-cost loops), not a hard global quota — a hard quota needs shared state (database) or the platform firewall.
const MAX_KEYS = 5000;

function createWindowCounter({ windowMs, max: maxOrFn, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  const limit = () => (typeof maxOrFn === 'function' ? maxOrFn() : maxOrFn); // a function lets the limit follow configuration
  function prune(t) {
    if (hits.size < MAX_KEYS) return;
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    if (hits.size >= MAX_KEYS) hits.clear(); // under a flood of distinct keys: forget rather than grow without bound
  }
  const entry = (key) => {
    const t = now();
    const e = hits.get(key);
    return e && e.resetAt > t ? e : null;
  };
  return {
    // counts one hit; limited=true once the window already holds `max` hits
    hit(key) {
      const t = now();
      prune(t);
      let e = entry(key);
      if (!e) { e = { count: 0, resetAt: t + windowMs }; hits.set(key, e); }
      if (e.count >= limit()) return { limited: true, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
      e.count += 1;
      return { limited: false, retryAfterSec: 0 };
    },
    // is the key at its limit (without counting)?
    peek(key) {
      const e = entry(key);
      return e && e.count >= limit() ? { limited: true, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) } : { limited: false, retryAfterSec: 0 };
    },
    fail(key) {
      const t = now();
      prune(t);
      let e = entry(key);
      if (!e) { e = { count: 0, resetAt: t + windowMs }; hits.set(key, e); }
      e.count += 1;
    },
    reset(key) { hits.delete(key); },
    size: () => hits.size,
  };
}

// The client address as the platform reports it (Vercel sets x-forwarded-for itself); falls back to the socket.
function clientKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function limitMiddleware(counter, message) {
  return (req, res, next) => {
    const r = counter.hit(clientKey(req));
    if (!r.limited) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    return res.status(429).json({ error: message || '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  };
}

// Headers that are safe for every page of this app (no CSP: the front end's inline use has not been audited).
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

module.exports = { createWindowCounter, clientKey, limitMiddleware, securityHeaders };
