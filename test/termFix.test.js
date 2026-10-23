const test = require('node:test');
const assert = require('node:assert/strict');
const { fixTerms } = require('../server/lib/termFix');
const { parseDraftResponse } = require('../server/lib/aiDraft');

test('fixTerms: 고올레익 (any spacing) becomes 고올레인; other text is untouched; non-strings pass through', () => {
  assert.equal(fixTerms('고올레익 대두유와 고 올레익 품종'), '고올레인 대두유와 고올레인 품종');
  assert.equal(fixTerms('올레산 함량이 높다'), '올레산 함량이 높다');
  assert.equal(fixTerms(null), null);
});

test('parseDraftResponse: the wrong high-oleic spelling is corrected in the stored summary and insight', () => {
  const raw = JSON.stringify({ summary: '고올레익 대두유 구매가 늘었다.', insight: '고올레익 품종 확대가 수요를 지지할 가능성이 있다.' });
  const out = parseDraftResponse(raw, { sectors: [], usages: [] });
  assert.ok(!/올레익/.test(`${out.summary} ${out.insight}`));
});
