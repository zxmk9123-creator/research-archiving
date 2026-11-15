// SELF-HEALING for the morning collection. Nothing here waits for a person: whenever the site itself notices (on a visit, on any cron call)
// that today's collection is unfinished and nobody is working on it, it starts the next hop of the chain by itself.
//  - needsKick(): not completed, inside the 07:00-12:00 KST window, and either stalled (no lease and no progress for STALL_MS) or not
//    started 15 minutes into the window (the 07:00 cron never arrived).
//  - claim: one kick per minute across all instances (atomic UPDATE), so a burst of visitors cannot start a burst of hops; a hop that
//    finds the lease held by a live one just answers "in_progress".
//  - every kick is written to the pipeline trace.
const pool = require('../db/pool');
const guard = require('./cronGuard');
const { recordPipelineEvent } = require('./pipelineTrace');

const KICK_MIN_GAP_MS = 60 * 1000;
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

// Headline side of the same rule: collection is done but today's brief is not (failed row, a generation nobody has touched for longer
// than its lease, or a model-free stand-in that may be upgraded). Without this the retry waited for the next external cron call.
function needsHeadlineKick(st, brief, now = new Date()) {
  if (!st || !st.completedToday || !brief) return false;
  const { hour } = kstParts(now);
  if (hour < WINDOW_START_HOUR_KST || hour >= WINDOW_END_HOUR_KST) return false;
  const ageMs = now.getTime() - new Date(brief.updatedAt).getTime();
  if (brief.status === 'failed') return ageMs > 30 * 1000;
  if (brief.status === 'generating') return ageMs > 6 * 60 * 1000;
  return brief.status === 'ready' && brief.degraded && ageMs > 31 * 60 * 1000 && brief.attempts < require('./dailyBrief').MAX_AUTO_DAILY_ATTEMPTS;
}

async function readBriefRow(now) {
  const { rows } = await pool.query(
    "SELECT status, updated_at, attempt_count, COALESCE(brief->>'degraded', '') = 'true' AS degraded FROM daily_briefs WHERE brief_date = $1",
    [require('./dailyBrief').kstDate(now)]
  );
  const r = rows[0];
  return r ? { status: r.status, updatedAt: r.updated_at, attempts: Number(r.attempt_count) || 0, degraded: r.degraded } : null;
}

async function claimKick() {
  await pool.query("INSERT INTO scheduler_jobs (job_name, last_run_date) VALUES ('pipeline_kick', CURRENT_DATE) ON CONFLICT (job_name) DO NOTHING");
  const { rows } = await pool.query(
    "UPDATE scheduler_jobs SET last_completed_at = now(), last_run_date = CURRENT_DATE WHERE job_name = 'pipeline_kick' AND (last_completed_at IS NULL OR last_completed_at < now() - make_interval(secs => $1)) RETURNING job_name",
    [KICK_MIN_GAP_MS / 1000]
  );
  return rows.length > 0;
}

// LAST LINE OF DEFENCE: whoever pings or visits the site also checks the deadline. Collection unfinished at 09:30 KST is told to a person once
// a day (e-mail/webhook, deduplicated by day in opsAlerts), independent of whether any scheduler's cron call ever ran the watchdog.
const LATE_ALERT_MINUTE_KST = 9 * 60 + 30;
async function maybeAlertLate(st, now, dispatch) {
  if (!st || st.completedToday) return false;
  const { hour, minute } = kstParts(now);
  const m = hour * 60 + minute;
  if (m < LATE_ALERT_MINUTE_KST || hour >= WINDOW_END_HOUR_KST) return false;
  const progress = st.progress ? `${st.progress.done}/${st.progress.total}` : 'not started';
  const day = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const send = dispatch || require('./opsAlerts').dispatchAlerts;
  const r = await send([{ key: `late-collection:${day}`, subject: '아침 기사 수집 지연', urgent: true, text: `오늘 아침 기사 수집이 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} KST 현재 끝나지 않았습니다 (진행 ${progress}, 상태 ${st.state}). 자동으로 다음 단계를 계속 시작하는 중이며, 10시가 되면 수집이 덜 끝났어도 헤드라인 생성을 시작합니다.` }]);
  return Boolean(r && r.sent);
}

async function maybeKickStalledPipeline({ now = new Date(), status, env, fetchImpl, sleep, dispatch } = {}) {
  const st = status || await require('./dailyDiscovery').getDailyDiscoveryStatus(now);
  await maybeAlertLate(st, now, dispatch).catch((err) => console.error('late-collection alert failed:', err.message));
  let headline = false;
  if (!needsKick(st, now)) {
    if (!(st && st.completedToday)) return { kicked: false, reason: 'not_needed' };
    const brief = await readBriefRow(now).catch(() => null);
    if (!needsHeadlineKick(st, brief, now)) return { kicked: false, reason: 'not_needed' };
    headline = true;
  }
  if (!(await claimKick())) return { kicked: false, reason: 'recently_kicked' };
  if (headline) {
    // one hop is enough: it runs ensure_daily_brief, which restarts (or upgrades) the headline under its own claim and caps
    const result = await guard.chainNext(1, { env, fetchImpl, sleep });
    await recordPipelineEvent('self_heal_kick', { state: 'headline', result });
    return { kicked: true, headline: true, result };
  }
  // depth 1 starts a fresh hop budget, so a pipeline that ran out of hops can still finish
  const result = await guard.fanOut(guard.FAN_OUT, { env, fetchImpl, sleep });
  await recordPipelineEvent('self_heal_kick', { state: st.state, progress: st.progress ? `${st.progress.done}/${st.progress.total}` : null, result });
  return { kicked: true, result };
}

module.exports = { maybeAlertLate, needsKick, needsHeadlineKick, claimKick, maybeKickStalledPipeline, KICK_MIN_GAP_MS };
