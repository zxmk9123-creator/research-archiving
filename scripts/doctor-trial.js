#!/usr/bin/env node
// Trial-day helper for a SUPERVISED Pipeline Doctor recovery. Needs DATABASE_URL. It never enables recovery and never calls the Doctor endpoint.
//   check    [--date YYYY-MM-DD] [--backup file]   READ-ONLY go/no-go on the data side (eligible finding, sole action, attempts left, backup)
//   backup   [--date YYYY-MM-DD] [--file out.json]  READ-ONLY export of the two rows a recovery can touch (daily_briefs of the day, ops_doctor)
//   restore  --file out.json [--apply]               dry run by default; --apply writes ONLY those two rows back and verifies they match the backup
//   arm      --key headline:<cause> --backup file --by name   stores ONE ~15-min, single-use approval for exactly that finding. Refuses unless `check` is GO
//                                                       and the key is the single eligible finding. DOCTOR_RECOVERY stays off; the approval is consumed by the next recover run.
//   revoke                                              withdraws a still-pending approval
//   status                                              shows the stored approval (read-only)
const fs = require('fs');

const ROWS = {
  daily_briefs: {
    select: 'SELECT to_jsonb(t) AS r FROM daily_briefs t WHERE brief_date = $1::date',
    same: 'SELECT to_jsonb(t) = $2::jsonb AS same FROM daily_briefs t WHERE brief_date = $1::date',
    restore: `UPDATE daily_briefs SET status = r.status, window_start = r.window_start, window_end = r.window_end, item_count = r.item_count,
                source_item_ids = r.source_item_ids, brief = r.brief, error = r.error, attempt_count = r.attempt_count,
                updated_at = r.updated_at, completed_at = r.completed_at
              FROM jsonb_populate_record(NULL::daily_briefs, $2::jsonb) r WHERE daily_briefs.brief_date = $1::date`,
    keyed: true,
  },
  ops_doctor: {
    select: "SELECT to_jsonb(t) AS r FROM scheduler_jobs t WHERE job_name = 'ops_doctor'",
    same: "SELECT to_jsonb(t) = $1::jsonb AS same FROM scheduler_jobs t WHERE job_name = 'ops_doctor'",
    restore: `UPDATE scheduler_jobs SET last_run_date = r.last_run_date, last_completed_at = r.last_completed_at, last_totals = r.last_totals,
                last_failed_sources = r.last_failed_sources
              FROM jsonb_populate_record(NULL::scheduler_jobs, $1::jsonb) r WHERE scheduler_jobs.job_name = 'ops_doctor'`,
    keyed: false,
  },
};
const args = (spec, date) => (spec.keyed ? [date] : []);

async function backup(pool, { date, file } = {}) {
  const out = { takenAt: new Date().toISOString(), date, rows: {} };
  for (const [name, spec] of Object.entries(ROWS)) out.rows[name] = (await pool.query(spec.select, args(spec, date))).rows[0]?.r || null;
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

// dry run (apply=false) only reports; apply runs in ONE transaction and rolls back unless every restored row equals its backup exactly
async function restore(pool, saved, { apply = false } = {}) {
  const report = {};
  for (const [name, spec] of Object.entries(ROWS)) {
    const row = saved.rows[name];
    const a = (extra) => (spec.keyed ? [saved.date, extra] : [extra]);
    if (!row) { report[name] = 'no row existed at backup time: nothing restored (handle manually)'; continue; }
    const cur = (await pool.query(spec.same, a(JSON.stringify(row)))).rows[0];
    report[name] = !cur ? 'row missing now: nothing restored (handle manually)' : cur.same ? 'identical to backup' : (apply ? 'restored' : 'differs from backup (dry run)');
  }
  if (!apply) return report;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [name, spec] of Object.entries(ROWS)) {
      const row = saved.rows[name];
      if (!row || report[name] !== 'restored') continue;
      await client.query(spec.restore, spec.keyed ? [saved.date, JSON.stringify(row)] : [JSON.stringify(row)]);
      const ok = (await client.query(spec.same, spec.keyed ? [saved.date, JSON.stringify(row)] : [JSON.stringify(row)])).rows[0];
      if (!ok || !ok.same) throw new Error(`${name} does not match its backup after restore`);
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  return report;
}

async function check(pool, { now = new Date(), date, backupFile, maxBackupAgeMin = 60 } = {}) {
  const doctor = require('../server/lib/pipelineDoctor');
  const { evaluateHealth } = require('../server/lib/pipelineHealth');
  const dailyBrief = require('../server/lib/dailyBrief');
  const briefDate = date || dailyBrief.kstDate(now);
  const ctx = await doctor.collectContext(now);
  const health = evaluateHealth(ctx, now.getTime());
  const findings = doctor.diagnose(health, ctx, now.getTime());
  const eligible = findings.filter((f) => f.action && ['retryable', 'auto_recoverable'].includes(f.classification));
  const doc = (await pool.query("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'ops_doctor'")).rows[0]?.last_totals || {};
  const plan = doctor.planRecovery(findings, doc, { now: now.getTime(), mode: 'recover', recoveryEnabled: true }); // hypothetical: what WOULD run
  const used = (await pool.query('SELECT attempt_count FROM daily_briefs WHERE brief_date = $1::date', [briefDate])).rows[0]?.attempt_count || 0;
  const cap = dailyBrief.MAX_AUTO_DAILY_ATTEMPTS;
  const need = doctor.MAX_MODEL_CALLS_PER_RECOVERY + 1; // one claim + one failure per budgeted call
  let backupOk = false;
  try {
    const b = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    backupOk = b.date === briefDate && Boolean(b.rows.daily_briefs) && Date.now() - new Date(b.takenAt).getTime() <= maxBackupAgeMin * 60000;
  } catch { backupOk = false; }
  const checks = [
    ['health verdict is warn/failed', health.status === 'warn' || health.status === 'failed'],
    ['exactly one retryable/auto-recoverable finding', eligible.length === 1],
    ['its action is retry_headline (never kick_pipeline)', eligible.length === 1 && eligible[0].action === 'retry_headline'],
    ['the planner would run exactly that action (no cooldown / limit / prior failure)', plan.actions.length === 1 && plan.actions[0].action === 'retry_headline'],
    [`daily attempts left >= ${need} (used ${used} of ${cap})`, cap - used >= need],
    [`a backup of ${briefDate} taken in the last ${maxBackupAgeMin} min exists`, backupOk],
  ];
  return {
    go: checks.every(([, ok]) => ok), health: health.status, checks: checks.map(([name, ok]) => ({ name, ok })),
    eligible: eligible.map((f) => ({ key: f.key, action: f.action, evidence: f.evidence })), skipped: plan.skipped,
    manual: ['Vercel production env must NOT contain DOCTOR_RECOVERY before arming (list names only)', 'a Neon snapshot taken just before arming exists (list_snapshots)'],
  };
}

if (require.main === module) {
  const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const pool = require('../server/db/pool');
  const date = opt('date') || require('../server/lib/dailyBrief').kstDate(new Date());
  const cmd = process.argv[2];
  const run = cmd === 'check' ? () => check(pool, { date, backupFile: opt('backup') })
    : cmd === 'backup' ? () => backup(pool, { date, file: opt('file') })
    : cmd === 'arm' ? () => arm(pool, { key: opt('key'), backupFile: opt('backup'), date, by: opt('by') })
    : cmd === 'revoke' ? () => require('../server/lib/pipelineDoctor').revokeApproval(approvalStore())
    : cmd === 'status' ? () => status(pool)
    : cmd === 'restore' ? () => restore(pool, JSON.parse(fs.readFileSync(opt('file'), 'utf8')), { apply: process.argv.includes('--apply') })
    : async () => { throw new Error('usage: doctor-trial.js check|backup|restore [--date D] [--file F] [--backup F] [--apply]'); };
  run().then((r) => { console.log(JSON.stringify(r, null, 2)); return pool.end(); }).catch((e) => { console.error(e.message); process.exitCode = 1; return pool.end(); });
}
const approvalStore = () => ({ mutate: (fn) => require('../server/lib/jobState').mutateJobState('ops_doctor', fn) });
async function arm(pool, { key, backupFile, date, by, now = new Date(), store = approvalStore() } = {}) {
  const c = await check(pool, { now, date, backupFile });
  if (!c.go) return { armed: false, reason: 'check_is_no_go', failing: c.checks.filter((x) => !x.ok).map((x) => x.name) };
  if (c.eligible[0].key !== key) return { armed: false, reason: 'key_is_not_the_single_eligible_finding', eligible: c.eligible[0].key };
  return require('../server/lib/pipelineDoctor').armApproval(store, { key, now: now.getTime(), by });
}
async function status(pool) {
  const r = (await pool.query("SELECT last_totals->'approval' AS a FROM scheduler_jobs WHERE job_name = 'ops_doctor'")).rows[0];
  return { approval: r ? r.a : null, now: Date.now() };
}

module.exports = { backup, restore, check, arm, status };
