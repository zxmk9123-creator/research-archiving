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

test('normalizeSpecTables: one row per company, tons/year in the capacity column, other values listed as 참고', () => {
  const st = require('../server/lib/specTable');
  assert.deepEqual(st.parseCapacity('150만 톤 [1]'), { tons: 1500000, converted: false });
  assert.equal(Math.round(st.parseCapacity('10,500 bpd').tons), Math.round(10500 * 158.987 * 365 * 0.8 / 1000));
  assert.equal(st.parseCapacity('1,000만 갤런').converted, true);
  assert.equal(st.parseCapacity('자료에 없음'), null);
  const t = [
    '| 업체명 | 생산능력 | 원료 | 상태 | 기준 시점 |', '| :--- | :--- | :--- | :--- | :--- |',
    '| EcoCeres | 45만 톤 | - | 계획 | 2030년 [5] |', '| EcoCeres | 77만 톤 [6] | 폐식용유 | 가동 | 현재 |',
    '| Chevron | 10만 bpd | - | 목표 | 2030년 |', '| Chevron | 3.4억 갤런 | - | 계획 | 2025년 |',
  ].join('\n');
  const out = st.normalizeSpecTables(t, { density: 0.8 });
  const rows = out.split('\n').filter((l) => /^\| (EcoCeres|Chevron)/.test(l));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('770,000') && out.includes('생산능력 (톤/년)'));
  assert.ok(rows[1].includes('환산') && out.includes('참고') && out.includes('450,000 톤/년'));
});
