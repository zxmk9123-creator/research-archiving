// Oil & Fats scope pre-filter for RSS collection. A lightweight topical
// gate — cheaper than and deliberately separate from ai_eligible, which
// only judges archival *worth* for items that already passed this topic
// check. A topically-relevant item can still be reviewer-ineligible later
// (e.g. a single-refinery capacity story with no market-wide narrative) —
// that's expected: this filter answers "is this even on-topic?", not
// "is this worth archiving?".
//
// v2 taxonomy — derived from analyzing all 72 human review decisions
// (reviewer_eligible IS NOT NULL) in production, not just the original
// literal edible-oil-product name list. Five categories, each backed by
// examples reviewers actually accepted:
//   1. Crude/refined oil market fundamentals (price, supply, exports,
//      reserves) — e.g. "$100 crude shock", Strategic Petroleum Reserve.
//   2. Oil/fuel physical flows through a named chokepoint — e.g. Hormuz,
//      Suez, Panama Canal — distinct from bare "shipping" or bare "Iran".
//   3. Oil-linked maritime regulation — e.g. IMO/MARPOL emissions rules
//      that change fuel-switching/compliance cost for oil cargo.
//   4. Edible oils/fats (existing coverage, unchanged) and plant-based
//      products/companies.
//   5. Diesel/fuel articles specifically, gated on market-impact context
//      (price/cost language) rather than the bare word "diesel" — a
//      state-level administrative diesel story is not automatically the
//      same as a diesel-export-ban price-impact story (see the boundary
//      fixtures in test/relevanceFilter.test.js for the limits of this).
//
// Deliberately still conservative on bare generic terms: "oil", "fuel",
// "shipping", "energy", "Iran", "LNG", "coal", "natural gas",
// "electricity", "iron ore", and general freight/logistics/maritime news
// must NOT match on their own — only the specific compound
// phrases/co-occurrences below do.
//
// Aggregate freight/shipping indices (Baltic Dry Index, DHL Pricing Power
// Index) are intentionally NOT auto-matched here. Reviewers have accepted
// them, but making "freight index" a general relevance rule would sweep
// in large amounts of unrelated freight news that merely cites *an*
// index. Kept as an explicit human-review candidate for now (see the
// Report from the v2-taxonomy analysis task) rather than encoded.

const EDIBLE_FAT_PATTERNS = [
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

// Category 4b: plant-based/edible-fat-derived products — requires
// "plant-based" co-occurring with a food/nutrition context word, so it
// doesn't sweep in unrelated "plant-based economy"/"plant-based battery"
// usage.
const PLANT_BASED_TERM = /\bplant-based\b/i;
const PLANT_BASED_CONTEXT = /\b(food|nutrition|ingredient|diet|gut|health|protein)\b/i;

// Category 1: crude/refined oil market fundamentals — specific compound
// phrases, not bare "oil".
const CRUDE_REFINED_PATTERNS = [
  /\bcrude oil\b/i,
  /\bcrude (?:export|shipment)s?\b/i,
  /\bcrude shock\b/i,
  /\bBrent crude\b/i,
  /\bWTI crude\b/i,
  /\bstrategic petroleum reserve\b/i,
  /\bpetroleum (?:exports?|shipments?|products?)\b/i,
  /\brefinery runs?\b/i,
  /\boil prices?\b/i,
  /\boil market\b/i,
  /\boil exports?\b/i,
];

// Category 5: diesel/fuel articles gated on market-impact context —
// requires the fuel term AND a price/cost-impact word, so a local
// administrative diesel story (e.g. a state tax-relief measure) doesn't
// match on "diesel" alone the same way a price-shock story does.
const DIESEL_FUEL_TERM = /\b(diesel|bunker fuel)\b/i;
const MARKET_IMPACT_CONTEXT = /\b(price|prices|expensive|cost|costs|shortage|record high|record low|soaring)\b/i;

// Category 2: oil/fuel physical flows through a named chokepoint. The
// chokepoint name alone is not enough — production data includes a
// Hormuz-datelined story that reviewers rejected because its actual
// subject was an LNG force-majeure, not oil ("Qatar Extends LNG Force
// Majeure as Hormuz Crisis Drags On"). So the chokepoint must co-occur
// with an oil/fuel-flow term (still never matching bare "oil" alone
// elsewhere in this file — this is a narrow, paired check).
const CHOKEPOINT_PATTERNS = [
  /\bstrait of hormuz\b/i,
  /\bhormuz\b/i,
  /\bsuez canal\b/i,
  /\bsuez\b/i,
  /\bpanama canal\b/i,
];
const OIL_FLOW_CONTEXT = /\b(oil|crude|petroleum|tanker|barrels?)\b/i;

// Category 3: oil-linked maritime regulation with an explicit named
// mechanism (IMO/MARPOL emissions frameworks affecting fuel-switching/
// compliance cost), not bare "shipping regulation".
const MARITIME_REGULATION_PATTERNS = [
  /\bMARPOL\b/,
  /\bIMO Net-Zero Framework\b/i,
  /\bISWG-GHG\b/i,
];

// title/description are matched together since RSS descriptions are often
// where the specific oil/fat term appears even when the title is generic.
function isRelevantToOilFatsScope(title, description) {
  const text = `${title || ''} ${description || ''}`;

  if (EDIBLE_FAT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (PLANT_BASED_TERM.test(text) && PLANT_BASED_CONTEXT.test(text)) return true;
  if (CRUDE_REFINED_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (DIESEL_FUEL_TERM.test(text) && MARKET_IMPACT_CONTEXT.test(text)) return true;
  if (CHOKEPOINT_PATTERNS.some((pattern) => pattern.test(text)) && OIL_FLOW_CONTEXT.test(text)) return true;
  if (MARITIME_REGULATION_PATTERNS.some((pattern) => pattern.test(text))) return true;

  return false;
}

module.exports = {
  isRelevantToOilFatsScope,
  EDIBLE_FAT_PATTERNS,
  CRUDE_REFINED_PATTERNS,
  CHOKEPOINT_PATTERNS,
  MARITIME_REGULATION_PATTERNS,
  // Back-compat alias for the v1 export name.
  KEYWORD_PATTERNS: EDIBLE_FAT_PATTERNS,
};
