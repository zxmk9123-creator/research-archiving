const test = require('node:test');
const assert = require('node:assert/strict');
const ae = require('../server/lib/aliasEnrichment');

test('plausible alias: Korean 2-30 chars, Latin 3-40 chars with a letter; junk rejected', () => {
  assert.equal(ae.plausible('인피니엄'), true);
  assert.equal(ae.plausible('Infinium Energy'), true);
  for (const weak of ['Eni', 'Total', 'GAR', 'TBL', 'SOP']) assert.equal(ae.plausible(weak), false, weak);
  assert.equal(ae.plausible('인피'), false);
  assert.equal(ae.plausible('인'), false);
  assert.equal(ae.plausible('AB'), false);
  assert.equal(ae.plausible('12345'), false);
  assert.equal(ae.plausible(''), false);
});

test('parseReply tolerates fences and prose; sameCompany folds auto-discovered duplicates', () => {
  assert.deepEqual(ae.parseReply('```json\n[{"name":"Infinium","aliases":["인피니엄"]}]\n```'), [{ name: 'Infinium', aliases: ['인피니엄'] }]);
  assert.deepEqual(ae.parseReply('nothing'), []);
  assert.equal(ae.sameCompany({ name: 'KLK', aliases: ['Kuala Lumpur Kepong'] }, { name: 'Kuala Lumpur Kepong Bhd', aliases: [] }), true);
  assert.equal(ae.sameCompany({ name: 'Neste', aliases: [] }, { name: 'Eni S.p.A.', aliases: [] }), false);
  assert.equal(ae.sameCompany({ name: 'Wilmar', aliases: ['윌마'] }, { name: 'Wilmar International Limited', aliases: [] }), true);
});
