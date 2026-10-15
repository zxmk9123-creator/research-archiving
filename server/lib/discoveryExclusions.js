// Records candidates the pre-insert gates dropped (out of scope / stale) so
// the scope-tuning analysis has the "what we rejected" half of the data —
// before this, a filtered candidate left no trace, so a topic the static
// filter wrongly excluded could never be noticed. One row per URL: a repeat
// sighting only bumps seen_count/last_seen_at, so a daily-repeating result
// can't grow the table. Best-effort by design: a logging failure must never
// fail or slow a collection run.
const pool = require('../db/pool');

const SUMMARY_MAX_CHARS = 600;
const TITLE_MAX_CHARS = 300;

async function recordExclusion({ sourceId, url, title, summary, publishedAt, reason }) {
  if (!url || !reason) return;
  try {
    await pool.query(
      `INSERT INTO discovery_exclusions (source_id, url, title, summary, published_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (url) DO UPDATE
         SET seen_count = discovery_exclusions.seen_count + 1,
             last_seen_at = now(),
             reason = EXCLUDED.reason`,
      [
        sourceId ?? null,
        url,
        title ? String(title).slice(0, TITLE_MAX_CHARS) : null,
        summary ? String(summary).slice(0, SUMMARY_MAX_CHARS) : null,
        publishedAt || null,
        reason,
      ]
    );
  } catch (err) {
    console.error(`discovery_exclusion record failed: ${err.message}`);
  }
}

module.exports = { recordExclusion };
