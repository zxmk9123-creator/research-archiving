// Pure comparison logic between the AI's eligibility verdict (ai_eligible)
// and the reviewer's own decision (reviewer_eligible). No DOM dependency,
// so this file is used by the browser (via <script>) and by node:test —
// same pattern as sectorTree.js.
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.EligibilityMatch = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Returns one of:
  //   'match'              - AI and reviewer agree (true/true or false/false)
  //   'ai_false_positive'  - AI said eligible, reviewer said not eligible
  //   'ai_false_negative'  - AI said not eligible, reviewer said eligible
  //   null                 - excluded: no reviewer decision yet, or AI gave
  //                          no verdict to compare against
  //
  // NULL is never treated as a third eligibility value here — a NULL on
  // either side just means "nothing to compare", not "disagreement".
  function classifyEligibilityMatch(aiEligible, reviewerEligible) {
    if (typeof reviewerEligible !== 'boolean') return null;
    if (typeof aiEligible !== 'boolean') return null;
    if (aiEligible === reviewerEligible) return 'match';
    return aiEligible === true ? 'ai_false_positive' : 'ai_false_negative';
  }

  return { classifyEligibilityMatch };
});
