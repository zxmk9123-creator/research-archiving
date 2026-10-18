const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../server/lib/entityRegistry');

test('cluster: suffix variants, roster aliases and learned bilingual spellings become one entity with same_names', () => {
  const out = reg.cluster(
    [{ name: 'Eni S.p.A.', n: 5 }, { name: 'Eni', n: 3 }, { name: 'Burger King', n: 2 }, { name: '버거킹', n: 1 }, { name: 'Neste', n: 9 }, { name: 'Neste Oyj', n: 1 }, { name: 'Wilmar', n: 50 }, { name: 'Wilmar International Limited', n: 2 }, { name: 'Group', n: 4 }],
    { links: [['Burger King', '버거킹'], ['Wilmar', 'Wilmar International Limited']], rosterNames: ['Wilmar'] }
  );
  const by = (e) => out.find((g) => g.entity === e);
  assert.equal(out.filter((g) => [g.entity, ...g.same_names].includes('Eni') && [g.entity, ...g.same_names].includes('Eni S.p.A.')).length, 1);
  assert.equal(out.filter((g) => [g.entity, ...g.same_names].includes('버거킹') && [g.entity, ...g.same_names].includes('Burger King')).length, 1);
  assert.equal(by('Wilmar').same_names.includes('Wilmar International Limited'), true);
  assert.equal(by('Neste').same_names.includes('Neste Oyj'), true);
  assert.ok(!out.some((g) => g.entity === 'Group' && g.same_names.length));
});

test('sameCompanyName: spellings of one company merge; subsidiaries, sites and partners do not', () => {
  const s = reg.sameCompanyName;
  assert.ok(s('Chevron', '셰브론') && s('Chevron', 'Chevron Corp.') && s('COSMO Oil', 'Cosmo Oil'));
  assert.ok(s('Diamond Green Diesel', 'DGD') && s('Carbon Neutral Fuels', 'CNF'));
  assert.ok(s('포스코인터내셔널', '포스코인터') && s('Wilmar', 'Wilmar International Limited'));
  assert.ok(!s('BP plc', 'Archaea Energy') && !s('BP plc', 'bp Castellón') && !s('BP plc', 'bp Kwinana'));
  assert.ok(!s('Diamond Green Diesel', 'Darling Ingredients'));
  assert.ok(!s('Eni', 'Enilive'));
  assert.ok(!s('Mitsui', 'Mitsui Chemicals') && !s('Chevron', 'Chevron Renewable Energy Group'));
});

test('sameCompanyName crossScript can be switched off (English name vs an existing Latin name must really match)', () => {
  assert.equal(reg.sameCompanyName('Burger King', '버거킹'), true);
  assert.equal(reg.sameCompanyName('Burger King', '버거킹', { crossScript: false }), false);
  assert.equal(reg.sameCompanyName('Burger King', 'Burger King Corp.', { crossScript: false }), true);
});

test('cluster: generic-word variants merge; a name that only survives as a stored same_name keeps its link', () => {
  const out = reg.cluster([{ name: 'Golden Agri', n: 2 }, { name: 'Golden Agri Resources', n: 4 }, { name: 'Golden Agri-Resources', n: 9 }, { name: 'Chevron-REG', n: 1 }, { name: 'Chevron', n: 5 }, { name: 'Burger King', n: 3 }, { name: '버거킹', n: 0 }], { links: [['Burger King', '버거킹']] });
  const grp = (n) => out.find((g) => [g.entity, ...g.same_names].includes(n));
  assert.equal(grp('Golden Agri'), grp('Golden Agri-Resources'));
  assert.equal(grp('Golden Agri Resources'), grp('Golden Agri-Resources'));
  assert.notEqual(grp('Chevron-REG'), grp('Chevron'));
  assert.equal(grp('버거킹'), grp('Burger King'));
});

test('cluster never merges by acronym on its own (BP vs Bharat Petroleum, P&G vs Phelan Green Group)', () => {
  const out = reg.cluster([{ name: 'Bharat Petroleum Corp. Ltd', n: 3 }, { name: 'BP', n: 9 }, { name: 'bp', n: 4 }, { name: 'Phelan Green Group', n: 1 }, { name: 'P&G', n: 2 }]);
  const grp = (n) => out.find((g) => [g.entity, ...g.same_names].includes(n));
  assert.notEqual(grp('BP'), grp('Bharat Petroleum Corp. Ltd'));
  assert.notEqual(grp('P&G'), grp('Phelan Green Group'));
  assert.equal(grp('BP'), grp('bp'));
});

test('refineRole: code rules correct the model (finance only for financiers, emitter needs used-oil evidence, supplier needs feedstock evidence)', () => {
  const r = reg.refineRole;
  assert.equal(r('finance', { name: '포스코인터내셔널' }), 'trader');
  assert.equal(r('finance', { name: 'Mitsubishi' }), 'trader');
  assert.equal(r('finance', { name: 'Idemitsu Kosan', factRoles: { producer: 4 } }), 'producer');
  assert.equal(r('finance', { name: 'Bain Capital' }), 'finance');
  assert.equal(r('finance', { name: 'BNP 파리바' }), 'finance');
  assert.equal(r('emitter', { name: 'Unilever', evidence: ['Unilever buys palm oil'] }), 'consumer');
  assert.equal(r('emitter', { name: 'Burger King', evidence: ['폐식용유를 수거해'] }), 'emitter');
  assert.equal(r('supplier', { name: 'Air bp', evidence: ['jet fuel to airports'] }), 'trader');
  assert.equal(r('supplier', { name: 'FatHopes Energy', evidence: ['UCO 수거 전문 기업'] }), 'supplier');
  assert.equal(r('other', { name: 'Puma Energy', factRoles: { producer: 3 } }), 'producer');
  assert.equal(r('other', { name: 'Metro Atlanta Chamber', factRoles: { producer: 3 } }), 'other');
  assert.equal(r('bogus', { name: 'X' }), 'other');
});

test('refineRole: a supplier without feedstock evidence is a producer (processor) unless it is a fuel distributor', () => {
  assert.equal(reg.refineRole('supplier', { name: 'Musim Mas', evidence: ['palm oil refinery'] }), 'producer');
  assert.equal(reg.refineRole('supplier', { name: 'Avfuel Corporation', evidence: ['fuel'] }), 'trader');
  assert.equal(reg.refineRole('supplier', { name: 'Restaurant Technologies', evidence: ['used cooking oil collection'] }), 'supplier');
});
