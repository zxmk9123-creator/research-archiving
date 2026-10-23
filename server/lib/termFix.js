// HOUSE SPELLING for domain terms. Free-tier models transliterate English terms their own way ("high oleic" -> "고올레익");
// the archive writes them one way. Applied to every AI-written Korean field before it is stored, so a wrong form never reaches
// the archive, the headline brief or the chatbot. Add a [pattern, replacement] pair for each newly found variant.
const TERM_FIXES = [
  [/고\s*올레익/g, '고올레인'], // high-oleic (고올레인 대두/해바라기/카놀라유 ...)
];

function fixTerms(text) {
  if (typeof text !== 'string' || !text) return text;
  return TERM_FIXES.reduce((t, [re, to]) => t.replace(re, to), text);
}

module.exports = { fixTerms, TERM_FIXES };
