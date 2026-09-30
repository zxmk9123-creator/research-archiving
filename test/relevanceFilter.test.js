const test = require('node:test');
const assert = require('node:assert/strict');
const { isRelevantToOilFatsScope } = require('../server/lib/relevanceFilter');

test('isRelevantToOilFatsScope: a clearly relevant Oil & Fats article is accepted', () => {
  assert.equal(
    isRelevantToOilFatsScope('Indonesia raises palm oil export levy', 'The government increased the tax on crude palm oil shipments.'),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope('Soybean oil futures rise on tight supply', null),
    true
  );
});

test('isRelevantToOilFatsScope: a clearly irrelevant article is filtered out', () => {
  assert.equal(
    isRelevantToOilFatsScope('Central bank raises interest rates amid inflation concerns', 'The rate hike is the third this year.'),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope('Local football team wins championship final', 'Fans celebrated in the streets overnight.'),
    false
  );
});

test('isRelevantToOilFatsScope: English aliases for the existing sector taxonomy are accepted', () => {
  assert.equal(isRelevantToOilFatsScope('New sunflower oil refinery opens in Ukraine', null), true);
  assert.equal(isRelevantToOilFatsScope('Canada canola oil exports climb', null), true);
  assert.equal(isRelevantToOilFatsScope('EU rapeseed oil output forecast cut', null), true);
  assert.equal(isRelevantToOilFatsScope('Used cooking oil collection expands in California', null), true);
  assert.equal(isRelevantToOilFatsScope('SAF demand grows as airlines seek lower emissions', 'Sustainable aviation fuel producers ramp up capacity.'), true);
  assert.equal(isRelevantToOilFatsScope('Tallow-based biodiesel plant announced', null), true);
  assert.equal(isRelevantToOilFatsScope('FAME blending mandate raised to 10%', null), true);
});

test('isRelevantToOilFatsScope: a generic keyword used unrelatedly does not create an obvious false positive', () => {
  // Bare "oil"/"fat" are intentionally NOT matched on their own — dietary-
  // fat health articles and generic motor-oil mentions must not trip the
  // filter just because they mention the word.
  //
  // Crude-oil price/OPEC stories are a deliberate v2 change from v1: the
  // human-review dataset (72 reviewed items) showed reviewers consistently
  // accept crude/refined oil market fundamentals (e.g. "$100 crude shock",
  // Strategic Petroleum Reserve) as in-scope — this is category 1 of the
  // v2 taxonomy, not a false positive.
  assert.equal(
    isRelevantToOilFatsScope('Oil prices surge as OPEC agrees to cut output', 'Crude oil benchmark rose 3% in early trading.'),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope('Study finds low-fat diet reduces heart disease risk', 'Researchers tracked body fat percentage over five years.'),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope('Mechanic recommends synthetic motor oil for winter driving', null),
    false
  );
});

// --- v2 taxonomy regression fixtures, derived from the 72-item human
// review dataset analysis. ---

test('isRelevantToOilFatsScope: eligible — crude/refined oil market fundamentals', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'U.S. Strategic Petroleum Reserve Falls to Lowest Level Since 1982',
      'Crude stocks in the U.S. Strategic Petroleum Reserve stood at 284.6 million barrels for the week ending September 18.'
    ),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'Gulf oil exports recover, but why is the world still facing a $100 crude shock?',
      'Gulf oil exports are recovering after months of disruption caused by the US-Israeli war with Iran.'
    ),
    true
  );
});

test('isRelevantToOilFatsScope: eligible — Hormuz/oil-flow chokepoint stories', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Iran Says Won’t Soften Demands As Trump Rejects Hormuz Offer',
      'Iran stuck to its seven-day proposal for reopening the crucial Strait of Hormuz to oil tanker traffic.'
    ),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'Waterborne shipments from the U.S. Gulf Coast increased in April and May',
      'Waterborne shipments of crude oil and petroleum products from the U.S. Gulf Coast (PADD 3) to the West Coast more than quadrupled.'
    ),
    true
  );
});

test('isRelevantToOilFatsScope: eligible — plant-based/edible-fat-derived products', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Gut feeling: Biomel’s UK plant-based gut-health push',
      'Biomel founders discuss why the UK plant-based gut-health business can keep thriving.'
    ),
    true
  );
});

test('isRelevantToOilFatsScope: ineligible — other commodities (iron ore, LNG, coal) stay excluded', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Could the Central African Republic – Kribi iron ore corridor become the next major source of Capesize demand?',
      'A&S Resources is developing iron ore and other mineral assets, announcing plans for a railway line to Kribi port.'
    ),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'Qatar Extends LNG Force Majeure as Hormuz Crisis Drags On',
      'QatarEnergy has extended the force majeure on LNG deliveries to Asia and Europe by another month.'
    ),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'Coal Prices Hold Firm at High Levels as LNG Costs Rise',
      'Provincial spot power markets showed increasingly divergent trends amid high coal and LNG costs.'
    ),
    false
  );
});

test('isRelevantToOilFatsScope: ineligible — general freight/logistics/maritime-industry news stays excluded', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'The Great Lakes Towing Company Orders Two New Damen Tugs from Great Lakes Shipyard',
      'Hulls 11 and 12 will continue the company’s fleet renewal and expansion program.'
    ),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'Lowe’s test drives drone delivery',
      'Lowe’s is testing drones to speed up its game in same-day delivery.'
    ),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'CISA publishes its first Wärtsilä advisory after Cydome finds critical flaw in FOS software',
      'Cydome’s maritime cyber research team identified critical vulnerabilities in Wärtsilä FOS-Onboard.'
    ),
    false
  );
});

// Boundary case 1: same underlying topic (US diesel export policy), but
// the accepted article frames a national/global fuel-price consequence
// while the rejected one is a localized administrative relief measure
// with no market-price framing. This distinction is inherently fuzzy for
// a keyword filter — see the Report note on this pair as a case that may
// still need human-review confirmation rather than a fully solved rule.
test('isRelevantToOilFatsScope: boundary — diesel market-impact article vs. local diesel administrative measure', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Why Blocking U.S. Diesel Exports Could Make Fuel More Expensive',
      'Talk of a possible ban on U.S. exports of diesel fuel to curb soaring prices at the pump could end up pushing all fuel prices higher.'
    ),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'US considers diesel export restrictions',
      'Louisiana’s Governor declared a state of emergency over diesel supplies, allowing farmers to use lower-taxed dyed diesel for a month.'
    ),
    false
  );
});

// Boundary case 2: same Iran/Hormuz conflict, but only the article that
// explicitly names the Strait of Hormuz chokepoint is treated as an
// oil-flow story — general diplomatic scheduling news about Iran, with no
// chokepoint or oil-flow mechanism named, stays excluded (bare "Iran" is
// never matched on its own).
test('isRelevantToOilFatsScope: boundary — Hormuz oil-flow article vs. general Iran diplomacy', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Iran Says Won’t Soften Demands As Trump Rejects Hormuz Offer',
      'Iran stuck to its seven-day proposal for reopening the crucial Strait of Hormuz to oil tanker traffic.'
    ),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope(
      'U.S. and Iran Set to Hold Separate Talks With Mediators on Monday or Tuesday',
      'Qatari mediators are likely to hold separate talks with Iranian Foreign Minister Abbas Araqchi in New York.'
    ),
    false
  );
});

test('isRelevantToOilFatsScope: matches against description even when the title is generic', () => {
  assert.equal(
    isRelevantToOilFatsScope('Company announces quarterly results', 'Growth was driven by higher palm oil sales volumes.'),
    true
  );
});

test('isRelevantToOilFatsScope: matches Korean sector names directly', () => {
  assert.equal(isRelevantToOilFatsScope('팜유 가격 상승', null), true);
  assert.equal(isRelevantToOilFatsScope('중앙은행 금리 인상 발표', null), false);
});

// --- v2.1 chokepoint gate fix — regression fixtures from the 73-item
// retrospective validation. The gate no longer requires an explicit oil/
// crude/tanker word alongside the chokepoint name; it's relevant by
// default unless a competing commodity (LNG/coal/natural gas/
// electricity) is the article's subject. ---

test('isRelevantToOilFatsScope: Hormuz article without explicit oil/crude/tanker wording is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Iran Says Won’t Soften Demands As Trump Rejects Hormuz Offer',
      'Iran stuck to its seven-day proposal for reopening the crucial Strait of Hormuz, saying it won’t soften its conditions.'
    ),
    true
  );
});

test('isRelevantToOilFatsScope: Suez article without explicit oil wording is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Suez return speeds up Savannah India service by 10-14 days',
      'Two major liners are returning India-Savannah services to the Suez Canal, cutting transit times by up to 14 days.'
    ),
    true
  );
});

test('isRelevantToOilFatsScope: Panama Canal article without explicit oil wording is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Panama Canal Adds Transit Capacity as Rainfall Brings Relief',
      'The Panama Canal Authority announced it is easing draft and daily transit restrictions after increased rainfall.'
    ),
    true
  );
});

test('isRelevantToOilFatsScope: Hormuz article with LNG as the primary subject stays irrelevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Qatar Extends LNG Force Majeure as Hormuz Crisis Drags On',
      'QatarEnergy has extended the force majeure on LNG deliveries to Asia and Europe by another month, as LNG cargo traffic through the Strait of Hormuz remains largely blocked.'
    ),
    false
  );
});

// --- Plant-based hyphen normalization ---

test('isRelevantToOilFatsScope: "plant-based" (regular hyphen) is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('A plant-based gut-health push', 'The company focuses on plant-based nutrition.'),
    true
  );
});

test('isRelevantToOilFatsScope: "plant‑based" (non-breaking hyphen, U+2011) is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Gut feeling: Biomel’s UK plant‑based gut‑health push', null),
    true
  );
});
