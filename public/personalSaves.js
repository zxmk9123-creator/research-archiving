// Personal Save ("나중에 다시 볼 자료") is pure browser-local state — no
// auth exists yet, so it is never identified by email or written to the
// server. Only the array<->Set (de)serialization and the toggle are pure
// logic here; app.js wraps these with the actual localStorage read/write.
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

(function () {
  const exported = { parseSavedIds, serializeSavedIds, toggleSavedId };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    window.PersonalSaves = exported;
  }
})();
