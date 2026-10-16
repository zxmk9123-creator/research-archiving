const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyIntent } = require('../server/lib/intent');
const searchRouter = require('../server/routes/search');

const roster = [
  { name: 'Neste', names: ['neste', '네스테'] },
  { name: 'Eni', names: ['eni', 'enilive'] },
  { name: 'Chevron', names: ['chevron'] },
];

test('intent: naming one known company is a focused profile, whatever generic nouns the question has', () => {
  for (const q of ['Neste 업체에 대해 알려줘', 'Neste 업체 개요 정리해줘', '네스테 회사 소개', 'Neste의 거점과 Capa']) {
    const r = classifyIntent(q, roster);
    assert.equal(r.type, 'entity', q);
    assert.equal(r.focus[0].name, 'Neste');
  }
});

test('intent: two or more named companies are a peer comparison of exactly those companies', () => {
  const r = classifyIntent('Neste와 Chevron의 SAF Capa 비교', roster);
  assert.equal(r.type, 'peers');
  assert.deepEqual(r.focus.map((c) => c.name), ['Neste', 'Chevron']);
});

test('intent: no company named + an aggregate cue is collective; plain questions are general', () => {
  for (const q of ['글로벌 정유업체의 전체 SAF Capa 데이터를 가져와서 시각화해줘', '글로벌 SAF 플랜트의 Capa를 누락없이 톤 단위로', '주요 기업들의 SAF 현황', 'SAF Capa를 누락없이 알려줘']) {
    assert.equal(classifyIntent(q, roster).type, 'collective', q);
  }
  for (const q of ['팜유 가격 이유', '이 회사 어때', 'SAF 플랜트 알려줘', '식용유 수출 업체 알려줘']) {
    assert.equal(classifyIntent(q, roster).type, 'general', q);
  }
});

test('intent: a short Latin name only matches as a whole word (no match inside other words)', () => {
  assert.equal(classifyIntent('penicillin 업체 소개', roster).type, 'general');
  assert.equal(classifyIntent('Eni 소개', roster).type, 'entity');
});

test('requiredCompanies: entity/general questions require nothing; peers require only the named companies', () => {
  const cands = [{ title: 'Neste plan', summary: 'x' }, { title: 'Chevron plan', summary: 'y' }, { title: 'Eni plan', summary: 'z' }];
  assert.deepEqual(searchRouter.requiredCompanies('Neste 업체에 대해 알려줘', cands, roster), []);
  assert.deepEqual(searchRouter.requiredCompanies('팜유 가격', cands, roster), []);
  assert.deepEqual(searchRouter.requiredCompanies('Neste와 Chevron 비교', cands, roster).map((c) => c.name), ['Neste', 'Chevron']);
  assert.deepEqual(searchRouter.requiredCompanies('글로벌 주요 업체 비교', cands, roster).map((c) => c.name), ['Neste', 'Eni', 'Chevron']);
});

test('coverage appendix snippet: the material that names the company in its title, and the sentence around the name', () => {
  const r2 = [{ name: 'Alpha', names: ['alpha'], indices: [1, 2] }];
  const cands = [
    { title: 'Industry roundup', summary: '여러 기업 소식이다. Alpha는 연 3만 톤 증설을 발표했다. 다른 소식도 있다.' },
    { title: 'Alpha expands plant', summary: '무관한 첫 문장이다. Alpha는 연 5만 톤 규모로 확장한다.' },
  ];
  const out = searchRouter.ensureCompanyCoverage('본문', r2, cands);
  assert.match(out, /\*\*Alpha\*\*: Alpha는 연 5만 톤 규모로 확장한다\. \[2\]/);
});

test('dropNearDuplicates: syndicated copies of one story keep only the best-ranked', () => {
  const rows = [
    { id: 1, title: 'Neste starts SAF production at its Rotterdam refinery with an initial 500,000 tons annual capacity' },
    { id: 2, title: 'Neste starts SAF production at its Rotterdam refinery with initial 500,000 tons annual capacity | News' },
    { id: 3, title: 'Neste opens expanded Singapore refinery with 1Mt SAF capacity' },
  ];
  assert.deepEqual(searchRouter.dropNearDuplicates(rows).map((r) => r.id), [1, 3]);
});
