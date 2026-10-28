// MORNING PIPELINE GUARANTEES. Collection -> headline -> home status must not depend on any one external trigger. Three rules:
//  1. SELF-CHAINING: a cron call that leaves discovery unfinished immediately calls the next one itself (the deployment's own production
//     domain, which Vercel supplies and which survives domain renames) instead of waiting for the next hourly external call.
//  2. DEADLINE: by 10:00 KST a headline exists even if collection is still running (built from what is collected; refreshed when more
//     items are published or collection completes) — see dailyBrief.ensureDailyBrief().
//  3. WATCHDOG: a stalled pipeline fails the cron response loudly, which turns the GitHub Actions run red (email notification).
const MAX_CHAIN_DEPTH = 15;
const WATCHDOG_STALL_HOUR_KST = 9;      // started late / no progress by 09:00 KST is an incident
const BRIEF_GRACE_MS = 30 * 60 * 1000;
const GENERATION_LEASE_MS = 25 * 60 * 1000; // same lease dailyBrief.js uses to reclaim a stuck generation  // collection done, headline still missing after 30 minutes

// The production host Vercel injects (tracks the project's current primary domain, unlike a hard-coded URL).
function chainTarget(env = process.env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  return host ? `https://${String(host).replace(/^https?:\/\//, '')}/api/cron/daily` : null;
}

function shouldChain(discoveryResult, depth) {
  return Boolean(discoveryResult && typeof discoveryResult === 'object' && discoveryResult.done === false && depth < MAX_CHAIN_DEPTH);
}

// Calls the next hop. The hop answers 202 at once and keeps working in its own invocation, so this returns in milliseconds. A hand-off that
// fails (network error, 5xx/429, a timeout) is retried twice with a short pause: one dropped call used to end the whole chain silently.
async function chainNext(depth, { env = process.env, fetchImpl = fetch, timeoutMs = 10000, retryDelaysMs = [1500, 4000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const url = chainTarget(env);
  if (!url || !env.CRON_SECRET) return 'no_target';
  let last = 'hop_not_called';
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${env.CRON_SECRET}`, 'x-cron-chain': String(depth) }, signal: ctrl.signal, redirect: 'manual' });
      last = `hop_${depth}_http_${res.status}`;
      // 202 = hop accepted; 401/403/3xx will not change on a retry
      if (res.status === 202 || res.status === 200 || (res.status >= 300 && res.status < 500 && res.status !== 408 && res.status !== 429)) return attempt ? `${last}_attempt${attempt + 1}` : last;
    } catch (err) {
      last = `hop_${depth}_failed_${String(err && err.message).slice(0, 60)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return `${last}_gave_up`;
}

// null when healthy, otherwise a short incident message. status = getDailyDiscoveryStatus(), brief = { state, completedAt }.
function pipelineIncident(status, brief, { hourKst, now = Date.now() } = {}) {
  if (!status.completedToday) {
    if (status.state === 'stalled' && hourKst >= WATCHDOG_STALL_HOUR_KST) {
      const p = status.progress ? ` at ${status.progress.done}/${status.progress.total}` : ' before starting';
      return `morning collection stalled${p}`;
    }
    return null;
  }
  if (brief.state === 'ready') return null;
  // A generation that is running right now (a retry flips the brief to 'generating' in the same cron call) is not an incident;
  // only one whose row has not moved for longer than the generation lease is.
  if (brief.state === 'generating' && brief.updatedAt && now - new Date(brief.updatedAt).getTime() < GENERATION_LEASE_MS) return null;
  const since = status.completedAt ? now - new Date(status.completedAt).getTime() : 0;
  return since > BRIEF_GRACE_MS ? `headline not ready ${Math.round(since / 60000)} min after collection (brief ${brief.state})` : null;
}

module.exports = { MAX_CHAIN_DEPTH, chainTarget, shouldChain, chainNext, pipelineIncident };
