// SELF-HEALING for the morning collection. Nothing here waits for a person: whenever the site itself notices (on a visit, on any cron call)
// that today's collection is unfinished and nobody is working on it, it starts the next hop of the chain by itself.
//  - needsKick(): not completed, inside the 07:00-12:00 KST window, and either stalled (no lease and no progress for STALL_MS) or not
//    started 15 minutes into the window (the 07:00 cron never arrived).
//  - claim: one kick per 4 minutes across all instances (atomic UPDATE), so a burst of visitors cannot start a burst of hops; a hop that
//    finds the lease held by a live one just answers "in_progress".
//  - every kick is written to the pipeline trace.
const pool = require('../db/pool');
const guard = require('./cronGuard');
const { recordPipelineEvent } = require('./pipelineTrace');

const KICK_MIN_GAP_MS = 4 * 60 * 1000;
const WINDOW_START_HOUR_KST = 7;
const WINDOW_END_HOUR_KST = 12;
const NOT_STARTED_GRACE_MIN = 15;

function kstParts(now) {
  const d = new Date(now.getTime() + 9 * 3600 * 1000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

function needsKick(status, now = new Date()) {
  if (!status || status.completedToday) return false;
  const { hour, minute } = kstParts(now);
  if (hour < WINDOW_START_HOUR_KST || hour >= WINDOW_END_HOUR_KST) return false;
  if (status.state === 'stalled') return true;
  return status.state === 'waiting' && !status.progress && hour * 60 + minute >= WINDOW_START_HOUR_KST * 60 + NOT_STARTED_GRACE_MIN;
}

async function claimKick() {
  await pool.query("INSERT INTO scheduler_jobs (job_name, last_run_date) VALUES ('pipeline_kick', CURRENT_DATE) ON CONFLICT (job_name) DO NOTHING");
  const { rows } = await pool.query(
    "UPDATE scheduler_jobs SET last_completed_at = now(), last_run_date = CURRENT_DATE WHERE job_name = 'pipeline_kick' AND (last_completed_at IS NULL OR last_completed_at < now() - make_interval(secs => $1)) RETURNING job_name",
    [KICK_MIN_GAP_MS / 1000]
  );
  return rows.length > 0;
}

async function maybeKickStalledPipeline({ now = new Date(), status, env, fetchImpl, sleep } = {}) {
  const st = status || await require('./dailyDiscovery').getDailyDiscoveryStatus(now);
  if (!needsKick(st, now)) return { kicked: false, reason: 'not_needed' };
  if (!(await claimKick())) return { kicked: false, reason: 'recently_kicked' };
  // depth 1 starts a fresh hop budget, so a pipeline that ran out of hops can still finish
  const result = await guard.chainNext(1, { env, fetchImpl, sleep });
  await recordPipelineEvent('self_heal_kick', { state: st.state, progress: st.progress ? `${st.progress.done}/${st.progress.total}` : null, result });
  return { kicked: true, result };
}

module.exports = { needsKick, claimKick, maybeKickStalledPipeline, KICK_MIN_GAP_MS };
