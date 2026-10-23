const test = require('node:test');
const assert = require('node:assert/strict');
const glossary = require('../server/lib/glossary');

test('matchCards: a definition question about a known term returns its card; a non-definition question returns none', () => {
  assert.deepEqual(glossary.matchCards('HVO가 뭐야?').map((c) => c.id), ['hvo']);
  assert.deepEqual(glossary.matchCards('카놀라유와 팜유의 차이를 알려줘').map((c) => c.id).sort(), ['palm', 'rapeseed']);
  assert.deepEqual(glossary.matchCards('팜유 가격 전망'), []);
  assert.deepEqual(glossary.matchCards('SAF 혼합의무란'), [glossary.CARDS.find((c) => c.id === 'saf'), glossary.CARDS.find((c) => c.id === 'mandate')]);
});

test('matchCards: latin terms match on word boundaries only', () => {
  assert.deepEqual(glossary.matchCards('whatsafe 뭐야'), []);
  assert.deepEqual(glossary.matchCards('what is uco').map((c) => c.id), ['uco']);
});

test('cards carry no figures and the answer is labelled as editorial background', () => {
  for (const c of glossary.CARDS) assert.ok(c.def.length > 20 && c.terms.length, c.id);
  const answer = glossary.cardsAnswer(glossary.matchCards('RSPO가 뭐야'));
  assert.match(answer, /^# 기초 지식/);
  assert.match(answer, /아카이빙 자료에 기반한 분석이 아닙니다/);
  assert.equal(glossary.cardsPromptBlock([]), '');
  assert.match(glossary.cardsPromptBlock(glossary.matchCards('HVO가 뭐야')), /예외/);
});

test('new cards match their own terms; "red" alone does not trigger the RED card', () => {
  assert.deepEqual(glossary.matchCards('B40이 뭐야').map((c) => c.id), ['blend-b']);
  assert.deepEqual(glossary.matchCards('MPOB와 MPOC 차이').map((c) => c.id), ['agencies']);
  assert.deepEqual(glossary.matchCards('what is red meat'), []);
  assert.deepEqual(glossary.matchCards('EU RED가 뭐야').map((c) => c.id), ['red']);
});
