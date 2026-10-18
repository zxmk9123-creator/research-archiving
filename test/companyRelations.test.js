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
