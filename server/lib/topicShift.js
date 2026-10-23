// TOPIC SHIFT. A follow-up normally inherits the previous turn (its text for retrieval, its sector and companies, the history shown to
// the writer). When the new question is about something else ("팜유 시장 동향" -> "AtJ 프로젝트 리스트업") that inheritance turns it into
// "팜유 AtJ 프로젝트" and the answer becomes "insufficient evidence". A question is treated as a NEW topic when it has no referential
// wording, enough topical terms of its own, and shares none of them with the previous question or the carried sector.
const REFERENTIAL = /(^|\s)(그|이|저|위|해당|앞서|앞의|이전|방금|그럼|그러면|그리고|그중|그 중|이중|이 중|같은|동일|또|더|다른|추가로|계속)(\s|$|[가-힣]{0,2}(?=\s|$))|(위의|앞의|이전의|그것|이것|거기|여기|아까)/;
const MIN_OWN_TERMS = 2;

function lastUserTurn(history) {
  const turns = Array.isArray(history) ? history.filter((t) => t && t.role === 'user' && typeof t.content === 'string') : [];
  return turns.length ? turns[turns.length - 1].content : '';
}

// extractConcepts is passed in (search.js owns tokenisation) to avoid a circular import.
function isNewTopic(question, history, prevContext, extractConcepts) {
  const prev = lastUserTurn(history);
  if (!prev) return false;
  if (REFERENTIAL.test(String(question || ''))) return false;
  const own = extractConcepts(question);
  if (own.length < MIN_OWN_TERMS) return false;
  const prevText = `${prev} ${(prevContext && prevContext.subject) || ''} ${((prevContext && prevContext.entities) || []).join(' ')}`.toLowerCase();
  const shares = own.some((forms) => forms.some((f) => f.length >= 2 && prevText.includes(String(f).toLowerCase())));
  return !shares;
}

module.exports = { isNewTopic, REFERENTIAL };
