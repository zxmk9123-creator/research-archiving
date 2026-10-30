// PIPELINE DOCTOR: turns a WARN/FAIL health verdict into (1) a diagnosis with evidence, (2) a recovery decision, (3) at most one bounded,
// already-safe recovery round, (4) a re-check, and (5) a stored report. It builds on pipelineHealth.js and reuses the pipeline's OWN recovery
// paths; it adds no new way to collect, publish or write data.
//
// Classification of every finding:
//   retryable         transient / known failure whose retry is part of the normal path (e.g. headline generation after a bad model answer)
//   auto_recoverable  a stuck state the pipeline already knows how to restart (stalled collection chain, headline worker lost)
//   needs_human       cause unclear, outage, data-changing remedy, external scheduler, or retries exhausted. NEVER acted on.
// Only the two executors below can run, and only in mode "recover" with DOCTOR_RECOVERY=on. Diagnosis (default) is read-only.
//
// Limits (stored in scheduler_jobs 'ops_doctor', atomically): one run at a time (lease), at most MAX_ROUNDS_PER_DAY recovery rounds per KST
// day, at most MAX_ATTEMPTS_PER_KEY per problem per day with a cooldown, and a problem that a recovery did not resolve is not retried again.
const { evaluateHealth, collectHealthInput } = require('./pipelineHealth');
const { mutateJobState } = require('./jobState');

const JOB = 'ops_doctor';
const LOCK_MS = 8 * 60000;
const COOLDOWN_MS = 10 * 60000;
const MAX_ROUNDS_PER_DAY = 3;
const MAX_ATTEMPTS_PER_KEY = 2;
const COOLDOWN_BY_CAUSE = { db_pool_contention: 3 * COOLDOWN_MS }; // give a saturated database time to drain before asking it for more
const MAX_UNRESOLVED_PER_KEY = 1;     // a recovery that did not fix it is not repeated
const EXECUTOR_TIMEOUT_MS = 200000;
const RUN_BUDGET_MS = 250000;        // the whole run (diagnosis, actions, re-check, report) must fit the ~300 s function limit
const MIN_ACTION_MS = 30000;         // do not start an action with less time than this left
const RECHECK_RESERVE_MS = 15000;
const KEEP_REPORTS = 20;
const KST_MS = 9 * 3600000;
const kstDay = (ms) => new Date(ms + KST_MS).toISOString().slice(0, 10);

const ACTIONS = {
  kick_pipeline: 'restart the stalled collection chain through the existing self-heal kick (cursor-resumed, claimed once per 4 min)',
  retry_headline: 'ask the existing headline guard for one more generation attempt (atomic claim, daily attempt cap, no overwrite of a ready headline)',
};

const finding = (checkId, cause, confidence, classification, evidence, extra = {}) => ({
  checkId, cause, confidence, classification, humanUrgency: extra.humanUrgency || (classification === 'needs_human' ? 'now' : 'none'),
  evidence, action: extra.action || null, key: `${checkId}:${cause}`,
});

// Only the cause part counts: the stored error carries the start of the model's answer after " | head=", which is free text and must not steer
// the classification ("network" or "503" inside an answer is not a network failure).
const errorKind = (text) => {
  const t = String(text || '').replace(/ \| head=[^]*$/, '');
  if (/No AI provider/i.test(t)) return 'unknown'; // a configuration problem, not a transient one
  if (/brief_placeholder_output|brief_truncated_by_max_tokens|invalid_brief_json|not valid JSON|Unexpected token|incomplete_brief|meta_phrase_in_summary|headline_lead_too_long|unexpected_non_korean_script/.test(t)) return 'model_output_invalid';
  if (/retry_deferred/.test(t)) return 'insufficient_invocation_time';
  // our own database being saturated is not the model's fault, and retrying into it makes it worse: its own cause, its own (longer) cooldown
  if (/timeout exceeded when trying to connect|too many clients|remaining connection slots|connection terminated|pool is (?:full|exhausted)/i.test(t)) return 'db_pool_contention';
  // a rejected key / exhausted quota does not heal by retrying; every retry would only burn another key
  if (/\b(401|402|403)\b|insufficient_quota|exceeded your current quota|invalid api key|unauthorized|forbidden/i.test(t)) return 'provider_unavailable';
  if (/timed? ?out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|overloaded|rate.?limit|\b(429|500|502|503|504|520|521|522|523|524)\b|AI provider/i.test(t)) return 'ai_provider_transient';
  return 'unknown';
};

// Pure. ctx = the health input (discovery, brief, trace, heartbeat, ...) plus attempts [{error, created_at}] and providers (provider_health doc).
function diagnose(health, ctx, now = Date.now()) {
  const out = [];
  const trace = Array.isArray(ctx.trace) ? ctx.trace : [];
  const recentTrace = trace.filter((e) => !e.at || now - new Date(e.at).getTime() < 24 * 3600000);
  const attempts = Array.isArray(ctx.attempts) ? ctx.attempts : [];
  const lastErrors = attempts.slice(-3).map((a) => String(a.error || '').slice(0, 160));
  for (const c of health.checks) {
    if (c.status !== 'warn' && c.status !== 'fail') continue;
    const ev = [`health ${c.id}: ${c.detail}`];
    if (c.id === 'discovery_run' && c.status === 'fail') {
      const gaveUp = recentTrace.filter((e) => e.kind === 'cron_call' && /gave_up/.test(String(e.chained || ''))).length;
      if (/missing scheduled run/.test(c.detail)) {
        const hbToday = ctx.heartbeat && ctx.heartbeat.days && ctx.heartbeat.days[kstDay(now)];
        ev.push(hbToday ? `trigger calls today: ${JSON.stringify(Object.fromEntries(Object.entries(hbToday).map(([k, v]) => [k, v.n])))}` : 'no trigger call recorded today');
        out.push(finding(c.id, 'run_not_started', 'likely', 'auto_recoverable', ev, { action: 'kick_pipeline' }));
      } else {
        if (gaveUp) ev.push(`${gaveUp} continuation hand-off(s) gave up in the last 24 h`);
        out.push(finding(c.id, 'continuation_lost', gaveUp ? 'likely' : 'unknown', 'auto_recoverable', ev, { action: 'kick_pipeline' }));
      }
    } else if (c.id === 'discovery_run') {
      out.push(finding(c.id, 'slow_collection', 'confirmed', 'needs_human', ev, { humanUrgency: 'review' }));
    } else if (c.id === 'discovery_output') {
      const p = ctx.providers && ctx.providers.days && ctx.providers.days[kstDay(now)];
      const parked = ctx.providers && ctx.providers.parked ? Object.keys(ctx.providers.parked).filter((k) => ctx.providers.parked[k].until > now) : [];
      if (p) ev.push(`search providers today: ${JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { requests: v.requests, success: v.success }])))}`);
      if (parked.length) ev.push(`${parked.length} provider key(s) parked (cooling down)`);
      out.push(finding(c.id, 'collection_outage', p || parked.length ? 'likely' : 'unknown', 'needs_human', ev, { humanUrgency: c.status === 'fail' ? 'now' : 'review' }));
    } else if (c.id === 'headline') {
      if (lastErrors.length) ev.push(`last attempt errors: ${lastErrors.join(' | ')}`);
      if (/automatic limit reached/.test(c.detail)) out.push(finding(c.id, 'attempt_cap_reached', 'confirmed', 'needs_human', ev));
      else if (/stuck: generating/.test(c.detail)) out.push(finding(c.id, 'worker_lost', 'likely', 'auto_recoverable', ev, { action: 'retry_headline' }));
      else if (/failed after/.test(c.detail)) {
        const kind = [ctx.brief && ctx.brief.error, lastErrors[lastErrors.length - 1]].map(errorKind).find((k) => k !== 'unknown') || 'unknown';
        if (kind === 'unknown') out.push(finding(c.id, 'unknown_generation_error', 'unknown', 'needs_human', ev));
        else if (kind === 'provider_unavailable') out.push(finding(c.id, kind, 'likely', 'needs_human', ev)); // key/quota problem: a person must fix it
        else out.push(finding(c.id, kind, kind === 'ai_provider_transient' || kind === 'db_pool_contention' ? 'likely' : 'confirmed', 'retryable', ev, { action: 'retry_headline' }));
      } else if (/missing/.test(c.detail)) {
        if (ctx.discovery && ctx.discovery.completedToday) out.push(finding(c.id, 'generation_not_started', 'likely', 'retryable', ev, { action: 'retry_headline' }));
        else out.push(finding(c.id, 'headline_missing_before_collection_done', 'unknown', 'needs_human', ev));
      } else if (/empty headline although/.test(c.detail)) out.push(finding(c.id, 'brief_inconsistent', 'confirmed', 'needs_human', ev));
      else if (/after the 09:00 KST target/.test(c.detail)) out.push(finding(c.id, 'late_completion', 'confirmed', 'needs_human', ev, { humanUrgency: 'review' }));
      else out.push(finding(c.id, 'unrecognised_headline_state', 'unknown', 'needs_human', ev));
    } else if (c.id === 'trigger_missed') {
      out.push(finding(c.id, 'scheduler_trigger_missed', 'confirmed', 'needs_human', ev, { humanUrgency: 'review' }));
    } else if (c.id === 'recovery') {
      out.push(finding(c.id, 'recoveries_occurred', 'confirmed', 'needs_human', ev, { humanUrgency: 'review' }));
    } else {
      out.push(finding(c.id, 'unrecognised', 'unknown', 'needs_human', ev));
    }
  }
  return out;
}

// Pure. Decides what may run NOW. doc = the stored ops_doctor state.
function planRecovery(findings, doc, { now = Date.now(), mode = 'diagnose', recoveryEnabled = false } = {}) {
  const plan = { actions: [], skipped: [] };
  const day = (doc && doc.days && doc.days[kstDay(now)]) || {};
  const byKey = day.byKey || {};
  const candidates = findings.filter((f) => f.action && (f.classification === 'retryable' || f.classification === 'auto_recoverable'));
  if (!candidates.length) return plan;
  if (mode !== 'recover') { for (const f of candidates) plan.skipped.push({ key: f.key, reason: 'diagnose_mode' }); return plan; }
  if (!recoveryEnabled) { for (const f of candidates) plan.skipped.push({ key: f.key, reason: 'recovery_disabled (set DOCTOR_RECOVERY=on to allow)' }); return plan; }
  if ((day.rounds || 0) >= MAX_ROUNDS_PER_DAY) { for (const f of candidates) plan.skipped.push({ key: f.key, reason: 'daily_round_limit' }); return plan; }
  const seenActions = new Set();
  for (const f of candidates) {
    const st = byKey[f.key] || {};
    if ((st.unresolved || 0) >= MAX_UNRESOLVED_PER_KEY) plan.skipped.push({ key: f.key, reason: 'recovery_already_failed_for_this_problem' });
    else if ((st.count || 0) >= MAX_ATTEMPTS_PER_KEY) plan.skipped.push({ key: f.key, reason: 'attempt_limit_for_this_problem' });
    else if (st.lastAt && now - st.lastAt < (COOLDOWN_BY_CAUSE[f.cause] || COOLDOWN_MS)) plan.skipped.push({ key: f.key, reason: 'cooldown' });
    else if (seenActions.has(f.action)) plan.skipped.push({ key: f.key, reason: 'same_action_already_planned' });
    else { seenActions.add(f.action); plan.actions.push({ action: f.action, key: f.key, why: f.cause, does: ACTIONS[f.action] }); }
  }
  return plan;
}

const SECRET_RE = /((?:api[_-]?key|token|secret|password|authorization|x-subscription-token)["'\s:=]+[^\s"',;&]{6,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{10,}|tvly-[A-Za-z0-9_-]{8,}|BSA[A-Za-z0-9_-]{16,}|postgres(?:ql)?:\/\/\S+|[A-Fa-f0-9]{40,})/g;
const scrub = (value) => JSON.parse(String(JSON.stringify(value)).replace(SECRET_RE, '[redacted]'));

const failing = (h) => h.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => `${c.id}:${c.status}`);
const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('executor_timeout')), ms); })]).finally(() => clearTimeout(t)); };

// Pure. Compares the verdict before and after a recovery round.
function judgeOutcome(before, after, ran) {
  const b = new Set(failing(before));
  const a = failing(after);
  const worse = a.some((x) => !b.has(x) && x.endsWith(':fail'));
  if (worse) return 'unresolved';
  const hasFail = a.some((x) => x.endsWith(':fail'));
  const kicked = ran.some((r) => r.action === 'kick_pipeline' && r.result && r.result.kicked);
  const stillRunning = after.checks.some((c) => c.id === 'discovery_run' && c.status === 'pass' && /in progress/.test(c.detail));
  // a restarted collection is only "improving" until it has actually completed
  if (!hasFail && kicked && stillRunning) return 'improving';
  const generating = after.checks.some((c) => c.id === 'headline' && c.status === 'pass' && /^generating/.test(c.detail));
  if (!hasFail && generating) return 'improving'; // the new attempt is under way; only a ready headline counts as recovered
  // a check that FAILED before and is only downgraded while its work is still running (fail -> warn "still in progress past 10:00") is progress, not a fix.
  // A finished-but-late result ("ready, 60 min after the target") is done: that warning is permanent information, not pending work
  const failedIds = before.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  if (!hasFail && after.checks.some((c) => failedIds.includes(c.id) && c.status !== 'pass' && /in progress|generating|still running/i.test(c.detail))) return 'improving';
  if (after.status === 'ok' || !hasFail) return 'recovered'; // no failure left (informational warnings, e.g. a late headline, may remain)
  const fixed = [...b].filter((x) => x.endsWith(':fail') && !a.includes(x));
  return fixed.length ? 'improving' : 'unresolved';
}

async function collectContext(now) {
  const pool = require('../db/pool');
  const input = await collectHealthInput(now);
  const safe = async (fn, fb) => { try { return await fn(); } catch (err) { console.error('doctor read failed:', err.message); return fb; } };
  input.attempts = await safe(async () => (await pool.query("SELECT error, created_at FROM daily_brief_attempts WHERE brief_date = $1 ORDER BY created_at DESC LIMIT 5", [require('./dailyBrief').kstDate(now)])).rows.reverse(), []);
  input.providers = await safe(async () => { const r = (await pool.query("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'provider_health'")).rows[0]; return r ? r.last_totals : null; }, null);
  return input;
}

// Runs before the lease is taken (so a refused round costs no attempt): is our own database in a state to take more work?
async function dbPreflight() {
  const pool = require('../db/pool');
  if (pool.waitingCount > 0) return { ok: false, reason: 'pool_saturated' };
  let t;
  try {
    await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('slow')), 5000); })]);
    return { ok: true };
  } catch (err) { return { ok: false, reason: `db_unhealthy: ${String(err && err.message).slice(0, 80)}` }; } finally { clearTimeout(t); }
}

const defaultExecutors = {
  // Both executors receive { deadlineAt (wall-clock ms), now (the doctor's own moment) }. The decision to act and the action must be judged at the
  // SAME moment: a kick diagnosed at 11:59 must not be refused because the window closed at 12:00 while the doctor was running.
  async kick_pipeline({ now } = {}) {
    const r = await require('./pipelineGuardian').maybeKickStalledPipeline({ now: now || new Date() });
    await new Promise((resolve) => setTimeout(resolve, 15000)); // let the started hop take its lease before the re-check
    return r;
  },
  async retry_headline({ deadlineAt, now } = {}) {
    const dailyBrief = require('./dailyBrief');
    const at = now || new Date();
    const status = await require('./dailyDiscovery').getDailyDiscoveryStatus(at);
    const deadline = deadlineAt || Date.now() + 200000;
    const r = await dailyBrief.runWithDeadline(deadline, () => dailyBrief.ensureDailyBrief(at, { discoveryDone: status.completedToday }));
    const stillRunning = await require('./background').drain(Math.max(1000, deadline - Date.now() - 5000)); // the generation runs in the background: wait for it
    return { ...r, stillRunning }; // > 0: the generation outlived our wait — in progress, not finished
  },
};

// The orchestrator. Everything external is injectable so each situation can be tested without a database or network.
async function runDoctor({
  mode = 'diagnose', recoveryEnabled = process.env.DOCTOR_RECOVERY === 'on', now = new Date(),
  gather = collectContext, executors = defaultExecutors, store = null, preflight = store ? async () => ({ ok: true }) : dbPreflight, executorTimeoutMs = EXECUTOR_TIMEOUT_MS, clock = () => Date.now(),
} = {}) {
  const startedAt = new Date().toISOString();
  const t0 = now.getTime();
  const report = { startedAt, mode, recoveryEnabled, outcome: null, humanNeeded: false, before: null, findings: [], plan: null, actions: [], after: null, summary: '' };
  const st = store || {
    read: async () => (await require('../db/pool').query("SELECT last_totals FROM scheduler_jobs WHERE job_name = $1", [JOB])).rows[0]?.last_totals || {},
    mutate: (fn) => mutateJobState(JOB, fn),
  };
  const runEnd = clock() + RUN_BUDGET_MS;
  const day = kstDay(t0);
  const lockId = `${t0}-${Math.random().toString(36).slice(2, 8)}`;

  // read-only part
  const ctx = await gather(now);
  const before = evaluateHealth(ctx, t0);
  report.before = { status: before.status, failing: failing(before), summary: before.summary };
  report.findings = diagnose(before, ctx, t0);
  report.humanNeeded = report.findings.some((f) => f.classification === 'needs_human' && f.humanUrgency === 'now');

  let doc = {};
  try { doc = await st.read(); } catch (err) { console.error('doctor state read failed:', err.message); }
  report.plan = planRecovery(report.findings, doc, { now: t0, mode, recoveryEnabled });

  if (before.status === 'ok' || (before.status === 'unknown' && !report.findings.length)) {
    // a PASS that only says "generating"/"in progress" is work under way, not a confirmed healthy pipeline
    const underway = before.checks.some((c) => c.status === 'pass' && /^generating|in progress/.test(c.detail));
    report.outcome = before.status === 'ok' ? (underway ? 'in_progress' : 'healthy') : 'no_action';
  } else if (!report.plan.actions.length) {
    const reasons = report.plan.skipped.map((s) => s.reason);
    report.outcome = reasons.includes('daily_round_limit') || reasons.some((r) => /already_failed|attempt_limit/.test(r)) ? 'limit_reached'
      : reasons.some((r) => /recovery_disabled|diagnose_mode/.test(r)) ? 'recovery_not_permitted'
      : report.humanNeeded ? 'needs_human'
      : report.findings.some((f) => f.classification === 'needs_human') ? 'review_only' : 'no_action';
    // the automatic way out is used up (or was tried and failed) while the pipeline is still failing: a person has to take over
    if (report.outcome === 'limit_reached' && report.before.failing.some((x) => x.endsWith(':fail'))) report.humanNeeded = true;
  } else if (!(report.preflight = await preflight().catch((err) => ({ ok: false, reason: String(err && err.message).slice(0, 80) }))).ok) {
    // nothing was claimed or counted: the next round simply tries again once the database has recovered
    report.outcome = 'deferred_db_unhealthy';
  } else {
    // take the lease: one doctor at a time
    let acquired = false;
    const persisted = await st.mutate((d) => {
      acquired = false; // this function may be re-applied on a newer document: decide again every time
      if (d.lock && d.lock.until > t0 && d.lock.id !== lockId) return undefined;
      acquired = true;
      d.lock = { id: lockId, until: t0 + LOCK_MS };
      const dd = (d.days = d.days || {})[day] || (d.days[day] = {});
      dd.rounds = (dd.rounds || 0) + 1;
      for (const a of report.plan.actions) { const k = (dd.byKey = dd.byKey || {})[a.key] || (dd.byKey[a.key] = {}); k.count = (k.count || 0) + 1; k.lastAt = t0; }
      for (const k of Object.keys(d.days).sort().slice(0, -5)) delete d.days[k];
      return d;
    });
    // the lease and the attempt counters must really be stored before anything is executed: an unstored lease protects nothing
    if (!persisted) { acquired = false; report.outcome = 'state_unavailable'; report.humanNeeded = true; }
    else if (!acquired) {
      report.outcome = 'locked';
    } else {
      for (const a of report.plan.actions) {
        const began = clock();
        const left = runEnd - began - RECHECK_RESERVE_MS;
        if (left < MIN_ACTION_MS) { report.actions.push({ action: a.action, key: a.key, why: a.why, error: 'skipped_no_time_left', ms: 0 }); continue; }
        try {
          const budget = Math.min(executorTimeoutMs, left);
          // deadlineAt is a real wall-clock instant (the executors wait on real I/O); the doctor's clock only does the accounting
          const result = await withTimeout(executors[a.action]({ deadlineAt: Date.now() + budget, now: new Date(began) }), budget);
          report.actions.push({ action: a.action, key: a.key, why: a.why, result, ms: clock() - began });
        } catch (err) {
          report.actions.push({ action: a.action, key: a.key, why: a.why, error: String(err && err.message).slice(0, 160), ms: clock() - began });
        }
      }
      // re-check with fresh data, exactly the same check
      const afterNow = clock();
      const afterCtx = await gather(new Date(afterNow));
      const after = evaluateHealth(afterCtx, afterNow);
      report.after = { status: after.status, failing: failing(after), summary: after.summary };
      // an action that threw or timed out may have partly run: it counts as attempted. Only explicit no-ops and never-started actions do not.
      const applied = report.actions.some((x) => x.error !== 'skipped_no_time_left' && !(x.result && (x.result.kicked === false || x.result.ran === false)));
      report.outcome = applied ? judgeOutcome(before, after, report.actions) : (after.status === 'ok' ? 'recovered' : 'not_applied');
      report.afterFindings = diagnose(after, afterCtx, afterNow);
      // "improving" means the work is still under way: it is not a success yet and the next health run has to confirm it
      report.stillRunning = report.outcome === 'improving';
      if (report.outcome === 'unresolved' || report.outcome === 'not_applied') report.humanNeeded = true;
      await st.mutate((d) => {
        const dd = ((d.days = d.days || {})[day] = d.days[day] || {});
        for (const a of report.actions) { const k = ((dd.byKey = dd.byKey || {})[a.key] = dd.byKey[a.key] || {}); k.lastResult = report.outcome; if (report.outcome === 'unresolved') k.unresolved = (k.unresolved || 0) + 1; }
        return d;
      });
    }
  }
  if (!report.after) report.after = null;

  const lines = [
    `Doctor (${mode}${mode === 'recover' && !recoveryEnabled ? ', recovery disabled' : ''}): ${report.outcome}${report.humanNeeded ? ' — HUMAN NEEDED' : ''}`,
    `before: ${report.before.status} [${report.before.failing.join(', ') || 'none'}]`,
    ...report.findings.map((f) => `- ${f.checkId} → ${f.cause} (${f.confidence}) = ${f.classification}${f.humanUrgency !== 'none' ? `/${f.humanUrgency}` : ''}${f.action ? `, action ${f.action}` : ''}\n    ${f.evidence.join('\n    ')}`),
    ...report.plan.skipped.map((s) => `- not run: ${s.key} (${s.reason})`),
    ...report.actions.map((a) => `- ran ${a.action}: ${a.error ? `error ${a.error}` : JSON.stringify(a.result)}`),
  ];
  if (report.stillRunning) lines.push('- still running or only partly fixed: NOT yet confirmed fixed (only the next health run reporting PASS decides)');
  if (report.preflight && !report.preflight.ok) lines.push(`- deferred: database not ready (${report.preflight.reason}); nothing was started or counted`);
  if (report.after) lines.push(`after: ${report.after.status} [${report.after.failing.join(', ') || 'none'}]`);
  report.summary = lines.join('\n');
  report.finishedAt = new Date().toISOString();

  const safeReport = scrub(report);
  try {
    await st.mutate((d) => {
      d.reports = [...(d.reports || []), { at: safeReport.finishedAt, mode, outcome: safeReport.outcome, humanNeeded: safeReport.humanNeeded, before: safeReport.before.failing, after: safeReport.after && safeReport.after.failing, findings: safeReport.findings.map((f) => ({ key: f.key, classification: f.classification, confidence: f.confidence })), actions: safeReport.actions.map((a) => ({ action: a.action, error: a.error || null })) }].slice(-KEEP_REPORTS);
      if (d.lock && d.lock.id === lockId) d.lock = { id: null, until: 0 };
      return d;
    });
  } catch (err) { console.error('doctor report store failed:', err.message); }
  return safeReport;
}

module.exports = { dbPreflight, collectContext, defaultExecutors, ACTIONS, runDoctor, diagnose, planRecovery, judgeOutcome, scrub, errorKind, MAX_ROUNDS_PER_DAY, MAX_ATTEMPTS_PER_KEY, COOLDOWN_MS };
