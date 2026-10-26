// WAKE THE AI ROUTER WHEN SOMEONE ARRIVES. The FreeLLMAPI router runs on a free Render web service that goes to sleep when idle; the first
// request after that waits tens of seconds for the container to start. Opening the home page now sends one cheap, unauthenticated request
// (/api/ping on the router's own host) so the wake-up overlaps with the time the visitor spends typing the question.
// Best-effort and bounded: at most one ping per instance every MIN_GAP_MS, never throws, never waits for the router in the response.
const MIN_GAP_MS = 5 * 60 * 1000;
const PING_TIMEOUT_MS = 70000; // longer than a cold start; the request only has to reach the sleeping service to wake it

let lastPingAt = 0;

// 'https://router.example.com/v1' -> 'https://router.example.com/api/ping'; null when not configured or not a URL.
function pingUrl(baseUrl = process.env.FREELLMAPI_BASE_URL) {
  try {
    const u = new URL(String(baseUrl || ''));
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.origin}/api/ping`;
  } catch (_) {
    return null;
  }
}

// Returns { started, reason }. The ping itself runs in the background (the returned promise `done` settles when it finishes).
function warmRouter({ now = Date.now(), fetchImpl = fetch, baseUrl } = {}) {
  const url = pingUrl(baseUrl);
  if (!url) return { started: false, reason: 'not_configured', done: Promise.resolve() };
  if (now - lastPingAt < MIN_GAP_MS) return { started: false, reason: 'recent', done: Promise.resolve() };
  lastPingAt = now;
  const done = fetchImpl(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS), headers: { accept: 'application/json' } })
    .then((res) => ({ ok: res.ok }), (err) => { lastPingAt = 0; return { ok: false, error: String(err && err.message).slice(0, 80) }; }); // a failed ping may be retried by the next visitor
  return { started: true, reason: 'pinged', done };
}

module.exports = { warmRouter, pingUrl, MIN_GAP_MS, _reset: () => { lastPingAt = 0; } };
