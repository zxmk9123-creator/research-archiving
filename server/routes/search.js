const express = require('express');
const crypto = require('crypto');
const numberCheck = require('../lib/numberCheck');
const { titleSimilarity } = require('../lib/similarity');
const tableCheck = require('../lib/tableCheck');
const requestCompliance = require('../lib/requestCompliance');
const datasetPipeline = require('../lib/datasetPipeline');
const workloadPlan = require('../lib/workloadPlan');
const { classifyIntent, ENTITY_NOUN } = require('../lib/intent');
const { canonicalizeProperNouns } = require('../lib/nameFix');
const itemFacts = require('../lib/itemFacts');
const pool = require('../db/pool');
// Accessed via the module object (not destructured) so tests can mock
// provider.callProviderWithFallback without a real network call, the same
// way pool.query is swapped out below.
const provider = require('../lib/ai/provider');
const { createLimiter } = require('../lib/ai/concurrencyLimiter');

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
         candidate_count, source_count, provider, failure_type, is_followup, question_fingerprint,
         ttft_ms, streamed, model_used
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        fields.requestId, 'ai_search', fields.outcome, fields.httpStatus, fields.latencyMs,
        fields.candidateCount ?? null, fields.sourceCount ?? null, fields.provider ?? null,
        fields.failureType ?? null, Boolean(fields.isFollowup), fields.questionFingerprint ?? null,
        fields.ttftMs ?? null, Boolean(fields.streamed), fields.model ?? null,
      ]
    );
  } catch (err) {
    console.error('ai-search telemetry write failed:', err.message);
  }
}

// ===========================================================================
// AI CHATBOT OPERATING PRINCIPLES (운영 원칙) — product-agnostic. Nothing below is tied
// to SAF, a company or a commodity; those only appear in examples and test fixtures.
// Each principle names the module that enforces it and the test file that proves it.
//
//  O1  Intent decides the work (lib/intent.js): one named company -> focused profile;
//      several -> exactly those compared; an aggregate question with no name -> the
//      roster; anything else -> plain answer. A generic noun never starts a sweep.
//  O2  Retrieval follows the topic, not the phrasing (this file, P1-P9 above): concepts,
//      language-fair candidates, member/subject coverage, near-duplicate dropping.
//  O3  Quantities are verified, not trusted (lib/numberCheck.js): every figure is checked
//      against its cited material in a unit-aware way; scale slips are corrected from the
//      source, inventions flagged; model-derived parentheticals dropped.
//  O4  Quantity comparisons are built in code (lib/datasetPipeline.js): extract -> verify
//      -> convert -> table + chart, for any entity/metric/unit group (mass, volume, money);
//      the writer's own table/chart are replaced by the verified ones.
//  O5  Presentation is consistent (lib/tableCheck.js, enrichChartJson): one unit and format
//      per column, mixed units annotated, chart == table, one state vocabulary.
//  O6  The user's explicit request is enforced (lib/requestCompliance.js): chart kind, unit,
//      a chart when asked for, completeness.
//  O7  Big jobs are confirmed first (lib/workloadPlan.js): quantity datasets, whole-roster
//      sweeps and long reports show a scope card (quick = recommended, full = one click).
//  O8  Answers always end complete (trimToCompleteBlock/completeTruncatedAnswer): a cut-off
//      is continued once or trimmed to the last whole block — never shown as an error.
//  O9  Names and text are clean (lib/nameFix.js, stripStrayScripts, citation normalisation).
//  O10 Latency and tokens are managed, not capped: parallel dataset + writer, hedged
//      non-streaming calls, stall retry, deterministic-first verification, tiered evidence
//      budget, answer cache, compact system prompt.
// ===========================================================================

// Bounded candidate set — never send the whole table to the LLM.
const MAX_CANDIDATES = 12;
// Minimal conversation context: the last few turns, not persisted anywhere
// (the client holds them in memory only, see renderHome()'s aiSearchHistory).
const MAX_HISTORY_TURNS = 3;

// Production incident: "국내 e-SAF 생산에 참여하는 기관 및 기업들" found nothing,
// while a differently-worded question whose own text happened to contain
// "e-SAF 생산" verbatim did. Root cause: extractKeywords kept each token's
// exact inflected form ("참여하는", "기업들"), so a candidate whose text says
// "참여" or "참여했다" or "기업" (no 들) never matched a plain ILIKE %참여하는%
// — not a relevance problem, a literal-substring-vs-conjugation mismatch.
// Below, each token also contributes its stem (common particle/verb-ending
// stripped) as an extra keyword — e.g. "참여하는" -> "참여", "기업들" -> "기업"
// — so inflected question wording still matches a candidate's own (possibly
// differently-conjugated) wording. This is pure string processing against
// the already-tokenized question, so it adds no network/LLM call and no
// serial latency: retrieveCandidates' per-keyword docFreq lookups already
// run in parallel (Promise.all), so a few more keywords only add more
// concurrent fast index-backed queries, not more wall-clock time.
const KOREAN_STRIPPABLE_SUFFIXES = [
  '습니다', '했습니다', '됩니다', '입니다', '하였다', '되었다', '이었다',
  '하는', '했던', '한다', '했다', '하고', '하며', '되는', '되어', '했고',
  '에서', '으로', '에게', '한테', '부터', '까지', '에는', '이나', '라는',
  '은', '는', '이', '가', '을', '를', '의', '와', '과', '도', '만', '들', '로', '나', '란', '에',
].sort((a, b) => b.length - a.length); // longest suffix checked first

function stemKorean(word) {
  // Up to two passes: plural + particle stack ("식용유지들의" -> "식용유지들" -> "식용유지").
  let stem = word;
  for (let pass = 0; pass < 2; pass++) {
    const suffix = KOREAN_STRIPPABLE_SUFFIXES.find((x) => stem.length - x.length >= 2 && stem.endsWith(x));
    if (!suffix) break;
    stem = stem.slice(0, -suffix.length);
  }
  return stem;
}

// Root cause of a real miss: "국내 e-SAF 생산 현황" never surfaced e-SAF
// material and instead returned generic/AtJ/ethanol-based SAF articles.
// The OLD tokenizer stripped every non-letter/non-digit character
// (including hyphens) before splitting on whitespace, so "e-SAF" became
// "e SAF" — and "e" (1 char) was then dropped by the length>=2 filter,
// collapsing "e-SAF" down to the same generic "saf" keyword a plain "SAF"
// question would produce. With that prefix gone, nothing in the keyword
// set could distinguish an e-SAF-specific article from the far more
// numerous AtJ/ethanol-based/generic SAF ones — "saf" alone has high
// corpus frequency (low IDF weight) and ranks whatever the biggest SAF
// subtype in the archive happens to be, not necessarily e-SAF.
// Hyphens between letters/digits are now preserved as part of the token
// ("e-saf" survives as its own keyword, rare → high IDF weight → ranks
// e-SAF-tagged material above generic SAF), while STILL adding the
// hyphen-stripped parts ("saf") as fallback keywords so a broader
// question keeps matching broader material too.
// ===========================================================================
// RETRIEVAL PRINCIPLES (대원칙) — these hold for EVERY question, not for any
// particular word. Each was learned from a real miss; each is enforced by a
// topic-independent test in test/searchRoute.test.js.
//
//  P1 Topic over phrasing. Only content-bearing terms drive retrieval. How a
//     question is asked ("~에 대해 알려줘", "tell me about") is a closed
//     grammatical/pragmatic class and is removed — never a topic word.
//  P2 One concept, many spellings. A term and its trivial variants (particle
//     glued on, inflected, hyphen/space/no-space) are ONE concept.
//  P3 Concepts, not strings. A concept scores once (its best-matching form),
//     so listing more spellings can never inflate a score; weight is by
//     rarity in this archive (IDF).
//  P4 Language-fair candidates. Relevant material in either language
//     (Korean / non-Korean) must reach the model; one language may not fill
//     every slot while relevant material in the other is left out.
//  P5 Partial evidence still answers. When relevant but incomplete material
//     exists, answer what it supports and name what it doesn't cover —
//     blanket abstention is reserved for "nothing relevant at all".
//  P6 Never silently empty. If filtering would leave nothing to search, fall
//     back to the unfiltered terms.
// ===========================================================================

// P1: closed classes only. (a) request/interrogative morphology that applies
// to ANY verb ("알려줘", "정리해줘", "보여주세요"), (b) "about/regarding"
// postpositional forms, (c) a short list of meta-question words, (d) common
// English function/question words. Topic vocabulary is never listed here.
const QUESTION_FRAMING_PATTERNS = [
  /(줘|주세요|주라|달라|줄래|줄까)$/,
  /^(대해서?|대하여|대한|관해서?|관하여|관한|관련|관련된|관련해서)$/,
  /^(어떻게|어떤|어떠한|어떨까|무엇|뭐|뭐야|뭔가|뭔지|왜|언제|어디|누가|얼마)$/,
];
const QUESTION_FRAMING_TERMS = new Set([
  '구체적', '구체적으로', '구체', '자세히', '상세히', '상세', '간단히', '쉽게', '대략', '전반', '전반적',
  // request-for-output words (any topic): asking for a chart/table/analysis is
  // not itself a topic and used to pull in unrelated "analysis" articles
  '그래프', '차트', '도표', '시각화', '그림', '그려', '그리', '만들', '작성', '비교', '비교분석', '분석', '표로', '정리',
  'chart', 'graph', 'plot', 'table', 'visualize', 'visualization', 'compare', 'comparison', 'analysis',
  // data-request words
  '데이터', '자료', '전체', '모든', '가져', '가져와', '불러', '찾아',
  '알려', '알고', '설명', '궁금', '질문', '내용', '정보', '개념', '정의', '의미', '있는지', '있나요', '인가요', '인지', '부탁',
  'tell', 'about', 'explain', 'please', 'what', 'how', 'why', 'when', 'where', 'who', 'which',
  'give', 'show', 'describe', 'detail', 'details', 'information', 'overview', 'the', 'and', 'for', 'are', 'is',
  'of', 'in', 'on', 'to', 'or', 'an', 'do', 'does', 'can', 'could', 'would', 'should', 'me', 'my', 'with', 'from',
]);
function isQuestionFraming(token) {
  return QUESTION_FRAMING_TERMS.has(token) || QUESTION_FRAMING_PATTERNS.some((re) => re.test(token));
}

// P2: trivial spelling variants of a hyphenated Latin compound.
function spellingVariants(token) {
  const variants = new Set([token]);
  if (/[a-z]/.test(token) && token.includes('-')) {
    variants.add(token.replace(/-/g, ''));
    variants.add(token.replace(/-/g, ' '));
  }
  return Array.from(variants);
}

const MAX_CONCEPTS = 16;

// Returns concepts: each is an array of surface forms treated as ONE concept
// (P2). A hyphenated compound keeps its parts as separate, more generic
// concepts so a broader question still matches broader material.
function extractConcepts(q) {
  const tokens = String(q || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    // A Korean particle glued to a Latin/number term ("e-SAF에", "SAF를") would
    // be one useless token ("saf에"); split at every Latin<->Hangul boundary.
    .replace(/([a-z0-9-])([가-힣])/g, '$1 $2')
    .replace(/([가-힣])([a-z0-9])/g, '$1 $2')
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, '')) // stray leading/trailing hyphens (e.g. a bare "-" bullet)
    .filter((w) => w.replace(/-/g, '').length >= 2);

  const build = (usable) => {
    const concepts = new Map();
    const add = (forms) => { if (!concepts.has(forms[0])) concepts.set(forms[0], forms); };
    for (const token of usable) {
      if (token.includes('-')) {
        add(spellingVariants(token));
        for (const part of token.split('-')) if (part.length >= 2) add([part]);
      } else {
        const stem = stemKorean(token);
        add(stem === token ? [token] : [token, stem]);
      }
    }
    return Array.from(concepts.values()).slice(0, MAX_CONCEPTS);
  };

  const topical = build(tokens.filter((t) => !isQuestionFraming(t) && !isQuestionFraming(stemKorean(t))));
  return topical.length ? topical : build(tokens); // P6
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
  const ownKeywords = extractConcepts(question);
  if (ownKeywords.length >= MIN_OWN_RETRIEVAL_KEYWORDS || !Array.isArray(history) || !history.length) {
    return question;
  }
  const priorUserTurns = history.filter((t) => t && t.role === 'user' && typeof t.content === 'string');
  const lastUserTurn = priorUserTurns[priorUserTurns.length - 1];
  if (!lastUserTurn) return question;
  return `${lastUserTurn.content} ${question}`;
}

// How many Published items a single keyword matches, searched against the
// exact same fields retrieveCandidates() itself searches (so the weighting
// below reflects this corpus, not a general-language assumption).
async function conceptDocFrequency(forms) {
  const pats = forms.map((f) => `%${f}%`);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS cnt FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.status = 'Published' AND (
       i.title ILIKE ANY($1) OR i.summary ILIKE ANY($1) OR i.insight ILIKE ANY($1)
       OR i.ai_summary ILIKE ANY($1) OR i.ai_insight ILIKE ANY($1) OR s.name ILIKE ANY($1)
       OR EXISTS (SELECT 1 FROM item_sectors isec JOIN sectors sec ON sec.id = isec.sector_id WHERE isec.item_id = i.id AND sec.name ILIKE ANY($1))
       OR EXISTS (SELECT 1 FROM item_usages iu JOIN usages u ON u.id = iu.usage_id WHERE iu.item_id = i.id AND u.name ILIKE ANY($1))
     )`,
    [pats]
  );
  // A real COUNT(*) always returns exactly one row, but defend anyway —
  // an empty result defaults to "never seen" (docFreq 0), which gives
  // that concept the maximum possible weight rather than crashing
  // retrieval entirely over one malformed count.
  return rows[0]?.cnt ?? 0;
}

// P4: SQL returns a wider, relevance-ordered pool; this picks the final
// MAX_CANDIDATES so neither language can monopolize the slots. Each
// language present among sufficiently relevant rows (score >= 35% of the
// best) gets up to MIN_PER_LANGUAGE reserved slots; the rest are filled by
// pure rank. Order stays by relevance. A row's language is judged from its
// title (Hangul share of letters).
const CANDIDATE_POOL = 60;
const MIN_PER_LANGUAGE = 4;
const RELEVANCE_FLOOR_RATIO = 0.35;
function languageOf(row) {
  const letters = String(row.title || '').match(/\p{L}/gu) || [];
  const hangul = String(row.title || '').match(/[가-힣]/g) || [];
  return letters.length && hangul.length / letters.length >= 0.3 ? 'ko' : 'other';
}
function selectDiverseCandidates(rows, max = MAX_CANDIDATES) {
  if (rows.length <= max) return rows;
  const top = Number(rows[0].relevance_score) || 0;
  const eligible = rows.filter((r) => (Number(r.relevance_score) || 0) >= top * RELEVANCE_FLOOR_RATIO);
  const picked = new Set();
  const byLanguage = new Map();
  for (const r of eligible) {
    const lang = languageOf(r);
    if (!byLanguage.has(lang)) byLanguage.set(lang, []);
    byLanguage.get(lang).push(r);
  }
  for (const list of byLanguage.values()) list.slice(0, MIN_PER_LANGUAGE).forEach((r) => picked.add(r));
  for (const r of rows) { if (picked.size >= max) break; picked.add(r); }
  return rows.filter((r) => picked.has(r)).slice(0, max);
}

// P7 Coverage of named groups. A question about a GROUP ("식용유지들의 생산량")
// is really about its members (팜유, 대두유, ...). The sector taxonomy already
// encodes that hierarchy, so a concept that names a parent sector is expanded
// to its child sectors, and each member gets its own small retrieval slot —
// otherwise one member's articles fill the whole candidate list and the answer
// (and any chart) covers a single target.
const MAX_TARGETS = 6;
const PER_TARGET = 2;
// Hard ceiling on what reaches the model after all coverage additions (prompt size/latency bound).
const MAX_TOTAL_CANDIDATES = 24;
// A concept present in at most this many Published items is a "specific" subject (an entity), not a topic word.
const SPECIFIC_DOCFREQ = 250;
async function taxonomyTargets(concepts) {
  const forms = Array.from(new Set(concepts.flat().map((f) => f.toLowerCase())));
  if (!forms.length) return [];
  try {
    const { rows } = await pool.query(
      `SELECT c.name FROM sectors p JOIN sectors c ON c.parent_id = p.id
       WHERE lower(p.name) = ANY($1) ORDER BY c.id LIMIT ${MAX_TARGETS}`,
      [forms]
    );
    return rows.map((r) => r.name).filter(Boolean);
  } catch (_) {
    return []; // expansion is an enhancement; never fail retrieval over it
  }
}
async function retrieveForTarget(target, otherForms) {
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name, 0 AS relevance_score
     FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.status = 'Published' AND (i.title ILIKE $1 OR i.summary ILIKE $1 OR i.insight ILIKE $1 OR i.ai_summary ILIKE $1 OR i.ai_insight ILIKE $1)
     ORDER BY ((i.title ILIKE $1)::int + (CASE WHEN (i.summary ILIKE ANY($2) OR i.ai_summary ILIKE ANY($2) OR i.title ILIKE ANY($2)) THEN 2 ELSE 0 END)) DESC, i.published_at DESC NULLS LAST
     LIMIT ${PER_TARGET}`,
    [`%${target}%`, otherForms.length ? otherForms.map((f) => `%${f}%`) : ['%%']]
  );
  return rows;
}

// P9 Collective questions cover the whole roster. "글로벌 정유업체의 전체 SAF
// CAPA", "major producers", "기업별 ..." name NO company, so term matching alone
// surfaces whichever few companies happen to use the question's exact words
// (a real answer covered 4 companies while the archive held 9+). When the
// question speaks of companies in general, every watchlist company (the
// `companies` table, with aliases) gets its own slots, ranked by overlap with
// the question's other terms.
// (Intent — entity / peers / collective / general — is decided by lib/intent.js from what the
// question NAMES; a generic noun such as "업체" no longer starts a roster sweep.)
const MAX_WATCHLIST = 40;
const PER_COMPANY = 2; // roster sweep: fewer rows per company so a long roster stays within the prompt budget
async function retrieveForWatchlist(otherForms) {
  let companies;
  try {
    ({ rows: companies } = await pool.query(
      `SELECT id, name, aliases FROM companies WHERE watched = true ORDER BY id LIMIT ${MAX_WATCHLIST}`
    ));
  } catch (_) {
    return [];
  }
  const out = [];
  if (!otherForms.length) return []; // nothing besides "companies" to anchor relevance on
  const others = otherForms.map((f) => `%${f}%`);
  for (const c of companies) {
    const pats = [c.name, ...(c.aliases || [])].filter((n) => n && n.trim().length >= 3).map((n) => `%${n.trim()}%`);
    if (!pats.length) continue;
    try {
      const { rows } = await pool.query(
        `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name, 0 AS relevance_score
         FROM items i LEFT JOIN sources s ON s.id = i.source_id
         WHERE i.status = 'Published' AND (
           i.title ILIKE ANY($1) OR i.summary ILIKE ANY($1) OR i.ai_summary ILIKE ANY($1)
           OR EXISTS (SELECT 1 FROM item_companies ic WHERE ic.item_id = i.id AND ic.company_id = $3))
           AND (i.title ILIKE ANY($2) OR i.summary ILIKE ANY($2) OR i.ai_summary ILIKE ANY($2) OR i.insight ILIKE ANY($2) OR i.ai_insight ILIKE ANY($2))
         ORDER BY ((CASE WHEN (i.summary ILIKE ANY($2) OR i.ai_summary ILIKE ANY($2) OR i.insight ILIKE ANY($2) OR i.ai_insight ILIKE ANY($2)) THEN 2 ELSE 0 END)
                   + (CASE WHEN i.title ILIKE ANY($2) THEN 1 ELSE 0 END)
                   + (CASE WHEN i.title ILIKE ANY($1) THEN 1 ELSE 0 END)) DESC, i.published_at DESC NULLS LAST
         LIMIT ${PER_COMPANY}`,
        [pats, others, c.id]
      );
      out.push(...rows);
    } catch (_) { /* best-effort per company */ }
  }
  return out;
}

// Syndicated copies of one story ("Neste starts SAF production in Rotterdam" x3) crowd
// out distinct evidence; keep the best-ranked of each near-identical title group.
function dropNearDuplicates(rows, threshold = 0.7) {
  const kept = [];
  for (const r of rows) if (!kept.some((k) => titleSimilarity(k.title, r.title) >= threshold)) kept.push(r);
  return kept;
}

async function retrieveCandidates(question, history, { light = false } = {}) {
  const retrievalQuery = resolveRetrievalQuery(question, history);
  const concepts = extractConcepts(retrievalQuery);
  if (!concepts.length) return [];

  // Production incident: a question naming a specific entity (e.g. "PT
  // Danantara Sumberdaya Indonesia(DSI)") plus a generic framing word
  // ("피해보는" harmed) retrieved 8 OTHER Indonesia/palm-oil articles that
  // merely matched the generic keywords "indonesia"/"pt" (Indonesian
  // company-name prefix, appears constantly) and generic Korean connector
  // words like "인해"/"기업이" (appear in countless unrelated summaries) —
  // each counting as a FULL point, same as the one keyword ("dsi") that
  // actually, specifically identified the right article. The single
  // article that literally named DSI and described the exact margin
  // pressure being asked about scored only 2 matches and never made the
  // top MAX_CANDIDATES cut, even though it was the best answer available.
  // Each keyword's weight is now 1 / log2(docFreq + 2) — a keyword only a
  // handful of Published items contain (a specific entity name) counts far
  // more than one most of the corpus contains (a country name, a common
  // corporate prefix, an ordinary connector word), without needing a
  // hand-maintained stopword list for either language.
  const docFreqs = await Promise.all(concepts.map(conceptDocFrequency));
  const weights = docFreqs.map((cnt) => 1 / Math.log2(cnt + 2));

  const params = [];
  // One clause per CONCEPT (P2/P3): a concept's forms are OR'd inside a single
  // clause, so its weight is added at most once however many spellings match.
  const keywordClauses = concepts.map((forms) => {
    const idxs = forms.map((form) => {
      params.push(`%${form}%`);
      return params.length;
    });
    const perForm = (idx) => `(i.title ILIKE $${idx} OR i.summary ILIKE $${idx} OR i.insight ILIKE $${idx}
      OR i.ai_summary ILIKE $${idx} OR i.ai_insight ILIKE $${idx} OR s.name ILIKE $${idx}
      OR EXISTS (SELECT 1 FROM item_sectors isec JOIN sectors sec ON sec.id = isec.sector_id WHERE isec.item_id = i.id AND sec.name ILIKE $${idx})
      OR EXISTS (SELECT 1 FROM item_usages iu JOIN usages u ON u.id = iu.usage_id WHERE iu.item_id = i.id AND u.name ILIKE $${idx}))`;
    return `(${idxs.map(perForm).join(' OR ')})`;
  });
  // relevance_score is now a weighted sum (keyword specificity), not a
  // flat count — recency still only breaks ties among equally relevant
  // items, same as before.
  const relevanceExpr = keywordClauses.map((clause, i) => `(CASE WHEN ${clause} THEN ${weights[i]} ELSE 0 END)`).join(' + ');
  // status = 'Published' only — never Draft/Rejected/unpublished material.
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name,
            (${relevanceExpr}) AS relevance_score
     FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.status = 'Published' AND (${keywordClauses.join(' OR ')})
     ORDER BY (${relevanceExpr}) DESC, i.published_at DESC NULLS LAST
     LIMIT ${CANDIDATE_POOL}`,
    params
  );
  const base = selectDiverseCandidates(dropNearDuplicates(rows));
  // P8 Every specific subject gets a seat. In a multi-subject question
  // ("Neste, Eni, Chevron의 ... 비교") the top-ranked rows can all belong to
  // one subject. For each rare (specific) concept that fewer than PER_TARGET
  // candidates mention, pull its own best rows — the same coverage guarantee
  // as P7, but driven by the question's own terms, no taxonomy needed.
  const textOf = (r) => `${r.title} ${r.summary || ''} ${r.ai_summary || ''} ${r.insight || ''} ${r.ai_insight || ''}`.toLowerCase();
  const seenIds = new Set(base.map((r) => r.id));
  const coverage = [];
  const specific = concepts
    .map((forms, i) => ({ forms, df: docFreqs[i] }))
    .filter((c) => c.df > 0 && c.df <= SPECIFIC_DOCFREQ && c.forms[0].length >= 3)
    .sort((a, b) => a.df - b.df)
    .slice(0, 4);
  if (specific.length >= 2) {
    for (const c of specific) {
      const have = base.filter((r) => c.forms.some((f) => textOf(r).includes(f.toLowerCase()))).length;
      if (have >= PER_TARGET) continue;
      const others = concepts.filter((f) => f !== c.forms).flat();
      try {
        for (const r of await retrieveForTarget(c.forms[0], others)) if (!seenIds.has(r.id)) { seenIds.add(r.id); coverage.push(r); }
      } catch (_) { /* best-effort */ }
    }
  }
  let baseCovered = base.concat(coverage);
  let ceiling = MAX_TOTAL_CANDIDATES;
  const intent = classifyIntent(retrievalQuery, await getRoster());
  if (!light && intent.type === 'collective') {
    const nonGeneric = concepts.filter((forms, i) => docFreqs[i] > 0 && docFreqs[i] <= SPECIFIC_DOCFREQ * 8).flat();
    const known = new Set(baseCovered.map((r) => r.id));
    const fromRoster = (await retrieveForWatchlist(nonGeneric)).filter((r) => !known.has(r.id) && known.add(r.id));
    baseCovered = baseCovered.concat(fromRoster);
    ceiling = MAX_TOTAL_CANDIDATES + 24;
  }
  const targets = await taxonomyTargets(concepts);
  if (!targets.length) return baseCovered.slice(0, ceiling);
  const targetSet = new Set(targets.map((t) => t.toLowerCase()));
  const otherForms = concepts.filter((forms) => !forms.some((f) => targetSet.has(f.toLowerCase()))).flat();
  const seen = new Set(baseCovered.map((r) => r.id));
  const extras = [];
  for (const t of targets) {
    try {
      for (const r of await retrieveForTarget(t, otherForms)) if (!seen.has(r.id)) { seen.add(r.id); extras.push(r); }
    } catch (_) { /* best-effort */ }
  }
  return baseCovered.concat(extras).slice(0, ceiling);
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
- Choose list markers by the relationship between the answer units, not merely by how many facts or sources there are. Use a numbered list (1., 2., 3. in ascending order) only when the points are connected and their sequence, priority, ranking, comparison, or progression matters to understanding one combined answer. Use "- " bullets for a single answer unit and for multiple independent items/sub-answers that do not form one connected sequence or argument. Do not number a set of unrelated companies, articles, or facts just because there are several of them.
- For a single substantive answer, use one "- " bullet rather than a numbered "1." item.
- Hierarchy must be visible through indentation. Use exactly three levels and never flatten them into one list: (1) a short "# " heading line for each topic/group (e.g. "# e-SAF", "# 바이오 SAF"); (2) under it, top-level "- " bullets, one per key point, starting with a **bold label** then the explanation; (3) beneath a bullet, supporting detail (figures, examples, sources of the claim, exceptions) as "- " bullets indented by exactly two spaces ("  - "). A third indent level (four spaces) is allowed only for a detail of a detail. Siblings share the same indent; a child is always indented deeper than its parent; do not put a group title or a category name as a same-level bullet next to its own contents, and do not skip levels.
- Never output HTML tags (no <br>, <ul>, <li> etc.). Inside a table cell keep each cell to one short line of plain text; if a cell needs several items, separate them with "; " or ", " — never with <br> or "- " bullets. Put long lists outside the table as normal Markdown bullets.
- Light Markdown is fine for readability: **bold** for key terms/figures, "- " for bullets, "1. " for a connected numbered list, and a short "#" line for a section heading only when the answer has multiple distinct sections.
- If the answer has multiple top-level numbered sections (e.g. "1. 공급 측면...", "2. 관세·비용 요인..."), number them sequentially through the ENTIRE answer — never restart at "1." for a later section. A plain "-" paragraph inserted between numbered sections does not reset the count; the next numbered section continues from where the numbering left off (e.g. after "2.", the next section is "3.", not "1." again).
- Citations are REQUIRED, not optional: after every sentence that states a fact, add [N] where N is the 자료 번호 (e.g. 자료 2 -> [2]) that sentence is actually based on. Place [N] AFTER the sentence's closing punctuation, never before it — write "...정책이 변경되었다. [1]", never "...정책이 변경되었다 [1]." Use multiple markers like [1][3] if a sentence draws on more than one. Never cite a 자료 번호 that isn't in the supplied materials, and never cite one you didn't actually use for that sentence.
- Never use LaTeX or math markup (no dollar-sign math spans, no backslash commands, no _ or ^ subscript syntax) — write chemical formulas and units in plain text or Unicode, e.g. CO₂, H₂, m³.
- Length (hard rule): keep the whole answer within about 450 Korean words — tables and chart JSON count — or about 700 for a single-company profile. Lead with the answer, then the most decision-relevant facts; merge duplicate materials and cite each fact once. Never try to cover everything: if more material exists than fits, say in one short line what was left out and offer to continue. The answer must always END COMPLETE — never stop mid-sentence, mid-list, mid-table or mid-chart.
- Comparisons across several targets: show every target the materials give a figure for, side by side with the same fields and the same unit; name in one line any requested target with no usable figure.
- SUBJECT FIT: list an entity only if the materials tie it to the product/subject the question names (e.g. a palm-oil question lists palm-oil handlers, not producers of an unrelated fuel that merely appear in the archive). If the archive lacks the major players of that subject, say so in one line instead of filling the list with off-subject entities.
- Charts and tables (only when asked, or when 3+ comparable numbers make one clearly better): tables use Markdown pipe tables with the unit stated once in the header, one number format per column (commas for thousands, a dot for decimals, ranges as "50만~120만 톤"), current/plan/target in separate columns, "-" for no data, "미공시" for undisclosed. A chart is a fenced block \`\`\`chart containing one JSON object {"type":"bar"|"hbar"|"stacked"|"line"|"area"|"pie"|"donut"|"scatter","title":"...","unit":"...","labels":[...],"series":[{"name":"...","data":[numbers or null]}]} (hbar for rankings, line for time trends, pie/donut only for shares of one whole, at most 10 items and 4 series). To merge the parts of one company that add up (its plants), use one series with "groups":[company per label] and "combine":"sum" and optional "notes":[detail per label]. Use ONLY figures stated in the materials; put the unit in "unit"; follow with 1-3 sentences of takeaways, each cited.
- NUMBER FIDELITY (critical): copy every figure EXACTLY as the material writes it, with its own scale and unit ("50만 톤" stays "50만 톤", never "5만 톤"; "1.2 Mt" stays "1.2 Mt"). Do not convert between 만/천/백만/억, kt/Mt/톤 or gallons/barrels/tonnes yourself — write each figure in the unit its material uses (when the user asks for one common unit, the system converts and states the basis). A range uses the material's two endpoints. A figure not found in the cited material must not be written.
- Never write the words "이전 답변"/"이전 질문" as a citation, and never cite as [1, 2], [1-3] or [자료 3]: always separate brackets with plain numbers, [1][2]. Every table row and every chart's lead-in sentence needs at least one [N] (put it at the end of the row's last cell).
- Do not use any other citation style (no Markdown links, no raw URLs, no footnotes) — only the bracketed 자료 번호.
Rules:
- If the supplied materials contain NOTHING relevant to the question, say so explicitly in Korean (e.g. "현재 보유한 자료로는 답변하기에 근거가 부족합니다.") instead of guessing or filling gaps with outside knowledge.
- If the materials are relevant but only PARTIALLY cover the question (for example a concept/definition question where the materials describe projects, policies or cases rather than a formal definition), do NOT answer with only an insufficiency notice: present what the materials do support, grouped sensibly, then state in one sentence what they do not cover (e.g. "정의 자체를 다룬 자료는 없고, 아래는 관련 사례입니다"). Never fill the uncovered part from outside knowledge. Use materials in every language supplied — Korean and non-Korean materials are equally valid evidence, and domestic (Korean) cases belong in the answer when supplied.
- Before connecting the user's question to the materials, separate the question into its 대상(subject/target), 효과(the claimed effect), and 기간(time period) — do not match on a blurred combination of these. Treat the material's wording as the SAME claim as the question only when (a) the material states that exact effect directly, or (b) the material's wording is a genuinely equivalent expression about the SAME subject/target (e.g. "피해" and "마진 압박" on the same company are the same claim). Never connect across a different subject or a wider scope than the material actually supports — a single company's cost/margin pressure ("한 기업의 비용/마진 압박") is NOT evidence of market-wide harm ("시장 전체 피해"); state the claim at the scope the material actually covers, never broadened.
- Every factual claim must be grounded in the supplied materials and marked with its [N] citation — never stated as fact without one.
- Proper nouns (company names, project/deal names, place names) must be copied character-for-character from the supplied materials, never retyped from memory or paraphrased. Never split a single word across two scripts (e.g. mixing a Latin-alphabet fragment into the middle of a Korean word like "포스코인터내셔널") — if a term appears in the materials in English, keep it entirely in English; if in Korean, keep it entirely in Korean, exactly as spelled there.
- A material's own "인사이트" is interpretation, not a stated fact — present it as such (e.g. "~로 해석됩니다", "~일 가능성이 있습니다"), never as a reported fact, and always alongside the factual sentence/[N] it's based on, never as a freestanding claim. Structure the answer so facts actually confirmed in the materials and what those facts suggest (인사이트) stay visibly distinct. If either side is unclear or unsupported at the question's actual scope, narrow the answer to only what's clearly supported rather than extending it.
- Be concise and research-oriented — no greetings, no conversational filler, no restating the question.
- If earlier conversation turns are given, treat them as context for a follow-up question, but still ground every claim only in the materials given now.
- Respond in Korean.`;

// Prompt-prep trim: a hard cap per field so one unusually long AI_summary/
// insight doesn't blow up the user message size (MAX_CANDIDATES=8
// materials, each potentially contributing two long fields) — the time
// the provider spends just reading a longer prompt before it emits a
// first token is real and scales with this, not just with how long the
// model's own answer ends up being. 320/240 chars keep each field at
// roughly 2-3 sentences, enough for the model to cite accurately without
// the full original text.
const MAX_SUMMARY_CHARS = 700;
const MAX_INSIGHT_CHARS = 450;
function truncateField(text, maxChars) {
  const str = String(text || '');
  return str.length > maxChars ? `${str.slice(0, maxChars)}…` : str;
}

// Evidence budget: the first FULL_MATERIALS candidates keep the full summary/insight
// budget; later ones (roster/coverage additions) are trimmed harder — the model reads
// ~40% fewer tokens with the best-ranked evidence intact. onlyWithQuantities keeps
// the original 자료 numbers but lists only materials that state a capacity-type figure
// (used by the dataset extraction call, which only needs those).
const FULL_MATERIALS = 12;
const TAIL_SUMMARY_CHARS = 380;
const TAIL_INSIGHT_CHARS = 200;
const CAPACITY_CLASSES = new Set(['mass', 'gal', 'bbl', 'bpd', 'liter', 'usd', 'eur', 'krw']);
function buildMaterialsBlock(candidates, { onlyWithQuantities = false, onlyIndices = null } = {}) {
  return candidates.map((m, i) => {
    if (onlyIndices && !onlyIndices.has(i)) return null;
    if (onlyWithQuantities && !numberCheck.extractQuantities(materialText(m)).some((q) => CAPACITY_CLASSES.has(q.cls))) return null;
    const tail = i >= FULL_MATERIALS;
    return [
      `자료 ${i + 1} — 제목: ${m.title}`,
      `출처: ${m.source_name || '미확인'}`,
      `발행일: ${m.published_at ? String(m.published_at).slice(0, 10) : '미확인'}`,
      `요약: ${truncateField(m.summary || m.ai_summary || '(요약 없음)', tail ? TAIL_SUMMARY_CHARS : MAX_SUMMARY_CHARS)}`,
      (m.insight || m.ai_insight) ? `인사이트: ${truncateField(m.insight || m.ai_insight, tail ? TAIL_INSIGHT_CHARS : MAX_INSIGHT_CHARS)}` : null,
    ].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n');
}

function buildHistoryBlock(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const turns = history.slice(-MAX_HISTORY_TURNS * 2);
  const lines = turns
    .filter((t) => t && typeof t.content === 'string')
    .map((t) => `${t.role === 'assistant' ? '이전 답변' : '이전 질문'}: ${t.content.slice(0, 900)}`);
  return lines.length ? `[이전 대화]\n${lines.join('\n')}\n\n` : '';
}

const INSUFFICIENT_MESSAGE = '현재 보유한 Research Center 자료로는 이 질문에 답변하기에 근거가 부족합니다. 관련 자료가 추가되면 다시 질문해 주세요.';

// Re-derives which 자료 N were actually cited, straight from the model's
// own [N] markers — never trusted from prose alone. Returns the distinct,
// in-range indices (1-based, matching buildMaterialsBlock's 자료 N) in the
// order they first appear, so citation order drives display order too.
// Footnote losses seen with many candidates: the model writes markers in
// shapes the [N] matcher never recognised — "[1, 2]", "[1-3]", "[자료 3]" —
// so they were neither linked nor counted as cited, and it copies the prompt's
// own "[이전 답변]" label. Normalise all of these to plain [N][N] runs (or drop
// the label) BEFORE anything else reads the text.
function normalizeCitationMarkers(text) {
  return String(text || '')
    .replace(/\[\s*이전\s*(?:답변|질문)\s*\]/g, '')
    .replace(/\[\s*(?:자료|출처|source|ref)\s*\.?\s*(\d{1,2})\s*\]/gi, '[$1]')
    .replace(/\[\s*(?:자료|출처|source|ref)?\s*\.?\s*(\d{1,2})\s*[-–~]\s*(\d{1,2})\s*\]/gi, (w, a, b) => {
      const lo = Number(a), hi = Number(b);
      if (hi < lo || hi - lo > 9) return w;
      return Array.from({ length: hi - lo + 1 }, (_, i) => `[${lo + i}]`).join('');
    })
    .replace(/\[\s*(?:자료|출처|source|ref)?\s*\.?\s*(\d{1,2}(?:\s*[,，、]\s*(?:자료\s*)?\d{1,2})+)\s*\]/gi, (w, list) =>
      list.split(/[,，、]/).map((x) => `[${x.replace(/\D/g, '')}]`).join(''));
}

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

// Backstop for the SYSTEM_PROMPT's "[N] goes after the closing punctuation"
// rule — prompt instructions alone don't reliably hold (same reasoning as
// aiDraft.js's hasForeignScriptBleed/isUngroundedGeneralization overrides),
// and a model writing "...변경되었다 [1]." reads as the period belonging to
// the citation rather than the sentence. Moves a run of one or more [N]
// markers to after the sentence-ending punctuation that follows them,
// regardless of what the model actually emitted. A marker with nothing
// following it (end of text, no punctuation) is left untouched — there is
// nothing to reorder it against.
function moveCitationsAfterPunctuation(text) {
  return String(text || '').replace(/\s*((?:\[\d{1,2}\])+)\s*([.!?])/g, '$2 $1');
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
Be conservative: flag a claim ONLY when the cited material clearly does not state it or contradicts it. A claim that restates, paraphrases, translates (Korean/English), or summarizes numbers, names or facts found anywhere in the cited material (title, summary or insight) IS supported; so is a table row or list item built from it. When unsure, treat the claim as supported.\nRespond with ONLY a JSON array of the claim numbers that are NOT supported by their cited material(s) — e.g. [2,5] — or [] if every claim is supported. No other text, no explanation.`;

// Everything the model was shown for a material (title, summary, insight, both
// AI fields) — the verifier used to see only the summary, so a claim drawn from
// the insight or a figure only in the title was judged "unsupported" and lost
// its footnote.
function materialText(m) {
  return [m.title, m.summary, m.ai_summary, m.insight, m.ai_insight].filter(Boolean).join(' ');
}

// Cheap guard against verifier over-flagging: a claim that shares a number or
// at least two content terms with one of its cited materials is concretely
// grounded there, whatever a noisy yes/no judgement said.
function claimOverlapsMaterials(claimLine, indices, candidates, minTerms = 2) {
  const claim = claimLine.replace(/\[\d{1,2}\]/g, '').toLowerCase();
  const hay = indices.map((i) => materialText(candidates[i - 1] || {})).join(' ').toLowerCase();
  // Shared TOPIC words alone are not grounding (a title match is exactly the
  // topical-overlap case verification exists for): terms must appear in the
  // material's body fields, numbers anywhere.
  const body = indices.map((i) => { const m = candidates[i - 1] || {}; return [m.summary, m.ai_summary, m.insight, m.ai_insight].filter(Boolean).join(' '); }).join(' ').toLowerCase();
  const numbers = (claim.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')).filter((n) => n.replace(/\D/g, '').length >= 2);
  if (numbers.some((n) => hay.includes(n))) return true;
  const terms = Array.from(new Set((claim.match(/[a-z가-힣]{2,}/g) || []).map((t) => stemKorean(t)).filter((t) => t.length >= 2 && !isQuestionFraming(t))));
  return terms.filter((t) => body.includes(t)).length >= minTerms;
}

function buildVerificationPrompt(claims, candidates) {
  return claims.map((c, i) => {
    const materialsText = c.indices.map((idx) => {
      const m = candidates[idx - 1];
      return `자료 ${idx}: ${materialText(m)}`;
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

// Production incident: this is the step between "streamed answer
// finished" and "the polished done event lands" — it used to inherit
// callProviderWithFallback's full FREELLMAPI_TIMEOUT_MS (150s), so a
// slow verification call could make the user wait up to two and a half
// minutes AFTER already watching the full answer stream in, just for the
// citation-link swap. This is a nice-to-have quality pass, never worth
// that wait: bounded to a short budget of its own, and racing past it
// fails open (returns the unverified text) exactly the same way an
// outright error already does below — the user just gets the streamed
// citations kept as-is a little sooner instead of a corrected version
// much later.
const DEFAULT_VERIFICATION_TIMEOUT_MS = 12000;
// Read fresh on every call (not cached at module load), same convention
// adapters/webSearch.js's getConfiguredKeys() already uses for its own
// env-driven config — lets this be tuned (or overridden in a test)
// without a process restart.
function getVerificationTimeoutMs() {
  return Number(process.env.AI_SEARCH_VERIFICATION_TIMEOUT_MS) || DEFAULT_VERIFICATION_TIMEOUT_MS;
}
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    // onTimeout() is expected to throw (verifyCitations' only caller
    // passes a function that does) — caught here and turned into a
    // rejection rather than an uncaught exception in this timer callback,
    // which runs outside any surrounding try/catch.
    timer = setTimeout(() => {
      try { resolve(onTimeout()); } catch (err) { reject(err); }
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Second-pass check layered on top of the base answer: a [N] marker only
// proves the model POINTED at a material, never that the material backs
// that specific sentence (the gap a reviewer flagged — a biofuel-policy
// claim citing a food-inflation article purely on topical overlap). This
// re-asks the model, focused only on claim-vs-material support, and
// strips the citation marker(s) from any claim it flags as unsupported —
// the sentence stays, it just stops claiming that material as evidence.
// Fails open (changes nothing) on any error, timeout, or unparseable
// response: this is a quality layer on the base answer, never allowed to
// block or break it.
// NEVER SHOW A CUT-OFF ANSWER. If the provider reports it hit the output limit (the
// provider appends a visible notice), the notice is stripped and the answer is either
// CONTINUED once (a short, bounded call that only finishes what was cut) or, failing
// that, trimmed back to its last complete sentence/row/block. The user never sees
// "답변이 길이 제한으로 잘렸습니다".
const TRUNCATION_NOTICE_RE = /\n*⚠ 답변이 길이 제한으로[\s\S]*$/;
const CONTINUE_SYSTEM = 'You finish an answer that was cut off. Output ONLY the remaining text that completes it — do not repeat anything already written. Keep it under 150 Korean words, keep the same language, formatting and [N] citation style, use only facts from the supplied materials, and close any open list, table or code block. If the answer is already complete enough, output a single short closing sentence.';

function trimToCompleteBlock(text) {
  let t = String(text || '').trimEnd();
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2 === 1) t = t.slice(0, t.lastIndexOf('```')).trimEnd();
  let lines = t.split('\n');
  const terminal = /[.!?。다요음함임됨죠)\]|`*]\s*$/;
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (!last.trim()) { lines.pop(); continue; }
    if (/^\s*\|/.test(last)) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').length;
      const prev = lines.slice(0, -1).reverse().find((l) => /^\s*\|/.test(l));
      if (!/\|\s*$/.test(last) || (prev && cells(last) < cells(prev))) { lines.pop(); continue; } // half a table row
    }
    if (terminal.test(last) || /^#{1,6}\s/.test(last.trim()) || (/^\s*(?:[-*•]|\d+[.)])\s/.test(last) && last.trim().length < 40)) break; // a short list item may legitimately lack a period
    let cut = -1; // last real sentence end inside the line (a 다/요 only counts at a word boundary)
    for (const m of last.matchAll(/[.!?。](?=\s|$)|[다요](?=[\s.]|$)/g)) cut = m.index;
    if (cut > 0) { lines[lines.length - 1] = last.slice(0, cut + 1); break; }
    lines.pop();
  }
  return lines.join('\n').trimEnd();
}

async function completeTruncatedAnswer(partial, candidates, signal) {
  try {
    const cited = extractCitedIndices(partial, candidates.length).slice(0, 8);
    const materials = cited.map((i) => `자료 ${i} — ${candidates[i - 1].title}\n${truncateField(candidates[i - 1].summary || candidates[i - 1].ai_summary || '', 320)}`).join('\n\n');
    const tail = partial.slice(-2500);
    const result = await withTimeout(
      callHedged({ system: CONTINUE_SYSTEM, user: `[Materials]\n${materials}\n\n[Answer so far]\n${tail}` }, { signal, hedgeAfterMs: 8000 }),
      40000,
      () => { throw new Error('continuation timed out'); }
    );
    let cont = String(result.text || '').replace(TRUNCATION_NOTICE_RE, '').trim().slice(0, 1500);
    if (!cont) throw new Error('empty continuation');
    const probe = partial.slice(-40);
    const at = cont.indexOf(probe);
    if (probe.length >= 20 && at >= 0) cont = cont.slice(at + probe.length).trimStart(); // model repeated the tail
    console.log('ai-search truncation_repaired mode=continued');
    return trimToCompleteBlock(`${partial}${/\s$/.test(partial) || /^[\n.,)\]]/.test(cont) ? '' : ' '}${cont}`);
  } catch (err) {
    console.log(`ai-search truncation_repaired mode=trimmed (${err.message})`);
    return trimToCompleteBlock(partial);
  }
}

// Answer cache: the same question over the same evidence set returns the finished
// answer instantly (follow-ups with history are never cached). Keyed by the question
// and the candidate ids, so newly published/changed material changes the key.
const ANSWER_CACHE_TTL_MS = 15 * 60 * 1000;
const ANSWER_CACHE_MAX = 100;
const answerCache = new Map();
function answerCacheKey(question, candidates, mode = 'full') {
  const norm = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${mode}|${norm}|${candidates.map((c) => c.id).join(',')}`).digest('hex');
}
const answerCacheEnabled = () => process.env.AI_SEARCH_CACHE !== 'off';
function answerCacheGet(key) {
  if (!answerCacheEnabled()) return null;
  const hit = answerCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ANSWER_CACHE_TTL_MS) { answerCache.delete(key); return null; }
  answerCache.delete(key); answerCache.set(key, hit); // refresh recency
  return hit.value;
}
function answerCacheSet(key, value) {
  if (!answerCacheEnabled()) return;
  answerCache.set(key, { at: Date.now(), value });
  while (answerCache.size > ANSWER_CACHE_MAX) answerCache.delete(answerCache.keys().next().value);
}

// Hedged call for non-streaming work: if the first attempt has not answered within
// hedgeAfterMs (the router can land on a stalled upstream for 30-45 s), a second
// attempt is started in parallel and the first valid answer wins; the loser is aborted.
// A fast failure triggers the second attempt immediately.
function callHedged(promptMessages, { signal, hedgeAfterMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const controllers = [];
    let settled = false;
    let started = 0;
    let failures = 0;
    let timer = null;
    const onCallerAbort = () => controllers.forEach((c) => c.abort());
    if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
      controllers.forEach((c) => c.abort());
      fn(value);
    };
    const launch = () => {
      if (settled || started >= 2) return;
      started++;
      const c = new AbortController();
      controllers.push(c);
      Promise.resolve(provider.callProviderWithFallback(promptMessages, { signal: c.signal, lane: 'chat' })).then(
        (r) => finish(resolve, r),
        (err) => { failures++; if (failures >= started) { if (started < 2) launch(); else finish(reject, err); } }
      );
    };
    timer = setTimeout(launch, hedgeAfterMs);
    launch();
  });
}

async function verifyCitations(text, candidates, signal) {
  const allClaims = splitClaimLines(text, candidates.length);
  // Deterministic first: a claim sharing a figure, or >= 3 body terms, with the material it
  // cites is concretely grounded and never needs the (slow, token-heavy) LLM judge. Only
  // doubtful claims are sent — most answers need no verification call at all.
  const claims = allClaims.filter((c) => !claimOverlapsMaterials(c.line, c.indices, candidates, 3));
  if (!claims.length) return text;
  try {
    const timeoutMs = getVerificationTimeoutMs();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const result = await withTimeout(
        callHedged({
          system: VERIFICATION_SYSTEM_PROMPT,
          user: buildVerificationPrompt(claims, candidates),
        }, { signal: controller.signal, hedgeAfterMs: 5000 }),
        timeoutMs,
        () => {
          controller.abort();
          throw new Error(`citation verification timed out after ${timeoutMs}ms`);
        }
      );
      const unsupported = parseUnsupportedClaimNumbers(result.text, claims.length);
      if (!unsupported.length) return text;
      let corrected = text;
      for (const n of unsupported) {
        const { line, indices } = claims[n - 1];
        if (claimOverlapsMaterials(line, indices, candidates)) continue; // grounded: keep the footnote
        corrected = corrected.replace(line, line.replace(/\[\d{1,2}\]/g, '').trim());
      }
      return corrected;
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
    }
  } catch (err) {
    console.error('ai-search citation verification failed:', err.message);
    return text;
  }
}

// Shared by both the streaming and non-streaming paths: turns a raw
// model answer into the final {answer, sources} the client renders.
// Citation verification (an extra provider round-trip) used to run
// before ANY output reached the browser, doubling perceived latency on
// every single request — now it only ever delays this final polish
// step, never the first visible token (see the streaming path below).
// Roster = the watchlist companies with every spelling we match them by.
async function getRoster() {
  try {
    const { rows } = await pool.query('SELECT name, aliases FROM companies WHERE watched = true');
    return rows.map((r) => ({
      name: r.name,
      rawNames: [r.name, ...(r.aliases || [])].map((n) => String(n || '').trim()).filter(Boolean),
      names: Array.from(new Set([r.name, String(r.name).split(/[\s.]+/)[0], ...(r.aliases || [])]
        .map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length >= 3))),
    }));
  } catch (_) {
    return [];
  }
}

// ENFORCED COVERAGE (대원칙): when a question is about companies in general, every
// roster company for which materials were supplied MUST appear in the answer.
// 1) the prompt carries an explicit mandatory list (with which 자료 mention each);
// 2) after generation, any company still absent from the text is appended
//    deterministically from its own material, with a [N] footnote — so the
//    answer can never silently omit a company that the archive covers.
const { SECTOR_KEYWORD_PATTERNS } = require('../lib/classificationSanity');
function requiredCompanies(question, candidates, roster) {
  const intent = classifyIntent(question, roster);
  if (intent.type !== 'collective' && intent.type !== 'peers') return [];
  const scoped = intent.type === 'peers' ? intent.focus : roster; // peers: exactly the companies the user named
  const texts = candidates.map((m) => `${m.title} ${m.summary || ''} ${m.ai_summary || ''} ${m.insight || ''} ${m.ai_insight || ''}`.toLowerCase());
  // TOPIC BINDING: when the question names a product (팜유, SAF, 대두유 ...), a company is "required"
  // only through materials that are about that product — a roster company known from another
  // product line (e.g. SAF-only producers in a palm-oil question) must not be forced in.
  const subject = Object.values(SECTOR_KEYWORD_PATTERNS).filter((re) => re.test(question));
  const aboutSubject = (m) => !subject.length || subject.some((re) => re.test(`${m.title} ${m.summary || ''} ${m.ai_summary || ''} ${m.insight || ''} ${m.ai_insight || ''}`));
  return scoped
    .map((c) => ({ ...c, indices: texts.map((t, i) => (aboutSubject(candidates[i]) && c.names.some((n) => t.includes(n)) ? i + 1 : null)).filter(Boolean) }))
    .filter((c) => c.indices.length);
}
function buildCoverageBlock(required) {
  if (!required.length) return '';
  return `\n\n[필수 포함 업체 — 자료가 제공된 업체이므로 표·차트·본문에서 하나도 빠뜨리지 말 것. 해당 항목의 수치가 자료에 없으면 "-" 또는 "미공시"로 표시하고 그 사실을 한 줄로 밝힐 것]\n${required.map((c) => `- ${c.name} (자료 ${c.indices.slice(0, 6).join(', ')})`).join('\n')}`;
}
function ensureCompanyCoverage(text, required, candidates) {
  const low = String(text || '').toLowerCase();
  const named = (c) => c.indices.some((i) => c.names.some((n) => String(candidates[i - 1].title || '').toLowerCase().includes(n)));
  // only companies with a material that names them in its TITLE are appended — a passing
  // mention in a body is not evidence worth adding to the answer
  const missing = required.filter((c) => !c.names.some((n) => low.includes(n)) && named(c));
  if (!missing.length) return text;
  const bullets = missing.map((c) => {
    // the material that names the company in its TITLE first, then the sentence around the name
    const idx = c.indices.find((i) => c.names.some((n) => String(candidates[i - 1].title || '').toLowerCase().includes(n))) || c.indices[0];
    const m = candidates[idx - 1];
    const body = String(m.ai_summary || m.summary || m.title || '').replace(/\s+/g, ' ').trim();
    const sentences = body.split(/(?<=[.。!?다요])\s+/);
    const hit = sentences.find((sn) => c.names.some((n) => sn.toLowerCase().includes(n))) || sentences[0] || body;
    const snippet = hit.length > 150 ? `${hit.slice(0, 150)}…` : hit;
    return `- **${c.name}**: ${snippet} [${idx}]`;
  });
  return `${String(text).trimEnd()}\n\n# 추가 확인된 업체 (자료 기준)\n본문에서 다루지 못했으나 자료가 확인된 업체입니다.\n${bullets.join('\n')}`;
}

// Chart safety net: when the model draws one bar per plant/site of the same
// company ("Neste 싱가포르", "Neste 로테르담") without asking for them to be
// combined, group the parts by KNOWN company (watchlist names/aliases) so the
// client draws one stacked row per company. Parts whose labels read like
// scenarios of one quantity (현재/2030/계획/전망...) are never summed.
// One vocabulary for the state of a figure, everywhere: 현재 / 건설중 / 계획 / 목표.
// ("현대" is a model typo for 현재; 기존/가동/운영 -> 현재; 신규/예정/전망 -> 계획.)
const STATUS_ONLY = /^(?:20\d\d|현재|현대|기존|가동\s*중?|운영\s*중?|건설\s*중|계획|신규|예정|전망|목표|[\s,~\-년])*$/;
function normalizeStatusPart(part) {
  const t = part.trim();
  const year = (t.match(/20\d\d/) || [''])[0];
  if (/^(?:20\d\d\s*년?\s*)?(?:현재|현대|기존|가동\s*중?|운영\s*중?)$/.test(t)) return year ? `${year} 현재` : '현재';
  if (/^(?:20\d\d\s*년?\s*)?(?:건설\s*중)$/.test(t)) return year ? `${year} 건설중` : '건설중';
  if (/^(?:20\d\d\s*년?\s*)?(?:목표)(?!\s*[가-힣A-Za-z0-9])/.test(t)) return year ? `${year} 목표` : '목표';
  if (/^(?:20\d\d\s*년?\s*)?(?:계획|신규|예정|전망)(?:[^,]*)$/.test(t) && !/\d\s*(?:만|억|톤|Mt|kt)/.test(t)) return year ? `${year} 계획` : '계획';
  return t;
}
function normalizeStatusLabel(label) {
  return String(label).replace(/[(（]([^)）]*)[)）]/g, (m, inner) => `(${inner.split(',').map(normalizeStatusPart).join(', ')})`);
}

function enrichChartJson(chart, roster) {
  if (!chart || !Array.isArray(chart.labels)) return chart;
  // consistent state wording in every label
  const labels = chart.labels.map((l) => normalizeStatusLabel(String(l)));
  let out = { ...chart, labels };
  if (chart.combine || !['bar', 'hbar'].includes(chart.type || 'bar')) return out;
  if (labels.length < 3 || !Array.isArray(chart.series) || chart.series.length !== 1) return out;
  const entityOf = (label) => {
    const low = label.toLowerCase();
    let best = null;
    for (const c of roster) {
      for (const n of c.names) {
        if (low.startsWith(n) && (!best || n.length > best.len)) best = { name: c.name, len: n.length };
      }
    }
    return best;
  };
  const found = labels.map((l) => entityOf(l));
  const siteOf = (l, f) => l.slice(f.len).replace(/[(（][^)）]*[)）]/g, '').trim().toLowerCase();
  const counts = new Map();
  found.forEach((f) => { if (f) counts.set(f.name, (counts.get(f.name) || 0) + 1); });
  const mergeable = new Set();
  for (const [name, count] of counts) {
    if (count < 2) continue;
    // parts of ONE company that add up are DIFFERENT plants: every part names its own site.
    // Parts that only differ by year/status wording are scenarios of one figure — never summed.
    const sites = labels.map((l, i) => (found[i] && found[i].name === name ? siteOf(l, found[i]) : null)).filter((x) => x !== null);
    if (sites.some((x) => !x || STATUS_ONLY.test(x))) continue;
    if (new Set(sites).size !== sites.length) continue;
    mergeable.add(name);
  }
  if (!mergeable.size) return out;
  const notes = Array.isArray(chart.notes) ? chart.notes : labels.map((l) => (l.match(/[(（]([^)）]*)[)）]/) || [])[1] || '');
  return { ...out, combine: 'sum', groups: labels.map((l, i) => (found[i] && mergeable.has(found[i].name) ? found[i].name : l)), notes };
}
// A company-wide total ("전체", "전사 합계") must never share an axis with the single
// sites it sums; the total is dropped from the chart (it stays in the table/text).
const TOTAL_LABEL = /^\s*(전체|전사|합계|총계|총합|total|overall|all|grand total)(\s*(합계|총계|계|total))?\s*([(（][^)）]*[)）])?\s*$/i;
function dropTotalFromSiteChart(chart) {
  if (!chart || !Array.isArray(chart.labels) || chart.labels.length < 3 || !Array.isArray(chart.series)) return chart;
  const idx = chart.labels.map((l, i) => (TOTAL_LABEL.test(String(l)) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length || idx.length === chart.labels.length) return chart;
  const keep = (_, i) => !idx.includes(i);
  const out = { ...chart, labels: chart.labels.filter(keep), series: chart.series.map((s) => ({ ...s, data: (s.data || []).filter(keep) })) };
  if (Array.isArray(chart.groups)) out.groups = chart.groups.filter(keep);
  if (Array.isArray(chart.notes)) out.notes = chart.notes.filter(keep);
  return out;
}
async function enrichChartBlocks(text, candidates = [], question = '') {
  if (!/```chart/.test(text)) return text;
  const roster = await getRoster();
  if (!roster.length) return text;
  const rowMap = tableCheck.tableRowQuantities(text);
  return text.replace(/```chart[^\n]*\n([\s\S]*?)```/g, (whole, body) => {
    try {
      const guardedChart = numberCheck.guardChartNumbers(JSON.parse(body), candidates, materialText);
      if (guardedChart.fixed || guardedChart.dropped) console.log(`ai-search chart_number_guard fixed=${guardedChart.fixed} dropped=${guardedChart.dropped}`);
      const compliant = requestCompliance.applyChartCompliance(guardedChart.chart, requestCompliance.parseRequest(question));
      if (compliant.changed.length) console.log(`ai-search request_compliance chart_${compliant.changed.join('+')}`);
      let chartOut = dropTotalFromSiteChart(compliant.chart);
      const um = numberCheck.unitMultiplier(chartOut.unit);
      if (um) {
        const rec = tableCheck.reconcileChartWithTable(chartOut, rowMap, um.mult, um.cls);
        if (rec.fixed) console.log(`ai-search chart_table_reconcile fixed=${rec.fixed}`);
        chartOut = rec.chart;
      }
      const enriched = enrichChartJson(chartOut, roster);
      return `\`\`\`chart\n${JSON.stringify(enriched)}\n\`\`\``;
    } catch (_) { return whole; }
  });
}

// Quantitative visualization requests: build the verified dataset (table + chart)
// in code (see lib/datasetPipeline.js). Null on any failure -> normal generation.
const DATASET_TIMEOUT_MS = 75000;
async function tryBuildDataset(question, candidates, required, signal) {
  const req = requestCompliance.parseRequest(question);
  if (!datasetPipeline.isDatasetRequest(req, question)) return null;
  try {
    const density = datasetPipeline.productDensity(`${question} ${candidates.map(materialText).join(' ').slice(0, 40000)}`);
    // 1) facts stored when the items were published (item_facts): no AI call at all
    let records = [];
    let pending = [];
    try {
      const loaded = await itemFacts.loadFactRecords(candidates);
      records = datasetPipeline.recordsForQuestion(loaded.records.map((r) => datasetPipeline.guardStoredRecord(r, materialText(candidates[r.source - 1] || {}))), question, density);
      // 2) only items never processed (facts_status IS NULL) that state a quantity still need the AI extraction
      pending = candidates
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => !loaded.statusById.get(c.id) && itemFacts.hasQuantity(materialText(c)))
        .map(({ i }) => i);
    } catch (err) {
      console.error('ai-search item_facts read failed:', err.message);
      pending = candidates.map((_, i) => i);
    }
    // 1b) the WHOLE archive's stored facts for the question's topic, not only the chat's top-N
    //     articles; those extra articles are appended after the candidates so footnotes resolve
    let extraCandidates = [];
    try {
      const topic = [];
      for (const forms of extractConcepts(question)) {
        const f = forms[0];
        if (!f || datasetPipeline.METRIC_WORDS.test(f) || ENTITY_NOUN.test(f) || requestCompliance.isVisualWord(f)) continue;
        topic.push(...forms);
      }
      if (topic.length) {
        const wide = await itemFacts.loadFactsByTopic(topic, { excludeIds: candidates.map((c) => c.id).filter(Boolean), baseIndex: candidates.length });
        const textOfSource = (r) => materialText(wide.items[r.source - candidates.length - 1] || {});
        records = records.concat(datasetPipeline.recordsForQuestion(wide.records.map((r) => datasetPipeline.guardStoredRecord(r, textOfSource(r))), question, density));
        extraCandidates = wide.items;
      }
    } catch (err) {
      console.error('ai-search topic facts failed:', err.message);
    }
    if (pending.length) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal && signal.reason);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await withTimeout(
          callHedged(
            { system: datasetPipeline.EXTRACTION_SYSTEM, user: datasetPipeline.buildExtractionUser(question, buildMaterialsBlock(candidates, { onlyWithQuantities: true, onlyIndices: new Set(pending) })) },
            { signal: controller.signal, hedgeAfterMs: 15000 }
          ),
          DATASET_TIMEOUT_MS,
          () => { controller.abort(); throw new Error(`dataset extraction timed out after ${DATASET_TIMEOUT_MS}ms`); }
        );
        records = records.concat(datasetPipeline.verifyRecords(datasetPipeline.parseRecords(result.text), candidates, materialText, { density }));
      } catch (err) {
        console.error('ai-search dataset extraction failed (using stored facts only):', err.message);
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    try { records = datasetPipeline.canonicalizeEntities(records, await getRoster()); } catch (_) { /* keep names as extracted */ }
    const dataset = datasetPipeline.buildDataset(records, required, { unitTons: req.unitTons, density });
    if (dataset) {
      dataset.extraCandidates = extraCandidates;
      console.log(`ai-search dataset built records=${dataset.records} extra_articles=${extraCandidates.length} extracted_live=${pending.length ? 'yes' : 'no'}`);
    }
    return dataset;
  } catch (err) {
    console.error('ai-search dataset pipeline failed:', err.message);
    return null;
  }
}

// Free-tier models occasionally leak a few characters of another script into Korean prose
// ("재생 디زل"). Those characters are removed unless the supplied materials contain them.
const STRAY_SCRIPT_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0900-\u097F\u0E00-\u0E7F\u0400-\u04FF]+/g;
function stripStrayScripts(text, candidates) {
  const t = String(text || '');
  if (!/[가-힣]/.test(t) || !STRAY_SCRIPT_RE.test(t)) return t;
  STRAY_SCRIPT_RE.lastIndex = 0;
  const known = candidates.map(materialText).join(' ');
  return t.replace(STRAY_SCRIPT_RE, (m) => (known.includes(m) ? m : ''));
}

// ANY visual request ("시각화", "도식", "표로", "한눈에", chart words) must end up with a table
// or a chart. A quantity request gets its chart from the answer's table (ensureChartPresent);
// when neither exists the answer is condensed into one compact table by a short, bounded call.
const TABULATE_SYSTEM = 'Condense the given answer into ONE compact Markdown pipe table (at most 8 rows, 2 to 5 columns) that makes its key points easy to scan. Copy every figure exactly, keep every [N] citation on the row it supports, add no new facts, and output ONLY the table.';
async function ensureVisual(text, req, signal) {
  if (!req.wantsVisual || /```chart/.test(text) || /^\s*\|.+\|\s*$/m.test(text)) return text;
  try {
    const result = await withTimeout(
      callHedged({ system: TABULATE_SYSTEM, user: String(text).slice(0, 6000) }, { signal, hedgeAfterMs: 8000 }),
      30000,
      () => { throw new Error('tabulate timed out'); }
    );
    const table = String(result.text || '').split('\n').filter((l) => /^\s*\|/.test(l)).join('\n').trim();
    if ((table.match(/\n/g) || []).length < 2) return text; // a header, a separator and a row at least
    console.log('ai-search request_compliance table_built_for_visual_request');
    return `${text}\n\n${table}`;
  } catch (err) {
    console.log(`ai-search visual fallback skipped (${err.message})`);
    return text;
  }
}

async function finalizeAnswer(rawText, candidates, signal, required = [], question = '', dataset = null, { quick = false } = {}) {
  let rawBody = String(rawText || '');
  if (TRUNCATION_NOTICE_RE.test(rawBody)) {
    rawBody = await completeTruncatedAnswer(rawBody.replace(TRUNCATION_NOTICE_RE, '').trimEnd(), candidates, signal);
  }
  let modelText = stripStrayScripts(normalizeCitationMarkers(rawBody), candidates);
  modelText = canonicalizeProperNouns(modelText, candidates.map(materialText), await getRoster());
  if (dataset) {
    // The system draws the table and chart; drop any the model still wrote.
    // (and its own unit-conversion remarks: the dataset states the basis itself)
    modelText = modelText.replace(/```chart[\s\S]*?```/g, '').split('\n').filter((l) => !/^\s*\|/.test(l) && !/환산|변환|밀도|conversion|density/i.test(l)).join('\n').trim();
  }
  const verifiedModel = await verifyCitations(modelText, candidates, signal);
  const verified = dataset ? `${dataset.markdown}\n\n${verifiedModel}` : verifiedModel;
  const covered = ensureCompanyCoverage(verified, required, candidates);
  // Number fidelity: figures are checked against the materials cited for them and
  // corrected/flagged (see lib/numberCheck.js) BEFORE footnotes are renumbered.
  const guarded = numberCheck.guardAnswerNumbers(covered, candidates, extractCitedIndices, materialText);
  if (guarded.fixed || guarded.flagged) console.log(`ai-search number_guard fixed=${guarded.fixed} flagged=${guarded.flagged}`);
  // Table presentation: one unit/format per numeric column, malformed numbers
  // removed, mixed-unit columns annotated (see lib/tableCheck.js).
  const tabled = tableCheck.normalizeTablesInText(guarded.text);
  if (tabled.normalized || tabled.warnings) console.log(`ai-search table_guard normalized=${tabled.normalized} warnings=${tabled.warnings}`);
  // Explicit user requests are enforced in code (chart kind, unit, a chart when one
  // was asked for) — see lib/requestCompliance.js.
  const req = requestCompliance.parseRequest(question);
  if (quick) req.completeness = false; // quick scope: no forced completeness rebuild
  const completed = requestCompliance.enforceCompleteChart(tabled.text, req);
  if (completed.rebuilt) console.log('ai-search request_compliance chart_rebuilt_for_completeness');
  const ensured = requestCompliance.ensureChartPresent(completed.text, req);
  const visualText = await ensureVisual(ensured.text, req, signal);
  if (ensured.built) console.log('ai-search request_compliance chart_built_from_table');
  const text = visualText;
  // Citation links are built from the DB rows we actually sent, never from
  // whatever the model's text claims — the model can't fabricate a URL.
  // Which candidates become `sources` is further narrowed to only the ones
  // the model's own [N] markers actually cited — a retrieved-but-unused
  // candidate never gets shown as "evidence" for an answer that didn't
  // draw on it. If the model cited nothing (missed the instruction), fall
  // back to showing every retrieved candidate rather than an empty list.
  const citedIndices = extractCitedIndices(text, candidates.length);
  const citedCandidates = citedIndices.length ? citedIndices.map((i) => candidates[i - 1]) : candidates;
  const answer = await enrichChartBlocks(moveCitationsAfterPunctuation(citedIndices.length ? remapCitationMarkers(text, citedIndices) : text), candidates, question);
  const sources = citedCandidates.map((c) => ({
    id: c.id,
    title: c.title,
    source: c.source_name || null,
    published_at: c.published_at,
  }));
  return { answer, sources };
}

// A client that can render incrementally sends Accept: text/event-stream
// to opt in; anything else (including no Accept header at all) gets
// today's plain JSON response, completely unchanged — this is additive,
// not a breaking change to the existing contract.
function wantsStream(req) {
  return (req.get('accept') || '').includes('text/event-stream');
}

const searchLimiter = createLimiter(2, 0, 4);
router.post('/', (req, res) => {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(Object.assign(new Error('client disconnected'), { name: 'AbortError' }));
  };
  res.once('close', onClose);
  searchLimiter((signal) => handleSearch(req, res, signal), controller.signal)
    .catch((err) => {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      if (err.code === 'LIMITER_QUEUE_FULL') {
        return res.status(503).set('Retry-After', '2').json({ error: '검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
      }
      console.error('ai-search request failed:', err.message);
      return res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
    })
    .finally(() => res.removeListener('close', onClose));
});

async function handleSearch(req, res, signal) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const isFollowup = Array.isArray(req.body.history) && req.body.history.length > 0;
  const streaming = wantsStream(req);

  // Not logged to ai_search_logs — an empty query never reaches retrieval
  // or the provider, so there's no operation to report telemetry for
  // (existing callers/tests rely on this guard touching the DB at all).
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  if (!question) return res.status(400).json({ error: '질문을 입력해 주세요.' });
  const fingerprint = questionFingerprint(question);
  // Scope the user confirmed on the guide card ({confirmed, mode: 'full'|'quick'}).
  const scope = req.body.scope && typeof req.body.scope === 'object' ? req.body.scope : {};
  const confirmed = scope.confirmed === true;
  const quick = confirmed && scope.mode === 'quick';

  let candidates;
  try {
    candidates = await retrieveCandidates(question, req.body.history, { light: quick });
    if (quick) candidates = candidates.slice(0, workloadPlan.QUICK_CANDIDATES);
    if (signal.aborted || res.destroyed) return;
  } catch (err) {
    console.error('ai-search retrieval failed:', err.message);
    const httpStatus = 500;
    await recordSearchTelemetry({ requestId, outcome: 'retrieval_error', httpStatus, latencyMs: Date.now() - startedAt, isFollowup, questionFingerprint: fingerprint, streamed: streaming });
    return res.status(httpStatus).json({ error: '검색 중 오류가 발생했습니다.' });
  }

  if (!candidates.length) {
    const httpStatus = 200;
    await recordSearchTelemetry({
      requestId, outcome: 'insufficient_evidence', httpStatus, latencyMs: Date.now() - startedAt,
      candidateCount: 0, sourceCount: 0, isFollowup, questionFingerprint: fingerprint, streamed: streaming,
    });
    // Never opens an SSE stream for this case — nothing was ever going to
    // stream, so the client's own content-type check (see app.js) just
    // treats this exactly like a non-streaming response.
    return res.status(httpStatus).json({ answer: INSUFFICIENT_MESSAGE, insufficient: true, sources: [] });
  }

  const roster = await getRoster();
  const intent = classifyIntent(question, roster);
  const required = quick ? [] : requiredCompanies(question, candidates, roster);
  // The verified dataset (extraction call) runs IN PARALLEL with the writing call: total
  // wait = the slower of the two, not their sum. If it succeeds, its table/chart replace
  // any the writer produced; if it fails, the writer's own answer stands.
  const cacheKey = Array.isArray(req.body.history) && req.body.history.length ? null : answerCacheKey(question, candidates, quick ? 'quick' : 'full');
  const cached = cacheKey ? answerCacheGet(cacheKey) : null;
  if (cached) {
    await recordSearchTelemetry({
      requestId, outcome: 'success', httpStatus: 200, latencyMs: Date.now() - startedAt,
      candidateCount: candidates.length, sourceCount: cached.sources.length, provider: 'cache',
      isFollowup, questionFingerprint: fingerprint, streamed: streaming,
    });
    if (!streaming) return res.json({ answer: cached.answer, insufficient: false, sources: cached.sources });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: done\ndata: ${JSON.stringify({ answer: cached.answer, insufficient: false, sources: cached.sources })}\n\n`);
    return res.end();
  }
  // Heavy requests are confirmed with the user before any AI work starts.
  if (!confirmed) {
    const materialsChars = buildMaterialsBlock(candidates).length;
    const assessment = workloadPlan.assessWorkload({
      question, candidates, required, expectLong: /(상세|자세히|종합|보고서|리포트|심층|모두|전부|전체|전수|누락)/.test(question) && candidates.length >= 20 && intent.type !== 'entity',
      systemChars: SYSTEM_PROMPT.length, materialsChars,
      extractionChars: buildMaterialsBlock(candidates, { onlyWithQuantities: true }).length,
      quickMaterialsChars: buildMaterialsBlock(candidates.slice(0, workloadPlan.QUICK_CANDIDATES)).length,
    });
    if (assessment.heavy) return res.json({ needsConfirmation: true, plan: assessment.plan });
  }
  const datasetPromise = quick ? Promise.resolve(null) : tryBuildDataset(question, candidates, required, signal);
  datasetPromise.catch(() => {});
  const scopeBlock = quick
    ? '\n\n[범위: 핵심 요약 모드 — 사용자가 빠른 요약을 선택했다. 상위 10개 안팎의 주요 대상만 간결하게 정리하고 나머지는 한 줄로 언급한다.]'
    : '';
  // The writer always produces a complete answer of its own; if the verified dataset
  // (built in parallel) succeeds, its table/chart replace the writer's.
  const datasetPending = !quick && datasetPipeline.isDatasetRequest(requestCompliance.parseRequest(question), question);
  const profileBlock = intent.type === 'entity'
    ? `\n\n[질의 유형: 기업 프로파일 — ${intent.focus[0].name}] 이 질문은 한 기업에 대한 개요 요청이다. 자료를 하나씩 훑지 말고 주제별로 종합해 아래 구조로 쓴다(자료에 있는 항목만, 없으면 "미확보"로 한 줄): (1) # 개요 — 어떤 회사인지(정체성·본사·주력 사업·규모) 2~3문장 (2) # 생산·사업 거점 — 거점별 제품과 CAPA·상태(현재/건설중/계획)를 표로, 수치는 자료 표기 그대로 (3) # 전략과 투자 (4) # 최근 동향 — 최신순 3~5개 (5) # 확인되지 않은 항목. 중복·유사 자료는 합치고, 문장마다 가장 관련 높은 자료 1~3개만 인용하며, 모든 자료를 나열하거나 인용할 필요는 없다. 전체 분량은 한국어 700단어 안팎으로 제한한다.`
    : intent.type === 'peers'
      ? `\n\n[질의 유형: 피어 비교 — ${intent.focus.map((c) => c.name).join(', ')}] 질문에 지명된 기업만 같은 항목·같은 단위로 나란히 비교한다(기업별 개요 한 줄, 비교표, 차이를 만드는 요인). 지명되지 않은 기업은 다루지 않는다.`
      : '';
  const user = `${buildHistoryBlock(req.body.history)}[Research Center materials]\n${buildMaterialsBlock(candidates)}\n\n[Question]\n${question}${buildCoverageBlock(required)}${profileBlock}${scopeBlock}`;

  if (!streaming) {
    let text;
    let providerName;
    try {
      const result = await provider.callProviderWithFallback({ system: SYSTEM_PROMPT, user }, { signal, lane: 'chat' });
      text = result.text;
      providerName = result.provider;
    } catch (err) {
      if (signal.aborted || res.destroyed) return;
      console.error('ai-search provider failed:', err.message);
      const httpStatus = 502;
      await recordSearchTelemetry({
        requestId, outcome: 'provider_error', httpStatus, latencyMs: Date.now() - startedAt,
        candidateCount: candidates.length, failureType: err.failureType || null, isFollowup, questionFingerprint: fingerprint, streamed: false,
      });
      return res.status(httpStatus).json({ error: 'AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
    if (signal.aborted || res.destroyed) return;
    const dataset = await datasetPromise;
    if (dataset && dataset.extraCandidates && dataset.extraCandidates.length) candidates.push(...dataset.extraCandidates);
    const { answer, sources } = await finalizeAnswer(text, candidates, signal, required, question, dataset, { quick });
    if (signal.aborted || res.destroyed) return;
    if (cacheKey && sources.length) answerCacheSet(cacheKey, { answer, sources });
    await recordSearchTelemetry({
      requestId, outcome: 'success', httpStatus: 200, latencyMs: Date.now() - startedAt,
      candidateCount: candidates.length, sourceCount: sources.length, provider: providerName,
      isFollowup, questionFingerprint: fingerprint, streamed: false,
    });
    return res.json({ answer, insufficient: false, sources });
  }

  // --- Streaming path ---
  // Raw model tokens (including their own [N] markers, un-remapped) are
  // forwarded to the browser as they arrive, purely so the user sees
  // something within seconds instead of waiting for the full answer AND
  // the citation-verification pass on top of it. The client renders this
  // raw stream as plain text, then swaps to the polished, citation-linked
  // version the instant the `done` event arrives — see renderHome()'s
  // runAiSearchTurn in app.js.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable any reverse-proxy response buffering, or token events arrive in one late burst
  });
  const sendEvent = (event, data) => { if (!signal.aborted && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  // Tokens are held back until the dataset settles (usually already done by the time the
  // model has written its first paragraph), so the system table/chart can lead the stream.
  let datasetSettled = !datasetPending; // other requests stream straight through
  let held = '';
  const flushed = datasetPromise.then((d) => {
    datasetSettled = true;
    if (d) sendEvent('token', { delta: `${d.markdown}\n\n` });
    if (held) { sendEvent('token', { delta: held }); held = ''; }
    return d;
  });
  let rawText;
  let ttftMs = null;
  let modelUsed = null;
  try {
    const result = await provider.callProviderWithFallbackStreaming(
      { system: SYSTEM_PROMPT, user },
      (delta) => { if (datasetSettled) sendEvent('token', { delta }); else held += delta; },
      { signal, lane: 'chat' }
    );
    rawText = result.text;
    ttftMs = result.ttftMs;
    modelUsed = result.model;
  } catch (err) {
    if (signal.aborted || res.destroyed) return;
    console.error('ai-search streaming provider failed:', err.message);
    sendEvent('error', { message: 'AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    res.end();
    await recordSearchTelemetry({
      requestId, outcome: 'provider_error', httpStatus: 502, latencyMs: Date.now() - startedAt,
      candidateCount: candidates.length, failureType: err.failureType || null, isFollowup, questionFingerprint: fingerprint,
      streamed: true, ttftMs,
    });
    return;
  }

  if (signal.aborted || res.destroyed) return;
  const dataset = await flushed;
  if (dataset && dataset.extraCandidates && dataset.extraCandidates.length) candidates.push(...dataset.extraCandidates);
  const { answer, sources } = await finalizeAnswer(rawText, candidates, signal, required, question, dataset, { quick });
  if (signal.aborted || res.destroyed) return;
  if (cacheKey && sources.length) answerCacheSet(cacheKey, { answer, sources });
  sendEvent('done', { answer, insufficient: false, sources });
  res.end();
  await recordSearchTelemetry({
    requestId, outcome: 'success', httpStatus: 200, latencyMs: Date.now() - startedAt,
    candidateCount: candidates.length, sourceCount: sources.length, provider: 'freellmapi', model: modelUsed,
    isFollowup, questionFingerprint: fingerprint, streamed: true, ttftMs,
  });
}

module.exports = router;
module.exports.extractConcepts = extractConcepts;
module.exports.enrichChartJson = enrichChartJson;
module.exports.normalizeStatusLabel = normalizeStatusLabel;
module.exports.trimToCompleteBlock = trimToCompleteBlock;
module.exports.stripStrayScripts = stripStrayScripts;
module.exports.dropNearDuplicates = dropNearDuplicates;
module.exports.callHedged = callHedged;
module.exports.answerCacheKey = answerCacheKey;
module.exports._clearAnswerCache = () => answerCache.clear();
module.exports.enrichChartBlocks = enrichChartBlocks;
module.exports.dropTotalFromSiteChart = dropTotalFromSiteChart;
module.exports.requiredCompanies = requiredCompanies;
module.exports.ensureCompanyCoverage = ensureCompanyCoverage;
module.exports.buildCoverageBlock = buildCoverageBlock;
module.exports.normalizeCitationMarkers = normalizeCitationMarkers;
module.exports.claimOverlapsMaterials = claimOverlapsMaterials;
module.exports.selectDiverseCandidates = selectDiverseCandidates;
module.exports.resolveRetrievalQuery = resolveRetrievalQuery;
module.exports.buildMaterialsBlock = buildMaterialsBlock;
module.exports.buildHistoryBlock = buildHistoryBlock;
module.exports.INSUFFICIENT_MESSAGE = INSUFFICIENT_MESSAGE;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.questionFingerprint = questionFingerprint;
module.exports.extractCitedIndices = extractCitedIndices;
module.exports.remapCitationMarkers = remapCitationMarkers;
module.exports.moveCitationsAfterPunctuation = moveCitationsAfterPunctuation;
module.exports.splitClaimLines = splitClaimLines;
module.exports.parseUnsupportedClaimNumbers = parseUnsupportedClaimNumbers;
module.exports.VERIFICATION_SYSTEM_PROMPT = VERIFICATION_SYSTEM_PROMPT;
module.exports.wantsStream = wantsStream;
module.exports.finalizeAnswer = finalizeAnswer;
module.exports.truncateField = truncateField;
module.exports.withTimeout = withTimeout;
module.exports.getVerificationTimeoutMs = getVerificationTimeoutMs;
