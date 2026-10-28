// A small persistent trace of what the morning pipeline did (chain hand-offs, self-heal kicks, completion), kept in the existing
// scheduler_jobs table (job 'pipeline_trace', last_totals.events, newest last, capped). Vercel keeps runtime logs for one hour only; this
// keeps the answer to "what happened and when" available the next day. Never throws: tracing must not break the pipeline.
const pool = require('../db/pool');

const JOB = 'pipeline_trace';
const MAX_EVENTS = 60;

async function recordPipelineEvent(kind, detail = {}) {
  try {
    const { rows } = await pool.query('SELECT last_totals FROM scheduler_jobs WHERE job_name = $1', [JOB]);
    const events = (rows[0] && rows[0].last_totals && Array.isArray(rows[0].last_totals.events)) ? rows[0].last_totals.events : [];
    events.push({ at: new Date().toISOString(), kind, ...detail });
    await pool.query(
      `INSERT INTO scheduler_jobs (job_name, last_run_date, last_totals) VALUES ($1, CURRENT_DATE, $2::jsonb)
       ON CONFLICT (job_name) DO UPDATE SET last_run_date = CURRENT_DATE, last_totals = $2::jsonb`,
      [JOB, JSON.stringify({ events: events.slice(-MAX_EVENTS) })]
    );
  } catch (err) {
    console.error('pipeline trace failed:', err.message);
  }
}

module.exports = { recordPipelineEvent, MAX_EVENTS };
