// Work started "in the background" (fire-and-forget) dies with the process on a serverless host: the function is frozen as soon as
// the response is sent. track() keeps such a promise alive — it hands it to the platform's waitUntil when there is one and records it so
// the cron endpoint can drain() everything before it answers. On a long-lived server this is a no-op beyond the bookkeeping.
const pending = new Set();

function platformWaitUntil() {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')];
    const store = ctx && typeof ctx.get === 'function' ? ctx.get() : null;
    return store && typeof store.waitUntil === 'function' ? store.waitUntil : null;
  } catch (_) { return null; }
}

function track(promise) {
  if (!promise || typeof promise.then !== 'function') return promise;
  const tracked = Promise.resolve(promise).catch(() => {}).finally(() => pending.delete(tracked));
  pending.add(tracked);
  const waitUntil = platformWaitUntil();
  if (waitUntil) { try { waitUntil(tracked); } catch (_) { /* best effort */ } }
  return promise;
}

// Waits for every tracked promise, at most timeoutMs; returns how many were still running.
async function drain(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (pending.size && Date.now() < deadline) {
    let timer;
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => { timer = setTimeout(r, Math.max(50, deadline - Date.now())); })]);
    clearTimeout(timer); // a finished wait must not leave its timer (up to the whole budget) running
  }
  return pending.size;
}

module.exports = { track, drain, _pendingCount: () => pending.size };
