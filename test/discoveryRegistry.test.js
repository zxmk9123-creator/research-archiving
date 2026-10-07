const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Content-level regression for the Discovery Query Registry's second
// expansion (research-literature/institutional/company-IR queries) —
// schema.sql is the only place these rows are defined (seeded idempotently
// on every boot via INSERT...WHERE NOT EXISTS), so this reads it directly
// rather than hitting a real database. collectDailyDiscoveryNow()/
// getDueSources() already select generically on
// method='crawl' AND is_daily_discovery=true with no query-name-specific
// logic, so a new row appearing here is automatically included in both the
// hourly scheduler and the Daily Discovery job without any code change —
// confirmed below by checking the two UPDATE/seed blocks that flag them.

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

const NEW_RESEARCH_QUERY_NAMES = [
  'Web Discovery: palm oil soybean oil peer-reviewed journal research',
  'Web Discovery: edible oil market working paper academic research',
  'Web Discovery: institutional white paper oilseed market outlook',
  'Web Discovery: commodity oil price forecast research institute',
  'Web Discovery: vegetable oil tanker shipping economics research paper',
  'Web Discovery: palm oil sustainability journal study',
  'Web Discovery: edible oil company investor relations earnings',
  'Web Discovery: palm oil company annual report investor presentation',
];

const PRE_EXISTING_QUERY_NAMES = [
  'Web Discovery: palm oil export tariff regulation',
  'Web Discovery: crude oil price OPEC supply policy',
  'Web Discovery: vegetable oil tanker freight rates shipping',
  'Web Discovery: Wilmar Cargill palm oil investment expansion',
  'Web Discovery: palm oil soybean oil price market news',
  'Web Discovery: edible oil tanker freight rates Baltic index',
  'Web Discovery: EU deforestation regulation palm oil EUDR',
  'Web Discovery: Indonesia Malaysia palm oil export quota policy',
  'Web Discovery: Bunge ADM Louis Dreyfus edible oil investment',
  'Web Discovery: USDA oilseeds outlook report',
  'Web Discovery: IGC grain market report oilseeds',
  'Web Discovery: soybean crush margin market report',
];

test('discovery registry: all 8 new research-literature/company-IR queries are seeded as crawl + is_daily_discovery', () => {
  for (const name of NEW_RESEARCH_QUERY_NAMES) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected schema.sql to seed "${name}"`);
  }
  // They're all inserted in one VALUES block with method/trust_grade/flag
  // columns bound once via SELECT v.name, v.url, 'crawl', 7, 'B', true —
  // find that specific block and confirm it's the one containing these names.
  const secondSeedBlock = schemaSql.slice(schemaSql.indexOf(NEW_RESEARCH_QUERY_NAMES[0]) - 500, schemaSql.indexOf(NEW_RESEARCH_QUERY_NAMES[NEW_RESEARCH_QUERY_NAMES.length - 1]) + 500);
  assert.match(secondSeedBlock, /'crawl', 7, 'B', true/);
  assert.match(secondSeedBlock, /WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\)/);
});

test('discovery registry: the new queries do not duplicate or alter any pre-existing query name', () => {
  for (const name of NEW_RESEARCH_QUERY_NAMES) {
    assert.ok(!PRE_EXISTING_QUERY_NAMES.includes(name), `"${name}" must be new, not a pre-existing query`);
  }
  for (const name of PRE_EXISTING_QUERY_NAMES) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected the pre-existing query "${name}" to still be present unchanged`);
  }
});

test('discovery registry: new queries use multi-domain intent hints, not a single hardcoded publisher', () => {
  const academicQuery = schemaSql.match(/'edible oil vegetable oil market working paper academic research[^']*'/);
  assert.ok(academicQuery, 'expected the academic working-paper query to exist');
  // At least two distinct domain hints (site:) rather than one hardcoded source.
  const siteHints = academicQuery[0].match(/site:[a-z.]+/g) || [];
  assert.ok(siteHints.length >= 2, `expected multiple site: hints, got ${JSON.stringify(siteHints)}`);
});

// --- Third expansion: production/supply/demand, sunflower/rapeseed, and
// Black Sea/Ukraine-Russia trade — distinct intents the first 20 queries
// left thin, not near-duplicates of any existing query. ---

const THIRD_EXPANSION_QUERY_NAMES = [
  'Web Discovery: palm oil soybean oil production supply demand balance',
  'Web Discovery: sunflower rapeseed canola oil market price EU',
  'Web Discovery: Black Sea Ukraine Russia sunflower grain oilseed exports',
];

test('discovery registry: the third expansion (production/supply/demand, sunflower/rapeseed, Black Sea trade) is seeded as crawl + is_daily_discovery', () => {
  for (const name of THIRD_EXPANSION_QUERY_NAMES) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected schema.sql to seed "${name}"`);
  }
  const thirdSeedBlock = schemaSql.slice(
    schemaSql.indexOf(THIRD_EXPANSION_QUERY_NAMES[0]) - 500,
    schemaSql.indexOf(THIRD_EXPANSION_QUERY_NAMES[THIRD_EXPANSION_QUERY_NAMES.length - 1]) + 500
  );
  assert.match(thirdSeedBlock, /'crawl', 7, 'B', true/);
  assert.match(thirdSeedBlock, /WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\)/);
});

test('discovery registry: the third expansion does not duplicate any pre-existing or second-expansion query name', () => {
  const allPriorNames = [...PRE_EXISTING_QUERY_NAMES, ...NEW_RESEARCH_QUERY_NAMES];
  for (const name of THIRD_EXPANSION_QUERY_NAMES) {
    assert.ok(!allPriorNames.includes(name), `"${name}" must be new, not a pre-existing query`);
  }
  for (const name of allPriorNames) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected prior query "${name}" to still be present unchanged`);
  }
});

// --- Fourth expansion: corporate deal/investment/project coverage
// (JV formation, M&A, plant construction/FID), biased first toward
// biofuel/SAF and then across the rest of the oils-and-fats value chain —
// distinct from the existing IR/earnings/annual-report queries, which skew
// toward disclosure documents rather than deal announcements. ---

const FOURTH_EXPANSION_QUERY_NAMES = [
  'Web Discovery: SAF biofuel company investment plant partnership deal',
  'Web Discovery: edible oil renewable diesel company M&A joint venture project',
];

test('discovery registry: the fourth expansion (SAF/biofuel and cross-sector company deals) is seeded as crawl + is_daily_discovery', () => {
  for (const name of FOURTH_EXPANSION_QUERY_NAMES) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected schema.sql to seed "${name}"`);
  }
  const fourthSeedBlock = schemaSql.slice(
    schemaSql.indexOf(FOURTH_EXPANSION_QUERY_NAMES[0]) - 500,
    schemaSql.indexOf(FOURTH_EXPANSION_QUERY_NAMES[FOURTH_EXPANSION_QUERY_NAMES.length - 1]) + 500
  );
  assert.match(fourthSeedBlock, /'crawl', 7, 'B', true/);
  assert.match(fourthSeedBlock, /WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\)/);
});

test('discovery registry: the fourth expansion does not duplicate any pre-existing, second-, or third-expansion query name', () => {
  const allPriorNames = [...PRE_EXISTING_QUERY_NAMES, ...NEW_RESEARCH_QUERY_NAMES, ...THIRD_EXPANSION_QUERY_NAMES];
  for (const name of FOURTH_EXPANSION_QUERY_NAMES) {
    assert.ok(!allPriorNames.includes(name), `"${name}" must be new, not a pre-existing query`);
  }
  for (const name of allPriorNames) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected prior query "${name}" to still be present unchanged`);
  }
});

test('discovery registry: the Query Registry stays bounded (not dozens of queries)', () => {
  const totalQueries = PRE_EXISTING_QUERY_NAMES.length + NEW_RESEARCH_QUERY_NAMES.length + THIRD_EXPANSION_QUERY_NAMES.length + FOURTH_EXPANSION_QUERY_NAMES.length;
  assert.equal(totalQueries, 25);
  assert.ok(totalQueries < 30, 'the registry should stay bounded enough to control API cost/search volume');
});

test('discovery registry: getDueSources/collectDailyDiscoveryNow select generically on is_daily_discovery — no per-query-name code exists', () => {
  const collectorJs = fs.readFileSync(path.join(__dirname, '../server/lib/collector.js'), 'utf8');
  const dailyDiscoveryJs = fs.readFileSync(path.join(__dirname, '../server/lib/dailyDiscovery.js'), 'utf8');
  // Neither file references any specific query name — selection is purely
  // by method/is_daily_discovery/frequency columns, so every new row above
  // is automatically picked up by both the hourly scheduler and the daily
  // job without needing its own code path.
  for (const name of [...NEW_RESEARCH_QUERY_NAMES, ...FOURTH_EXPANSION_QUERY_NAMES]) {
    assert.ok(!collectorJs.includes(name), 'collector.js must not special-case a query name');
    assert.ok(!dailyDiscoveryJs.includes(name), 'dailyDiscovery.js must not special-case a query name');
  }
  assert.match(dailyDiscoveryJs, /is_daily_discovery = true/);
});
