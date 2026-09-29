const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDraftResponse,
  buildUserPrompt,
  buildTaxonomyBlock,
  buildFactualSummary,
  factOrUnconfirmed,
  UNCONFIRMED,
} = require('../server/lib/aiDraft');

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
    summary: '인도네시아 정부가 국내 공급 안정을 위해 팜유 수출세를 톤당 50달러 인상하면서 아시아 팜유 가격에 상승 압력이 커지고 있다.',
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
  assert.equal(
    draft.summary,
    '인도네시아 정부가 국내 공급 안정을 위해 팜유 수출세를 톤당 50달러 인상하면서 아시아 팜유 가격에 상승 압력이 커지고 있다.'
  );
  // The 5W1H facts are reasoning criteria only — never a labeled dump in the summary.
  assert.doesNotMatch(draft.summary, /누가:|무엇을:|규모\/금액:|시점:|장소:|이유:|영향:/);
  // Still extracted internally (used for eligibility/reasoning, not shown as-is).
  assert.equal(draft.facts.who, '인도네시아 정부');
  assert.equal(draft.facts.amount, '톤당 50달러');
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

test('buildTaxonomyBlock: only lists the taxonomy actually passed in (grounding, not invented labels)', () => {
  const block = buildTaxonomyBlock(taxonomy.sectors, taxonomy.usages);
  assert.match(block, /3: 팜유/);
  assert.doesNotMatch(block, /어묵/); // sanity: nothing invented appears
});
