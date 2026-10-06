const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDraftResponse,
  buildUserPrompt,
  buildTaxonomyBlock,
  buildFactualSummary,
  resolveInsight,
  isUngroundedGeneralization,
  factOrUnconfirmed,
  parseEligible,
  applyAiDraftIfEligible,
  generateAiDraftForItem,
  UNCONFIRMED,
  INSIGHT_FALLBACK,
  SYSTEM_PROMPT,
} = require('../server/lib/aiDraft');
const pool = require('../server/db/pool');

const taxonomy = {
  sectors: [
    { id: 1, name: '식용유지' },
    { id: 3, name: '팜유' },
    { id: 4, name: '대두유' },
  ],
  usages: [
    { id: 1, name: 'NBO 작성' },
    { id: 3, name: '시장 전망' },
  ],
};

function fullResponse(overrides = {}) {
  return JSON.stringify({
    eligible: true,
    eligibility_reason: '구체적 수치와 시점이 포함된 시장 뉴스다.',
    who: '인도네시아 정부',
    what: '팜유 수출세를 인상했다',
    amount: '톤당 50달러',
    when: '2026-09-01',
    where: '인도네시아',
    why: '국내 공급 안정을 위해',
    impact: '아시아 팜유 가격 상승 압력',
    summary: '인도네시아 정부가 국내 공급 안정을 위해 팜유 수출세를 톤당 50달러 인상했다.',
    insight: '이번 조치는 다른 팜유 수출국의 유사 정책으로 이어질 가능성이 있다.',
    key_takeaway: '수출세 인상이 단기 가격 상승 요인이다.',
    suggested_sectors: [3],
    suggested_usages: [3],
    ...overrides,
  });
}

test('parseDraftResponse: accepts a valid structured response and passes through the model\'s natural-language summary', () => {
  const draft = parseDraftResponse(fullResponse(), taxonomy);
  assert.equal(draft.eligible, true);
  assert.equal(draft.eligibilityReason, '구체적 수치와 시점이 포함된 시장 뉴스다.');
  assert.equal(draft.keyTakeaway, '수출세 인상이 단기 가격 상승 요인이다.');
  assert.deepEqual(draft.suggestedSectors, [3]);
  assert.deepEqual(draft.suggestedUsages, [3]);
  assert.equal(draft.summary, '인도네시아 정부가 국내 공급 안정을 위해 팜유 수출세를 톤당 50달러 인상했다.');
  assert.equal(draft.insight, '이번 조치는 다른 팜유 수출국의 유사 정책으로 이어질 가능성이 있다.');
  // The 5W1H facts are reasoning criteria only — never a labeled dump in the summary.
  assert.doesNotMatch(draft.summary, /누가:|무엇을:|규모\/금액:|시점:|장소:|이유:|영향:/);
  // Still extracted internally (used for eligibility/reasoning, not shown as-is).
  assert.equal(draft.facts.who, '인도네시아 정부');
  assert.equal(draft.facts.amount, '톤당 50달러');
});

test('parseDraftResponse: summary and insight are kept as two distinct fields — fact vs. inference', () => {
  const draft = parseDraftResponse(fullResponse({
    summary: '회사 A가 공장을 확장한다고 발표했다.',
    insight: '이는 지역 내 생산 능력 경쟁이 심화될 조짐으로 해석될 수 있다.',
  }), taxonomy);
  assert.equal(draft.summary, '회사 A가 공장을 확장한다고 발표했다.');
  assert.equal(draft.insight, '이는 지역 내 생산 능력 경쟁이 심화될 조짐으로 해석될 수 있다.');
  assert.notEqual(draft.summary, draft.insight);
});

const WELL_GROUNDED_FACTS = {
  who: '인도네시아 정부', what: '팜유 수출세를 인상했다', amount: '톤당 50달러',
  when: '2026-09-01', where: '인도네시아', why: '국내 공급 안정을 위해', impact: '아시아 팜유 가격 상승 압력',
};
// Mirrors production item 65: eligible=false because the article had almost
// no concrete facts — only a bare topic, everything else 미확보.
const THIN_FACTS = {
  who: UNCONFIRMED, what: 'UK 식물성 장 건강 제품 트렌드', amount: UNCONFIRMED,
  when: UNCONFIRMED, where: UNCONFIRMED, why: UNCONFIRMED, impact: UNCONFIRMED,
};

test('resolveInsight: passes through the model\'s trimmed inference when the facts support it', () => {
  assert.equal(
    resolveInsight('  향후 가격 변동성이 커질 수 있다.  ', WELL_GROUNDED_FACTS),
    '향후 가격 변동성이 커질 수 있다.'
  );
});

test('resolveInsight: falls back to an honest "no notable implication" statement when the model gives none', () => {
  assert.equal(resolveInsight('', WELL_GROUNDED_FACTS), INSIGHT_FALLBACK);
  assert.equal(resolveInsight(undefined, WELL_GROUNDED_FACTS), INSIGHT_FALLBACK);
  assert.equal(resolveInsight(null, WELL_GROUNDED_FACTS), INSIGHT_FALLBACK);
});

// Regression: production item 65 — eligible=false, almost no concrete facts,
// but the model still wrote a generic, ungrounded market prediction ("UK
// 식물성 장 건강 시장이 향후 성장할 가능성이 있다."). Too few confirmed facts
// must override the model's insight regardless of what it says, since there
// isn't enough evidence in the article to support any inference from it.
test('resolveInsight: overrides a generic/ungrounded market prediction when too few facts were actually confirmed (item 65 pattern)', () => {
  const genericPrediction = 'UK 식물성 장 건강 시장이 향후 성장할 가능성이 있다.';
  assert.equal(resolveInsight(genericPrediction, THIN_FACTS), INSIGHT_FALLBACK);
});

test('resolveInsight: a single confirmed fact is still not enough grounding for an inference', () => {
  const oneFact = { ...THIN_FACTS, what: '식물성 장 건강 보충제 신제품 출시' };
  assert.equal(resolveInsight('시장 경쟁이 심화될 것이다.', oneFact), INSIGHT_FALLBACK);
});

test('resolveInsight: exactly the minimum number of confirmed facts is enough to keep the model\'s inference', () => {
  const twoFacts = { ...THIN_FACTS, what: '회사 A가 신제품을 출시했다', when: '2026-09-15' };
  const insight = '이는 관련 시장의 경쟁이 심화되는 신호로 해석될 수 있다.';
  assert.equal(resolveInsight(insight, twoFacts), insight);
});

// --- Ungrounded generalization: enough facts to pass the count check, but
// the model still overreaches beyond what those facts actually support. ---

test('isUngroundedGeneralization: flags scope words like 업계/산업/시장 전반·전체', () => {
  assert.equal(isUngroundedGeneralization('업계 전반의 확장 추세를 보여준다.'), true);
  assert.equal(isUngroundedGeneralization('산업 전체가 성장할 것으로 보인다.'), true);
});

test('isUngroundedGeneralization: flags an unsupported macro-slowdown conclusion', () => {
  assert.equal(isUngroundedGeneralization('이는 업계 전반의 경기 둔화를 시사한다.'), true);
  assert.equal(isUngroundedGeneralization('산업 침체로 이어질 수 있다.'), true);
});

test('isUngroundedGeneralization: does not flag a specific, article-scoped monitoring point', () => {
  assert.equal(isUngroundedGeneralization('해당 기업의 다음 분기 실적을 지켜볼 필요가 있다.'), false);
  assert.equal(isUngroundedGeneralization('경쟁사의 유사한 조치 여부가 관전 포인트다.'), false);
});

test('resolveInsight: concrete, well-grounded facts keep a specific article-scoped insight', () => {
  const specificInsight = '경쟁사들이 유사한 수출세 인상에 나설지가 관전 포인트다.';
  assert.equal(resolveInsight(specificInsight, WELL_GROUNDED_FACTS), specificInsight);
});

// Regression: a single company's news generalized into an industry-wide
// expansion claim must fall back, even when enough facts were confirmed.
test('resolveInsight: a single-company fact does not license a generic industry-wide expansion claim', () => {
  const singleCompanyFacts = {
    who: '회사 A', what: '신규 생산 라인을 가동했다', amount: '연산 10만톤',
    when: '2026-09-20', where: UNCONFIRMED, why: UNCONFIRMED, impact: UNCONFIRMED,
  };
  const overreach = '이는 업계 전반의 생산 능력 확대로 이어질 것이다.';
  assert.equal(resolveInsight(overreach, singleCompanyFacts), INSIGHT_FALLBACK);
});

// Regression: one company's job-cut figure is not evidence of an
// industry-wide slowdown.
test('resolveInsight: a single job-cut figure does not license an unsupported "industry slowdown" claim', () => {
  const jobCutFacts = {
    who: '회사 B', what: '인력을 감축했다', amount: '200명',
    when: '2026-09-10', where: UNCONFIRMED, why: '비용 절감을 위해', impact: UNCONFIRMED,
  };
  const overreach = '이는 업계 전반의 경기 둔화를 시사한다.';
  assert.equal(resolveInsight(overreach, jobCutFacts), INSIGHT_FALLBACK);
});

// Regression: insufficient/non-relevant article facts still fall back, as before.
test('resolveInsight: insufficient facts fall back even when the model attempts a specific-sounding claim', () => {
  assert.equal(resolveInsight('해당 기업의 다음 행보를 지켜볼 필요가 있다.', THIN_FACTS), INSIGHT_FALLBACK);
});

test('parseDraftResponse: strips a ```json code fence before parsing', () => {
  const raw = '```json\n' + fullResponse() + '\n```';
  const draft = parseDraftResponse(raw, taxonomy);
  assert.match(draft.summary, /인도네시아 정부/);
});

test('parseDraftResponse: rejects malformed JSON safely (no throw escapes as a crash, just a clear Error)', () => {
  assert.throws(() => parseDraftResponse('this is not json at all', taxonomy), /not valid JSON/);
});

test('parseDraftResponse: rejects a JSON array (not an object)', () => {
  assert.throws(() => parseDraftResponse('[1,2,3]', taxonomy), /not a JSON object/);
});

test('parseDraftResponse: never throws on a missing internal fact — it becomes 미확보 internally, but the summary is unaffected since it comes from the model\'s prose', () => {
  const draft = parseDraftResponse(fullResponse({ amount: undefined, when: '' }), taxonomy);
  assert.equal(draft.facts.amount, UNCONFIRMED);
  assert.equal(draft.facts.when, UNCONFIRMED);
  assert.doesNotMatch(draft.summary, new RegExp(UNCONFIRMED));
});

test('parseDraftResponse: normalizes model-invented "none/null/없음" style fillers to 미확보 in the internal facts (never a fabricated fact)', () => {
  const draft = parseDraftResponse(fullResponse({ amount: '없음', where: 'null', why: 'N/A' }), taxonomy);
  assert.equal(draft.facts.amount, UNCONFIRMED);
  assert.equal(draft.facts.where, UNCONFIRMED);
  assert.equal(draft.facts.why, UNCONFIRMED);
});

test('parseDraftResponse: eligible defaults to null (no recommendation) when the model omits a boolean verdict', () => {
  const draft = parseDraftResponse(fullResponse({ eligible: 'yes' }), taxonomy);
  assert.equal(draft.eligible, null);
});

test('parseDraftResponse: eligible=false is preserved as an explicit recommendation, not treated as "missing"', () => {
  const draft = parseDraftResponse(fullResponse({ eligible: false, eligibility_reason: '단순 헤드라인, 구체적 사실 없음' }), taxonomy);
  assert.equal(draft.eligible, false);
  assert.equal(draft.eligibilityReason, '단순 헤드라인, 구체적 사실 없음');
});

test('parseDraftResponse: a quoted "true"/"false" string from the model (the observed production bug — Groq has no JSON-schema enforcement) is still recognized as a real verdict', () => {
  assert.equal(parseDraftResponse(fullResponse({ eligible: 'true' }), taxonomy).eligible, true);
  assert.equal(parseDraftResponse(fullResponse({ eligible: 'false' }), taxonomy).eligible, false);
});

test('parseEligible: preserves genuine booleans as-is', () => {
  assert.equal(parseEligible(true), true);
  assert.equal(parseEligible(false), false);
});

test('parseEligible: normalizes "true"/"false" strings, including case and surrounding whitespace', () => {
  assert.equal(parseEligible('true'), true);
  assert.equal(parseEligible('false'), false);
  assert.equal(parseEligible('True'), true);
  assert.equal(parseEligible('FALSE'), false);
  assert.equal(parseEligible('  true  '), true);
  assert.equal(parseEligible('  FALSE  '), false);
});

test('parseEligible: numeric 1/0 are not guessed as booleans — they stay null', () => {
  assert.equal(parseEligible(1), null);
  assert.equal(parseEligible(0), null);
});

test('parseEligible: an unrecognized string, or a missing/undefined value, stays null', () => {
  assert.equal(parseEligible('yes'), null);
  assert.equal(parseEligible(undefined), null);
  assert.equal(parseEligible(null), null);
});

test('parseDraftResponse: missing eligibility_reason falls back to 미확보 rather than an empty string', () => {
  const draft = parseDraftResponse(fullResponse({ eligibility_reason: '' }), taxonomy);
  assert.equal(draft.eligibilityReason, UNCONFIRMED);
});

test('parseDraftResponse: discards unknown sector ids instead of persisting them', () => {
  const draft = parseDraftResponse(fullResponse({ suggested_sectors: [3, 999] }), taxonomy);
  assert.deepEqual(draft.suggestedSectors, [3]);
});

test('parseDraftResponse: discards unknown usage ids instead of persisting them', () => {
  const draft = parseDraftResponse(fullResponse({ suggested_usages: [3, 42] }), taxonomy);
  assert.deepEqual(draft.suggestedUsages, [3]);
});

test('parseDraftResponse: deduplicates repeated ids from the model', () => {
  const draft = parseDraftResponse(fullResponse({ suggested_sectors: [3, 3, 1] }), taxonomy);
  assert.deepEqual(draft.suggestedSectors, [3, 1]);
});

test('parseDraftResponse: non-array suggestion fields degrade to empty arrays, not a crash', () => {
  const draft = parseDraftResponse(fullResponse({ suggested_sectors: 'not-an-array', suggested_usages: null }), taxonomy);
  assert.deepEqual(draft.suggestedSectors, []);
  assert.deepEqual(draft.suggestedUsages, []);
});

test('factOrUnconfirmed: returns the trimmed value when present', () => {
  assert.equal(factOrUnconfirmed('  톤당 50달러  '), '톤당 50달러');
});

test('factOrUnconfirmed: returns 미확보 for missing, empty, or non-string values', () => {
  assert.equal(factOrUnconfirmed(undefined), UNCONFIRMED);
  assert.equal(factOrUnconfirmed(''), UNCONFIRMED);
  assert.equal(factOrUnconfirmed(null), UNCONFIRMED);
  assert.equal(factOrUnconfirmed(42), UNCONFIRMED);
});

test('buildFactualSummary: uses the model\'s natural-language summary as-is when present', () => {
  const facts = { who: 'A', what: 'B', amount: UNCONFIRMED, when: 'D', where: 'E', why: 'F', impact: 'G' };
  const summary = buildFactualSummary(facts, '  자연스러운 한두 문장 요약.  ');
  assert.equal(summary, '자연스러운 한두 문장 요약.');
});

test('buildFactualSummary: never renders a labeled 누가/무엇을/... list, even as a fallback', () => {
  const facts = { who: UNCONFIRMED, what: '팜유 수출세 인상', amount: UNCONFIRMED, when: UNCONFIRMED, where: UNCONFIRMED, why: UNCONFIRMED, impact: UNCONFIRMED };
  const summary = buildFactualSummary(facts, '');
  assert.doesNotMatch(summary, /누가:|무엇을:|규모\/금액:|시점:|장소:|이유:|영향:/);
});

test('buildFactualSummary: falls back to the "what" fact when the model gives no summary, still omitting 미확보 fields rather than listing them', () => {
  const facts = { who: UNCONFIRMED, what: '팜유 수출세 인상', amount: UNCONFIRMED, when: UNCONFIRMED, where: UNCONFIRMED, why: UNCONFIRMED, impact: UNCONFIRMED };
  const summary = buildFactualSummary(facts, undefined);
  assert.equal(summary, '팜유 수출세 인상');
});

test('buildFactualSummary: falls back to a generic message when nothing at all is confirmed, never fabricating a fact', () => {
  const facts = { who: UNCONFIRMED, what: UNCONFIRMED, amount: UNCONFIRMED, when: UNCONFIRMED, where: UNCONFIRMED, why: UNCONFIRMED, impact: UNCONFIRMED };
  const summary = buildFactualSummary(facts, '');
  assert.equal(summary, '핵심 사실이 확인되지 않았습니다.');
});

test('buildUserPrompt: uses title + description, never claims to have read a full article', () => {
  const prompt = buildUserPrompt({ title: '팜유 뉴스', summary: '가격 상승' }, taxonomy);
  assert.match(prompt, /Title: 팜유 뉴스/);
  assert.match(prompt, /Description: 가격 상승/);
});

test('buildUserPrompt: falls back to "(none available)" when no description was collected', () => {
  const prompt = buildUserPrompt({ title: '제목만 있음', summary: null }, taxonomy);
  assert.match(prompt, /Description: \(none available\)/);
});

test('buildUserPrompt: an extractedText argument (e.g. PDF text) is used as the material instead of item.summary', () => {
  const prompt = buildUserPrompt({ title: '보고서', summary: 'RSS 요약은 무시되어야 함' }, taxonomy, 'PDF에서 추출된 본문 내용');
  assert.match(prompt, /Description: PDF에서 추출된 본문 내용/);
  assert.doesNotMatch(prompt, /RSS 요약은 무시되어야 함/);
});

test('buildUserPrompt: extractedText is truncated so an arbitrarily long PDF cannot blow up prompt size', () => {
  const longText = 'x'.repeat(20000);
  const prompt = buildUserPrompt({ title: '보고서' }, taxonomy, longText);
  const descriptionLine = prompt.split('\n').find((l) => l.startsWith('Description:'));
  assert.ok(descriptionLine.length < 8100);
});

test('buildTaxonomyBlock: only lists the taxonomy actually passed in (grounding, not invented labels)', () => {
  const block = buildTaxonomyBlock(taxonomy.sectors, taxonomy.usages);
  assert.match(block, /3: 팜유/);
  assert.doesNotMatch(block, /어묵/); // sanity: nothing invented appears
});

// --- Eligibility prompt refinement (73-item human-review dataset) ---
// The prompt must encode the ordered A-E criteria and must NOT fall back
// to the old "has specific facts = eligible" heuristic.

test('SYSTEM_PROMPT: encodes the ordered eligibility criteria and explicitly disavows the old heuristic', () => {
  assert.match(SYSTEM_PROMPT, /Concrete development/);
  assert.match(SYSTEM_PROMPT, /Research significance/);
  assert.match(SYSTEM_PROMPT, /Evidence\/anchor/);
  assert.match(SYSTEM_PROMPT, /Scope and framing/);
  assert.match(SYSTEM_PROMPT, /Recurring content/);
  assert.match(SYSTEM_PROMPT, /do NOT require numerical data when the development itself is materially significant/i);
  assert.match(SYSTEM_PROMPT, /do not use "has specific facts\/figures" by itself as the test/i);
});

test('SYSTEM_PROMPT: summary and insight rules are unchanged from before this refinement', () => {
  assert.match(SYSTEM_PROMPT, /a natural, flowing 1-3 sentence Korean summary containing ONLY the article's directly-stated facts/);
  assert.match(SYSTEM_PROMPT, /a separate 1-2 sentence Korean field for what goes BEYOND the plain facts/);
});

// The eight scenarios below are pure parseDraftResponse pass-through
// fixtures: parseDraftResponse never itself judges eligibility (that's the
// model's job, per the refined prompt above) — these confirm the parser
// preserves whatever verdict+reason the model returns for each scenario,
// with no corruption/override, across the full range of cases the new
// prompt is meant to produce.

test('eligibility scenario: concrete market development -> eligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: true,
    eligibility_reason: '팜유 수출세 인상이라는 구체적 정책 변화가 아시아 가격에 영향을 미친다.',
  }), taxonomy);
  assert.equal(draft.eligible, true);
});

test('eligibility scenario: single-company development with meaningful market/business implication -> eligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: true,
    eligibility_reason: '단일 기업의 발표이지만 정제유 수출 물량이 크게 늘어 국제 시장 점유율에 영향을 준다.',
    who: '단고테 정유', what: '정제유 수출 물량 확대', impact: '나이지리아의 국제 시장 점유율 확대',
  }), taxonomy);
  assert.equal(draft.eligible, true);
});

test('eligibility scenario: single-company operational news with no broader implication -> ineligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: false,
    eligibility_reason: '단일 유정의 시추 방식 변경에 관한 기술적 운영 정보로, 시장 전반에 대한 시사점이 없다.',
    who: '퍼미안 지역 운영사', what: '시추공 길이를 늘려 생산량을 늘림', impact: UNCONFIRMED,
  }), taxonomy);
  assert.equal(draft.eligible, false);
});

test('eligibility scenario: geopolitical/security incident without economic transmission -> ineligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: false,
    eligibility_reason: '군사적 공격 사건이며 경제적 파급 효과가 명시되어 있지 않다.',
    who: '이란', what: '호르무즈 해협에서 발생한 미사일 공격', impact: UNCONFIRMED,
  }), taxonomy);
  assert.equal(draft.eligible, false);
});

test('eligibility scenario: recurring roundup with no discrete development -> ineligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: false,
    eligibility_reason: '매주 발행되는 정기 시장 동향 요약으로 이번 호에 새로운 구체적 사건이 없다.',
    what: '주간 벙커유 시장 동향 요약', impact: UNCONFIRMED,
  }), taxonomy);
  assert.equal(draft.eligible, false);
});

test('eligibility scenario: recurring roundup containing a material new development -> eligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: true,
    eligibility_reason: '정기 요약이지만 주요 기업들의 ZEMBA 이니셔티브 참여라는 새로운 구체적 사건을 포함한다.',
    who: 'Google, Microsoft, DSV', what: 'ZEMBA 이니셔티브 참여 발표', impact: '해운 탈탄소 협력 확대',
  }), taxonomy);
  assert.equal(draft.eligible, true);
});

test('eligibility scenario: quantified market event -> eligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: true,
    eligibility_reason: '미국 전략비축유가 1982년 이후 최저 수준으로 하락했다는 구체적 수치가 포함된 시장 사건이다.',
    who: 'EIA', what: '전략비축유 재고 발표', amount: '2억 8,460만 배럴',
  }), taxonomy);
  assert.equal(draft.eligible, true);
});

test('eligibility scenario: relevant but vague commentary -> ineligible', () => {
  const draft = parseDraftResponse(fullResponse({
    eligible: false,
    eligibility_reason: '유지 시장에 대한 막연한 논평으로 구체적 사건이나 수치가 없다.',
    who: UNCONFIRMED, what: UNCONFIRMED, amount: UNCONFIRMED, when: UNCONFIRMED, where: UNCONFIRMED, why: UNCONFIRMED, impact: UNCONFIRMED,
  }), taxonomy);
  assert.equal(draft.eligible, false);
});

// --- applyAiDraftIfEligible: the autonomous auto-archive step ---

function mockPool(handlers) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('applyAiDraftIfEligible: does nothing when ai_status is not completed', async () => {
  const { calls, restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({ rows: [{ id: 1, ai_status: 'pending', ai_eligible: true }] })],
  ]);
  try {
    const result = await applyAiDraftIfEligible(1);
    assert.equal(result.archived, false);
    assert.equal(calls.filter((c) => c.text.includes('UPDATE items SET summary')).length, 0);
  } finally {
    restore();
  }
});

test('applyAiDraftIfEligible: does nothing when ai_eligible is false', async () => {
  const { calls, restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({ rows: [{ id: 1, ai_status: 'completed', ai_eligible: false }] })],
  ]);
  try {
    const result = await applyAiDraftIfEligible(1);
    assert.equal(result.archived, false);
    assert.equal(calls.filter((c) => c.text.includes('UPDATE items SET summary')).length, 0);
  } finally {
    restore();
  }
});

test('applyAiDraftIfEligible: does nothing when ai_eligible is null (no recommendation)', async () => {
  const { restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({ rows: [{ id: 1, ai_status: 'completed', ai_eligible: null }] })],
  ]);
  try {
    const result = await applyAiDraftIfEligible(1);
    assert.equal(result.archived, false);
  } finally {
    restore();
  }
});

test('applyAiDraftIfEligible: copies ai_summary/ai_insight to canonical fields and publishes when eligible with valid classification', async () => {
  const { calls, restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({
      rows: [{
        id: 42, ai_status: 'completed', ai_eligible: true,
        ai_summary: '요약문', ai_insight: '인사이트',
        ai_suggested_sectors: [3], ai_suggested_usages: [7],
      }],
    })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
  ]);
  try {
    const result = await applyAiDraftIfEligible(42);
    assert.equal(result.archived, true);
    const publishCall = calls.find((c) => c.text.includes('UPDATE items SET summary'));
    assert.ok(publishCall);
    assert.deepEqual(publishCall.params, ['요약문', '인사이트', 42]);
    assert.match(publishCall.text, /status = 'Published'/);
    assert.ok(calls.some((c) => c.text.includes('INSERT INTO item_sectors') && c.text.includes('(42, 3)')));
    assert.ok(calls.some((c) => c.text.includes('INSERT INTO item_usages') && c.text.includes('(42, 7)')));
  } finally {
    restore();
  }
});

test('applyAiDraftIfEligible: skips sector/usage inserts when none were suggested', async () => {
  const { calls, restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({
      rows: [{ id: 5, ai_status: 'completed', ai_eligible: true, ai_summary: 's', ai_insight: 'i', ai_suggested_sectors: [], ai_suggested_usages: [] }],
    })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: false, has_usage: false }] })],
  ]);
  try {
    await applyAiDraftIfEligible(5);
    assert.equal(calls.filter((c) => c.text.includes('INSERT INTO item_sectors')).length, 0);
    assert.equal(calls.filter((c) => c.text.includes('INSERT INTO item_usages')).length, 0);
  } finally {
    restore();
  }
});

// --- minimum classification invariant: an AI-eligible item is never
// auto-published without at least one real sector AND usage tag ---

test('applyAiDraftIfEligible: does NOT publish an eligible item with no suggested sectors/usages (no classification)', async () => {
  const { calls, restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({
      rows: [{ id: 6, ai_status: 'completed', ai_eligible: true, ai_summary: 's', ai_insight: 'i', ai_suggested_sectors: [], ai_suggested_usages: [] }],
    })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: false, has_usage: false }] })],
  ]);
  try {
    const result = await applyAiDraftIfEligible(6);
    assert.equal(result.archived, false);
    assert.equal(calls.filter((c) => c.text.includes('UPDATE items SET summary')).length, 0);
  } finally {
    restore();
  }
});

test('applyAiDraftIfEligible: does NOT publish when only a sector (no usage) ends up classified', async () => {
  const { calls, restore } = mockPool([
    ['SELECT * FROM items WHERE id', () => ({
      rows: [{ id: 7, ai_status: 'completed', ai_eligible: true, ai_summary: 's', ai_insight: 'i', ai_suggested_sectors: [3], ai_suggested_usages: [] }],
    })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: false }] })],
  ]);
  try {
    const result = await applyAiDraftIfEligible(7);
    assert.equal(result.archived, false);
    assert.equal(calls.filter((c) => c.text.includes('UPDATE items SET summary')).length, 0);
  } finally {
    restore();
  }
});

// --- generateAiDraftForItem: persistent telemetry (ai_latency_ms / ai_failure_type) ---

function mockTaxonomyAnd(itemsHandler) {
  return mockPool([
    ['SELECT * FROM items WHERE id', itemsHandler],
    ['SELECT id, name FROM sectors', () => ({ rows: [{ id: 3, name: '팜유' }] })],
    ['SELECT id, name FROM usages', () => ({ rows: [{ id: 3, name: '식용' }] })],
  ]);
}

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('generateAiDraftForItem: a successful call persists ai_latency_ms and clears ai_failure_type', async () => {
  const { calls, restore } = mockTaxonomyAnd(() => ({ rows: [{ id: 1, title: 't', summary: 's' }] }));
  try {
    const providerFn = () => delay(15, { text: fullResponse(), provider: 'freellmapi' });
    const result = await generateAiDraftForItem(1, providerFn);
    assert.equal(result.ok, true);

    const completedCall = calls.find((c) => c.text.includes("ai_status = 'completed'"));
    assert.ok(completedCall, 'expected the completed UPDATE to run');
    assert.match(completedCall.text, /ai_failure_type = NULL/);
    assert.match(completedCall.text, /ai_latency_ms = \$8/);
    const latencyMs = completedCall.params[7];
    assert.equal(typeof latencyMs, 'number');
    assert.ok(latencyMs >= 15, `expected latency >= 15ms, got ${latencyMs}`);
  } finally {
    restore();
  }
});

test('generateAiDraftForItem: a provider timeout persists ai_failure_type=timeout and a non-null ai_latency_ms', async () => {
  const { calls, restore } = mockTaxonomyAnd(() => ({ rows: [{ id: 2, title: 't', summary: 's' }] }));
  try {
    const providerFn = async () => {
      await delay(10);
      const err = new Error('AI provider unavailable (timeout)');
      err.transient = true;
      err.failureType = 'timeout';
      throw err;
    };
    const result = await generateAiDraftForItem(2, providerFn);
    assert.equal(result.ok, false);

    const failedCall = calls.find((c) => c.text.includes("ai_status = 'failed'"));
    assert.ok(failedCall, 'expected the failed UPDATE to run');
    const [reason, failureType, latencyMs, itemId] = failedCall.params;
    assert.match(reason, /timeout/);
    assert.equal(failureType, 'timeout');
    assert.equal(typeof latencyMs, 'number');
    assert.ok(latencyMs >= 10, `expected latency >= 10ms, got ${latencyMs}`);
    assert.equal(itemId, 2);
  } finally {
    restore();
  }
});

test('generateAiDraftForItem: a non-provider (application) failure persists ai_failure_type=NULL', async () => {
  const { calls, restore } = mockTaxonomyAnd(() => ({ rows: [{ id: 3, title: 't', summary: 's' }] }));
  try {
    // No .failureType set — e.g. an invalid-JSON draft response, same as
    // runProviderChain's distinction between provider and application errors.
    const providerFn = () => delay(5, { text: 'not valid json', provider: 'freellmapi' });
    const result = await generateAiDraftForItem(3, providerFn);
    assert.equal(result.ok, false);

    const failedCall = calls.find((c) => c.text.includes("ai_status = 'failed'"));
    assert.ok(failedCall);
    const [, failureType, latencyMs] = failedCall.params;
    assert.equal(failureType, null);
    assert.equal(typeof latencyMs, 'number');
  } finally {
    restore();
  }
});
