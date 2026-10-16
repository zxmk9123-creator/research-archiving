const pool = require('../db/pool');
const { matchCompanies } = require('./companyMatch');

// Automatic company-profile intake. The AI draft already reads every article,
// so it also names the companies that are the article's business actors
// (producers / refiners / suppliers / traders — not governments, agencies or
// media). When such an article is PUBLISHED:
//   1) it is tagged to any watchlist company it mentions (this used to happen
//      only on some ingest paths, never for Web Discovery);
//   2) every company NOT yet on the watchlist is filed in `company_candidates`
//      with the items that mention it;
//   3) a candidate seen in PROMOTE_AFTER distinct published items is promoted
//      onto the watchlist (`companies`, watched) and its items are tagged — so
//      the chatbot's company sweep and coverage enforcement pick it up with no
//      manual step. Demote with DELETE /api/companies/:id (watched=false); a
//      demoted/ignored name is never promoted again.
const PROMOTE_AFTER = 3;
const MAX_NAMES_PER_ITEM = 5;
const MAX_ITEM_IDS = 25;

// Not businesses (or too generic to be a profile target) even if a model
// lists them. Lower-cased exact matches only.
const NOT_A_COMPANY = new Set([
  'eu', 'european union', 'usda', 'iata', 'icao', 'opec', 'opec+', 'fao', 'imf', 'oecd', 'iea', 'epa', 'doe', 'cftc',
  'reuters', 'bloomberg', 'argus', 'platts', 'ihs markit', 'fastmarkets', 'linkedin', 'google', 'youtube', 'twitter',
  'government', 'ministry', 'saf', 'hefa', 'uco', 'ucome', 'b40', 'b50', 'rin', 'lcfs', 'refueleu',
  '정부', '농림부', '산업부', '환경부', '산업통상자원부', '국회', '유럽연합', '국제항공운송협회',
]);

// Pure: normalises the model's raw `companies` value into clean names.
function extractCompanyNames(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const raw = typeof entry === 'string' ? entry : entry && typeof entry.name === 'string' ? entry.name : '';
    const name = raw.replace(/\s+/g, ' ').trim().replace(/^[("'“‘]+|[)"'”’,.;]+$/g, '').trim();
    if (name.length < 3 || name.length > 60) continue;
    if (!/[\p{L}]/u.test(name) || /^\d/.test(name)) continue;
    const key = name.toLowerCase();
    if (NOT_A_COMPANY.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_NAMES_PER_ITEM) break;
  }
  return out;
}

const keyOf = (name) => name.trim().toLowerCase();

async function loadRosterKeys() {
  const { rows } = await pool.query('SELECT name, aliases FROM companies');
  const keys = new Set();
  for (const r of rows) for (const n of [r.name, ...(r.aliases || [])]) if (n) keys.add(keyOf(n));
  return keys;
}

async function promoteCandidate(cand) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, aliases, watched) VALUES ($1, $2, true)
     ON CONFLICT (name) DO UPDATE SET watched = true RETURNING id`,
    [cand.name, [cand.name]]
  );
  const companyId = rows[0] && rows[0].id;
  await pool.query(
    "UPDATE company_candidates SET status = 'promoted', company_id = $1, promoted_at = now() WHERE name_key = $2",
    [companyId, cand.name_key]
  );
  if (companyId && cand.item_ids && cand.item_ids.length) {
    await pool.query(
      `INSERT INTO item_companies (item_id, company_id)
       SELECT unnest($1::int[]), $2 ON CONFLICT DO NOTHING`,
      [cand.item_ids, companyId]
    );
  }
  console.log(`company_discovery promoted candidate "${cand.name}" (${cand.item_ids.length} items)`);
  return companyId;
}

// Called once per newly published item. Never throws into the publish path.
async function recordCompanyMentions(item) {
  try {
    await matchCompanies(item.id, `${item.title || ''} ${item.ai_summary || ''}`);
    const names = extractCompanyNames(item.ai_companies);
    if (!names.length) return { recorded: 0 };
    const roster = await loadRosterKeys();
    let recorded = 0;
    for (const name of names) {
      const key = keyOf(name);
      if (roster.has(key)) continue; // already tracked (or demoted): never re-filed
      const { rows } = await pool.query(
        `INSERT INTO company_candidates (name_key, name, item_ids, mention_count)
         VALUES ($1, $2, ARRAY[$3::int], 1)
         ON CONFLICT (name_key) DO UPDATE SET
           item_ids = CASE WHEN $3::int = ANY(company_candidates.item_ids) OR cardinality(company_candidates.item_ids) >= ${MAX_ITEM_IDS}
                           THEN company_candidates.item_ids ELSE array_append(company_candidates.item_ids, $3::int) END,
           mention_count = CASE WHEN $3::int = ANY(company_candidates.item_ids) THEN company_candidates.mention_count ELSE company_candidates.mention_count + 1 END,
           last_seen_at = now()
         RETURNING name_key, name, item_ids, mention_count, status`,
        [key, name, item.id]
      );
      recorded++;
      const cand = rows[0];
      if (cand && cand.status === 'candidate' && cand.item_ids.length >= PROMOTE_AFTER) await promoteCandidate(cand);
    }
    return { recorded };
  } catch (err) {
    console.error('company_discovery failed:', err.message);
    return { recorded: 0, error: err.message };
  }
}

module.exports = { extractCompanyNames, recordCompanyMentions, promoteCandidate, PROMOTE_AFTER, NOT_A_COMPANY };
