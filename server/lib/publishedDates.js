// UNDATED items: pages collected without a publication date (profile collection, institutional pages) cannot be judged
// by the freshness rules and drop to "시점 불명". Many carry the date in their own URL (/2025/03/12/..., 20250312,
// /2025/03/): that is the page's own evidence, used only for items that have no date at all.
const pool = require('../db/pool');

const MIN_YEAR = 2015;
function valid(y, m, d, now = new Date()) {
  if (y < MIN_YEAR || y > now.getFullYear()) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || dt.getTime() > now.getTime()) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// -> 'YYYY-MM-DD' (month-only dates take the 1st) or null
function dateFromUrl(url, now = new Date()) {
  const u = String(url || '');
  let m = u.match(/(?<![0-9])(20[12]\d)[\/_.-](0[1-9]|1[0-2])[\/_.-](0[1-9]|[12]\d|3[01])(?![0-9])/);
  if (m) return valid(+m[1], +m[2], +m[3], now);
  m = u.match(/(?<![0-9])(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?![0-9])/);
  if (m) return valid(+m[1], +m[2], +m[3], now);
  m = u.match(/\/(20[12]\d)\/(0[1-9]|1[0-2])(?:\/|$|\?)/);
  if (m) return valid(+m[1], +m[2], 1, now);
  return null;
}

async function backfillPublishedDates() {
  const { rows } = await pool.query("SELECT id, source_url FROM items WHERE published_at IS NULL AND source_url IS NOT NULL");
  let updated = 0;
  for (const r of rows) {
    const d = dateFromUrl(r.source_url);
    if (!d) continue;
    await pool.query('UPDATE items SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [r.id, d]);
    updated++;
  }
  return { undated: rows.length, updated };
}

module.exports = { dateFromUrl, backfillPublishedDates };
