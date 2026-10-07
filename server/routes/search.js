const express = require('express');
const pool = require('../db/pool');
// Accessed via the module object (not destructured) so tests can mock
// provider.callProviderWithFallback without a real network call, the same
// way pool.query is swapped out below.
const provider = require('../lib/ai/provider');

const router = express.Router();

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

async function retrieveCandidates(question) {
  const keywords = extractKeywords(question);
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

const SYSTEM_PROMPT = `You are the AI Research Search assistant for the Oil&Fats Research Center, a Korean oils & fats (유지) market intelligence archive.
Answer the user's question using ONLY the "Research Center materials" supplied in the user message below — never your own outside knowledge, never invented facts, never invented sources or URLs.
Rules:
- If the supplied materials do not contain enough information to answer, say so explicitly in Korean (e.g. "현재 보유한 자료로는 답변하기에 근거가 부족합니다.") instead of guessing or filling gaps with outside knowledge.
- Every factual claim must be traceable to one of the supplied materials — refer to them by their [번호] (e.g. [1], [2]) when citing.
- Clearly separate stated evidence from your own interpretation/inference; phrase inference as such (e.g. "~로 추정됩니다", "~일 가능성이 있습니다"), never as a reported fact.
- Be concise and research-oriented — no greetings, no conversational filler, no restating the question.
- If earlier conversation turns are given, treat them as context for a follow-up question, but still ground every claim only in the materials given now.
- Respond in Korean.`;

function buildMaterialsBlock(candidates) {
  return candidates.map((m, i) => [
    `[${i + 1}] 제목: ${m.title}`,
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
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  if (!question) return res.status(400).json({ error: '질문을 입력해 주세요.' });

  let candidates;
  try {
    candidates = await retrieveCandidates(question);
  } catch (err) {
    console.error('ai-search retrieval failed:', err.message);
    return res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
  }

  if (!candidates.length) {
    return res.json({ answer: INSUFFICIENT_MESSAGE, insufficient: true, sources: [] });
  }

  const user = `${buildHistoryBlock(req.body.history)}[Research Center materials]\n${buildMaterialsBlock(candidates)}\n\n[Question]\n${question}`;

  let text;
  try {
    const result = await provider.callProviderWithFallback({ system: SYSTEM_PROMPT, user });
    text = result.text;
  } catch (err) {
    // Never leak provider credentials/internal error details to the browser.
    console.error('ai-search provider failed:', err.message);
    return res.status(502).json({ error: 'AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  // Citation links are built from the DB rows we actually sent, never from
  // whatever the model's text claims — the model can't fabricate a URL.
  res.json({
    answer: text,
    insufficient: false,
    sources: candidates.map((c) => ({
      id: c.id,
      title: c.title,
      source: c.source_name || null,
      published_at: c.published_at,
    })),
  });
});

module.exports = router;
module.exports.extractKeywords = extractKeywords;
module.exports.buildMaterialsBlock = buildMaterialsBlock;
module.exports.buildHistoryBlock = buildHistoryBlock;
module.exports.INSUFFICIENT_MESSAGE = INSUFFICIENT_MESSAGE;
