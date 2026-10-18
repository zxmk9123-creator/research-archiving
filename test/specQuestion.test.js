const test = require('node:test');
const assert = require('node:assert/strict');
const sq = require('../server/lib/specQuestion');

test('spec questions are recognised', () => {
  assert.ok(sq.isSpecQuestion('SAF 주요 업체별 스펙 정리해줘'));
  assert.ok(sq.isSpecQuestion('Neste, Eni 스펙 비교'));
  assert.ok(!sq.isSpecQuestion('SAF 생산업체 Top10'));
});

test('dropEmptyRows removes rows without any value and the non-producer explanation lines, keeps real rows', () => {
  const t = [
    '| 업체명 | 생산능력 | 원료 |', '| :--- | :--- | :--- |',
    '| Neste | 연간 150만 톤 [1] | UCO |', '| United Airlines | - | 자료에 언급 없음 |', '| Shell | 미공시 | ⚠원문 확인 필요 |', '| Eni | - | 폐식용유 [2] |',
    '', '- 항공사는 생산자가 아닌 구매처라 생산 스펙이 없습니다.', '- Neste는 확대 중입니다.',
  ].join('\n');
  const out = sq.dropEmptyRows(t);
  assert.ok(out.includes('Neste') && out.includes('| Eni |') && out.includes('| 업체명 |'));
  assert.ok(!out.includes('United Airlines') && !out.includes('Shell') && !out.includes('구매처'));
  assert.ok(out.includes('Neste는 확대'));
});
