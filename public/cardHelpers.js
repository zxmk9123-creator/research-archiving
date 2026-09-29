// Pure helper for the item-card render boundary. No DOM dependency, so this
// same file is used by the browser (via <script>) and by node:test. Follows
// the same IIFE-factory pattern as sectorTree.js/eligibilityMatch.js: every
// internal function lives inside the factory closure, never as a bare
// top-level declaration — classic <script> tags share one global lexical
// scope, so a top-level `function normalizeImportantIds` here would collide
// with app.js's `const { normalizeImportantIds } = CardHelpers;` and throw
// a SyntaxError before any script on the page runs.
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.CardHelpers = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Normalizes whatever gets passed as "importantIds" into a real Set before
  // any .has() call touches it. This is the fix for the production crash:
  // itemCard(item, importantIds) was used directly as an Array.map()
  // callback in one call site (related.map(itemCard)), so JS silently
  // passed the array *index* (a Number) as importantIds instead of the
  // intended Set — works fine for index 0 (falsy, short-circuits before
  // .has()) and throws "importantIds.has is not a function" for index 1,
  // 2, ... Rather than relying on every call site to pass the right shape
  // (or downgrading to .includes(), which would just paper over a
  // wrong-shape value silently), every consumer normalizes through this
  // function at the render boundary.
  function normalizeImportantIds(value) {
    return value instanceof Set ? value : new Set();
  }

  return { normalizeImportantIds };
});
