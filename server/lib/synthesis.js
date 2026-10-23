// SYNTHESIS MODE. Retrieval already returns many deduplicated materials; what made answers read like one article's summary
// was the context handed to the writer (materials in raw relevance order, no recency/evidence priority) and the prompt (no
// issue-level structure). For a broad "what is happening / outlook / impact" question this module (1) reorders the materials by
// relevance + recency + evidence, and (2) adds the answer structure: ranked issues, an overall judgement that separates facts,
// interpretation and outlook, and follow-up monitoring — or, when the archive is thin, a plain statement of the limit.
const numberCheck = require('./numberCheck');

const BROAD = /(동향|이슈|현황|전망|흐름|트렌드|추세|영향|변화|최근|종합|무슨\s*일|뉴스|근황|리스크|시사점|trend|outlook|impact|latest|update)/i;
const SIMPLE_FACT = /(얼마|몇\s*(%|퍼센트|톤|개|곳|명|원|달러)|언제|누가|누구|어디)/;
const DOMESTIC = /(국내|한국|우리나라)/;
const MIN_FOR_SYNTHESIS = 3; // fewer relevant materials than this: answer within them and state the limit
const DAY = 86400000;

function isBroadQuestion(question) {
  const q = String(question || '');
  return BROAD.test(q) && !(SIMPLE_FACT.test(q) && !/(동향|이슈|전망|흐름|트렌드|추세)/.test(q));
}

const textOf = (m) => [m.title, m.summary, m.ai_summary, m.insight, m.ai_insight].filter(Boolean).join(' ');

// relevance (SQL order score) 50% + recency 35% (linear over 90 days) + evidence 15% (states a quantity).
function priorityScore(m, topRel, now) {
  const rel = topRel > 0 ? Math.min(1, (Number(m.relevance_score) || 0) / topRel) : 0.5;
  const t = m.published_at ? new Date(m.published_at).getTime() : NaN;
  const recency = Number.isFinite(t) ? Math.max(0, 1 - (now - t) / (90 * DAY)) : 0;
  let evidence = 0;
  try { evidence = numberCheck.extractQuantities(textOf(m)).length ? 1 : 0; } catch (_) { evidence = 0; }
  return 0.5 * rel + 0.35 * recency + 0.15 * evidence;
}

function rankForSynthesis(candidates, now = Date.now()) {
  const topRel = Math.max(0, ...candidates.map((m) => Number(m.relevance_score) || 0));
  return candidates
    .map((m, i) => ({ m, i, s: priorityScore(m, topRel, now) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

function promptBlock(question, candidateCount) {
  if (candidateCount < MIN_FOR_SYNTHESIS) {
    return `\n\n[답변 방식: 근거 자료가 ${candidateCount}건뿐이다] 이 자료로 확인되는 범위만 간결히 답한다. 한 건의 사례로 산업 전체의 흐름을 단정하지 말고, 마지막에 "자료가 ${candidateCount}건뿐이라 종합 판단은 어렵다"는 취지로 한계를 한 줄로 밝힌다. 이슈를 억지로 늘리지 않는다.`;
  }
  const domestic = DOMESTIC.test(question)
    ? ' 질문이 국내를 묻는다: "국내 기업·시장 직접 이슈"와 "국내 시장에 영향을 주는 해외 이슈"를 구분해 쓴다.'
    : '';
  return `\n\n[답변 방식: 아카이브 종합 분석] 자료를 하나씩 요약하지 말고 공통 주제별로 묶어 쓴다. 자료는 질문 관련성·최신성·근거 수준 순으로 정렬되어 있다.
# 핵심 이슈 — 중요도순 3~5개(관련 자료가 부족하면 억지로 채우지 않는다). 이슈마다 (1) 핵심 사실 [N] 발행일 표기 (2) 관련 자료 간 연결점 (3) 국내 시장·기업과의 관련성 (4) 실무적 시사점. 순위는 질문 관련성, 최신성, 사업 영향도, 근거 수준(수치·공식 발표·복수 자료)으로 정한다.
# 종합 판단 — 복수 자료에서 공통으로 확인되는 흐름과 의미. "확인된 사실"과 "인사이트(여러 자료를 종합한 해석)"와 "향후 전망"을 문장 단위로 구분해 쓴다. 단일 사례만으로 산업 전체의 추세를 단정하지 않는다.
# 추가 모니터링 — 추가 확인이 필요한 지표와 후속 이슈 2~4개.${domestic}
각 사실 문장에는 근거 자료 [N]을 붙이고 자료의 발행일을 함께 쓴다. 자료에 없는 사실·수치·출처는 만들지 않는다. [분량: 이 종합 답변은 한국어 650단어 안팎까지 허용한다.]`;
}

module.exports = { isBroadQuestion, rankForSynthesis, promptBlock, MIN_FOR_SYNTHESIS };
