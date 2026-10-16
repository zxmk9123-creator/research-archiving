// SUBJECT SCOPE. "팜유 생산·정제 업체" asks for the palm-oil industry's producers/refiners — not for
// every roster company whose materials happen to mention palm oil (biofuel makers, refiners that
// buy palm feedstock, SAF developers). When the question is a palm producer/refiner listing, only
// roster companies tagged segment='palm' are in scope: out-of-scope companies are removed from the
// candidate materials, the required list, the dataset and table/bullet rows of the answer.
const PALM = /(팜|palm)/i; // 팜유, 팜오일, 팜 농장, 팜 생산업체 ...
const PRODUCER_CUE = /(생산\s*업체|생산자|생산\s*기업|생산사|정제\s*업체|정제사|리파이너|refiner|플랜테이션|plantation|농장|producer|mills?(?![a-z])|업체|기업|회사|숏리스트|shortlist)/i;
const USER_CUE = /(수입|구매|사용|소비|바이오디젤|biodiesel|SAF|재생|HVO|연료|fuel)/i;

function forQuestion(question) {
  const q = String(question || '');
  if (PALM.test(q) && PRODUCER_CUE.test(q) && !USER_CUE.test(q)) return { segment: 'palm', label: '팜유 생산·정제 업체' };
  return null;
}

// A roster row that names the same company as an in-scope one (e.g. an auto-discovered "Wilmar International
// Limited" next to the tagged "Wilmar") is in scope too: in-scope wins any name overlap.
function sameCompany(a, b) {
  return a.names.some((x) => x.length >= 3 && b.names.some((y) => y.length >= 3 && (x === y || x.includes(y) || y.includes(x))));
}
function splitRoster(roster, scope) {
  const tagged = roster.filter((c) => c.segment === scope.segment);
  const allowed = roster.filter((c) => c.segment === scope.segment || tagged.some((t) => sameCompany(c, t)));
  return { allowed, outside: roster.filter((c) => !allowed.includes(c)) };
}

const nameMatches = (c, text) => c.names.some((n) => n.length >= 3 && text.startsWith(n));

// Table rows and bullets whose subject (first entity written on the line) is an out-of-scope roster company.
function dropOutOfScopeLines(text, outside) {
  if (!outside.length) return text;
  return String(text || '').split('\n').filter((line) => {
    if (/^\s*#/.test(line) || /^\s*\|\s*:?-{2,}/.test(line)) return true;
    if (!/^\s*(\||[-*•]|\d+\.)/.test(line)) return true;
    const lead = line.replace(/^[\s|>*\-•\d.]+/, '').replace(/^\*+\s*/, '').toLowerCase();
    return !outside.some((c) => nameMatches(c, lead));
  }).join('\n');
}

// Extra retrieval terms so a short phrasing ('팜 생산업체') still reaches the subject's materials.
function retrievalHint(question, scope) {
  return scope && !/(팜유|palm oil)/i.test(String(question || '')) ? `${question} 팜유 palm oil` : question;
}

module.exports = { retrievalHint, forQuestion, splitRoster, dropOutOfScopeLines };
