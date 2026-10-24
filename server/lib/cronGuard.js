// MORNING PIPELINE GUARANTEES. Collection -> headline -> home status must not depend on any one external trigger. Three rules:
//  1. SELF-CHAINING: a cron call that leaves discovery unfinished immediately calls the next one itself (the deployment's own production
//     domain, which Vercel supplies and which survives domain renames) instead of waiting for the next hourly external call.
//  2. DEADLINE: by 10:00 KST a headline exists even if collection is still running (built from what is collected; refreshed when more
//     items are published or collection completes) — see dailyBrief.ensureDailyBrief().
//  3. WATCHDOG: a stalled pipeline fails the cron response loudly, which turns the GitHub Actions run red (email notification).
const MAX_CHAIN_DEPTH = 15;
const WATCHDOG_STALL_HOUR_KST = 9;      // started late / no progress by 09:00 KST is an incident
const BRIEF_GRACE_MS = 30 * 60 * 1000;  // collection done, headline still missing after 30 minutes

// The production host Vercel injects (tracks the project's current primary domain, unlike a hard-coded URL).
function chainTarget(env = process.env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  return host ? `https://${String(host).replace(/^https?:\/\//, '')}/api/cron/daily` : null;
}

function shouldChain(discoveryResult, depth) {
  return Boolean(discoveryResult && typeof discoveryResult === 'object' && discoveryResult.done === false && depth < MAX_CHAIN_DEPTH);
}

// Calls the next hop. The hop answers 202 at once and keeps working in its own invocation, so this returns in milliseconds.
async function chainNext(depth, { env = process.env, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = chainTarget(env);
  if (!url || !env.CRON_SECRET) return 'no_target';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${env.CRON_SECRET}`, 'x-cron-chain': String(depth) }, signal: ctrl.signal, redirect: 'manual' });
    return `hop_${depth}_http_${res.status}`;
  } catch (err) {
    return `hop_${depth}_failed_${String(err && err.message).slice(0, 60)}`;
  } finally {
    clearTimeout(timer);
  }
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
  const since = status.completedAt ? now - new Date(status.completedAt).getTime() : 0;
  return since > BRIEF_GRACE_MS ? `headline not ready ${Math.round(since / 60000)} min after collection (brief ${brief.state})` : null;
}

module.exports = { MAX_CHAIN_DEPTH, chainTarget, shouldChain, chainNext, pipelineIncident };
