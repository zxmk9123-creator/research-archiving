// PROPER-NOUN CANONICALIZATION. Free-tier models sometimes mis-spell a name they
// were given ("Ecoseas" for "EcoCeres"). A capitalized Latin word in the answer that
// appears nowhere in the supplied materials (or the company roster) but is a
// near-spelling of a word that does is replaced by the materials' own spelling.
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const WORD_RE = /\b[A-Z][A-Za-z]{4,}\b/g;
const LEGAL_FORM_WORDS = new Set(require('./corpSuffix').FORM_WORDS_LONG); // "Incorporated", "Corporation", "Limited" ... are never "corrected" into another word


function buildVocabulary(texts, roster) {
  const vocab = new Map(); // lower -> canonical spelling (most frequent wins)
  const counts = new Map();
  const add = (w) => {
    const k = w.toLowerCase();
    const key = `${k}|${w}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    const best = vocab.get(k);
    if (!best || counts.get(key) > (counts.get(`${k}|${best}`) || 0)) vocab.set(k, w);
  };
  for (const t of texts) for (const w of String(t || '').match(WORD_RE) || []) add(w);
  for (const c of roster) for (const n of [c.name, ...(c.rawNames || [])]) for (const w of String(n || '').match(WORD_RE) || []) add(w);
  return vocab;
}

function canonicalizeProperNouns(text, materialTexts, roster = []) {
  const vocab = buildVocabulary(materialTexts, roster);
  if (!vocab.size) return text;
  const keys = [...vocab.keys()];
  return String(text || '').replace(WORD_RE, (word) => {
    const k = word.toLowerCase();
    if (vocab.has(k) || LEGAL_FORM_WORDS.has(k)) return word;
    const limit = word.length >= 7 ? 3 : 2;
    let best = null;
    for (const cand of keys) {
      if (Math.abs(cand.length - k.length) > limit || cand[0] !== k[0]) continue;
      const d = lev(k, cand);
      if (d <= limit && d / Math.max(k.length, cand.length) <= 0.4 && (!best || d < best.d)) best = { d, cand };
    }
    return best ? vocab.get(best.cand) : word;
  });
}

module.exports = { canonicalizeProperNouns, lev };
