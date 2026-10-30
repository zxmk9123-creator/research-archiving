// M1 health check: did today's scheduled publishing pipeline run, and did the headline reach a terminal, correct state?
// DIAGNOSIS ONLY. It reads state that the pipeline already records (scheduler_jobs cursor/completion, daily_briefs, daily_brief_attempts,
// pipeline_trace, trigger_heartbeat) and reports; it never writes, retries, regenerates or deploys anything. Remediation stays with the
// pipeline's own guards and with a person.
//
// evaluateHealth() is pure (all inputs passed in) so every case is testable; collectHealthInput() is the only part that touches the database.
// Check results: pass | warn | fail | unknown. "unknown" means the evidence needed to judge is missing; it is never reported as a pass or a fail.
const { triggerIncidents } = require('./triggerHeartbeat');

const KST_MS = 9 * 3600000;
const DISCOVERY_START_HOUR_KST = 8;       // the morning run must have started by now
const BRIEF_TARGET_MINUTES_KST = 9 * 60;  // the headline target: 09:00 KST
const BRIEF_MISSING_GRACE_MS = 30 * 60000; // collection done, no headline row for this long = missing
const BRIEF_LEASE_MS = 6 * 60000;         // a 'generating' row silent for longer lost its worker (same lease dailyBrief.js reclaims at)
const BRIEF_DEADLINE_HOUR_KST = 10;       // dailyBrief.js generates by now even if collection is unfinished
const MAX_AUTO_DAILY_ATTEMPTS = 20;
const MOST_SOURCES_FAILED = 0.5;          // half or more of the sources failing is an outage, not a quiet day

const kst = (ms) => new Date(ms + KST_MS);
const minutesOfDayKst = (ms) => kst(ms).getUTCHours() * 60 + kst(ms).getUTCMinutes();
const ms = (v) => (v ? new Date(v).getTime() : null);
const mins = (a, b) => Math.round((a - b) / 60000);
const check = (id, status, detail) => ({ id, status, detail });

function discoveryChecks(d, now) {
  const hour = kst(now).getUTCHours();
  const out = [];
  if (!d) return [check('discovery', 'unknown', 'no discovery status available')];
  if (d.state === 'completed') {
    out.push(check('discovery_run', 'pass', `completed ${d.completedAt ? new Date(d.completedAt).toISOString() : ''}`.trim()));
    if (!d.totals) {
      out.push(check('discovery_output', 'unknown', 'collection is marked complete but its totals were not recorded (cannot tell a valid zero-item run from a failed one)'));
      return out;
    }
    const t = d.totals;
    const total = d.progress && d.progress.total;
    const failedSources = Array.isArray(d.failedSources) ? d.failedSources.length : Number(t.failedSources) || 0;
    const discovered = Number(t.discovered) || 0;
    const mostFailed = total ? failedSources / total >= MOST_SOURCES_FAILED : false;
    if (mostFailed && !discovered) out.push(check('discovery_output', 'fail', `${failedSources}/${total} sources failed and nothing was discovered`));
    else if (mostFailed) out.push(check('discovery_output', 'warn', `${failedSources}/${total} sources failed (discovered ${discovered})`));
    else if (!discovered) out.push(check('discovery_output', 'pass', `valid zero-item run: ${failedSources}${total ? `/${total}` : ''} sources failed, nothing new was discovered`));
    else out.push(check('discovery_output', 'pass', `discovered ${discovered}, archived ${t.archived || 0}, ${failedSources} source(s) failed`));
    return out;
  }
  if (d.state === 'running') {
    const progress = d.progress ? ` ${d.progress.done}/${d.progress.total}` : '';
    // still collecting after the headline's own generation deadline: working, but far later than the morning target
    out.push(hour >= BRIEF_DEADLINE_HOUR_KST ? check('discovery_run', 'warn', `still in progress${progress} past ${BRIEF_DEADLINE_HOUR_KST}:00 KST`) : check('discovery_run', 'pass', `in progress${progress}`));
    return out;
  }
  if (d.state === 'stalled') {
    if (d.progress) out.push(check('discovery_run', 'fail', `stalled at ${d.progress.done}/${d.progress.total}, last progress ${d.lastProgressAt || 'unknown'}`));
    else out.push(check('discovery_run', 'fail', `no run started by ${String(DISCOVERY_START_HOUR_KST).padStart(2, '0')}:00 KST (missing scheduled run)`));
    return out;
  }
  // 'waiting'
  out.push(check('discovery_run', hour >= DISCOVERY_START_HOUR_KST ? 'fail' : 'pass', hour >= DISCOVERY_START_HOUR_KST ? 'no run started (missing scheduled run)' : 'not due yet'));
  return out;
}

function headlineCheck(input, discovery, now) {
  const { brief, evidenceCandidates, attemptsToday } = input;
  const hour = kst(now).getUTCHours();
  const completedAt = discovery && discovery.completedAt ? ms(discovery.completedAt) : null;
  if (!brief) {
    if (completedAt && now - completedAt > BRIEF_MISSING_GRACE_MS) return check('headline', 'fail', `no headline row ${mins(now, completedAt)} min after collection completed (missing)`);
    if (completedAt) return check('headline', 'pass', 'collection just completed; headline not started yet (within grace)');
    if (hour >= BRIEF_DEADLINE_HOUR_KST) return check('headline', 'fail', `no headline row past ${BRIEF_DEADLINE_HOUR_KST}:00 KST (missing)`);
    return check('headline', 'pass', 'waiting for collection');
  }
  const attempts = Number(brief.attempt_count) || 0;
  const errorBit = brief.error ? `, last error: ${String(brief.error).slice(0, 120)}` : '';
  if (brief.status === 'ready' || brief.status === 'empty') {
    const items = Number(brief.item_count) || 0;
    if (items === 0) {
      if (evidenceCandidates === null || evidenceCandidates === undefined) return check('headline', 'unknown', 'empty headline and the number of eligible items is unknown');
      if (evidenceCandidates > 0) return check('headline', 'fail', `empty headline although ${evidenceCandidates} eligible item(s) exist`);
      return check('headline', 'pass', 'valid zero-item headline: no eligible item today');
    }
    const doneAt = ms(brief.completed_at);
    const lateMin = doneAt ? minutesOfDayKst(doneAt) - BRIEF_TARGET_MINUTES_KST : 0;
    if (doneAt && kst(doneAt).toISOString().slice(0, 10) === kst(now).toISOString().slice(0, 10) && lateMin > 0) {
      return check('headline', 'warn', `ready with ${items} item(s) but ${lateMin} min after the 09:00 KST target (attempts ${attempts})`);
    }
    return check('headline', 'pass', `ready with ${items} item(s), attempts ${attempts}`);
  }
  if (brief.status === 'generating') {
    const updated = ms(brief.updated_at);
    if (updated && now - updated > BRIEF_LEASE_MS) return check('headline', 'fail', `stuck: generating but no update for ${mins(now, updated)} min (non-terminal, worker lost)${errorBit}`);
    return check('headline', 'pass', `generating (attempt ${attempts}), updated ${updated ? mins(now, updated) : '?'} min ago`);
  }
  if (brief.status === 'failed') {
    const exhausted = attempts >= MAX_AUTO_DAILY_ATTEMPTS;
    return check('headline', 'fail', `failed after ${attempts} attempt(s)${exhausted ? ' (automatic limit reached: needs a person)' : ' (waiting for the next trigger to retry)'}${errorBit}${attemptsToday ? `, ${attemptsToday.count} failure(s) logged` : ''}`);
  }
  return check('headline', 'warn', `unexpected headline status "${brief.status}"`);
}

// One row per trigger verdict. With incidents: one row each (missed = warn, telemetry gaps = unknown). With none: a single PASS row that shows
// the evidence it rests on (latest call and today's count per trigger), so a healthy trigger is visible instead of silent.
function triggerCheck(input, now) {
  if (input.heartbeat === undefined) return [];
  const incidents = triggerIncidents(input.heartbeat, { now });
  if (incidents.length) return incidents.map((i) => check(`trigger_${i.kind}`, i.kind === 'missed' ? 'warn' : 'unknown', i.text));
  const hb = input.heartbeat || {};
  const today = ((hb.days || {})[kst(now).toISOString().slice(0, 10)]) || {};
  const parts = ['github', 'vercel'].map((name) => {
    const last = hb.last && hb.last[name];
    const n = today[name] && today[name].n;
    return last ? `${name} last ${last} (${n || 0} call(s) today)` : `${name} no call recorded`;
  });
  return [check('trigger', 'pass', `scheduler triggers on time: ${parts.join('; ')}`)];
}

function recoveryCheck(input, now) {
  const events = Array.isArray(input.trace) ? input.trace : null;
  if (events === null) return [check('recovery', 'unknown', 'no pipeline_trace available')];
  const since = now - 24 * 3600000;
  const recent = events.filter((e) => !e.at || new Date(e.at).getTime() >= since);
  const kicks = recent.filter((e) => e.kind === 'self_heal_kick').length;
  const gaveUp = recent.filter((e) => e.kind === 'cron_call' && /gave_up/.test(String(e.chained || ''))).length;
  const timeouts = recent.filter((e) => e.kind === 'source_timeout').length;
  const notes = [];
  if (kicks) notes.push(`${kicks} self-heal kick(s)`);
  if (gaveUp) notes.push(`${gaveUp} failed continuation hand-off(s)`);
  if (timeouts) notes.push(`${timeouts} source timeout(s)`);
  return [check('recovery', notes.length ? 'warn' : 'pass', notes.length ? `recovery was needed in the last 24 h: ${notes.join(', ')}` : 'no recovery events in the last 24 h')];
}

function evaluateHealth(input, now = Date.now()) {
  const checks = [
    ...discoveryChecks(input.discovery, now),
    headlineCheck(input, input.discovery, now),
    ...triggerCheck(input, now),
    ...recoveryCheck(input, now),
  ];
  const has = (s) => checks.some((c) => c.status === s);
  const status = has('fail') ? 'failed' : has('warn') ? 'warn' : has('unknown') ? 'unknown' : 'ok';
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', unknown: 'UNKNOWN' };
  const failing = checks.filter((c) => c.status === 'fail');
  const headline = status === 'ok' ? 'Pipeline healthy: scheduled run and headline are complete.'
    : status === 'failed' ? `Pipeline FAILED: ${failing.map((c) => c.id).join(', ')}.`
    : status === 'warn' ? 'Pipeline completed with warnings.'
    : 'Pipeline health could not be fully determined (missing telemetry).';
  const summary = [headline, '', ...checks.map((c) => `- [${icon[c.status]}] ${c.id}: ${c.detail}`)].join('\n');
  return { status, checkedAt: new Date(now).toISOString(), kstDate: kst(now).toISOString().slice(0, 10), checks, summary };
}

// The only database access: read-only SELECTs. Any piece that cannot be read is left undefined/null so the evaluation reports "unknown"
// for it instead of guessing.
async function collectHealthInput(now = new Date()) {
  const pool = require('../db/pool');
  const dailyDiscovery = require('./dailyDiscovery');
  const dailyBrief = require('./dailyBrief');
  const date = dailyBrief.kstDate(now);
  const input = {};
  const safe = async (fn, fallback) => { try { return await fn(); } catch (err) { console.error('pipeline health read failed:', err.message); return fallback; } };
  input.discovery = await safe(() => dailyDiscovery.getDailyDiscoveryStatus(now), null);
  input.brief = await safe(async () => (await pool.query('SELECT status, attempt_count, error, updated_at, completed_at, item_count FROM daily_briefs WHERE brief_date = $1', [date])).rows[0] || null, undefined);
  if (input.brief === undefined) { input.brief = null; input.briefUnreadable = true; }
  input.evidenceCandidates = await safe(() => dailyBrief.countEvidenceCandidates(date), null);
  input.attemptsToday = await safe(async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS count, max(created_at) AS last_at FROM daily_brief_attempts WHERE brief_date = $1', [date]);
    return rows[0];
  }, null);
  const job = async (name) => (await pool.query('SELECT last_totals FROM scheduler_jobs WHERE job_name = $1', [name])).rows[0];
  input.trace = await safe(async () => { const r = await job('pipeline_trace'); return (r && r.last_totals && r.last_totals.events) || []; }, null);
  input.heartbeat = await safe(async () => { const r = await job('trigger_heartbeat'); return r ? r.last_totals : null; }, undefined);
  return input;
}

async function runHealthCheck(now = new Date()) {
  const input = await collectHealthInput(now);
  if (input.briefUnreadable) {
    const result = evaluateHealth({ ...input, brief: null }, now.getTime());
    result.checks.push(check('headline_read', 'unknown', 'daily_briefs could not be read'));
    result.status = result.status === 'failed' ? 'failed' : 'unknown';
    return result;
  }
  return evaluateHealth(input, now.getTime());
}

module.exports = { evaluateHealth, collectHealthInput, runHealthCheck, BRIEF_LEASE_MS, MAX_AUTO_DAILY_ATTEMPTS };
