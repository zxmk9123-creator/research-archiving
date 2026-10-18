// DAILY ENTITY MAINTENANCE. New companies join the registry the moment their item is published (registerNames); this job settles
// what cannot be decided there: Hangul / English spellings, role of the new names, and stored relations whose names changed.
// Runs once every 3 days (KST calendar days) at or after 09:00 KST (claimed in scheduler_jobs, so a redeploy cannot run it twice); a failed step is recorded
// and the other steps still run; the result of the last run is kept in scheduler_jobs.last_totals.
const pool = require('../db/pool');
const { kstPartsOf } = require('./dailyDiscovery');

const JOB_NAME = 'entity_maintenance';
const INTERVAL_DAYS = 3;
const RUN_HOUR_KST = 9;
let running = false;

async function step(name, fn, out) {
  const t0 = Date.now();
  try {
    out.steps[name] = { ok: true, ms: 0, ...(await fn()) };
  } catch (err) {
    out.steps[name] = { ok: false, error: String(err.message).slice(0, 200) };
    out.errors.push(`${name}: ${String(err.message).slice(0, 120)}`);
    console.error(`entity maintenance step ${name} failed: ${err.message}`);
  }
  if (out.steps[name]) out.steps[name].ms = Date.now() - t0;
}

async function runMaintenance() {
  if (running) return { ran: false, reason: 'already_running' };
  running = true;
  const reg = require('./entityRegistry');
  const rel = require('./companyRelations');
  const out = { startedAt: new Date().toISOString(), steps: {}, errors: [] };
  try {
    await step('learn_bilingual', () => reg.learnBilingual({ limit: 120 }), out);
    await step('rebuild', () => reg.rebuild(), out);
    await step('classify_new_roles', () => reg.reclassifyRoles({ onlyNull: true, limit: 300 }), out);
    await step('relations_cleanup', () => rel.cleanupRelations(), out);
    await step('rebuild_after_cleanup', () => reg.rebuild(), out);
    out.finishedAt = new Date().toISOString();
    return { ran: true, ...out };
  } finally {
    running = false;
  }
}

async function maybeRunEntityMaintenance(now = new Date()) {
  if (process.env.ENTITY_MAINTENANCE === 'off') return { ran: false, reason: 'off' };
  const { date, hour } = kstPartsOf(now);
  if (hour < RUN_HOUR_KST) return { ran: false, reason: 'not_due' };
  // claimed only when the last claimed run is at least INTERVAL_DAYS KST days old (or there is none)
  const { rowCount } = await pool.query(
    `INSERT INTO scheduler_jobs (job_name, last_run_date) VALUES ($1, $2::date)
     ON CONFLICT (job_name) DO UPDATE SET last_run_date = $2::date
     WHERE scheduler_jobs.last_run_date IS NULL OR scheduler_jobs.last_run_date <= ($2::date - $3::int)`,
    [JOB_NAME, date, INTERVAL_DAYS]
  );
  if (!rowCount) return { ran: false, reason: 'ran_within_last_3_days' };
  try {
    const result = await runMaintenance();
    if (!result.ran) { await pool.query('UPDATE scheduler_jobs SET last_run_date = NULL WHERE job_name = $1', [JOB_NAME]); return result; }
    await pool.query('UPDATE scheduler_jobs SET last_completed_at = now(), last_totals = $2 WHERE job_name = $1', [JOB_NAME, JSON.stringify(result)]);
    return result;
  } catch (err) {
    await pool.query('UPDATE scheduler_jobs SET last_run_date = NULL WHERE job_name = $1', [JOB_NAME]).catch(() => {});
    throw err;
  }
}

async function getMaintenanceStatus() {
  const { rows } = await pool.query('SELECT last_run_date, last_completed_at, last_totals FROM scheduler_jobs WHERE job_name = $1', [JOB_NAME]);
  const r = rows[0] || {};
  const { rows: pending } = await pool.query('SELECT COUNT(*)::int AS n FROM entity_registry WHERE role IS NULL');
  return { running, lastRunDate: r.last_run_date || null, lastCompletedAt: r.last_completed_at || null, last: r.last_totals || null, rolesPending: pending[0].n };
}

module.exports = { runMaintenance, maybeRunEntityMaintenance, getMaintenanceStatus, JOB_NAME, INTERVAL_DAYS, RUN_HOUR_KST };
