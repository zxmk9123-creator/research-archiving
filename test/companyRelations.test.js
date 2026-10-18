const test = require('node:test');
const assert = require('node:assert/strict');
const rel = require('../server/lib/companyRelations');

test('parseRelations tolerates fences and junk', () => {
  assert.equal(rel.parseRelations('no json').length, 0);
  assert.equal(rel.parseRelations('```json\n[{"src":"A","dst":"B","relation":"owns"}]\n```').length, 1);
});

test('verifyRelations keeps only rows whose both names occur in the text, maps to canonical names, one row per JV pair', () => {
  const text = 'LG Chem and Eni formed LG Eni BioRefining. Eni owns 51% of Enilive. Hyundai E&C builds the plant for LG Eni BioRefining.';
  const canon = (n) => ({ 'lg chem': 'LG화학' }[n.toLowerCase()] || n);
  const out = rel.verifyRelations([
    { src: 'LG Chem', dst: 'Eni', relation: 'jv_partner', evidence: 'formed' },
    { src: 'Eni', dst: 'LG Chem', relation: 'jv_partner', evidence: 'formed' },
    { src: 'Eni', dst: 'Enilive', relation: 'owns', share_pct: 51, evidence: 'owns 51%' },
    { src: 'Hyundai E&C', dst: 'LG Eni BioRefining', relation: 'contractor_for', evidence: 'builds' },
    { src: 'Shell', dst: 'Eni', relation: 'owns' },             // Shell not in the text
    { src: 'Eni', dst: 'Enilive', relation: 'friend_of' },       // unknown relation
    { src: 'Eni', dst: 'eni', relation: 'owns' },                // self
  ], text, canon);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].src < out[0].dst, true);
  assert.equal(out.find((r) => r.relation === 'owns').share_pct, 51);
  assert.ok(out.some((r) => r.relation === 'jv_partner' && [r.src, r.dst].includes('LG화학')));
});

test('promptBlock lists only stored relations and describes direction', () => {
  assert.equal(rel.promptBlock([]), '');
  const b = rel.promptBlock([{ src: 'Eni', dst: 'Enilive', relation: 'owns', share_pct: 51 }, { src: 'A', dst: 'B', relation: 'contractor_for' }]);
  assert.match(b, /Eni는 Enilive의 모회사 51%/);
  assert.match(b, /A는 B의 하청·시공/);
});

test('fixRelation: ownership needs a cue, JV partners/minority holders are stakes, buyer/seller direction, non-companies dropped', () => {
  const f = rel.fixRelation;
  assert.equal(f({ src: 'bp', dst: 'Castrol', relation: 'owns', evidence: '카스트롤에 대한 전략적 검토를 진행' }), null);
  assert.equal(f({ src: 'Euglena', dst: 'Pengerang Biorefinery', relation: 'owns', evidence: '합작법인 Pengerang Biorefinery를 설립한' }).relation, 'stake');
  assert.equal(f({ src: 'KLK', dst: 'PT Putra', relation: 'owns', share_pct: 95, evidence: 'KLK가 95% 지분을 인수' }).relation, 'owns');
  assert.equal(f({ src: 'Eni', dst: 'X', relation: 'owns', share_pct: 30, evidence: '30% 지분 보유' }).relation, 'stake');
  const o = f({ src: 'TotalEnergies', dst: 'Air France-KLM', relation: 'offtake_from', evidence: '10년간 오프테이크 계약' });
  assert.deepEqual([o.src, o.dst], ['Air France-KLM', 'TotalEnergies']);
  assert.equal(f({ src: 'bp', dst: '사라고사 공항', relation: 'supplies', evidence: '공급' }), null);
  assert.equal(f({ src: 'IATA', dst: 'Neste', relation: 'supplies', evidence: 'x' }), null);
});

test('baseKey merges corporate-suffix variants', () => {
  assert.equal(rel.baseKey('Eni S.p.A.'), rel.baseKey('Eni'));
  assert.equal(rel.baseKey('Wilmar International Limited'), 'wilmar international');
  assert.equal(rel.baseKey('(주)LG화학'), rel.baseKey('LG화학'));
});

test('collective labels are not companies; real names that merely contain such words are kept', () => {
  for (const n of ['중국 내 식당', '여러 항공사들', '인도 자회사', '주요 항공사', '항공사', '코린도 산하 플랜테이션 회사 2곳', '카자흐스탄 내 최대 식용유 제조업체', 'major airlines', 'Restaurants', 'various suppliers']) assert.equal(rel.isNonCompanyName(n), true, n);
  for (const n of ['Restaurant Technologies', '대상주식회사', '이라크 국영 유조선 회사(IOTC)', 'Neste', '현대오일뱅크', 'Air bp', 'Customers Bancorp']) assert.equal(rel.isNonCompanyName(n), false, n);
});
