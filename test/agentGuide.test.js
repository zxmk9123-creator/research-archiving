const test = require('node:test');
const assert = require('node:assert/strict');
const { guideFor, followupsFor } = require('../server/lib/agentGuide');

test('platform, help and greeting questions are answered directly and end with a question offering next steps', () => {
  for (const q of ['Oil&Fat Research Center는 무슨 플랫폼이야?', '이 사이트 뭐하는 곳이야?', '뭘 할 수 있어?', '어떻게 사용해?', '안녕', '무역통계는 어떻게 써?']) {
    const g = guideFor(q);
    assert.ok(g, q);
    assert.ok(g.followups.length >= 2, q);
    assert.match(g.answer, /\?\*\*|\?$|주세요|드릴게요/, q);
  }
  assert.match(guideFor('Oil&Fat Research Center는 무슨 플랫폼이야?').answer, /어떤 도움이 필요하세요\?/);
});

test('research questions are not intercepted by the guide', () => {
  for (const q of ['팜유 가격 알려줘', '카길 기업 소개해줘', '수입량 분석 도와줘 팜유', 'HVO가 뭐야?', '인도네시아 B50 혼합의무 동향']) assert.equal(guideFor(q), null, q);
});

test('followups come from the glossary terms of the question, at most two, and none for unrelated text', () => {
  const f = followupsFor('팜유 가격 알려줘');
  assert.equal(f.length, 2);
  assert.match(f[0].question, /^팜유의 최근 동향/);
  assert.deepEqual(followupsFor('오늘 날씨 어때'), []);
});
