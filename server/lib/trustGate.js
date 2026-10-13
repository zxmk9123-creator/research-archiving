// Trust Gate: a structural sanity check run just before an item is
// allowed to auto-publish (applyAiDraftIfEligible in aiDraft.js).
// Independent of the AI's own eligibility/QA verdict — it catches data
// problems the AI step itself never looks at: a malformed/missing source
// URL, an implausible (future-dated) published_at, a bot-block or empty
// title that slipped through extraction, or an AI summary that's
// missing/degenerate despite ai_status='completed'. Any failure holds the
// item at its current status (normally Draft) instead of blocking it
// outright — same fail-closed convention the existing ai_qa_decision/
// hasValidClassification gates already use.
//
// Publisher identity is deliberately verified via source_url's own
// hostname, not a separate "publisher" field: production data shows most
// Web Discovery items have no sources.publisher (that column only ever
// holds a value for RSS/institution/structured sources, never crawl
// query-registry rows) — requiring it here would hold back the majority
// of what the system otherwise publishes correctly. A well-formed URL
// already carries its own publisher/origin.
const { isBotBlockPage } = require('./extractMetadata');

const MIN_SUMMARY_CHARS = 10;
const FUTURE_GRACE_DAYS = 2;

function hasValidSourceUrl(item) {
  try {
    const url = new URL(item.source_url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// published_at is often legitimately absent (extraction couldn't find a
// date on the page) — this only rejects an implausible value, never a
// missing one.
function hasPlausiblePublishedAt(item) {
  if (!item.published_at) return true;
  const published = new Date(item.published_at);
  if (Number.isNaN(published.getTime())) return false;
  return published.getTime() <= Date.now() + FUTURE_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

function hasUsableSummary(item) {
  if (item.ai_failure_type) return false;
  const summary = (item.ai_summary || '').trim();
  if (summary.length < MIN_SUMMARY_CHARS) return false;
  return summary !== (item.title || '').trim();
}

function hasSaneMetadata(item) {
  const title = (item.title || '').trim();
  if (!title) return false;
  return !isBotBlockPage(title);
}

function passesTrustGate(item) {
  return (
    hasValidSourceUrl(item) &&
    hasPlausiblePublishedAt(item) &&
    hasUsableSummary(item) &&
    hasSaneMetadata(item)
  );
}

module.exports = {
  passesTrustGate,
  hasValidSourceUrl,
  hasPlausiblePublishedAt,
  hasUsableSummary,
  hasSaneMetadata,
  MIN_SUMMARY_CHARS,
  FUTURE_GRACE_DAYS,
};
