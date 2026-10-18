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
