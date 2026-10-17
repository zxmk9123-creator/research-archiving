// UNCERTAINTY-TRIGGERED VERIFICATION ROUTINE. When an answer has to set an entity's figure aside because the
// evidence is weak (undated, older than the freshness window, product scope unconfirmed ...), that entity is queued here
// (enqueue, called after the answer is sent — never blocking it). A scheduled routine (runQueue) then collects fresh,
// dated sources for the queued entities through the normal collection pipeline; new items get their facts extracted on
// publish, so the NEXT answer rests on better evidence. Safeguards: one queue row per (entity, topic); a done entity is
// not re-queued for COOLDOWN_DAYS; at most MAX_ATTEMPTS tries; at most DAILY_LIMIT entities per day; one run at a time.
const pool = require('../db/pool');

const COOLDOWN_DAYS = 7;
const MAX_ATTEMPTS = 3;
const DAILY_LIMIT = 24;
const PER_RUN = 3;

const entityKey = (e) => String(e || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cleanEntity = (e) => String(e || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

// Queries aimed at DATED, quantity-bearing coverage of this entity within the topic.
function buildQueries(entity, topic, reason) {
  const subject = topic ? `${entity} ${topic}` : entity;
  const q = [
    `${subject} production capacity tonnes per year 2026 news`,
    `${subject} capacity expansion start-up 2025 2026`,
  ];
  if (/[가-힣]/.test(entity) || /[가-힣]/.test(topic || '')) q.push(`${subject} 생산능력 연산 톤 2026`);
  if (reason === 'undated' || reason === 'old') q.push(`${subject} annual report 2025 capacity`);
  return q.slice(0, 4);
}

// items: [{ entity, reason }] reason: 'undated' | 'old' | 'unconfirmed'
async function enqueue(items, { topic = '' } = {}) {
  if (process.env.VERIFICATION_ROUTINE === 'off') return { queued: 0 };
  let queued = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const entity = cleanEntity(it && it.entity);
    if (entity.length < 2) continue;
    const reason = ['undated', 'old', 'unconfirmed'].includes(it.reason) ? it.reason : 'unconfirmed';
    const r = await pool.query(
      `INSERT INTO verification_queue (entity_key, entity, topic, reason) VALUES ($1,$2,$3,$4)
       ON CONFLICT (entity_key, topic) DO UPDATE SET
         seen_count = verification_queue.seen_count + 1, last_seen_at = now(), reason = EXCLUDED.reason,
         status = CASE WHEN verification_queue.status = 'done' AND verification_queue.last_run_at < now() - ($5 || ' days')::interval THEN 'pending'
                       ELSE verification_queue.status END,
         attempts = CASE WHEN verification_queue.status = 'done' AND verification_queue.last_run_at < now() - ($5 || ' days')::interval THEN 0
                         ELSE verification_queue.attempts END
       RETURNING (xmax = 0) AS inserted`,
      [entityKey(entity), entity, String(topic || '').slice(0, 40), reason, String(COOLDOWN_DAYS)]
    );
    if (r.rows[0] && r.rows[0].inserted) queued++;
  }
  return { queued };
}

let running = false;
const state = { lastRun: null, lastResult: null };

async function runQueue({ max = PER_RUN, collect = require('./companyProfileCollection').collectQueries, extractPending = true } = {}) {
  if (process.env.VERIFICATION_ROUTINE === 'off') return { skipped: 'off' };
  if (running) return { skipped: 'already_running' };
  running = true;
  const result = { processed: [], skipped: null };
  try {
    const { rows: today } = await pool.query("SELECT count(*)::int AS n FROM verification_queue WHERE last_run_at > now() - interval '24 hours'");
    const budget = Math.max(0, Math.min(max, DAILY_LIMIT - today[0].n));
    if (!budget) { result.skipped = 'daily_limit'; return result; }
    const { rows } = await pool.query(
      `SELECT id, entity, topic, reason, attempts FROM verification_queue
        WHERE status = 'pending' AND attempts < $2 ORDER BY seen_count DESC, last_seen_at DESC LIMIT $1`,
      [budget, MAX_ATTEMPTS]
    );
    for (const row of rows) {
      await pool.query("UPDATE verification_queue SET status = 'running', last_run_at = now() WHERE id = $1", [row.id]);
      let archived = 0;
      let failed = false;
      try {
        const t = await collect(buildQueries(row.entity, row.topic, row.reason));
        archived = t.archived || 0;
        failed = t.failedQueries > 0 && archived === 0;
      } catch (err) {
        failed = true;
        console.error(`verification routine failed for ${row.entity}: ${err.message}`);
      }
      const attempts = row.attempts + 1;
      await pool.query(
        'UPDATE verification_queue SET status = $2, attempts = $3, archived_last = $4, last_run_at = now() WHERE id = $1',
        [row.id, failed ? (attempts >= MAX_ATTEMPTS ? 'gave_up' : 'pending') : 'done', attempts, archived]
      );
      result.processed.push({ entity: row.entity, topic: row.topic, archived, failed });
    }
    if (result.processed.length) {
      // dates from URLs and facts for the newly archived items
      try { await require('./publishedDates').backfillPublishedDates(); } catch (_) { /* best-effort */ }
      if (extractPending) { try { await require('./itemFacts').runBackfill({ limit: 100 }); } catch (_) { /* best-effort */ } }
    }
    return result;
  } finally {
    running = false;
    state.lastRun = new Date().toISOString();
    state.lastResult = result;
  }
}

async function getStatus() {
  const { rows } = await pool.query('SELECT status, count(*)::int AS n FROM verification_queue GROUP BY status');
  const { rows: recent } = await pool.query('SELECT entity, topic, reason, status, attempts, archived_last, last_run_at FROM verification_queue ORDER BY last_seen_at DESC LIMIT 25');
  return { running, counts: Object.fromEntries(rows.map((r) => [r.status, r.n])), recent, ...state };
}

module.exports = { enqueue, runQueue, getStatus, buildQueries, entityKey, COOLDOWN_DAYS, MAX_ATTEMPTS, DAILY_LIMIT };
