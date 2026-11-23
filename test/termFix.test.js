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

test('glossary: known mistranslations are repaired (토스터데이, 메모랜드 오더) and the fixed forms are handed out per English term', () => {
  const { fixTerms, glossaryHints, suspectTranslations } = require('../server/lib/termFix');
  assert.equal(fixTerms('미국 토스터데이 주간 가격'), '미국 추수감사절 주간 가격');
  assert.equal(fixTerms('덴마크 e-SAF 메모랜드 오더 체결'), '덴마크 e-SAF 양해각서(MOU) 체결');
  assert.equal(fixTerms('메모랜드 오ファ더'), '양해각서(MOU)');
  assert.deepEqual(glossaryHints('Thanksgiving Gas Prices Could Break a Record').map((h) => h.ko), ['추수감사절']);
  assert.deepEqual(glossaryHints('Parties signed a memorandum of understanding').map((h) => h.ko), ['양해각서(MOU)']);
  assert.deepEqual(glossaryHints('Palm oil prices'), []);
  assert.equal(suspectTranslations('Thanksgiving Gas Prices', '미국 명절 주간에 가솔린 가격이').length, 1, 'summary does not use the fixed form');
  assert.equal(suspectTranslations('Thanksgiving Gas Prices', '미국 추수감사절 주간에 가솔린 가격이').length, 0);
});

test('glossary: 11/23 brief mistranslations (UKMTO, mine, kerosene, methanol-to-jet, Thanksgiving meal)', () => {
  const { fixTerms, glossaryHints } = require('../server/lib/termFix');
  assert.equal(fixTerms('영국MTO 보고에 따르면'), '영국해상무역기구(UKMTO) 보고에 따르면');
  assert.equal(fixTerms('유조선 2척이 미탐침자나 어뢰에 맞아'), '유조선 2척이 기뢰나 어뢰에 맞아');
  assert.equal(fixTerms('화석 제로케인과 비교해'), '화석 등유(케로신)과 비교해');
  assert.equal(fixTerms('메소드톤-투-제트 기술'), '메탄올-투-제트 기술');
  assert.equal(fixTerms('설날 식비가 6% 오른다'), '추수감사절 식비가 6% 오른다');
  assert.deepEqual(glossaryHints('Two Tanker Incidents Reported Near Oman; Vessel Hit Mine East Of Hormuz').map((h) => h.ko), ['기뢰']);
  assert.deepEqual(glossaryHints('UKMTO Reports Two Tanker Attacks').map((h) => h.ko), ['영국해상무역기구(UKMTO)']);
  assert.deepEqual(glossaryHints('Coal mine output rises'), [], 'a plain "mine" is not a naval mine');
});
