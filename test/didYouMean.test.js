const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../server/lib/glossary');

test('didYouMean: near misses of a known term are suggested (Hangul by jamo, Latin by edit distance)', () => {
  const pick = (q) => g.didYouMean(q).map((f) => `${f.typed}>${f.term}`);
  assert.deepEqual(pick('대투유 가격 알려줘'), ['대투유>대두유']);
  assert.deepEqual(pick('지속가능항공류가 뭐야'), ['지속가능항공류>지속가능항공유']);
  assert.deepEqual(pick('스프래드가 뭐야'), ['스프래드>스프레드']);
  assert.deepEqual(pick('hov가 뭐야?'), ['hov>hvo']);
  assert.deepEqual(pick('biodisel 시황'), ['biodisel>biodiesel']);
});

test('didYouMean: correct terms, unrelated words and distinct neighbours are left alone', () => {
  for (const q of ['대두유 가격', '팜오일 시황', 'hvo 뭐야', 'SAF 혼합의무', '우크라이나 해바라기유', '수출세 변화', 'B35 뭐야', '오늘 날씨', '시황 요약해줘']) assert.deepEqual(g.didYouMean(q), [], q);
  assert.deepEqual(g.didYouMean('hov 시황'), [], 'a 3-letter near miss is only guessed in a definition question');
});

test('the answer opens with the suggestion and explains the concept; the question is corrected for retrieval', () => {
  const f = g.didYouMean('대투유가 뭐야?');
  assert.equal(g.correctQuestion('대투유가 뭐야?', f), '대두유가 뭐야?');
  assert.match(g.dymLead(f), /^\*\*'대두유'를 찾으시나요\?\*\* 입력하신 '대투유'/);
  assert.match(g.dymPromptBlock(f), /찾으시나요/);
  assert.equal(g.dymPromptBlock([]), '');
});
