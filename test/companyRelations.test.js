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
    { src: 'LG Chem', dst: 'Eni', relation: 'jv_partner', evidence: '합작 법인 formed' },
    { src: 'Eni', dst: 'LG Chem', relation: 'jv_partner', evidence: '합작 법인 formed' },
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

test('a label that lists several companies is not one company ("Foo, Inc." is)', () => {
  assert.equal(rel.isNonCompanyName('Valero, Darling Ingredients'), true);
  assert.equal(rel.isNonCompanyName('Neste, Marathon Petroleum'), true);
  assert.equal(rel.isNonCompanyName('Calumet, Inc'), false);
  assert.equal(rel.baseKey('Golden Agri-Resources'), 'golden agri resources');
});

test('fixRelation: jv_partner needs a stated joint venture, brand ownership is not company ownership, assets are not companies', () => {
  const f = rel.fixRelation;
  assert.equal(f({ src: 'LanzaTech', dst: 'Mibelle Group', relation: 'jv_partner', evidence: 'Mibelle Group과 협력해 기술을 개발 중' }), null);
  assert.equal(f({ src: 'DevvStream', dst: 'Southern Energy Renewables', relation: 'jv_partner', evidence: '기업 결합 제안을 승인받았다' }), null);
  assert.equal(f({ src: 'Airbus', dst: 'Tereos', relation: 'jv_partner', evidence: 'Technip, Airbus, Safran, Tereos가 합작 법인 Rebound를 설립' }).relation, 'jv_partner');
  assert.equal(f({ src: 'GS칼텍스', dst: '포스코인터내셔널', relation: 'jv_partner', evidence: 'GS칼텍스와 공동 설립한 정제법인 PT.ARC' }).relation, 'jv_partner');
  assert.equal(f({ src: 'Sime Darby Berhad', dst: 'Sime Darby Plantation Berhad', relation: 'owns', evidence: 'Sime Darby Berhad 소유의 브랜드 사용' }), null);
  assert.equal(f({ src: 'Sime Darby Berhad', dst: 'Sime Darby Plantation', relation: 'owns', evidence: 'Sime Darby Berhad가 지분 51%를 보유' }).relation, 'owns');
  assert.equal(f({ src: 'Eni', dst: '사푸칼라 탐사 블록', relation: 'owns', share_pct: 100, evidence: 'ENI는 사푸칼라 탐사 블록 지분 100%를 획득' }), null);
  assert.equal(f({ src: 'Eni', dst: 'Eni West Field', relation: 'stake', evidence: 'stake in field' }), null);
});

test('relation lifecycle: "ended" is accepted only when the article has ending wording; ended relations are history in the prompt, never current', () => {
  const text = 'Wilmar이 PZ Cussons와의 팜유 합작법인 지분을 7,000만 달러에 전량 인수했습니다.';
  const out = rel.verifyRelations([{ src: 'Wilmar', dst: 'PZ Cussons', relation: 'jv_partner', evidence: 'PZ Cussons와의 팜유 합작법인', status: 'ended', ended_evidence: '지분을 전량 인수' }], text);
  assert.equal(out[0].status, 'ended');
  assert.match(out[0].ended_note, /전량 인수/);
  const noCue = rel.verifyRelations([{ src: 'Airbus', dst: 'Tereos', relation: 'jv_partner', evidence: '합작 법인 Rebound를 설립', status: 'ended' }], 'Airbus와 Tereos가 합작 법인 Rebound를 설립했다. Airbus Tereos');
  assert.equal(noCue[0].status, 'active');
  const block = rel.promptBlock([{ src: 'Eni', dst: 'Enilive', relation: 'owns', share_pct: 51, status: 'active' }, { src: 'Wilmar', dst: 'PZ Cussons', relation: 'jv_partner', status: 'ended', ended_note: '지분 전량 인수' }]);
  assert.match(block, /Eni는 Enilive의 모회사/);
  assert.match(block, /종료된 관계/);
  assert.match(block, /Wilmar와 PZ Cussons는 합작 파트너 — 지분 전량 인수/);
  assert.equal(rel.describe({ src: 'A', dst: 'B', relation: 'supplies', status: 'ended' }), 'A는 B에 공급 (종료)');
});
