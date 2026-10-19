// LEGAL-FORM WORDS ("Inc", "Corp", "Ltd", "S.p.A.", "Bhd", "주식회사" ...). A name that differs from another only by these words is the
// SAME company: "LanzaJet Inc." = "LanzaJet", "Eni SpA" = "Eni", "Neste Oyj" = "Neste". One definition used by the dataset tables, the
// relation map, the entity registry, the spec tables and the typo corrector, so no layer treats the suffix as a different name.
const FORMS = new Set([
  'incorporated', 'inc', 'corporation', 'corp', 'company', 'co', 'limited', 'ltd', 'llc', 'llp', 'lp', 'plc', 'pcl', 'gmbh', 'ag', 'kg',
  'sa', 'sas', 'sarl', 'srl', 'spa', 'nv', 'bv', 'ab', 'asa', 'as', 'oyj', 'oy', 'kk', 'pte', 'pty', 'pjsc', 'ojsc', 'jsc', 'bhd', 'berhad', 'tbk', 'sdn',
]);
// words of 5+ letters among them: protected from the proper-noun typo corrector
const FORM_WORDS_LONG = [...FORMS].filter((w) => w.length >= 4);
const CJK_FORMS = /주식회사|\(주\)|㈜|유한회사|합자회사|株式会社|\(株\)|㈱/g;

// lower-case words of the name without legal forms, parentheses and punctuation; "PT" / "The" in front are dropped too
function stripForms(name) {
  let s = String(name || '').replace(CJK_FORMS, ' ').replace(/\(.*?\)|（.*?）/g, ' ');
  s = s.replace(/\b([a-z])\.(?=[a-z]\b)/gi, '$1').replace(/\b([a-z])\.(?=\s|$|,)/gi, '$1'); // S.p.A. -> SpA, L.L.C. -> LLC
  const tokens = s.toLowerCase().replace(/[,;]+/g, ' ').replace(/[.®™*_`]/g, '').split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && (FORMS.has(tokens[tokens.length - 1]) || ['&', 'and', '-'].includes(tokens[tokens.length - 1]))) tokens.pop();
  while (tokens.length > 1 && ['pt', 'the'].includes(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

module.exports = { FORMS, FORM_WORDS_LONG, CJK_FORMS, stripForms };
