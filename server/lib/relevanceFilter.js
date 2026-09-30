// Research Archiving relevance pre-filter for RSS collection. A lightweight
// topical gate — cheaper than and deliberately separate from ai_eligible,
// which only judges archival *worth* for items that already passed this
// topic check. A topically-relevant item can still be reviewer-ineligible
// later — that's expected: this filter answers "is this article within our
// research scope?", not "is this worth archiving?".
//
// v3 taxonomy — organized around four explicit priority scopes instead of
// an oil/fat-taxonomy-first design:
//   1. Logistics & Shipping Market
//   2. Crude Oil & Energy Markets
//   3. Regulations & Policies Affecting Edible and Industrial Oils
//   4. Major Global Edible/Industrial Oil Companies
//
// An article is relevant if it materially belongs to AT LEAST ONE scope.
// Explicit oil/fat wording ("palm oil", "vegetable oil", etc.) is never
// required — a Hormuz shipping story, a Brent price shock, an EU biofuel
// rule, or a major ADM investment can each be relevant on its own scope.
//
// Deliberately conservative on bare generic terms: "oil", "shipping",
// "logistics", "energy", "trade", "ports", "companies", generic
// geopolitical/military/macroeconomic news, and generic corporate PR must
// NOT match on their own — only the specific compound phrases/context
// co-occurrences below do.

// ---------------------------------------------------------------------
// Scope 1: Logistics & Shipping Market
// ---------------------------------------------------------------------
// Freight rates, vessel/fleet capacity, and named chokepoints/canals are
// relevant on their own (chokepoint stories are relevant by default,
// gated only against a competing non-oil commodity being the actual
// subject — see COMPETING_COMMODITY_CONTEXT). Generic logistics/
// trucking/warehouse/port-tech news is deliberately excluded even though
// it may mention "freight" or "shipping" in passing.
const FREIGHT_MARKET_PATTERNS = [
  /\btanker (?:freight )?rates?\b/i,
  /\bfreight rates?\b/i,
  /\bcontainer (?:freight|shipping) rates?\b/i,
  /\bbulk (?:carrier|shipping) rates?\b/i,
  /\bshipping (?:costs?|market)\b/i,
  /\bvessel availability\b/i,
  /\bfleet capacity\b/i,
  /\bport congestion\b/i,
  /\bport capacity\b/i,
];

const CHOKEPOINT_PATTERNS = [
  /\bstrait of hormuz\b/i,
  /\bhormuz\b/i,
  /\bsuez canal\b/i,
  /\bsuez\b/i,
  /\bpanama canal\b/i,
];
const COMPETING_COMMODITY_CONTEXT = /\b(LNG|liquefied natural gas|coal|natural gas|electricity)\b/i;

// Oil-linked maritime regulation with an explicit named mechanism
// (IMO/MARPOL emissions frameworks affecting fuel-switching/compliance
// cost for shipping), not bare "shipping regulation".
const MARITIME_REGULATION_PATTERNS = [
  /\bMARPOL\b/,
  /\bIMO Net-Zero Framework\b/i,
  /\bISWG-GHG\b/i,
];

// Generic logistics/technology terms that must NOT trigger relevance on
// their own, even though real Scope-1 stories sometimes share vocabulary
// with them (e.g. "port"). Used only for documentation/tests, not matched
// directly — the positive patterns above are written narrowly enough that
// these never match by themselves.

// ---------------------------------------------------------------------
// Scope 2: Crude Oil & Energy Markets
// ---------------------------------------------------------------------
// Crude/refined petroleum market fundamentals — specific compound
// phrases, not bare "oil" or bare "energy".
const CRUDE_ENERGY_PATTERNS = [
  /\bcrude oil\b/i,
  /\bcrude (?:export|shipment)s?\b/i,
  /\bcrude shock\b/i,
  /\bBrent crude\b/i,
  /\bWTI crude\b/i,
  /\bstrategic petroleum reserve\b/i,
  /\bpetroleum (?:exports?|shipments?|products?)\b/i,
  /\brefinery (?:runs?|capacity|outages?|operations?)\b/i,
  /\boil prices?\b/i,
  /\boil market\b/i,
  /\boil exports?\b/i,
  /\boil (?:supply|demand|inventor(?:y|ies)|production|imports?)\b/i,
  /\bOPEC\+?\b/,
  /\boil sanctions?\b/i,
  /\boil production polic(?:y|ies)\b/i,
];

// Refined-product/fuel terms gated on market-impact context — requires
// the fuel term AND a price/cost-impact word, so a local administrative
// diesel story (e.g. a state tax-relief measure) doesn't match on
// "diesel" alone the same way a price-shock/export-restriction story does.
const REFINED_FUEL_TERM = /\b(diesel|gasoline|jet fuel|fuel oil|bunker fuel)\b/i;
const MARKET_IMPACT_CONTEXT = /\b(price|prices|expensive|cost|costs|shortage|export restriction|export ban|supply|record high|record low|soaring)\b/i;

// ---------------------------------------------------------------------
// Scope 3: Regulations & Policies Affecting Edible and Industrial Oils
// ---------------------------------------------------------------------
const OIL_FAT_PRODUCT_PATTERNS = [
  /\bedible[- ]oils?\b/i,
  /\bvegetable oils?\b/i,
  /\bcooking oils?\b/i,
  /\bbiofuels?\b/i,
  /\bpalm oil\b/i,
  /\bsoy(?:bean)? oil\b/i,
  /\brapeseed oil\b/i,
  /\bcanola oil\b/i,
  /\bsunflower oil\b/i,
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
  /\banimal fats?\b/i,
  /\bindustrial oils?\b/i,
  // Korean sector names, in case a bilingual/Korean-language description
  // is ever collected.
  /식용유지/, /비식용유지/, /팜유/, /대두유/, /유채씨유/, /해바라기유/,
];

const POLICY_MECHANISM_PATTERNS = [
  /\bexport tax(?:es)?\b/i,
  /\bexport restrictions?\b/i,
  /\bexport levy\b/i,
  /\bimport tariffs?\b/i,
  /\btrade restrictions?\b/i,
  /\bbiofuel mandates?\b/i,
  /\bblending mandates?\b/i,
  /\bSAF policy\b/i,
  /\bcarbon regulations?\b/i,
  /\bemissions regulations?\b/i,
  /\bsustainability (?:rules?|requirements?|regulations?)\b/i,
  /\btraceability (?:rules?|requirements?|regulations?)\b/i,
  /\bdeforestation regulations?\b/i,
  /\bfood safety regulations?\b/i,
  /\brenewable fuel polic(?:y|ies)\b/i,
  /\bsubsidy\b/i, /\bsubsidies\b/i,
  /\bsanctions?\b/i,
];

// Plant-based/edible-fat-derived products — requires "plant-based"
// co-occurring with a food/nutrition context word, so it doesn't sweep in
// unrelated "plant-based economy"/"plant-based battery" usage.
const PLANT_BASED_TERM = /\bplant-based\b/i;
const PLANT_BASED_CONTEXT = /\b(food|nutrition|ingredient|diet|gut|health|protein)\b/i;

// ---------------------------------------------------------------------
// Scope 4: Major Global Edible/Industrial Oil Companies
// ---------------------------------------------------------------------
const MAJOR_OIL_FAT_COMPANIES = [
  /\bADM\b/, /\bArcher[- ]Daniels[- ]Midland\b/i,
  /\bCargill\b/i,
  /\bWilmar\b/i,
  /\bBunge\b/i,
  /\bLouis Dreyfus\b/i,
  /\bGolden Agri[- ]Resources\b/i,
  /\bSime Darby\b/i,
  /\bIOI Corporation\b/i,
  /\bKLK\b/, /\bKuala Lumpur Kepong\b/i,
  /\bMusim Mas\b/i,
  /\bFuji Oil\b/i,
  /\bNeste\b/i,
];

const COMPANY_DEVELOPMENT_CONTEXT = /\b(acqui(?:res?|sition|ring)|invest(?:s|ment|ing)?|capital expenditure|capex|new plant|new (?:factory|refinery|facility)|crushing facility|expan(?:d|ds|sion)|shut ?down|clos(?:e|es|ing) (?:a )?(?:plant|facility|refinery)|partnership|joint venture|supply agreement|sourcing|product launch|enters? (?:the )?market|exits? (?:the )?market|restructur(?:e|ing)|sustainability initiative|procurement)\b/i;

// Normalizes typographic hyphen variants (e.g. U+2011 non-breaking
// hyphen, as seen in a real "plant‑based" production title) to a plain
// ASCII hyphen, so every pattern above only has to spell "-" once.
function normalizeHyphens(text) {
  return text.replace(/[‐‑‒]/g, '-');
}

function scope1LogisticsShipping(text) {
  if (FREIGHT_MARKET_PATTERNS.some((p) => p.test(text)) && !COMPETING_COMMODITY_CONTEXT.test(text)) return true;
  if (MARITIME_REGULATION_PATTERNS.some((p) => p.test(text))) return true;
  if (CHOKEPOINT_PATTERNS.some((p) => p.test(text)) && !COMPETING_COMMODITY_CONTEXT.test(text)) return true;
  return false;
}

function scope2CrudeEnergy(text) {
  if (CRUDE_ENERGY_PATTERNS.some((p) => p.test(text))) return true;
  if (REFINED_FUEL_TERM.test(text) && MARKET_IMPACT_CONTEXT.test(text)) return true;
  return false;
}

function scope3RegulationsPolicies(text) {
  const hasProduct = OIL_FAT_PRODUCT_PATTERNS.some((p) => p.test(text));
  const hasPlantBased = PLANT_BASED_TERM.test(text) && PLANT_BASED_CONTEXT.test(text);
  if (!hasProduct && !hasPlantBased) return false;
  // Product/plant-based term alone already covers existing edible/
  // industrial-oil coverage (unchanged from prior taxonomy). A policy
  // mechanism co-occurring with the product term is the stronger,
  // regulation-specific signal, but isn't required when the product term
  // itself already establishes relevance.
  return true;
}

function scope4MajorCompanies(text) {
  return MAJOR_OIL_FAT_COMPANIES.some((p) => p.test(text)) && COMPANY_DEVELOPMENT_CONTEXT.test(text);
}

// title/description are matched together since RSS descriptions are often
// where the specific scope term appears even when the title is generic.
function isRelevantToOilFatsScope(title, description) {
  const text = normalizeHyphens(`${title || ''} ${description || ''}`);

  if (scope1LogisticsShipping(text)) return true;
  if (scope2CrudeEnergy(text)) return true;
  if (scope3RegulationsPolicies(text)) return true;
  if (scope4MajorCompanies(text)) return true;

  return false;
}

module.exports = {
  isRelevantToOilFatsScope,
  scope1LogisticsShipping,
  scope2CrudeEnergy,
  scope3RegulationsPolicies,
  scope4MajorCompanies,
  FREIGHT_MARKET_PATTERNS,
  CHOKEPOINT_PATTERNS,
  MARITIME_REGULATION_PATTERNS,
  CRUDE_ENERGY_PATTERNS,
  OIL_FAT_PRODUCT_PATTERNS,
  POLICY_MECHANISM_PATTERNS,
  MAJOR_OIL_FAT_COMPANIES,
  // Back-compat alias for the v1 export name.
  KEYWORD_PATTERNS: OIL_FAT_PRODUCT_PATTERNS,
};
