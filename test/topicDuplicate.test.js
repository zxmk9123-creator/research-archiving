const test = require('node:test');
const assert = require('node:assert');
const { redundantWith } = require('../server/lib/topicDuplicate');

const prior = { id: 1, title: '[국감] 지속가능항공유 혼합의무화 목표 올해 안에 확정해야', ai_summary: '박희승 의원은 국정감사에서 산업통상자원부에 2030년 SAF 혼합의무비율 3~5% 범위를 연내에 확정할 것을 촉구했다.', ai_key_takeaway: 'SAF 혼합의무 비율 연내 확정 필요' };

test('same event without new figures is redundant', () => {
  const c = { id: 2, title: '국감서 SAF 혼합의무 연내 확정 촉구', ai_summary: '박희승 의원이 국정감사에서 산업통상자원부에 SAF 혼합의무비율을 연내 확정할 것을 촉구했다. 2030년 목표.', ai_key_takeaway: 'SAF 혼합의무 비율 연내 확정' };
  assert.strictEqual(redundantWith(c, [prior]), 1);
});

test('same event with new figures is allowed', () => {
  const c = { id: 3, title: '국감 폐식용유 SAF 혼합의무 원료 유출 우려', ai_summary: '국정감사에서 SAF 혼합의무 확정이 거론되며 폐식용유 수출량이 2023년 3만 3천톤에서 2024년 7만 6천톤으로 늘고 71%가 미국행이라고 지적했다.', ai_key_takeaway: '폐식용유 수출 급증' };
  assert.strictEqual(redundantWith(c, [prior]), null);
});

test('unrelated topic is not touched', () => {
  const c = { id: 4, title: '말레이시아 팜유 선물 하락', ai_summary: '말레이시아 팜유 선물이 이번 주 하락세를 보이며 1.2% 내렸다 수출 둔화 영향.', ai_key_takeaway: '팜유 선물 약세' };
  assert.strictEqual(redundantWith(c, [prior]), null);
});
