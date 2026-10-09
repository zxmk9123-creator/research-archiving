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
  // status = 'Published' only — never Draft/Rejected/unpublished material.
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name
     FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.status = 'Published' AND (${keywordClauses.join(' OR ')})
     ORDER BY i.published_at DESC NULLS LAST
     LIMIT ${MAX_CANDIDATES}`,
    params
  );
  return rows;
}

// The application owns citations (see the `sources` array built from real
// DB rows below) — the model must never emit its own citation markers,
// since those can't be guaranteed to map back to a real record. Light
// Markdown is still allowed so the client's controlled renderer can turn it
// into real headings/bold/lists instead of a wall of plain text.
const SYSTEM_PROMPT = `You are the AI Research Search assistant for the Oil&Fats Research Center, a Korean oils & fats (유지) market intelligence archive.
Answer the user's question using ONLY the "Research Center materials" supplied in the user message below — never your own outside knowledge, never invented facts, never invented sources or URLs.
Formatting:
- Light Markdown is fine for readability: **bold** for key terms/figures, "- " for a bullet list, "1. " for a numbered list, and a short "#" line for a section heading when the answer has multiple parts.
- Do NOT output any citation marker — no [1], [7], (1), footnote-style references, Markdown links, or raw URLs. The application lists the sources separately; never cite them yourself, by number or otherwise.
Rules:
- If the supplied materials do not contain enough information to answer, say so explicitly in Korean (e.g. "현재 보유한 자료로는 답변하기에 근거가 부족합니다.") instead of guessing or filling gaps with outside knowledge.
- Every factual claim must be grounded in the supplied materials, referred to in plain language (e.g. "관련 자료에 따르면") — never by a number, bracket, or link.
- Clearly separate stated evidence from your own interpretation/inference; phrase inference as such (e.g. "~로 추정됩니다", "~일 가능성이 있습니다"), never as a reported fact.
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

  // Citation links are built from the DB rows we actually sent, never from
  // whatever the model's text claims — the model can't fabricate a URL.
  const sources = candidates.map((c) => ({
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
  res.json({ answer: text, insufficient: false, sources });
});

module.exports = router;
module.exports.extractKeywords = extractKeywords;
module.exports.resolveRetrievalQuery = resolveRetrievalQuery;
module.exports.buildMaterialsBlock = buildMaterialsBlock;
module.exports.buildHistoryBlock = buildHistoryBlock;
module.exports.INSUFFICIENT_MESSAGE = INSUFFICIENT_MESSAGE;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.questionFingerprint = questionFingerprint;
