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
  return out;
}

// Archive filter: all forms of the group when the whole query is a member, else just the query.
function filterForms(q) {
  const g = groupFor(q);
  return g ? g.forms : [String(q)];
}

module.exports = { GROUPS, groupFor, expandConcepts, filterForms };
