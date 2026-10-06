const pool = require('../db/pool');
const { callProviderWithFallback } = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');
const { hasValidClassification, deriveContentCategory } = require('./classification');

// Collector fires generateAiDraftForItem once per new item, unawaited — a
// single collection run can create dozens of items at once. Bounding the
// actual outbound provider calls here (not in collector.js) throttles every
// caller (collection AND manual retry) from one place, with no change to
// the fire-and-forget/failure-isolated call sites.
//
// Concurrency alone (2 at once) wasn't enough: production saw a 20-item
// burst still exhaust the Groq 8000 TPM budget, because bounding how many
// calls run *simultaneously* doesn't bound how many start per minute — with
// fast calls, 2-at-a-time still drains the whole queue in a few seconds,
// landing all the tokens in one rate window. AI_MIN_CALL_INTERVAL_MS spaces
// out call *starts* so a burst is spread across the window instead.
const AI_MAX_CONCURRENT_CALLS = 2;
const AI_MIN_CALL_INTERVAL_MS = 3000;
const limitAiCall = createLimiter(AI_MAX_CONCURRENT_CALLS, AI_MIN_CALL_INTERVAL_MS);

// Strict JSON-only contract — no free prose parsing. The model is given the
// full allowed vocabulary and told to return existing ids only, never invent
// new sector/usage labels.
const SYSTEM_PROMPT = `You are a research-archiving assistant for an oils & fats market intelligence archive.
Given a title and (if available) a short description of a collected article, respond with STRICT JSON ONLY — no markdown fences, no commentary, nothing before or after the JSON object.

The JSON object must have exactly this shape:
{"eligible": boolean, "eligibility_reason": string, "who": string, "what": string, "amount": string, "when": string, "where": string, "why": string, "impact": string, "summary": string, "insight": string, "key_takeaway": string, "suggested_sectors": number[], "suggested_usages": number[], "publication_decision": "PASS"|"HOLD"|"REJECT", "publication_reason": string}

Rules:
- eligible: evaluate in this order, and only then decide true/false. Do NOT use "has specific facts/figures" by itself as the test — a fact-dense article can still be ineligible, and a sparse one can still be eligible.
  A. Concrete development — is there a specific event, change, transaction, policy action, market movement, or product/company development? Generic commentary, a standing recurring update with nothing new, or vague discussion is NOT sufficient on its own.
  B. Research significance — does that development have a meaningful implication for oil/fats markets: trade flows, supply/demand, pricing, regulation, logistics, or business opportunities? The significance can be market-wide, trade-lane-specific, regulatory, or company-level — a single company's news counts if it carries a real business/market implication.
  C. Evidence/anchor — concrete figures, dates, named authorities, named companies, transactions, or policy measures strengthen eligibility, but do NOT require numerical data when the development itself is materially significant without it.
  D. Scope and framing — do not reject an article merely because it concerns one company, one country, or one region. Reject when it is narrow operational/administrative information with no meaningful research implication. Separately, distinguish genuine economic/market developments from pure geopolitical, diplomatic, or security/military incident reporting that carries no stated economic transmission.
  E. Recurring content — a recurring/weekly roundup format is a negative signal, not an automatic rejection: it can still be eligible if that specific edition contains a material new development, and ineligible if it's just the standing format with nothing new.
  Mark eligible=true only when A and B both hold (a concrete development with a meaningful implication); otherwise false.
- eligibility_reason: one concise Korean sentence explaining the eligible verdict, referencing which of the above criteria drove it.
- who / what / amount / when / where / why / impact: internal extraction fields, used only as your reasoning criteria for identifying the article's core facts — NOT the final output shown to a person. Fill each ONLY if it is explicitly stated in the given title/description. If a fact is not stated, respond with the exact Korean string "미확보" for that field — do NOT guess, infer, estimate, or fill in a plausible-sounding value.
- summary: a natural, flowing 1-3 sentence Korean summary containing ONLY the article's directly-stated facts (who/what/amount/when/where/why) — NOT a labeled list (do not write "누가:", "무엇을:", etc.), and NOT the place for inference, prediction, evaluation, or impact statements (those belong in "insight" instead). Prioritize concrete, decision-relevant facts (companies, transactions, amounts, volumes, dates, locations) when present. Simply omit any fact that is "미확보" or otherwise unavailable — never mention it, never write "미확보" or a placeholder inside the sentence, and never invent or infer a cause, amount, date, or company that isn't explicitly stated.
- insight: a separate 1-2 sentence Korean field for what goes BEYOND the plain facts — a specific monitoring point or movement implied by THIS article. It MUST be grounded in and traceable to the specific who/what/amount/when/where/why/impact facts you extracted above — never a generic industry/market prediction that could be written about any article in the sector regardless of its actual content. Do NOT generalize a single company's or single article's news into an industry-wide trend (e.g. do not turn one company's expansion into "업계 전반이 확대되고 있다"). Do NOT infer a macro slowdown, market expansion, future growth, or broad adoption trend unless the article itself gives evidence supporting that specific inference (e.g. a single job-cut figure at one company is NOT evidence of an industry-wide slowdown). If most of the extracted facts are "미확보" (i.e. this article gave you little concrete to reason from), or if you cannot identify a specific, article-grounded implication, do not stretch a generic claim out of the little that's there — plainly say no notable implication is evident instead. This is explicitly your inference, and must read as such (e.g. "~할 가능성이 있다", "~로 이어질 수 있다") rather than being stated as a confirmed fact — never phrase an inference as if it were reported in the article.
- key_takeaway: one concise Korean sentence stating the single most useful insight for a reviewer.
- suggested_sectors: 0-3 ids chosen ONLY from the allowed sector id list given below. Never invent an id or a name that is not listed.
- suggested_usages: 0-3 ids chosen ONLY from the allowed usage id list given below. Never invent an id or a name that is not listed.
- If you cannot confidently choose any tag, return an empty array for that field rather than guessing.
- publication_decision / publication_reason: a FINAL publication quality gate, separate and independent from "eligible" above (eligible only governs whether a human reviewer should look at this soon; publication_decision governs whether it may ever be auto-published). Evaluate at minimum:
  (1) Oil & Fats market relevance — is this actually about oil/fats markets, trade, policy, or adjacent logistics/feedstocks?
  (2) substantive research or reusable information value — does it contain real analysis, data, or reporting, not just a routine price snapshot, bare ticker/quote page, or a one-line stub?
  (3) source/original-content quality — is this original reporting/analysis, not a thin aggregator page with no real content of its own?
  (4) obvious repost/duplicate — is this clearly a syndicated copy or re-publication of content that adds nothing new?
  (5) freshness where applicable — if the article concerns a point-in-time event or figure, is it being presented as current when it is actually stale/outdated?
  - "PASS": the material clearly satisfies all of the above — safe to auto-publish as-is.
  - "REJECT": the material clearly fails one or more criteria — irrelevant to oil/fats, no substantive content, an obvious repost/duplicate, a bare low-value page (e.g. just a price ticker), or clearly stale content presented as current.
  - "HOLD": anything that is not confidently PASS or REJECT — insufficient information, borderline quality, or genuine uncertainty. When unsure, you MUST choose "HOLD" — never guess "PASS".
- publication_reason: one concise Korean sentence explaining the publication_decision verdict, referencing which of the 5 criteria above drove it.
- You are working only from the title/description given — do not claim to have read a full article.
- Output ONLY the JSON object.`;

function buildTaxonomyBlock(sectors, usages) {
  const sectorLines = sectors.map((s) => `${s.id}: ${s.name}`).join('\n');
  const usageLines = usages.map((u) => `${u.id}: ${u.name}`).join('\n');
  return `Allowed sectors (id: name):\n${sectorLines}\n\nAllowed usages (id: name):\n${usageLines}`;
}

// Source material priority: title + whatever short description/summary was
// already collected (RSS description, or a manually entered summary) —
// UNLESS extractedText is given (e.g. text pulled from an acquired PDF
// report), in which case that becomes the material instead of item.summary,
// since it is strictly more complete. Truncated to a generous but bounded
// length to keep prompt/token cost predictable regardless of report length;
// the system prompt already tells the model to work only from what it's
// given, so a truncated document is handled the same way a short RSS
// description already is — no new instruction needed for this case.
const MAX_EXTRACTED_TEXT_CHARS = 8000;

function buildUserPrompt(item, taxonomy, extractedText) {
  const material = [
    `Title: ${item.title}`,
    extractedText
      ? `Description: ${extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS)}`
      : item.summary
        ? `Description: ${item.summary}`
        : 'Description: (none available)',
  ].join('\n');
  return `${material}\n\n${buildTaxonomyBlock(taxonomy.sectors, taxonomy.usages)}`;
}

const UNCONFIRMED = '미확보';
// Some models produce these instead of the requested Korean placeholder when
// a fact is missing — normalize them too rather than storing an invented
// value or a stray "null"/"none" string.
const UNCONFIRMED_ALIASES = /^(없음|none|null|n\/a|unknown|not stated|not available)$/i;

// Never invents a fact: anything that isn't a genuine non-empty string from
// the model becomes the explicit "미확보" placeholder.
function factOrUnconfirmed(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && !UNCONFIRMED_ALIASES.test(trimmed)) return trimmed;
  }
  return UNCONFIRMED;
}

const FACT_KEYS = ['who', 'what', 'amount', 'when', 'where', 'why', 'impact'];

// who/what/amount/when/where/why/impact are extraction criteria only — they
// ground what the model should consider, but the user-facing ai_summary is
// the model's own natural-language sentence(s), not a labeled dump of these
// fields. This function's job is just to pick a safe value: the model's
// prose when it gave one, otherwise a minimal fallback built ONLY from facts
// that are actually confirmed (never a "미확보" placeholder inside prose,
// never an invented fact).
function buildFactualSummary(facts, modelSummary) {
  const summary = typeof modelSummary === 'string' ? modelSummary.trim() : '';
  if (summary) return summary;

  const what = facts.what !== UNCONFIRMED ? facts.what : '';
  return what || '핵심 사실이 확인되지 않았습니다.';
}

const INSIGHT_FALLBACK = '확인된 사실 외에 특이 동향이나 시사점은 없습니다.';

// Production incident (item 65): eligible=false (article lacked concrete
// facts) but the model still wrote a generic, ungrounded market prediction
// ("UK 식물성 장 건강 시장이 향후 성장할 가능성이 있다.") — an inference the
// title/description didn't actually support. Prompt instructions alone
// don't guarantee grounding, so this counts how many of the 7 extracted
// facts are actually confirmed and treats too few of them as "not enough
// evidence to infer anything from", overriding the model's insight
// regardless of what it wrote. Independent of ai_eligible on purpose — a
// thin article can still supply the couple of facts needed for a grounded
// inference, and eligibility is a separate (and separately fallible) verdict.
const MIN_CONFIRMED_FACTS_FOR_INSIGHT = 2;

function countConfirmedFacts(facts) {
  return FACT_KEYS.filter((key) => facts[key] !== UNCONFIRMED).length;
}

// Even with enough confirmed facts to reason from (passing
// MIN_CONFIRMED_FACTS_FOR_INSIGHT), the model can still overreach: it
// generalizes one company's news into an industry-wide trend, or reads a
// single job-cut figure as evidence of a macro slowdown — neither of which
// the article's facts actually support. These phrases are the recurring
// tell for that overreach (scope words like "업계/산업/시장 전반·전체", or a
// stated macro conclusion like "경기 둔화"/"업계 침체") regardless of how the
// rest of the sentence is worded.
const UNGROUNDED_GENERALIZATION_PATTERN = /(업계|산업|시장)\s*(전반|전체)|경기\s*둔화|(업계|산업)\s*(침체|둔화)/;

function isUngroundedGeneralization(insightText) {
  return UNGROUNDED_GENERALIZATION_PATTERN.test(insightText);
}

// Insight is deliberately the model's own inference (implications, an
// emerging trend, a point worth monitoring) — unlike buildFactualSummary,
// there is no fact-only fallback to construct here, since a bare fact is
// not an insight. Missing/empty, too few grounding facts to trust an
// inference from, or an inference that overreaches into an industry/macro
// claim the article doesn't support, all resolve to the same honest
// fallback rather than fabricating or keeping an unsupported statement.
function resolveInsight(modelInsight, facts) {
  const trimmed = typeof modelInsight === 'string' ? modelInsight.trim() : '';
  if (!trimmed) return INSIGHT_FALLBACK;
  if (countConfirmedFacts(facts) < MIN_CONFIRMED_FACTS_FOR_INSIGHT) return INSIGHT_FALLBACK;
  if (isUngroundedGeneralization(trimmed)) return INSIGHT_FALLBACK;
  return trimmed;
}

// Groq's chat completion API has no JSON-schema enforcement (see
// callGroq in provider.js) — the "strict JSON contract" above is prompt
// text only, so the model frequently emits booleans as quoted strings
// ("eligible": "true") instead of raw JSON booleans. A pure
// `typeof === 'boolean'` check treats every one of those as missing and
// falls back to null, which is what actually happened in production
// (near-total NULL despite the model rendering an answer almost every
// time). This normalizes the common string forms before giving up.
function parseEligible(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

// Publication Quality Gate v1: a final, independent publish-worthiness
// verdict (see the prompt rule above), separate from `eligible`. Fail-closed
// by design — the entire point of this gate is that AI screening/
// classification succeeding is NOT by itself enough to auto-publish, so
// anything the model didn't clearly mark PASS (missing, malformed, an
// unrecognized string, wrong type) becomes HOLD, never a silent PASS.
const QA_DECISIONS = new Set(['PASS', 'HOLD', 'REJECT']);
function parseQaDecision(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (QA_DECISIONS.has(normalized)) return normalized;
  }
  return 'HOLD';
}

// Pure validation: parses the model's raw text, enforces the contract, and
// discards any sector/usage id not present in the taxonomy passed in. Never
// touches the DB — fully unit-testable without a provider or a database.
function parseDraftResponse(raw, taxonomy) {
  let parsed;
  try {
    const cleaned = String(raw)
      .trim()
      .replace(/^```(json)?/i, '')
      .replace(/```$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('AI response was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI response was not a JSON object');
  }

  const facts = Object.fromEntries(FACT_KEYS.map((key) => [key, factOrUnconfirmed(parsed[key])]));
  const summary = buildFactualSummary(facts, parsed.summary);
  const insight = resolveInsight(parsed.insight, facts);
  const keyTakeaway = typeof parsed.key_takeaway === 'string' && parsed.key_takeaway.trim()
    ? parsed.key_takeaway.trim()
    : UNCONFIRMED;

  // Advisory only — a non-boolean verdict means "no recommendation" (null),
  // never a silent false, so Review can tell "AI said no" apart from
  // "AI draft is incomplete/failed to opine".
  const eligible = parseEligible(parsed.eligible);
  const eligibilityReason = typeof parsed.eligibility_reason === 'string' && parsed.eligibility_reason.trim()
    ? parsed.eligibility_reason.trim()
    : UNCONFIRMED;

  const sectorIds = new Set((taxonomy.sectors || []).map((s) => s.id));
  const usageIds = new Set((taxonomy.usages || []).map((u) => u.id));
  const suggestedSectors = Array.isArray(parsed.suggested_sectors)
    ? [...new Set(parsed.suggested_sectors.map(Number))].filter((id) => sectorIds.has(id))
    : [];
  const suggestedUsages = Array.isArray(parsed.suggested_usages)
    ? [...new Set(parsed.suggested_usages.map(Number))].filter((id) => usageIds.has(id))
    : [];

  const qaDecision = parseQaDecision(parsed.publication_decision);
  const qaReason = typeof parsed.publication_reason === 'string' && parsed.publication_reason.trim()
    ? parsed.publication_reason.trim()
    : UNCONFIRMED;

  return { summary, insight, keyTakeaway, eligible, eligibilityReason, facts, suggestedSectors, suggestedUsages, qaDecision, qaReason };
}

async function getTaxonomy() {
  const [{ rows: sectors }, { rows: usages }] = await Promise.all([
    pool.query('SELECT id, name FROM sectors ORDER BY id'),
    pool.query('SELECT id, name FROM usages ORDER BY id'),
  ]);
  return { sectors, usages };
}

// Sanitized for storage/UI: short, human-safe, never a stack trace, API key,
// or raw provider payload.
function sanitizeError(err) {
  const msg = err && err.message ? String(err.message) : 'unknown error';
  return msg.slice(0, 200);
}

// Generates (or retries) the AI draft for one existing item. Writes only to
// ai_* columns — never to summary/insight/item_sectors/item_usages/status,
// so a reviewer's confirmed values or a published item are never touched.
// Safe to call repeatedly: it only ever updates the same row by id, so a
// retry can never create a duplicate item. Never throws — always resolves
// with { ok, error? } so a fire-and-forget caller can't crash on it.
async function generateAiDraftForItem(itemId, providerFn = callProviderWithFallback, extractedText) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [itemId]);
  const item = rows[0];
  if (!item) return { ok: false, error: 'item not found' };

  await pool.query(`UPDATE items SET ai_status = 'pending', ai_error = NULL WHERE id = $1`, [itemId]);

  // Measures only the provider call itself (not the taxonomy fetch or JSON
  // parsing before/after it) — started right before providerFn runs, read
  // in both the success and failure paths below. Stays null if the call
  // never started (e.g. getTaxonomy() itself throws first).
  let providerCallStartedAt;
  try {
    const taxonomy = await getTaxonomy();
    const userPrompt = buildUserPrompt(item, taxonomy, extractedText);
    providerCallStartedAt = Date.now();
    const result = await limitAiCall(() => providerFn({ system: SYSTEM_PROMPT, user: userPrompt }));
    const latencyMs = Date.now() - providerCallStartedAt;
    // providerFn is callProviderWithFallback by default ({ text, provider }),
    // but a caller (e.g. a test, or an explicit single-provider override)
    // may still pass a function returning a bare string — accept both
    // without changing the output contract.
    const raw = typeof result === 'string' ? result : result.text;
    const usedProvider = typeof result === 'string' ? null : result.provider;
    const draft = parseDraftResponse(raw, taxonomy);

    await pool.query(
      `UPDATE items SET
         ai_status = 'completed',
         ai_summary = $1,
         ai_key_takeaway = $2,
         ai_suggested_sectors = $3,
         ai_suggested_usages = $4,
         ai_eligible = $5,
         ai_eligibility_reason = $6,
         ai_insight = $7,
         ai_qa_decision = $8,
         ai_qa_reason = $9,
         ai_error = NULL,
         ai_failure_type = NULL,
         ai_latency_ms = $10,
         ai_generated_at = now()
       WHERE id = $11`,
      [draft.summary, draft.keyTakeaway, draft.suggestedSectors, draft.suggestedUsages, draft.eligible, draft.eligibilityReason, draft.insight, draft.qaDecision, draft.qaReason, latencyMs, itemId]
    );
    // Operational visibility: which provider actually produced this draft
    // (useful once a fallback chain means it isn't always the same one).
    console.log(`AI draft generated for item ${itemId} via ${usedProvider || 'unknown provider'} latency_ms=${latencyMs}`);
    return { ok: true };
  } catch (err) {
    const reason = sanitizeError(err);
    const latencyMs = providerCallStartedAt ? Date.now() - providerCallStartedAt : null;
    // err.failureType (set by provider.js's markFallback) is only present
    // for a provider/transport-level failure (timeout/rate_limit/
    // server_error/auth/network/empty_response) — absent for a downstream
    // application error (e.g. invalid-JSON draft), which is exactly the
    // distinction this field exists to preserve.
    const failureType = err.failureType || null;
    console.error(`AI draft generation failed for item ${itemId}: ${reason} failure_type=${failureType || 'none'} latency_ms=${latencyMs}`);
    await pool.query(
      `UPDATE items SET ai_status = 'failed', ai_error = $1, ai_failure_type = $2, ai_latency_ms = $3 WHERE id = $4`,
      [reason, failureType, latencyMs, itemId]
    );
    return { ok: false, error: reason };
  }
}

// Autonomous-ingestion-only step: applies an already-generated AI draft as
// the item's canonical record and publishes it, with NO human "apply" in
// between. This is the one place in the codebase that copies ai_summary/
// ai_insight into summary/insight and flips status to 'Published' — manual
// entry and Review leave that gap deliberately open for a human to confirm
// (see the ai_* column comments in schema.sql). Called by every ingestion
// path's own collect function — institutionalIngest.js, structuredDataIngest.js,
// webDiscoveryIngest.js, and collector.js's collectSource() (RSS) — right
// after a successful generateAiDraftForItem(), so all four share this one
// gate instead of duplicating the publish decision.
//
// Reuses ai_eligible/ai_eligibility_reason as-is for the archive decision
// and its recorded reason — no new "screening result" column, per the
// instruction to reuse existing ai_* fields rather than add redundant ones.
// ai_suggested_sectors/ai_suggested_usages become the item's actual tags
// the same way a reviewer's "적용" action would, just without a human
// clicking it.
//
// Publication Quality Gate v1: ai_eligible alone (screening/classification
// succeeding) is NOT sufficient to auto-publish — ai_qa_decision must also
// be the literal string 'PASS' (see parseQaDecision: anything else,
// including an item generated before this gate existed where the column is
// NULL, fails closed to HOLD and is excluded here exactly like REJECT).
// HOLD/REJECT items are untouched by this function — they simply stay
// whatever they already were (normally Draft), still fully visible and
// actionable in Review, never silently discarded.
async function applyAiDraftIfEligible(itemId) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [itemId]);
  const item = rows[0];
  if (!item || item.ai_status !== 'completed' || item.ai_eligible !== true || item.ai_qa_decision !== 'PASS') {
    return { archived: false };
  }

  await pool.query('DELETE FROM item_sectors WHERE item_id = $1', [itemId]);
  await pool.query('DELETE FROM item_usages WHERE item_id = $1', [itemId]);
  if (item.ai_suggested_sectors && item.ai_suggested_sectors.length) {
    const values = item.ai_suggested_sectors.map((sid) => `(${itemId}, ${Number(sid)})`).join(',');
    await pool.query(`INSERT INTO item_sectors (item_id, sector_id) VALUES ${values}`);
  }
  if (item.ai_suggested_usages && item.ai_suggested_usages.length) {
    const values = item.ai_suggested_usages.map((uid) => `(${itemId}, ${Number(uid)})`).join(',');
    await pool.query(`INSERT INTO item_usages (item_id, usage_id) VALUES ${values}`);
  }

  // Minimum classification invariant: even an AI-eligible item never
  // auto-publishes without at least one real sector AND usage tag —
  // tags are applied above (from ai_suggested_sectors/usages) before this
  // check, so a normal eligible item with real suggestions is unaffected;
  // this only withholds publication for the edge case where AI returned
  // eligible=true but no (or only invalid) tag suggestions.
  if (!(await hasValidClassification(itemId))) {
    console.log(`applyAiDraftIfEligible: item ${itemId} is AI-eligible but has no sector/usage classification — not publishing`);
    return { archived: false };
  }

  await pool.query(
    `UPDATE items SET summary = $1, insight = $2, content_category = $3, status = 'Published' WHERE id = $4`,
    [item.ai_summary, item.ai_insight, deriveContentCategory(item.type), itemId]
  );

  return { archived: true };
}

module.exports = {
  SYSTEM_PROMPT,
  applyAiDraftIfEligible,
  UNCONFIRMED,
  INSIGHT_FALLBACK,
  buildTaxonomyBlock,
  buildUserPrompt,
  buildFactualSummary,
  resolveInsight,
  isUngroundedGeneralization,
  factOrUnconfirmed,
  parseEligible,
  parseQaDecision,
  parseDraftResponse,
  getTaxonomy,
  sanitizeError,
  generateAiDraftForItem,
};
