const test = require('node:test');
const assert = require('node:assert/strict');
const { stripForms } = require('../server/lib/corpSuffix');
const dp = require('../server/lib/datasetPipeline');
const rel = require('../server/lib/companyRelations');
const reg = require('../server/lib/entityRegistry');
const { canonicalizeProperNouns } = require('../server/lib/nameFix');

test('legal-form words never make a different name', () => {
  const same = [['LanzaJet', 'LanzaJet Inc.'], ['LanzaJet', 'LanzaJet, Inc.'], ['LanzaJet', 'LanzaJet (LanzaJet Inc)'], ['LanzaJet', 'LanzaJet Incorporated'],
    ['Eni', 'Eni S.p.A.'], ['Eni', 'Eni SpA'], ['Neste', 'Neste Oyj'], ['Toyota Tsusho', 'Toyota Tsusho Co., Ltd.'], ['Sime Darby Plantation', 'Sime Darby Plantation Bhd'],
    ['Musim Mas', 'PT Musim Mas'], ['LG화학', '(주)LG화학'], ['XCF Global', 'XCF Global Inc'], ['Chevron', 'Chevron Corp.'], ['Shell', 'Shell plc'], ['Alfa Laval', 'Alfa Laval AB'],
    ['Calumet', 'Calumet, Inc'], ['Foo', 'Foo Pte. Ltd.'], ['Foo', 'Foo L.L.C.'], ['Foo', 'The Foo Company']];
  for (const [a, b] of same) assert.equal(stripForms(a), stripForms(b), `${a} / ${b}`);
  // names that merely contain a form-like word elsewhere are untouched
  assert.equal(stripForms('Air bp'), 'air bp');
  assert.equal(stripForms('AB InBev'), 'ab inbev');
  assert.notEqual(stripForms('Eni'), stripForms('Enilive'));
});

test('every layer agrees: dataset rows, relation names, registry clusters, label with a comma', () => {
  const recs = [{ entity: 'LanzaJet Inc.', amount: 1 }, { entity: 'LanzaJet', amount: 2 }, { entity: 'LanzaJet, Inc', amount: 3 }, { entity: 'Neste Oyj', amount: 4 }, { entity: 'Neste', amount: 5 }];
  const out = dp.canonicalizeEntities(recs, []);
  assert.equal(new Set(out.map((r) => r.entity.toLowerCase().replace(/[^a-z]/g, '').replace(/inc$|oyj$/, ''))).size, 2);
  assert.equal(new Set(out.slice(0, 3).map((r) => r.entity)).size, 1);
  assert.equal(rel.baseKey('XCF Global Inc.'), rel.baseKey('XCF Global'));
  assert.equal(rel.isNonCompanyName('Calumet, Inc'), false);
  assert.equal(rel.isNonCompanyName('Toyota Tsusho, Co., Ltd.'), false);
  assert.equal(rel.isNonCompanyName('Valero, Darling Ingredients'), true);
  const groups = reg.cluster([{ name: 'LanzaJet', n: 3 }, { name: 'LanzaJet Inc.', n: 1 }, { name: 'Shell plc', n: 2 }, { name: 'Shell', n: 5 }]);
  assert.equal(groups.length, 2);
});

test('the typo corrector never rewrites a legal-form word ("Incorporated", "Limited" ...) into another word', () => {
  const vocab = ['Incorporate Inventory Limiter Corporal'];
  const text = 'XCF Global Incorporated and Foo Limited signed.';
  assert.equal(canonicalizeProperNouns(text, vocab, []), text);
});

test('"Capex" / "CAPEX" stay as written and are not "corrected" into the company name Caltex; real typos are still fixed', () => {
  const roster = [{ name: 'GS칼텍스', rawNames: ['GS칼텍스', 'GS Caltex', 'Caltex'] }];
  const mats = ['GS Caltex announced a new unit', 'EcoCeres builds a plant'];
  assert.equal(canonicalizeProperNouns('Capex는 20억 달러이고 CAPEX 규모는 크다. Opex와 EBITDA도 있다.', mats, roster), 'Capex는 20억 달러이고 CAPEX 규모는 크다. Opex와 EBITDA도 있다.');
  assert.equal(canonicalizeProperNouns('Ecoseas는 Caltex와 협력한다', mats, roster), 'EcoCeres는 Caltex와 협력한다');
  // a short name with a single wrong letter is still repaired
  assert.equal(canonicalizeProperNouns('Caltax 발표', mats, roster), 'Caltex 발표');
});
