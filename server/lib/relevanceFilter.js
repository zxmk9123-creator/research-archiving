// Oil & Fats scope pre-filter for RSS collection. A lightweight topical
// gate — cheaper than and deliberately separate from ai_eligible, which
// only judges archival *worth* for items that already passed this topic
// check. Reuses the existing sector taxonomy (식용유지/팜유/대두유/유채씨유/
// 해바라기유/비식용유지/UCO/UCOME/SAF/Tallow/FAME, see schema.sql) as the
// scope source — the patterns below are just the English aliases RSS
// articles commonly use for those same sectors, not a new taxonomy.
//
// Deliberately permissive (favors false negatives passing through over
// false positives being dropped): every pattern is a specific compound
// phrase or a short acronym at a word boundary, never a bare generic word
// like "oil" or "fat" alone — those would match crude-oil/engine-oil/
// dietary-fat articles that have nothing to do with this project's scope.
const KEYWORD_PATTERNS = [
  // 식용유지 (edible oils) and its children
  /\bedible oils?\b/i,
  /\bvegetable oils?\b/i,
  /\bcooking oils?\b/i,
  /\bpalm oil\b/i,
  /\bsoy(?:bean)? oil\b/i,
  /\brapeseed oil\b/i,
  /\bcanola oil\b/i,
  /\bsunflower oil\b/i,
  // 비식용유지 (non-edible oils/fats) and its children
  /\bnon-?edible oils?\b/i,
  /\bused cooking oil\b/i,
  /\bUCO\b/,
  /\bUCOME\b/,
  /\bSAF\b/,
  /\bsustainable aviation fuel\b/i,
  /\btallow\b/i,
  /\bFAME\b/,
  /\bfatty acid methyl esters?\b/i,
  /\bbiodiesel\b/i,
  /\boils? and fats\b/i,
  /\bfats and oils\b/i,
  // Korean sector names, in case a bilingual/Korean-language description
  // is ever collected.
  /식용유지/, /비식용유지/, /팜유/, /대두유/, /유채씨유/, /해바라기유/,
];

// title/description are matched together since RSS descriptions are often
// where the specific oil/fat term appears even when the title is generic.
function isRelevantToOilFatsScope(title, description) {
  const text = `${title || ''} ${description || ''}`;
  return KEYWORD_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = { isRelevantToOilFatsScope, KEYWORD_PATTERNS };
