const test = require('node:test');
const assert = require('node:assert/strict');
const { isRelevantToOilFatsScope } = require('../server/lib/relevanceFilter');

// ---------------------------------------------------------------------
// Scope 1: Logistics & Shipping Market
// ---------------------------------------------------------------------

test('Scope 1: tanker freight rates rise → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Tanker freight rates rise on tight vessel supply', null),
    true
  );
});

test('Scope 1: Suez Canal transit conditions change → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Suez Canal transit conditions ease as traffic resumes', null),
    true
  );
});

test('Scope 1: Panama Canal capacity changes → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Panama Canal Adds Transit Capacity as Rainfall Brings Relief',
      'The Panama Canal Authority announced it is easing draft and daily transit restrictions after increased rainfall.'
    ),
    true
  );
});

test('Scope 1: major shipping-route disruption → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Iran Says Won’t Soften Demands As Trump Rejects Hormuz Offer',
      'Iran stuck to its seven-day proposal for reopening the crucial Strait of Hormuz to oil tanker traffic.'
    ),
    true
  );
});

test('Scope 1: negative — trucking software', () => {
  assert.equal(
    isRelevantToOilFatsScope('AI software for truck dispatch cuts delivery times', null),
    false
  );
});

test('Scope 1: negative — warehouse automation', () => {
  assert.equal(
    isRelevantToOilFatsScope('Warehouse automation startup raises funding round', null),
    false
  );
});

test('Scope 1: negative — generic port technology', () => {
  assert.equal(
    isRelevantToOilFatsScope('Port installs new container-tracking technology platform', null),
    false
  );
});

test('Scope 1: negative — freight-cost story whose primary subject is a competing commodity (LNG) stays irrelevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('High Freight Costs Push More U.S. LNG Toward Europe', null),
    false
  );
});

test('Scope 1: oil/fuel freight-cost story is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('High Shipping Costs Push More U.S. Crude Oil Toward Europe', null),
    true
  );
});

test('Scope 1: existing non-competing freight-market case is unchanged', () => {
  assert.equal(
    isRelevantToOilFatsScope('Tanker freight rates rise on tight vessel supply', null),
    true
  );
});

test('Scope 1: negative — tugboat order with no broader shipping-market significance', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'The Great Lakes Towing Company Orders Two New Damen Tugs from Great Lakes Shipyard',
      'Hulls 11 and 12 will continue the company’s fleet renewal and expansion program.'
    ),
    false
  );
});

// ---------------------------------------------------------------------
// Scope 2: Crude Oil & Energy Markets
// ---------------------------------------------------------------------

test('Scope 2: Brent crude price shock → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Brent crude rises sharply due to supply disruption', null),
    true
  );
});

test('Scope 2: OPEC production change → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('OPEC agrees to cut output amid weak demand', null),
    true
  );
});

test('Scope 2: diesel supply/export restriction → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Why Blocking U.S. Diesel Exports Could Make Fuel More Expensive',
      'Talk of a possible ban on U.S. exports of diesel fuel to curb soaring prices at the pump could end up pushing all fuel prices higher.'
    ),
    true
  );
});

test('Scope 2: strategic petroleum reserve change → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'U.S. Strategic Petroleum Reserve Falls to Lowest Level Since 1982',
      'Crude stocks in the U.S. Strategic Petroleum Reserve stood at 284.6 million barrels for the week ending September 18.'
    ),
    true
  );
});

test('Scope 2: negative — unrelated electricity market news', () => {
  assert.equal(
    isRelevantToOilFatsScope('Electricity demand rises in Texas amid summer heat wave', null),
    false
  );
});

test('Scope 2: negative — unrelated natural gas news', () => {
  assert.equal(
    isRelevantToOilFatsScope('Natural gas company announces unrelated drilling project', null),
    false
  );
});

test('Scope 2: negative — generic "oil" wording with no relevant context', () => {
  assert.equal(
    isRelevantToOilFatsScope('Mechanic recommends synthetic motor oil for winter driving', null),
    false
  );
});

// ---------------------------------------------------------------------
// Scope 3: Regulations & Policies Affecting Edible and Industrial Oils
// ---------------------------------------------------------------------

test('Scope 3: palm-oil export levy → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Indonesia raises palm oil export levy', 'The government increased the tax on crude palm oil shipments.'),
    true
  );
});

test('Scope 3: EU biofuel/SAF feedstock regulation → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('EU changes biofuel feedstock sustainability rules', null),
    true
  );
});

test('Scope 3: vegetable-oil import tariff → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('New import tariff imposed on vegetable oil shipments', null),
    true
  );
});

test('Scope 3: sustainability/traceability regulation affecting oil/fat supply → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('New traceability requirements imposed on palm oil supply chains', null),
    true
  );
});

test('Scope 3: negative — general election news with no oil/fat policy connection', () => {
  assert.equal(
    isRelevantToOilFatsScope('General election news with no oil/fat policy connection', 'Voters head to the polls in a closely watched national election.'),
    false
  );
});

test('Scope 3: negative — general environmental regulation unrelated to oils/fats', () => {
  assert.equal(
    isRelevantToOilFatsScope('New emissions rules target coal power plants', null),
    false
  );
});

// ---------------------------------------------------------------------
// Scope 4: Major Global Edible/Industrial Oil Companies
// ---------------------------------------------------------------------

test('Scope 4: ADM capacity investment → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('ADM invests in new soybean processing capacity', null),
    true
  );
});

test('Scope 4: Cargill/Wilmar/Bunge major partnership → relevant', () => {
  assert.equal(isRelevantToOilFatsScope('Cargill expands palm-oil sourcing partnership', null), true);
  assert.equal(isRelevantToOilFatsScope('Wilmar and Bunge announce joint venture', null), true);
});

test('Scope 4: major edible-oil refinery expansion → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Wilmar builds a new edible-oil refinery in Indonesia', null),
    true
  );
});

test('Scope 4: major oilseed processing investment → relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Bunge announces capital expenditure for new crushing facility', null),
    true
  );
});

test('Scope 4: negative — unrelated corporate announcement', () => {
  assert.equal(
    isRelevantToOilFatsScope('A logistics software company appoints a new CEO', null),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope('An unrelated FMCG company changes its board', null),
    false
  );
});

test('Scope 4: negative — mention of a major company with no material development context', () => {
  assert.equal(
    isRelevantToOilFatsScope('Cargill employee wins local marathon', null),
    false
  );
});

// ---------------------------------------------------------------------
// Cross-cutting negatives
// ---------------------------------------------------------------------

test('Cross-cutting: generic geopolitical news stays excluded', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'U.S. and Iran Set to Hold Separate Talks With Mediators on Monday or Tuesday',
      'Qatari mediators are likely to hold separate talks with Iranian Foreign Minister Abbas Araqchi in New York.'
    ),
    false
  );
});

test('Cross-cutting: military incident with no economic/oil/shipping transmission stays excluded', () => {
  assert.equal(
    isRelevantToOilFatsScope('Local militia clashes reported near border checkpoint', null),
    false
  );
});

test('Cross-cutting: other commodities (iron ore, coal) stay excluded', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Coal Prices Hold Firm at High Levels as LNG Costs Rise',
      'Provincial spot power markets showed increasingly divergent trends amid high coal and LNG costs.'
    ),
    false
  );
});

test('Cross-cutting: matches against description even when the title is generic', () => {
  assert.equal(
    isRelevantToOilFatsScope('Company announces quarterly results', 'Growth was driven by higher palm oil sales volumes.'),
    true
  );
});

test('Cross-cutting: matches Korean sector names directly', () => {
  assert.equal(isRelevantToOilFatsScope('팜유 가격 상승', null), true);
  assert.equal(isRelevantToOilFatsScope('중앙은행 금리 인상 발표', null), false);
});

// ---------------------------------------------------------------------
// Preserved chokepoint/plant-based regressions
// ---------------------------------------------------------------------

test('Chokepoint: Hormuz article without explicit oil/crude/tanker wording is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Iran Says Won’t Soften Demands As Trump Rejects Hormuz Offer',
      'Iran stuck to its seven-day proposal for reopening the crucial Strait of Hormuz, saying it won’t soften its conditions.'
    ),
    true
  );
});

test('Chokepoint: Hormuz article with LNG as the primary subject stays irrelevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Qatar Extends LNG Force Majeure as Hormuz Crisis Drags On',
      'QatarEnergy has extended the force majeure on LNG deliveries to Asia and Europe by another month, as LNG cargo traffic through the Strait of Hormuz remains largely blocked.'
    ),
    false
  );
});

test('Chokepoint: Suez article without explicit oil wording is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Suez return speeds up Savannah India service by 10-14 days',
      'Two major liners are returning India-Savannah services to the Suez Canal, cutting transit times by up to 14 days.'
    ),
    true
  );
});

test('Chokepoint: Panama Canal article without explicit oil wording is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope(
      'Panama Canal Adds Transit Capacity as Rainfall Brings Relief',
      'The Panama Canal Authority announced it is easing draft and daily transit restrictions after increased rainfall.'
    ),
    true
  );
});

test('Plant-based: "plant-based" (regular hyphen) is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('A plant-based gut-health push', 'The company focuses on plant-based nutrition.'),
    true
  );
});

test('Plant-based: "plant‑based" (non-breaking hyphen, U+2011) is relevant', () => {
  assert.equal(
    isRelevantToOilFatsScope('Gut feeling: Biomel’s UK plant‑based gut‑health push', null),
    true
  );
});
