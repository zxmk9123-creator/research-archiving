// HOUSE SPELLING for domain terms. Free-tier models transliterate English terms their own way ("high oleic" -> "고올레익", "Thanksgiving" ->
// "토스터데이", "memorandum of understanding" -> "메모랜드 오더"); the archive writes them one way. Three layers use this one list:
//  1. aiDraft's prompt names the fixed Korean forms, so new summaries are written correctly;
//  2. fixTerms() repairs the known wrong forms in every AI-written Korean field before it is stored, and in the headline brief's input and output;
//  3. glossaryHints() / suspectTranslations() hand the headline brief the right Korean form next to each item whose English text names the term,
//     and flag items whose stored Korean summary does not use it (an unknown mistranslation of a known term is then still visible to the model).
// Add an entry for each newly found variant: en = how the source writes it, ko = the form to use, wrong = known bad forms.
const GLOSSARY = [
  { en: /thanksgiving/i, ko: '추수감사절', wrong: /토스터\s*데이|땡스기빙|땡스\s*기빙/g },
  { en: /memorandum\s+of\s+understanding|\bMOU\b/i, ko: '양해각서(MOU)', wrong: /메모랜드\s*오[^\s가-힣]{0,3}더|메모랜드\s*오브\s*언더스탠딩|메모란덤/g },
  { en: /high[\s-]*oleic/i, ko: '고올레인', wrong: /고\s*올레익/g },
];

const TERM_FIXES = GLOSSARY.map((g) => [g.wrong, g.ko]);

function fixTerms(text) {
  if (typeof text !== 'string' || !text) return text;
  return TERM_FIXES.reduce((t, [re, to]) => t.replace(re, to), text);
}

const stem = (ko) => ko.replace(/\(.*\)$/, '');

// [{ en: 'Thanksgiving', ko: '추수감사절' }]: fixed Korean forms for the terms the given (English or Korean) texts mention.
function glossaryHints(...texts) {
  const blob = texts.filter((t) => typeof t === 'string').join(' \n ');
  const out = [];
  for (const g of GLOSSARY) {
    const m = blob.match(g.en);
    if (m) out.push({ en: m[0], ko: g.ko });
  }
  return out;
}

// Entries whose English term is in the title but whose Korean summary uses neither the fixed form nor a known wrong form's absence:
// i.e. the summary talks about the term in words we cannot vouch for. Returns the same shape as glossaryHints.
function suspectTranslations(title, summary) {
  const s = String(summary || '');
  return glossaryHints(title).filter((h) => !s.includes(stem(h.ko)));
}

module.exports = { fixTerms, TERM_FIXES, GLOSSARY, glossaryHints, suspectTranslations };
