// QUESTION INTENT. Earlier, any question containing a generic word such as
// "업체" ("Neste 업체에 대해 알려줘") was treated as a whole-industry sweep: the
// archive was dumped into the prompt, every material was cited in turn, no
// company overview was written and unrelated companies were appended. Intent is
// now decided from WHAT the question names, not from generic nouns:
//   entity     — exactly one known company is named  -> a focused company profile
//   peers      — two or more known companies are named -> compare exactly those
//   collective — no company named + an aggregate cue ("글로벌", "주요", "전체",
//                "…들", "비교", "순위", "누락 없이" …) together with a company/plant
//                noun or a capacity word -> the whole roster is in scope
//   general    — everything else (no roster work at all)
const ENTITY_NOUN = /(업체|기업|회사|정유사|정유업체|메이저|생산자|공급사|업계|메이커|플랜트|설비|시설|거점|공장|사업장|compan|major|producer|supplier|refiner|player|operator|plant|facilit|biorefiner|\bsites?\b)/i;
const AGGREGATE_CUE = /(들[의은이을과와도만]?(?=\s|$)|주요|글로벌|전체|모든|전수|각\s*(사|업체|기업)|별\s|별로|비교|순위|상위|리스트|목록|누락|빠짐|peer|top\s*\d|\ball\b|every|leading|global|ranking|compar|worldwide)/i;
const COMPLETENESS = /(누락\s*없|빠짐\s*없|빠뜨리지|전수|모든|전체|전부|\ball\b|every|complete|exhaustive|entire)/i;
const CAPACITY = /(capa|capacity|생산\s*능력|용량|생산량|설비\s*규모|처리\s*능력)/i;

function mentions(question, company) {
  const q = String(question || '').toLowerCase();
  return company.names.some((n) => {
    if (!n || n.length < 3) return false;
    if (/^[a-z0-9 .&'()-]+$/.test(n)) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(q);
    }
    return q.includes(n);
  });
}

function classifyIntent(question, roster = []) {
  const focus = roster.filter((c) => mentions(question, c));
  if (focus.length === 1) return { type: 'entity', focus };
  if (focus.length >= 2) return { type: 'peers', focus };
  const q = String(question || '');
  const collective = (ENTITY_NOUN.test(q) && AGGREGATE_CUE.test(q)) || (COMPLETENESS.test(q) && (ENTITY_NOUN.test(q) || CAPACITY.test(q)));
  return { type: collective ? 'collective' : 'general', focus: [] };
}

module.exports = { classifyIntent, mentions };
