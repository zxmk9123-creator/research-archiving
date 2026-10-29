// Atomic read-modify-write of one scheduler_jobs.last_totals document using only pool.query: the UPDATE succeeds only if the row still holds
// exactly the document that was read (jsonb equality), otherwise it re-reads and re-applies fn. Concurrent serverless instances therefore
// cannot overwrite each other's changes. fn receives a deep copy and returns the new document (or undefined to leave it unchanged).
// Resolves true when written, false when it gave up (contention or DB error); never throws.
const pool = require('../db/pool');

async function mutateJobState(jobName, fn, { attempts = 6 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const { rows } = await pool.query('SELECT last_totals FROM scheduler_jobs WHERE job_name = $1', [jobName]);
      const exists = rows.length > 0;
      const old = exists ? rows[0].last_totals : null;
      const next = fn(old ? JSON.parse(JSON.stringify(old)) : {});
      if (next === undefined) return true;
      const json = JSON.stringify(next);
      let res;
      if (!exists) {
        res = await pool.query(
          'INSERT INTO scheduler_jobs (job_name, last_run_date, last_totals) VALUES ($1, CURRENT_DATE, $2::jsonb) ON CONFLICT (job_name) DO NOTHING RETURNING 1',
          [jobName, json]
        );
      } else {
        res = await pool.query(
          'UPDATE scheduler_jobs SET last_run_date = CURRENT_DATE, last_totals = $2::jsonb WHERE job_name = $1 AND last_totals IS NOT DISTINCT FROM $3::jsonb RETURNING 1',
          [jobName, json, old === null ? null : JSON.stringify(old)]
        );
      }
      if (res && res.rows && res.rows.length) return true;
    } catch (err) {
      console.error(`job state ${jobName} update failed:`, err.message);
      return false;
    }
  }
  return false;
}

module.exports = { mutateJobState };
