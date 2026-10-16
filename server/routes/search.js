const express = require('express');
const crypto = require('crypto');
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

// Bounded candidate set — never send the whole table to the LLM.
const MAX_CANDIDATES = 8;
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
  for (const suffix of KOREAN_STRIPPABLE_SUFFIXES) {
    if (word.length - suffix.length >= 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
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
const CANDIDATE_POOL = 30;
const MIN_PER_LANGUAGE = 3;
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

async function retrieveCandidates(question, history) {
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
  return selectDiverseCandidates(rows);
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
- Visualization process (follow in order whenever you produce a table or chart):
  1. Prepare the data: gather only figures stated in the materials; put them in one consistent unit and one consistent period basis (state any conversion in one sentence, and never convert with outside numbers); use null for a missing value; drop items with no usable number and say so.
  2. Choose the chart by the question: bar/hbar = compare a quantity across categories (e.g. sales or capacity by company; sort rankings in descending order); line = change over time (prices, production by year); scatter = the relationship between two numeric variables across items (e.g. capacity vs investment per plant) — needs at least 5 points, otherwise use a table or bar; stacked/pie/donut/area as described below. If no chart type fits the data honestly, use a table or plain text instead.
  3. Build it readable: always set a specific "title" (what, where, when), the "unit", and axis names "xLabel"/"yLabel" when the axes are not obvious; keep labels short; at most 12 categories and 4 series; do not add decoration.
  4. Interpret it: right after the chart or table write 1-3 sentences of takeaways (the highest/lowest, the trend or gap, anything notable), each with [N]; do not claim causes the materials do not state; mention data gaps or comparability caveats (different years, units, definitions).
- Visuals: when the user asks for a table/chart/graph, or when numeric comparisons across 3+ items/periods would be clearer visually, include one. Tables use standard Markdown pipe tables. Charts use a fenced block exactly like \`\`\`chart followed by one-line-or-multi-line JSON {"type":"bar"|"hbar"|"stacked"|"line"|"area"|"pie"|"donut"|"scatter","title":"...","unit":"...","xLabel":"...","yLabel":"...","labels":["..."],"series":[{"name":"...","data":[numbers]}]} and a closing \`\`\`. When several values belong to one entity (e.g. a company's capacity now vs 2030, or cost by scenario), MERGE them into ONE cluster per entity: make the entities the "labels" and the detail (현재, 2030년, 시나리오 A ...) the "series", with identical series names for every entity (max 4) and null for a missing value. Never list one bar per entity-detail pair. (Writing labels as "Entity(detail)" is also merged automatically, but the labels/series form is preferred.) Different details of the same entity are NOT additive, so use "bar"/"hbar" (never "stacked") for them. When the user asks to compare MULTIPLE targets (e.g. "식용유지들의 생산량 비교" = palm, soybean, rapeseed, sunflower oil), never chart just one of them: build ONE chart with every target the materials give numbers for as separate series (max 4, most-covered first), using a "line" chart over the shared periods (years) as labels; use null where a target has no figure for a period. If targets lack a common period, use a "bar" chart of the same year or the latest comparable figure per target, and say so in one sentence. Always list in text which requested targets had no usable data instead of silently dropping them. For "scatter": "labels" are the point names, series[0].data are the X values, series[1].data the Y values (same length, both numeric, name the series after the X and Y variables). Pick the type by the data: "line" for a time trend; "area" for cumulative/volume over time; "bar" to compare categories (or a few periods); "hbar" for rankings or long labels; "stacked" for composition of totals across categories/periods (one series per component); "pie"/"donut" ONLY for shares of ONE whole that sum to roughly 100% (single series, max 8 slices). Use several series (max 4) only when they share the same unit and labels. Use ONLY numbers stated in the supplied materials (never estimate or invent; omit the chart if fewer than 3 real data points), keep it to 12 labels and 4 series at most, and cite the source [N] in a sentence right after the chart or table.
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
const MAX_SUMMARY_CHARS = 320;
const MAX_INSIGHT_CHARS = 240;
function truncateField(text, maxChars) {
  const str = String(text || '');
  return str.length > maxChars ? `${str.slice(0, maxChars)}…` : str;
}

function buildMaterialsBlock(candidates) {
  return candidates.map((m, i) => [
    `자료 ${i + 1} — 제목: ${m.title}`,
    `출처: ${m.source_name || '미확인'}`,
    `발행일: ${m.published_at ? String(m.published_at).slice(0, 10) : '미확인'}`,
    `요약: ${truncateField(m.summary || m.ai_summary || '(요약 없음)', MAX_SUMMARY_CHARS)}`,
    (m.insight || m.ai_insight) ? `인사이트: ${truncateField(m.insight || m.ai_insight, MAX_INSIGHT_CHARS)}` : null,
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
async function verifyCitations(text, candidates, signal) {
  const claims = splitClaimLines(text, candidates.length);
  if (!claims.length) return text;
  try {
    const timeoutMs = getVerificationTimeoutMs();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const result = await withTimeout(
        provider.callProviderWithFallback({
          system: VERIFICATION_SYSTEM_PROMPT,
          user: buildVerificationPrompt(claims, candidates),
        }, { signal: controller.signal }),
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
        const { line } = claims[n - 1];
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
async function finalizeAnswer(rawText, candidates, signal) {
  const text = await verifyCitations(rawText, candidates, signal);
  // Citation links are built from the DB rows we actually sent, never from
  // whatever the model's text claims — the model can't fabricate a URL.
  // Which candidates become `sources` is further narrowed to only the ones
  // the model's own [N] markers actually cited — a retrieved-but-unused
  // candidate never gets shown as "evidence" for an answer that didn't
  // draw on it. If the model cited nothing (missed the instruction), fall
  // back to showing every retrieved candidate rather than an empty list.
  const citedIndices = extractCitedIndices(text, candidates.length);
  const citedCandidates = citedIndices.length ? citedIndices.map((i) => candidates[i - 1]) : candidates;
  const answer = moveCitationsAfterPunctuation(citedIndices.length ? remapCitationMarkers(text, citedIndices) : text);
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

  let candidates;
  try {
    candidates = await retrieveCandidates(question, req.body.history);
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

  const user = `${buildHistoryBlock(req.body.history)}[Research Center materials]\n${buildMaterialsBlock(candidates)}\n\n[Question]\n${question}`;

  if (!streaming) {
    let text;
    let providerName;
    try {
      const result = await provider.callProviderWithFallback({ system: SYSTEM_PROMPT, user }, { signal });
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
    const { answer, sources } = await finalizeAnswer(text, candidates, signal);
    if (signal.aborted || res.destroyed) return;
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

  let rawText;
  let ttftMs = null;
  let modelUsed = null;
  try {
    const result = await provider.callProviderWithFallbackStreaming(
      { system: SYSTEM_PROMPT, user },
      (delta) => sendEvent('token', { delta }),
      { signal }
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
  const { answer, sources } = await finalizeAnswer(rawText, candidates, signal);
  if (signal.aborted || res.destroyed) return;
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
