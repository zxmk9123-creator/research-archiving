// Fixed synonym groups: every form below is ONE concept, so a search for any of them (AI chatbot retrieval and the archive
// keyword filter) also finds materials that use another spelling.
const GROUPS = [
  {
    name: '유채씨유',
    forms: ['유채씨유', '카놀라유', '채종유', 'rapeseed oil', 'canola oil'],
    // single-token spellings that already name the concept ("카놀라", "rapeseed", ...)
    triggers: ['유채씨유', '유채유', '카놀라유', '카놀라', '채종유', 'rapeseed', 'canola', 'rapeseed oil', 'canola oil'],
  },
];

const norm = (s) => String(s || '').trim().toLowerCase();

function groupFor(text) {
  const t = norm(text);
  return t ? GROUPS.find((g) => g.triggers.includes(t) || g.forms.includes(t)) || null : null;
}

// extractConcepts() output (array of form arrays) + the raw question: a concept naming a group member gets all the group's forms;
// a multi-word member typed as a phrase ("canola oil" tokenises into two concepts) adds the group as one more concept.
function expandConcepts(concepts, question) {
  const q = norm(question);
  const out = concepts.map((forms) => {
    const g = forms.map(groupFor).find(Boolean);
    return g ? [...new Set([...forms, ...g.forms])] : forms;
  });
  for (const g of GROUPS) {
    const present = out.some((forms) => g.forms.every((f) => forms.includes(f)));
    if (!present && g.forms.some((f) => f.includes(' ') && q.includes(f))) out.push([...g.forms]);
  }
  if (MINOR_CUE.test(question) && OIL_CUE.test(question)) out.push([...MINOR_OILS]);
  return out;
}

// "비주류/마이너 식용유" names no oil, so keyword search finds nothing; the oils it stands for are searched instead.
const MINOR_OILS = ['쌀겨유', '아보카도유', '아마씨유', '포도씨유', '홍화씨유', '홍화유', '면실유', '호두유', '코코넛유', '올리브유', '땅콩유', '옥수수유', '참기름', '들기름',
  'rice bran oil', 'avocado oil', 'flaxseed oil', 'linseed oil', 'grapeseed oil', 'safflower oil', 'cottonseed oil', 'walnut oil', 'coconut oil', 'olive oil', 'peanut oil', 'corn oil', 'sesame oil'];
const MINOR_CUE = /(비주류|마이너|틈새|소규모|minor|niche)/i;
const OIL_CUE = /(식용유|식물성\s*유|식용\s*오일|오일|\boils?\b)/i;

// Archive filter: all forms of the group when the whole query is a member, else just the query.
function filterForms(q) {
  const g = groupFor(q);
  return g ? g.forms : [String(q)];
}

module.exports = { GROUPS, MINOR_OILS, groupFor, expandConcepts, filterForms };
