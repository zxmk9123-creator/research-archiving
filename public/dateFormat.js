// Single shared date-only formatter for editorial display (Archive/Detail):
// "2026-09-28T00:00:00.000Z" or "2026-09-28" -> "2026.09.28". Never shows
// time/timezone. Wrapped in the same IIFE-factory pattern as
// sectorTree.js/eligibilityMatch.js/cardHelpers.js — see cardHelpers.js
// for why a bare top-level function would break the page (classic
// <script> tags share one global lexical scope).
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.DateFormat = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatDateOnly(value) {
    if (!value) return '';
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return '';
    return `${match[1]}.${match[2]}.${match[3]}`;
  }

  return { formatDateOnly };
});
