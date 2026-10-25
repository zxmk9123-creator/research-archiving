// What an anonymous visitor may read. The archive is public, the review pipeline is not: without an admin session only Published items
// are visible (list, month counts, detail, related) and the columns that describe the internal AI/review pipeline are removed.
// Fields the public pages DO use (summary, insight, ai_summary, ai_insight, source_url, sectors, ...) stay.
const INTERNAL_FIELDS = [
  'ai_error', 'ai_failure_type', 'ai_latency_ms', 'ai_status', 'ai_eligible', 'ai_eligibility_reason', 'ai_qa_decision', 'ai_qa_reason',
  'ai_suggested_sectors', 'ai_suggested_usages', 'ai_companies', 'ai_generated_at', 'ai_key_takeaway',
  'gate_hold_reason', 'gate_hold_rule_version', 'reviewer_eligible',
  'auto_review', 'auto_review_at', 'auto_review_attempts', 'auto_review_reason',
  'facts_status', 'facts_extracted_at', 'relations_status',
];

function publicView(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const field of INTERNAL_FIELDS) delete out[field];
  return out;
}

// Query for an anonymous request: any status other than Published is refused (the caller answers 401), none given means Published.
function scopeQueryForAnonymous(query) {
  const status = query && query.status;
  if (status && status !== 'Published') return null;
  return { ...query, status: 'Published' };
}

module.exports = { INTERNAL_FIELDS, publicView, scopeQueryForAnonymous };
