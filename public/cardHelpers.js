// Normalizes whatever gets passed as "importantIds" into a real Set before
// any .has() call touches it. This is the fix for the production crash:
// itemCard(item, importantIds) was used directly as an Array.map() callback
// in one call site (related.map(itemCard)), so JS silently passed the
// array *index* (a Number) as importantIds instead of the intended Set —
// works fine for index 0 (falsy, short-circuits before .has()) and throws
// "importantIds.has is not a function" for index 1, 2, ... Rather than
// relying on every call site to pass the right shape (or downgrading to
// .includes(), which would just paper over a wrong-shape value silently),
// every consumer normalizes through this function at the render boundary.
function normalizeImportantIds(value) {
  return value instanceof Set ? value : new Set();
}

(function () {
  const exported = { normalizeImportantIds };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    window.CardHelpers = exported;
  }
})();
