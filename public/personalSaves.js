// Personal Save ("나중에 다시 볼 자료") is pure browser-local state — no
// auth exists yet, so it is never identified by email or written to the
// server. Only the array<->Set (de)serialization and the toggle are pure
// logic here; app.js wraps these with the actual localStorage read/write.
// Wrapped in the same IIFE-factory pattern as sectorTree.js/
// eligibilityMatch.js — see cardHelpers.js for why a bare top-level
// function here would break the page (shared global scope across classic
// <script> tags).
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.PersonalSaves = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseSavedIds(raw) {
    try {
      const arr = JSON.parse(raw || '[]');
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.map(Number).filter((n) => Number.isFinite(n)));
    } catch {
      return new Set();
    }
  }

  function serializeSavedIds(set) {
    return JSON.stringify([...set]);
  }

  function toggleSavedId(set, id) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  return { parseSavedIds, serializeSavedIds, toggleSavedId };
});
