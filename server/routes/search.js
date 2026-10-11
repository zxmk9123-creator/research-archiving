const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
// Accessed via the module object (not destructured) so tests can mock
// provider.callProviderWithFallback without a real network call, the same
// way pool.query is swapped out below.
const provider = require('../lib/ai/provider');

const router = express.Router();

// Operational telemetry for /api/search, persisted to PostgreSQL
// (ai_search_logs — see schema.sql) so it survives app restart/redeploy,
// unlike the console.error calls below which only ever reached process
// stdout. Metadata only: never the raw question or the AI's answer — see
// questionFingerprint() for the one-way hash used to correlate repeats.
// A telemetry write failure is logged but never allowed to fail or delay
// the actual user-facing response.
function questionFingerprint(question) {
  return crypto.createHash('sha256').update(question).digest('hex').slice(0, 32);
}

async function recordSearchTelemetry(fields) {
  try {
    await pool.query(
      `INSERT INTO ai_search_logs (
         request_id, operation, outcome, http_status, latency_ms,
         candidate_count, source_count, provider, failure_type, is_followup, question_fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        fields.requestId, 'ai_search', fields.outcome, fields.httpStatus, fields.latencyMs,
        fields.candidateCount ?? null, fields.sourceCount ?? null, fields.provider ?? null,
        fields.failureType ?? null, Boolean(fields.isFollowup), fields.questionFingerprint ?? null,
      ]
    );
  } catch (err) {
    console.error('ai-search telemetry write failed:', err.message);
  }
}

// Bounded candidate set — never send the whole table to the LLM.
const MAX_CANDIDATES = 8;
// Minimal conversation context: the last few turns, not persisted anywhere
// (the client holds them in memory only, see renderHome()'s aiSearchHistory).
const MAX_HISTORY_TURNS = 3;

// Simple, reliable retrieval: lowercase word tokens (Unicode-aware, so
// Korean terms work) ILIKE-matched against the same fields the Detail page
// already shows (title/summary/insight + the AI-drafted equivalents) plus
// source/sector/usage names. No new search index, no embeddings.
function extractKeywords(q) {
  return Array.from(new Set(
    String(q || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2)
  )).slice(0, 12);
}

// A context-dependent follow-up ("그 요인을 더 자세히 설명해줘", "그럼 수출량은?")
// typically yields very few real keywords of its own once pronouns/
// demonstratives/generic follow-up phrasing are stripped out — tokenizing
// it alone would retrieve nothing relevant even though the user clearly
// means "more about what we were just discussing". Below this threshold,
// the most recent prior user turn's text is folded in for retrieval only
// (the original question is still what's shown to the LLM and the user) —
// a deterministic, no-extra-LLM-call resolution, not a rewrite.
const MIN_OWN_RETRIEVAL_KEYWORDS = 3;

function resolveRetrievalQuery(question, history) {
  const ownKeywords = extractKeywords(question);
  if (ownKeywords.length >= MIN_OWN_RETRIEVAL_KEYWORDS || !Array.isArray(history) || !history.length) {
    return question;
  }
  const priorUserTurns = history.filter((t) => t && t.role === 'user' && typeof t.content === 'string');
  const lastUserTurn = priorUserTurns[priorUserTurns.length - 1];
  if (!lastUserTurn) return question;
  return `${lastUserTurn.content} ${question}`;
}

async function retrieveCandidates(question, history) {
  const retrievalQuery = resolveRetrievalQuery(question, history);
  const keywords = extractKeywords(retrievalQuery);
  if (!keywords.length) return [];
  const params = [];
  const keywordClauses = keywords.map((kw) => {
    params.push(`%${kw}%`);
    const idx = params.length;
    return `(i.title ILIKE $${idx} OR i.summary ILIKE $${idx} OR i.insight ILIKE $${idx}
      OR i.ai_summary ILIKE $${idx} OR i.ai_insight ILIKE $${idx} OR s.name ILIKE $${idx}
      OR EXISTS (SELECT 1 FROM item_sectors isec JOIN sectors sec ON sec.id = isec.sector_id WHERE isec.item_id = i.id AND sec.name ILIKE $${idx})
      OR EXISTS (SELECT 1 FROM item_usages iu JOIN usages u ON u.id = iu.usage_id WHERE iu.item_id = i.id AND u.name ILIKE $${idx}))`;
  });
  // Production incident: a clearly on-topic item (a Shell/SAF long-term
  // purchase deal, matching 4-5 of a 5-keyword question) never reached the
  // chatbot because ORDER BY published_at DESC NULLS LAST alone ranked
  // every single-keyword match (e.g. anything mentioning "SAF") above it —
  // this item's published_at happened to be NULL, which NULLS LAST sorts
  // dead last, and with ~26 other items sharing just the one keyword "SAF",
  // LIMIT 8 cut it off entirely regardless of how relevant it actually was.
  // relevance_score (how many distinct keywords actually matched) is now
  // the primary sort key, with recency only breaking ties among equally
  // relevant items — a precise multi-keyword question beats a generic
  // single-keyword coincidence regardless of either item's publish date.
  const relevanceExpr = keywordClauses.map((clause) => `(CASE WHEN ${clause} THEN 1 ELSE 0 END)`).join(' + ');
  // status = 'Published' only — never Draft/Rejected/unpublished material.
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name
     FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.status = 'Published' AND (${keywordClauses.join(' OR ')})
     ORDER BY (${relevanceExpr}) DESC, i.published_at DESC NULLS LAST
     LIMIT ${MAX_CANDIDATES}`,
    params
  );
  return rows;
}

// Per-claim traceability: the model must mark, after every sentence that
// states a fact, which numbered "자료 N" it came from (e.g. "...상승했습니다.
// [1]"). The application never trusts the model's prose alone to decide
// which sources get shown — extractCitedIndices() below re-derives the
// actual cited set straight from these markers, and only those candidates
// become `sources`; a candidate the model never leaned on never appears as
// "evidence" for an answer that didn't use it. Markers for an out-of-range
// number (hallucinated) are stripped, never trusted.
const SYSTEM_PROMPT = `You are the AI Research Search assistant for the Oil&Fat Research Center, a Korean oils & fats (유지) market intelligence archive.
Answer the user's question using ONLY the "Research Center materials" supplied in the user message below — never your own outside knowledge, never invented facts, never invented sources or URLs.
Formatting:
- Light Markdown is fine for readability: **bold** for key terms/figures, "- " for a bullet list, "1. " for a numbered list, and a short "#" line for a section heading when the answer has multiple parts.
- Citations are REQUIRED, not optional: after every sentence that states a fact, add [N] where N is the 자료 번호 (e.g. 자료 2 -> [2]) that sentence is actually based on. Use multiple markers like [1][3] if a sentence draws on more than one. Never cite a 자료 번호 that isn't in the supplied materials, and never cite one you didn't actually use for that sentence.
- Do not use any other citation style (no Markdown links, no raw URLs, no footnotes) — only the bracketed 자료 번호.
Rules:
- If the supplied materials do not contain enough information to answer, say so explicitly in Korean (e.g. "현재 보유한 자료로는 답변하기에 근거가 부족합니다.") instead of guessing or filling gaps with outside knowledge.
- Every factual claim must be grounded in the supplied materials and marked with its [N] citation — never stated as fact without one.
- Clearly separate stated evidence from your own interpretation/inference; phrase inference as such (e.g. "~로 추정됩니다", "~일 가능성이 있습니다"), never as a reported fact. An inference sentence may still carry a [N] if it's based on a specific material.
- Be concise and research-oriented — no greetings, no conversational filler, no restating the question.
- If earlier conversation turns are given, treat them as context for a follow-up question, but still ground every claim only in the materials given now.
- Respond in Korean.`;

function buildMaterialsBlock(candidates) {
  return candidates.map((m, i) => [
    `자료 ${i + 1} — 제목: ${m.title}`,
    `출처: ${m.source_name || '미확인'}`,
    `발행일: ${m.published_at ? String(m.published_at).slice(0, 10) : '미확인'}`,
    `요약: ${m.summary || m.ai_summary || '(요약 없음)'}`,
    (m.insight || m.ai_insight) ? `인사이트: ${m.insight || m.ai_insight}` : null,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function buildHistoryBlock(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const turns = history.slice(-MAX_HISTORY_TURNS * 2);
  const lines = turns
    .filter((t) => t && typeof t.content === 'string')
    .map((t) => `${t.role === 'assistant' ? '이전 답변' : '이전 질문'}: ${t.content.slice(0, 500)}`);
  return lines.length ? `[이전 대화]\n${lines.join('\n')}\n\n` : '';
}

const INSUFFICIENT_MESSAGE = '현재 보유한 Research Center 자료로는 이 질문에 답변하기에 근거가 부족합니다. 관련 자료가 추가되면 다시 질문해 주세요.';

// Re-derives which 자료 N were actually cited, straight from the model's
// own [N] markers — never trusted from prose alone. Returns the distinct,
// in-range indices (1-based, matching buildMaterialsBlock's 자료 N) in the
// order they first appear, so citation order drives display order too.
function extractCitedIndices(text, maxIndex) {
  const seen = new Set();
  const ordered = [];
  const re = /\[(\d{1,2})\]/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= maxIndex && !seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  }
  return ordered;
}

// Rewrites the model's [N] markers (numbered against the full candidate
// set sent to it) to [1..k] against `citedIndices`' own order — the order
// `sources` is about to be built in — so a marker in the displayed answer
// always points at the matching position in the displayed source list.
// An out-of-range or otherwise invalid marker (hallucinated) is dropped
// rather than left in the text pointing at nothing.
function remapCitationMarkers(text, citedIndices) {
  const newIndexByOld = new Map(citedIndices.map((orig, i) => [orig, i + 1]));
  return String(text || '').replace(/\[(\d{1,2})\]/g, (whole, digits) => {
    const newIndex = newIndexByOld.get(Number(digits));
    return newIndex ? `[${newIndex}]` : '';
  });
}

// Splits the model's answer into claim units (one per line, matching how
// renderAnswerBlock() on the client already treats lines/list items) and
// keeps only the ones that actually cite something — an uncited line has
// nothing to verify. `maxIndex` bounds extractCitedIndices() the same way
// the main citation pass does, so a hallucinated out-of-range marker never
// reaches the verification prompt either.
function splitClaimLines(text, maxIndex) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ line, indices: extractCitedIndices(line, maxIndex) }))
    .filter((c) => c.indices.length > 0);
}

// A focused, structured-output check — never asked to write prose, only to
// flag claim numbers — so a single extra provider call can verify many
// claims at once instead of one call per claim.
const VERIFICATION_SYSTEM_PROMPT = `You check whether a claim is genuinely supported by the material(s) cited for it — not just topically related to the same general subject, but actually stating what the claim says. A claim about biofuel policy citing a material that is only about food-price inflation, for example, is NOT supported even though both are oils & fats topics.
For each numbered claim below, with the material(s) cited for it, decide whether those materials genuinely support the claim.
Respond with ONLY a JSON array of the claim numbers that are NOT supported by their cited material(s) — e.g. [2,5] — or [] if every claim is supported. No other text, no explanation.`;

function buildVerificationPrompt(claims, candidates) {
  return claims.map((c, i) => {
    const materialsText = c.indices.map((idx) => {
      const m = candidates[idx - 1];
      return `자료 ${idx}: ${m.summary || m.ai_summary || m.insight || m.ai_insight || '(내용 없음)'}`;
    }).join('\n');
    const claimText = c.line.replace(/\[\d{1,2}\]/g, '').trim();
    return `주장 ${i + 1}: "${claimText}"\n인용된 자료:\n${materialsText}`;
  }).join('\n\n');
}

// Defensive parse of the verification call's response — a malformed or
// non-JSON reply (or anything outside 1..claimCount) is treated as "flags
// nothing", not as an error, so a verification-call hiccup never corrupts
// the answer that's about to go out.
function parseUnsupportedClaimNumbers(verificationText, claimCount) {
  const match = String(verificationText || '').match(/\[[\d,\s]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((n) => Number.isInteger(n) && n >= 1 && n <= claimCount);
  } catch {
    return [];
  }
}

// Second-pass check layered on top of the base answer: a [N] marker only
// proves the model POINTED at a material, never that the material backs
// that specific sentence (the gap a reviewer flagged — a biofuel-policy
// claim citing a food-inflation article purely on topical overlap). This
// re-asks the model, focused only on claim-vs-material support, and
// strips the citation marker(s) from any claim it flags as unsupported —
// the sentence stays, it just stops claiming that material as evidence.
// Fails open (changes nothing) on any error or unparseable response: this
// is a quality layer on the base answer, never allowed to break it.
async function verifyCitations(text, candidates) {
  const claims = splitClaimLines(text, candidates.length);
  if (!claims.length) return text;
  try {
    const result = await provider.callProviderWithFallback({
      system: VERIFICATION_SYSTEM_PROMPT,
      user: buildVerificationPrompt(claims, candidates),
    });
    const unsupported = parseUnsupportedClaimNumbers(result.text, claims.length);
    if (!unsupported.length) return text;
    let corrected = text;
    for (const n of unsupported) {
      const { line } = claims[n - 1];
      corrected = corrected.replace(line, line.replace(/\[\d{1,2}\]/g, '').trim());
    }
    return corrected;
  } catch (err) {
    console.error('ai-search citation verification failed:', err.message);
    return text;
  }
}

router.post('/', async (req, res) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const isFollowup = Array.isArray(req.body.history) && req.body.history.length > 0;

  // Not logged to ai_search_logs — an empty query never reaches retrieval
  // or the provider, so there's no operation to report telemetry for
  // (existing callers/tests rely on this guard touching the DB at all).
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  if (!question) return res.status(400).json({ error: '질문을 입력해 주세요.' });
  const fingerprint = questionFingerprint(question);

  let candidates;
  try {
    candidates = await retrieveCandidates(question, req.body.history);
  } catch (err) {
    console.error('ai-search retrieval failed:', err.message);
    const httpStatus = 500;
    await recordSearchTelemetry({ requestId, outcome: 'retrieval_error', httpStatus, latencyMs: Date.now() - startedAt, isFollowup, questionFingerprint: fingerprint });
    return res.status(httpStatus).json({ error: '검색 중 오류가 발생했습니다.' });
  }

  if (!candidates.length) {
    const httpStatus = 200;
    await recordSearchTelemetry({
      requestId, outcome: 'insufficient_evidence', httpStatus, latencyMs: Date.now() - startedAt,
      candidateCount: 0, sourceCount: 0, isFollowup, questionFingerprint: fingerprint,
    });
    return res.status(httpStatus).json({ answer: INSUFFICIENT_MESSAGE, insufficient: true, sources: [] });
  }

  const user = `${buildHistoryBlock(req.body.history)}[Research Center materials]\n${buildMaterialsBlock(candidates)}\n\n[Question]\n${question}`;

  let text;
  let providerName;
  try {
    const result = await provider.callProviderWithFallback({ system: SYSTEM_PROMPT, user });
    text = result.text;
    providerName = result.provider;
  } catch (err) {
    // Never leak provider credentials/internal error details to the browser.
    console.error('ai-search provider failed:', err.message);
    const httpStatus = 502;
    await recordSearchTelemetry({
      requestId, outcome: 'provider_error', httpStatus, latencyMs: Date.now() - startedAt,
      candidateCount: candidates.length, failureType: err.failureType || null, isFollowup, questionFingerprint: fingerprint,
    });
    return res.status(httpStatus).json({ error: 'AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  // Verify each citation against its claim before deciding what counts as
  // "actually cited" below — an unsupported citation gets its marker
  // stripped here, so it naturally falls out of `sources` below rather
  // than needing a separate filter pass.
  text = await verifyCitations(text, candidates);

  // Citation links are built from the DB rows we actually sent, never from
  // whatever the model's text claims — the model can't fabricate a URL.
  // Which candidates become `sources` is further narrowed to only the ones
  // the model's own [N] markers actually cited — a retrieved-but-unused
  // candidate never gets shown as "evidence" for an answer that didn't
  // draw on it. If the model cited nothing (missed the instruction), fall
  // back to showing every retrieved candidate rather than an empty list.
  const citedIndices = extractCitedIndices(text, candidates.length);
  const citedCandidates = citedIndices.length ? citedIndices.map((i) => candidates[i - 1]) : candidates;
  const answer = citedIndices.length ? remapCitationMarkers(text, citedIndices) : text;
  const sources = citedCandidates.map((c) => ({
    id: c.id,
    title: c.title,
    source: c.source_name || null,
    published_at: c.published_at,
  }));
  const httpStatus = 200;
  await recordSearchTelemetry({
    requestId, outcome: 'success', httpStatus, latencyMs: Date.now() - startedAt,
    candidateCount: candidates.length, sourceCount: sources.length, provider: providerName,
    isFollowup, questionFingerprint: fingerprint,
  });
  res.json({ answer, insufficient: false, sources });
});

module.exports = router;
module.exports.extractKeywords = extractKeywords;
module.exports.resolveRetrievalQuery = resolveRetrievalQuery;
module.exports.buildMaterialsBlock = buildMaterialsBlock;
module.exports.buildHistoryBlock = buildHistoryBlock;
module.exports.INSUFFICIENT_MESSAGE = INSUFFICIENT_MESSAGE;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.questionFingerprint = questionFingerprint;
module.exports.extractCitedIndices = extractCitedIndices;
module.exports.remapCitationMarkers = remapCitationMarkers;
module.exports.splitClaimLines = splitClaimLines;
module.exports.parseUnsupportedClaimNumbers = parseUnsupportedClaimNumbers;
module.exports.VERIFICATION_SYSTEM_PROMPT = VERIFICATION_SYSTEM_PROMPT;
