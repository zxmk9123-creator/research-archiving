const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isRelevantToOilFatsScope } = require('../server/lib/relevanceFilter');
const { OILS } = require('../server/lib/oilTaxonomy');

test('every minor oil in the taxonomy (English and Korean names) passes the collector scope filter; unrelated news still does not', () => {
  const samples = {
    olive: ['Olive oil prices surge after poor harvest', '올리브유 가격 급등'], coconut: ['Coconut oil exports jump', '코코넛유 수출'],
    'rice-bran': ['Rice bran oil demand rises', '쌀겨유 시장'], avocado: ['Avocado oil market growth', '아보카도유 수요'],
    sesame: ['Sesame oil exports from Korea', '참기름 수출'], perilla: ['Perilla oil demand', '들기름 소비'],
    corn: ['Corn oil margins', '옥수수유 가격'], cottonseed: ['Cottonseed oil supply', '면실유 공급'], peanut: ['Peanut oil prices', '땅콩유 가격'],
    flax: ['Flaxseed oil trade', '아마씨유 시장'], grapeseed: ['Grapeseed oil demand', '포도씨유 수요'], safflower: ['Safflower oil output', '홍화유 생산'],
    walnut: ['Walnut oil market', '호두유 시장'], 'palm-kernel': ['Palm kernel oil exports', '팜핵유 수출'],
  };
  for (const o of OILS.filter((x) => x.tier === 'minor')) {
    assert.ok(samples[o.id], `sample missing for ${o.id}`);
    for (const t of samples[o.id]) assert.equal(isRelevantToOilFatsScope(t, ''), true, `${o.id}: ${t}`);
  }
  assert.equal(isRelevantToOilFatsScope('Local bakery opens a new shop', 'cakes and bread'), false);
});

test('schema.sql seeds the minor-oil discovery queries idempotently (each name once, guarded by NOT EXISTS)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8');
  const names = [
    'Web Discovery: olive oil production consumption exports price', 'Web Discovery: coconut oil demand supply exports price',
    'Web Discovery: rice bran oil market demand exports', 'Web Discovery: avocado flaxseed linseed oil market growth',
    'Web Discovery: sesame perilla oil market demand exports', 'Web Discovery: corn cottonseed peanut oil market price demand',
    'Web Discovery: 비주류 식용유 시장 소비 수출', 'Archive Discovery: niche specialty edible oils market report',
  ];
  for (const n of names) assert.equal(sql.split(`('${n}'`).length - 1, 1, n);
  const block = sql.slice(sql.indexOf('Minor / niche edible oil coverage'));
  assert.equal((block.match(/WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\)/g) || []).length, 2);
});
