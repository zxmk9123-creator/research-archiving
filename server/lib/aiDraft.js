const pool = require('../db/pool');
const { callProvider } = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');

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
{"eligible": boolean, "eligibility_reason": string, "who": string, "what": string, "amount": string, "when": string, "where": string, "why": string, "impact": string, "summary": string, "insight": string, "key_takeaway": string, "suggested_sectors": number[], "suggested_usages": number[]}

Rules:
- eligible: true if this article is substantive enough to be worth archiving for a market-intelligence team (has concrete facts, not just a headline teaser or unrelated content); false otherwise.
- eligibility_reason: one concise Korean sentence explaining the eligible verdict.
- who / what / amount / when / where / why / impact: internal extraction fields, used only as your reasoning criteria for identifying the article's core facts — NOT the final output shown to a person. Fill each ONLY if it is explicitly stated in the given title/description. If a fact is not stated, respond with the exact Korean string "미확보" for that field — do NOT guess, infer, estimate, or fill in a plausible-sounding value.
- summary: a natural, flowing 1-3 sentence Korean summary containing ONLY the article's directly-stated facts (who/what/amount/when/where/why) — NOT a labeled list (do not write "누가:", "무엇을:", etc.), and NOT the place for inference, prediction, evaluation, or impact statements (those belong in "insight" instead). Prioritize concrete, decision-relevant facts (companies, transactions, amounts, volumes, dates, locations) when present. Simply omit any fact that is "미확보" or otherwise unavailable — never mention it, never write "미확보" or a placeholder inside the sentence, and never invent or infer a cause, amount, date, or company that isn't explicitly stated.
- insight: a separate 1-2 sentence Korean field for what goes BEYOND the plain facts — implications, an observable or emerging trend, or a concrete point worth monitoring. It MUST be grounded in and traceable to the specific who/what/amount/when/where/why/impact facts you extracted above from THIS article — never a generic industry/market prediction that could be written about any article in the sector regardless of its actual content. If most of those facts are "미확보" (i.e. this article gave you little concrete to reason from), do not stretch a generic prediction out of the little that's there — plainly say no notable implication is evident instead. This is explicitly your inference, and must read as such (e.g. "~할 가능성이 있다", "~로 이어질 수 있다") rather than being stated as a confirmed fact — never phrase an inference as if it were reported in the article.
- key_takeaway: one concise Korean sentence stating the single most useful insight for a reviewer.
- suggested_sectors: 0-3 ids chosen ONLY from the allowed sector id list given below. Never invent an id or a name that is not listed.
- suggested_usages: 0-3 ids chosen ONLY from the allowed usage id list given below. Never invent an id or a name that is not listed.
- If you cannot confidently choose any tag, return an empty array for that field rather than guessing.
- You are working only from the title/description given — do not claim to have read a full article.
- Output ONLY the JSON object.`;

function buildTaxonomyBlock(sectors, usages) {
  const sectorLines = sectors.map((s) => `${s.id}: ${s.name}`).join('\n');
  const usageLines = usages.map((u) => `${u.id}: ${u.name}`).join('\n');
  return `Allowed sectors (id: name):\n${sectorLines}\n\nAllowed usages (id: name):\n${usageLines}`;
}

// Source material priority: this project has no full-article extraction, so
// the only material ever sent is title + whatever short description/summary
// was already collected (RSS description, or a manually entered summary).
// The prompt above explicitly tells the model not to claim it read more.
function buildUserPrompt(item, taxonomy) {
  const material = [
    `Title: ${item.title}`,
    item.summary ? `Description: ${item.summary}` : 'Description: (none available)',
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

// Insight is deliberately the model's own inference (implications, an
// emerging trend, a point worth monitoring) — unlike buildFactualSummary,
// there is no fact-only fallback to construct here, since a bare fact is
// not an insight. Missing/empty, or too few grounding facts to trust an
// inference from, both resolve to the same honest fallback rather than
// fabricating or keeping an unsupported trend statement.
function resolveInsight(modelInsight, facts) {
  const trimmed = typeof modelInsight === 'string' ? modelInsight.trim() : '';
  if (!trimmed) return INSIGHT_FALLBACK;
  if (countConfirmedFacts(facts) < MIN_CONFIRMED_FACTS_FOR_INSIGHT) return INSIGHT_FALLBACK;
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

  return { summary, insight, keyTakeaway, eligible, eligibilityReason, facts, suggestedSectors, suggestedUsages };
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
async function generateAiDraftForItem(itemId, providerFn = callProvider) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [itemId]);
  const item = rows[0];
  if (!item) return { ok: false, error: 'item not found' };

  await pool.query(`UPDATE items SET ai_status = 'pending', ai_error = NULL WHERE id = $1`, [itemId]);

  try {
    const taxonomy = await getTaxonomy();
    const userPrompt = buildUserPrompt(item, taxonomy);
    const raw = await limitAiCall(() => providerFn({ system: SYSTEM_PROMPT, user: userPrompt }));
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
         ai_error = NULL,
         ai_generated_at = now()
       WHERE id = $8`,
      [draft.summary, draft.keyTakeaway, draft.suggestedSectors, draft.suggestedUsages, draft.eligible, draft.eligibilityReason, draft.insight, itemId]
    );
    return { ok: true };
  } catch (err) {
    const reason = sanitizeError(err);
    console.error(`AI draft generation failed for item ${itemId}: ${reason}`);
    await pool.query(`UPDATE items SET ai_status = 'failed', ai_error = $1 WHERE id = $2`, [reason, itemId]);
    return { ok: false, error: reason };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  UNCONFIRMED,
  INSIGHT_FALLBACK,
  buildTaxonomyBlock,
  buildUserPrompt,
  buildFactualSummary,
  resolveInsight,
  factOrUnconfirmed,
  parseEligible,
  parseDraftResponse,
  getTaxonomy,
  sanitizeError,
  generateAiDraftForItem,
};
