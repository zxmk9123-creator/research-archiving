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

const FRESH_DAYS = 120;     // older materials are background, not issues: dropped when enough recent ones exist
const MAX_SYNTHESIS_MATERIALS = 8; // fewer, better materials -> fewer repeated citations and a tighter answer

function selectForSynthesis(candidates, now = Date.now()) {
  const ranked = rankForSynthesis(candidates, now);
  const fresh = ranked.filter((m) => {
    const t = m.published_at ? new Date(m.published_at).getTime() : NaN;
    return Number.isFinite(t) && now - t <= FRESH_DAYS * DAY;
  });
  return (fresh.length >= MIN_FOR_SYNTHESIS ? fresh : ranked).slice(0, MAX_SYNTHESIS_MATERIALS);
}

function promptBlock(question, candidateCount) {
  if (candidateCount < MIN_FOR_SYNTHESIS) {
    return `\n\n[답변 방식: 근거 자료가 ${candidateCount}건뿐이다] 이 자료로 확인되는 범위만 간결히 답한다. 한 건의 사례로 산업 전체의 흐름을 단정하지 말고, 마지막에 "자료가 ${candidateCount}건뿐이라 종합 판단은 어렵다"는 취지로 한계를 한 줄로 밝힌다. 이슈를 억지로 늘리지 않는다.`;
  }
  const domestic = DOMESTIC.test(question)
    ? ' 질문이 국내를 묻는다: 이슈 제목 앞에 [국내] 또는 [해외→국내 영향]을 붙여 구분한다.'
    : '';
  return `\n\n[답변 방식: 핵심 위주 종합 브리핑 — 자료를 하나씩 요약하지 말고 공통 주제로 묶는다. 자료는 관련성·최신성·근거 수준 순이다]
# 핵심 이슈
- **이슈 제목(한 줄)**
  - 사실: 확인된 핵심 내용 1문장 [N]
  - 시사점: 국내 시장·기업 관련성을 포함한 실무적 의미 1문장 [N]
(이슈 3~4개, 중요도순. 자료가 부족하면 그보다 적게 쓰고 채우지 않는다.${domestic})
# 종합 판단
- **인사이트**
  - 복수 자료에서 확인되는 공통 흐름과 의미, 필요하면 향후 전망까지 합쳐 2문장 이내 [N][M]
# 추가 모니터링
- 확인할 지표·후속 이슈 2~3개, 한 줄씩, 인용 없이.
지킬 것: ① 모든 내용은 위 불릿 층위(상위 굵은 제목 → 하위 "- " 두 칸 들여쓰기)로 쓰고 줄글 문단을 쓰지 않는다. 하위 불릿은 위에 보인 라벨(사실/시사점)만 쓰고 각 불릿은 한 문장이다. ② 같은 [N]을 한 항목 안에서 반복하지 않고, 한 문장에 [N]은 1~2개만 쓴다. ③ 날짜를 본문에 쓰지 않는다(출처 목록에 표시된다). 시점이 의미를 바꿀 때만 "10월 22일"처럼 쓰고, 날짜가 불명이면 아무것도 쓰지 않는다. ④ 시장규모 전망 보고서·광고성 자료는 사실로 쓰지 않는다. ⑤ 자료에 없는 사실·수치·출처는 만들지 않는다. ⑥ 단일 사례로 산업 전체 추세를 단정하지 않는다. ⑦ 분량은 한국어 250~400단어, 군더더기 서두·맺음말 없이.`;
}

module.exports = { isBroadQuestion, rankForSynthesis, selectForSynthesis, promptBlock, MIN_FOR_SYNTHESIS, FRESH_DAYS, MAX_SYNTHESIS_MATERIALS };
