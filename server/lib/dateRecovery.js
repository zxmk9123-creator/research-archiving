// DRY-RUN publication-date recovery report. Reads eligible recent records and works out what a backfill WOULD do; it never writes: the only
// database access is one SELECT (loadEligibleRows), and fetching is read-only HTTP GET. A real backfill needs its own approval.
const pool = require('../db/pool');
const P = require('./publishedDates');

// Methods whose date is the article's own publication date and may be proposed for published_at. Month-only URL dates and social-post
// timestamps are deliberately not in this set.
const VERIFIED_METHODS = new Set(['url_date', 'spglobal_url_mmddyy', 'page_meta', 'page_ld_json', 'biomass_publishedAt']);

async function loadEligibleRows({ days = 7, limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, status, type, source_url, gate_hold_reason, gate_hold_rule_version, auto_review, collected_at
       FROM items
      WHERE published_at IS NULL AND source_url IS NOT NULL AND status IN ('Draft', 'Published')
        AND collected_at >= now() - make_interval(days => $1)
      ORDER BY id DESC LIMIT $2`,
    [days, limit]
  );
  return rows;
}

const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

// Settled earlier with a PERMANENT reason: never fetched again. A legacy 'undated_news_checked' (written before failures were classified,
// reason unknown) is the exception: it may have been a transient failure, so the report fetches it once more.
function settledPermanently(r) {
  return r.gate_hold_reason === 'undated_news_checked' && String(r.gate_hold_rule_version || '').startsWith('undated-news-v2:')
    && !String(r.gate_hold_rule_version).startsWith('undated-news-v2:retry:');
}

async function classify(r, { now, deps }) {
  const base = {
    id: r.id, status: r.status, type: r.type, source_domain: domainOf(r.source_url), human_reviewed: r.auto_review === 'human',
    current_hold: r.gate_hold_reason || null, candidate_date: null, corroboration: null, precision: null, method: null, evidence: null, outcome: null, reason: null,
    social_post_timestamp: P.socialPostTimestamp(r.source_url, now), proposed_action: null, writes: 'none',
  };
  if (settledPermanently(r)) return { ...base, outcome: 'settled', reason: String(r.gate_hold_rule_version).slice('undated-news-v2:'.length), proposed_action: 'skip_settled_permanent' };
  const res = await P.resolvePublicationDate(r.source_url, { ...deps, now });
  const row = { ...base, outcome: res.outcome, reason: res.reason || null, method: res.method || null, evidence: res.evidence || null, precision: res.precision || null, candidate_date: res.date || null,
    corroboration: res.method && res.method.startsWith('page_') ? (res.corroborated ? 'printed_on_page' : 'metadata_only') : (res.method ? 'url_pattern_or_rule' : null) };
  if (res.outcome === 'dated') {
    if (res.precision === 'month') return { ...row, proposed_action: 'review_month_only_low_confidence' };
    if (!VERIFIED_METHODS.has(res.method)) return { ...row, proposed_action: 'review_unverified_method' };
    // a metadata date that the page itself does not print may be a template or stale field: shown for review, not proposed for writing
    if (res.method.startsWith('page_') && !res.corroborated) return { ...row, proposed_action: 'review_uncorroborated_metadata_date' };
    // published_at is the only column a backfill would touch; summary, insight, tags and workflow status stay as they are, and for a
    // human-reviewed or already-published record nothing is re-judged or re-published
    return { ...row, proposed_action: 'set_published_at', writes: 'published_at only' };
  }
  if (res.outcome === 'transient') return { ...row, proposed_action: 'retry_later' };
  if (row.social_post_timestamp) return { ...row, proposed_action: 'report_only_unverified_social_timestamp' };
  return { ...row, proposed_action: 'mark_unresolved_permanent' };
}

async function buildDateRecoveryReport({ rows, now = new Date(), deps = {}, perHost = 1, overall = 3 } = {}) {
  const list = rows || await loadEligibleRows();
  const results = await P.mapWithHostLimit(list, (r) => domainOf(r.source_url), (r) => classify(r, { now, deps }), { perHost, overall });
  results.sort((a, b) => b.id - a.id);
  const count = (key) => results.reduce((m, r) => ({ ...m, [r[key] || '-']: (m[r[key] || '-'] || 0) + 1 }), {});
  return {
    dry_run: true, generated_at: now.toISOString(), eligible: list.length,
    summary: { by_action: count('proposed_action'), by_method: count('method'), by_status: count('status'), human_reviewed: results.filter((r) => r.human_reviewed).length },
    rows: results,
  };
}

module.exports = { buildDateRecoveryReport, loadEligibleRows, VERIFIED_METHODS };
