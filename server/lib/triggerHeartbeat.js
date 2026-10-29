// Which external trigger called /api/cron/daily, and when — kept in its own scheduler_jobs document (job 'trigger_heartbeat'), apart from
// pipeline_trace, so hourly calls cannot evict trace events. This watches the SCHEDULERS only; whether collection and the headline finished
// is judged separately (pipelineIncident), so a successful Vercel self-heal never hides a missed GitHub trigger.
const { mutateJobState } = require('./jobState');

const JOB = 'trigger_heartbeat';
const KEEP_DAYS = 7;
const KST_MS = 9 * 3600000;
// Thresholds, from the workflow (.github/workflows/scheduled-jobs.yml) and the recorded run history:
//  - the morning window is triggered every 10 min from 07:00 KST (plus the hourly :07 trigger); the morning target is 09:00 KST, so a
//    GitHub call is expected by 07:45 KST, which still leaves 75 min for the run
//  - outside the window GitHub delivered about 1 run in 5 (largest observed gap 7.6 h in 45 h of history), so a 9 h silence is the
//    smallest threshold that history does not already violate
const MORNING_DEADLINE_MIN = 7 * 60 + 45; // minutes after 00:00 KST
const MAX_GAP_MS = 9 * 3600000;

const kstDayOf = (ms) => new Date(ms + KST_MS).toISOString().slice(0, 10);

// Only what the platform or our own workflow states is trusted: Vercel cron identifies itself by its user agent, the Actions workflow sends
// X-Trigger-Source: github-actions. A bare curl/other user agent is NOT assumed to be GitHub; it is recorded as 'unknown'.
function classifyTrigger(userAgent = '', sourceHeader = '') {
  if (/^vercel-cron\//i.test(userAgent)) return 'vercel';
  if (String(sourceHeader).toLowerCase() === 'github-actions') return 'github';
  return 'unknown';
}

async function recordTrigger(userAgent, sourceHeader, now = new Date()) {
  const via = classifyTrigger(userAgent, sourceHeader);
  const at = now.toISOString();
  const day = kstDayOf(now.getTime());
  return mutateJobState(JOB, (doc) => {
    doc.since = doc.since || at;
    doc.last = { ...(doc.last || {}), [via]: at };
    doc.days = doc.days || {};
    const d = doc.days[day] || (doc.days[day] = {});
    const e = d[via] || (d[via] = { first: at, n: 0 });
    e.n += 1;
    e.last = at;
    for (const k of Object.keys(doc.days).sort().slice(0, -KEEP_DAYS)) delete doc.days[k];
    return doc;
  });
}

// Pure. hb = the stored document (null when none exists, undefined when it was not read). kind 'missed' = evidence of a missed trigger;
// 'telemetry' = the heartbeat cannot say (not recording yet / source unattributed) and is never reported as a miss.
function triggerIncidents(hb, { now = Date.now() } = {}) {
  if (hb === undefined) return [];
  if (hb === null || !hb.since) return [{ kind: 'telemetry', key: 'heartbeat_missing', text: 'trigger heartbeat has no data yet (telemetry missing, not a confirmed miss)' }];
  const out = [];
  const day = kstDayOf(now);
  const kst = new Date(now + KST_MS);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const rec = (hb.days || {})[day] || {};
  const windowStart = new Date(`${day}T00:00:00Z`).getTime() - KST_MS + 7 * 3600000; // 07:00 KST of this KST day
  if (minutes >= MORNING_DEADLINE_MIN && !(rec.github && rec.github.n > 0)) {
    if (new Date(hb.since).getTime() > windowStart) out.push({ kind: 'telemetry', key: `heartbeat_started_late:${day}`, text: `trigger heartbeat started after today's morning window (${hb.since}); GitHub delivery today cannot be judged` });
    else if (rec.unknown && rec.unknown.n > 0) out.push({ kind: 'telemetry', key: `github_unattributed:${day}`, text: `${rec.unknown.n} cron call(s) today have no trusted source; GitHub delivery cannot be confirmed (workflow must send X-Trigger-Source)` });
    else out.push({ kind: 'missed', key: `github_morning_missed:${day}`, text: `GitHub scheduled trigger missed: no call by 07:45 KST (vercel cron calls: ${(rec.vercel && rec.vercel.n) || 0})` });
  }
  const last = hb.last && hb.last.github;
  if (last && now - new Date(last).getTime() > MAX_GAP_MS) {
    out.push({ kind: 'missed', key: `github_gap:${last}`, text: `GitHub scheduled trigger silent for ${Math.round((now - new Date(last).getTime()) / 3600000)} h (last ${last})` });
  }
  return out;
}

module.exports = { classifyTrigger, recordTrigger, triggerIncidents, kstDayOf, JOB, MORNING_DEADLINE_MIN, MAX_GAP_MS };
