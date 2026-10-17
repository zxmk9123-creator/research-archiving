// CROSS-SCRIPT QUERY EXPANSION. A Korean question about "프로젝트 율리시스" cannot match an English-only article that
// says "Project Ulysses": the keyword search is literal. For the RARE terms of a question (few archive hits), the other
// spelling is looked up ONCE (model call, then stored in term_aliases) and added as an alternative form of the same
// concept — so the later question costs one cheap table read. Alternatives that are common words are discarded.
const pool = require('../db/pool');
const provider = require('./ai/provider');

const memo = new Map(); // term -> [alts], process-wide
const SYSTEM = 'For each term, give the other common spellings of the SAME thing in the other script (Korean <-> English): official English names, romanisations used in news, or the usual Korean transliteration. Respond with ONLY a JSON object {"term": ["spelling", ...]}. An empty list when the term is an ordinary word, a typo, or you are unsure. Never invent a name.';

const eligible = (t) => {
  const s = String(t || '').trim();
  if (!/[A-Za-z가-힣]/.test(s)) return false; // digits / punctuation only
  return /[가-힣]/.test(s) ? s.length >= 3 : /^[A-Za-z][A-Za-z0-9 .'-]{3,}$/.test(s);
};
const plausibleAlt = (alt, term) => {
  const s = String(alt || '').trim();
  return s.length >= 4 && s.length <= 40 && s.toLowerCase() !== String(term).toLowerCase() && /[A-Za-z가-힣]/.test(s);
};

async function lookupCached(terms) {
  const need = terms.filter((t) => !memo.has(t));
  if (need.length) {
    const { rows } = await pool.query('SELECT term, alt FROM term_aliases WHERE term = ANY($1)', [need]);
    const byTerm = new Map();
    for (const r of rows) { if (!byTerm.has(r.term)) byTerm.set(r.term, []); if (r.alt) byTerm.get(r.term).push(r.alt); }
    for (const t of need) if (byTerm.has(t)) memo.set(t, byTerm.get(t));
  }
  return terms.filter((t) => !memo.has(t));
}

// Returns Map(term -> alts). Unknown terms cost ONE batched model call (bounded), stored for good.
async function expandTerms(rawTerms, { timeoutMs = 6000 } = {}) {
  if (process.env.TERM_EXPANSION === 'off') return new Map();
  const terms = [...new Set(rawTerms.map((t) => String(t).toLowerCase().trim()).filter(eligible))].slice(0, 4);
  if (!terms.length) return new Map();
  try {
    const unknown = await lookupCached(terms);
    if (unknown.length) {
      const result = await Promise.race([
        provider.callProviderWithFallback({ system: SYSTEM, user: JSON.stringify(unknown) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('term expansion timed out')), timeoutMs)),
      ]);
      const raw = String(result.text || '');
      let parsed = {};
      try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch (_) { parsed = {}; }
      for (const t of unknown) {
        const alts = (Array.isArray(parsed[t]) ? parsed[t] : []).filter((a) => plausibleAlt(a, t)).slice(0, 3);
        memo.set(t, alts);
        await pool.query('INSERT INTO term_aliases (term, alt) VALUES ($1, $2) ON CONFLICT DO NOTHING', [t, ''] ).catch(() => {});
        for (const a of alts) await pool.query('INSERT INTO term_aliases (term, alt) VALUES ($1, $2) ON CONFLICT DO NOTHING', [t, a]).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`term expansion skipped: ${err.message}`);
  }
  return new Map(terms.filter((t) => memo.has(t)).map((t) => [t, memo.get(t)]));
}

module.exports = { expandTerms, eligible, plausibleAlt, _memo: memo };
