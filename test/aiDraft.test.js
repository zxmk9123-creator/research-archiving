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
    key_takeaway: '수출세 인상이 단기 가격 상승 요인이다.',
    suggested_sectors: [3],
    suggested_usages: [3],
    ...overrides,
  });
}

test('parseDraftResponse: accepts a valid structured response and builds a factual summary from it', () => {
  const draft = parseDraftResponse(fullResponse(), taxonomy);
  assert.equal(draft.eligible, true);
  assert.equal(draft.eligibilityReason, '구체적 수치와 시점이 포함된 시장 뉴스다.');
  assert.equal(draft.keyTakeaway, '수출세 인상이 단기 가격 상승 요인이다.');
  assert.deepEqual(draft.suggestedSectors, [3]);
  assert.deepEqual(draft.suggestedUsages, [3]);
  assert.match(draft.summary, /누가: 인도네시아 정부/);
  assert.match(draft.summary, /규모\/금액: 톤당 50달러/);
  assert.match(draft.summary, /영향: 아시아 팜유 가격 상승 압력/);
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

test('parseDraftResponse: never throws on a missing fact — it becomes 미확보 instead', () => {
  const draft = parseDraftResponse(fullResponse({ amount: undefined, when: '' }), taxonomy);
  assert.match(draft.summary, new RegExp(`규모/금액: ${UNCONFIRMED}`));
  assert.match(draft.summary, new RegExp(`시점: ${UNCONFIRMED}`));
});

test('parseDraftResponse: normalizes model-invented "none/null/없음" style fillers to 미확보 (never a fabricated fact)', () => {
  const draft = parseDraftResponse(fullResponse({ amount: '없음', where: 'null', why: 'N/A' }), taxonomy);
  assert.match(draft.summary, new RegExp(`규모/금액: ${UNCONFIRMED}`));
  assert.match(draft.summary, new RegExp(`장소: ${UNCONFIRMED}`));
  assert.match(draft.summary, new RegExp(`이유: ${UNCONFIRMED}`));
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

test('buildFactualSummary: renders all 7 facts in a fixed, labeled order', () => {
  const summary = buildFactualSummary({
    who: 'A', what: 'B', amount: 'C', when: 'D', where: 'E', why: 'F', impact: 'G',
  });
  assert.equal(summary, '누가: A\n무엇을: B\n규모/금액: C\n시점: D\n장소: E\n이유: F\n영향: G');
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
