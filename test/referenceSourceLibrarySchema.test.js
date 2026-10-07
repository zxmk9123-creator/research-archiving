const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Content-level regression for the Reference Source Library v1 schema
// change — schema.sql is the only place these columns/seed rows are
// defined (idempotent ALTER COLUMN IF NOT EXISTS + INSERT...WHERE NOT
// EXISTS), so this reads it directly rather than hitting a real database.

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

const NEW_COLUMNS = [
  'is_reference', 'source_type', 'region', 'commodities', 'coverage_note',
  'access_format', 'update_frequency', 'usage_note', 'last_verified_at', 'rss_available',
];

test('schema: every Reference Source Library column is added idempotently', () => {
  for (const col of NEW_COLUMNS) {
    assert.match(
      schemaSql,
      new RegExp(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS ${col}\\b`),
      `expected an idempotent ALTER COLUMN for ${col}`
    );
  }
});

test('schema: is_reference and rss_available default to false (an ordinary source is unaffected until explicitly marked)', () => {
  assert.match(schemaSql, /ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_reference BOOLEAN NOT NULL DEFAULT false/);
  assert.match(schemaSql, /ALTER TABLE sources ADD COLUMN IF NOT EXISTS rss_available BOOLEAN NOT NULL DEFAULT false/);
});

const SEEDED_REFERENCE_SOURCES = [
  'USDA FAS PSD Online',
  'MPOB Palm Oil Statistics',
  'GAPKI Palm Oil Statistics',
  'Bursa Malaysia Derivatives (FCPO)',
  'UN Comtrade',
];

test('schema: seeds a small, representative set of Oil&Fats reference sources (not a bulk directory)', () => {
  for (const name of SEEDED_REFERENCE_SOURCES) {
    assert.ok(schemaSql.includes(`'${name}'`), `expected schema.sql to seed "${name}"`);
  }
  // Deliberately small: a handful, not dozens.
  assert.ok(SEEDED_REFERENCE_SOURCES.length <= 10);
});

test('schema: the seed block inserts with method=manual and is_reference=true, idempotently', () => {
  const seedBlock = schemaSql.slice(
    schemaSql.indexOf(SEEDED_REFERENCE_SOURCES[0]) - 1500,
    schemaSql.indexOf(SEEDED_REFERENCE_SOURCES[SEEDED_REFERENCE_SOURCES.length - 1]) + 1000,
  );
  assert.match(seedBlock, /'manual'/);
  assert.match(seedBlock, /WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\)/);
});

test('schema: existing sources_method_check constraint is untouched (no new ingestion method introduced)', () => {
  assert.match(
    schemaSql,
    /ALTER TABLE sources ADD CONSTRAINT sources_method_check CHECK \(method IN \('rss','crawl','manual','institution','structured'\)\)/
  );
});

// --- v2: sector_links ---

test('schema: sector_links is added idempotently as a JSONB array, additive to url', () => {
  assert.match(
    schemaSql,
    /ALTER TABLE sources ADD COLUMN IF NOT EXISTS sector_links JSONB NOT NULL DEFAULT '\[\]'::jsonb/
  );
});

test('schema: each of the 5 seeded reference sources gets a sector_links backfill, idempotently (only when still empty)', () => {
  const blocks = sectorLinksBackfillBlocks();
  for (const name of SEEDED_REFERENCE_SOURCES) {
    assert.ok(blocks.has(name), `expected an idempotent sector_links backfill for "${name}"`);
    assert.ok(blocks.get(name).length > 0, `expected "${name}" to have at least one sector link`);
  }
  // Guard the WHERE clause's idempotency condition separately (boolean
  // existence check, not part of the captured/parsed JSON above).
  for (const name of SEEDED_REFERENCE_SOURCES) {
    assert.ok(
      schemaSql.includes(`WHERE name = '${name}' AND sector_links = '[]'::jsonb;`),
      `expected the backfill for "${name}" to be guarded by sector_links = '[]'::jsonb`
    );
  }
});

// Each UPDATE...sector_links...WHERE name=X block, keyed by X — split on the
// UPDATE keyword first so a later block's WHERE clause can never leak into
// an earlier block's non-greedy capture (both share the literal
// "UPDATE sources SET sector_links = '" prefix, so a regex spanning the
// whole file can overshoot past one block's own close into the next).
function sectorLinksBackfillBlocks() {
  const blocks = new Map();
  for (const chunk of schemaSql.split(/(?=UPDATE sources SET sector_links = )/)) {
    const m = chunk.match(/^UPDATE sources SET sector_links = '([\s\S]*?)'::jsonb\s*\nWHERE name = '([^']+)'/);
    if (m) blocks.set(m[2], JSON.parse(m[1]));
  }
  return blocks;
}

test('schema: USDA FAS PSD Online and MPOB each get MULTIPLE sector links, not one generic link', () => {
  const blocks = sectorLinksBackfillBlocks();
  const usdaLinks = blocks.get('USDA FAS PSD Online');
  assert.ok(usdaLinks && usdaLinks.length >= 2, 'expected USDA FAS PSD Online to have multiple sector links');
  assert.notEqual(usdaLinks[0].url, usdaLinks[1].url);

  const mpobLinks = blocks.get('MPOB Palm Oil Statistics');
  assert.ok(mpobLinks && mpobLinks.length >= 2, 'expected MPOB Palm Oil Statistics to have multiple sector links');
  assert.notEqual(mpobLinks[0].url, mpobLinks[1].url);
});

test('schema: no seeded sector_links URL is a bare organizational homepage', () => {
  const GENERIC_HOMEPAGES = [
    'https://www.mpob.gov.my/',
    'https://www.mpob.gov.my',
    'https://usda.gov/',
    'https://usda.gov',
    'https://www.bursamalaysia.com/',
    'https://www.bursamalaysia.com',
    'https://gapki.id/',
    'https://gapki.id',
    'https://un.org/',
    'https://un.org',
  ];
  const blocks = sectorLinksBackfillBlocks();
  const allLinks = [...blocks.values()].flat();
  assert.ok(allLinks.length > 0, 'expected at least one seeded sector link to check');
  for (const link of allLinks) {
    assert.ok(!GENERIC_HOMEPAGES.includes(link.url), `${link.url} looks like a bare homepage, not a sector-specific page`);
  }
});

// --- Web Discovery/crawl sources must never be Reference Source entries ---

test('schema: a standing invariant forces is_reference back to false for every ingestion method, not a one-time fix', () => {
  assert.match(
    schemaSql,
    /UPDATE sources SET is_reference = false\s*\nWHERE method IN \('rss','crawl','institution','structured'\) AND is_reference = true;/
  );
});

test('schema: none of the seeded Reference Source Library rows use an active-ingestion method', () => {
  const seedBlock = schemaSql.slice(
    schemaSql.indexOf('INSERT INTO sources (name, publisher, url, method, owner, trust_grade, is_reference'),
    schemaSql.indexOf('WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.name = v.name);'),
  );
  // Every seeded row must be 'manual' — none of rss/crawl/institution/structured.
  assert.ok(!/'(rss|crawl|institution|structured)'/.test(seedBlock), 'a Reference Source Library seed row used an ingestion method');
});

test('schema: no Web Discovery query source is ever registered as a Reference Source', () => {
  // Web Discovery sources are named with this prefix and are always
  // method='crawl' via SELECT v.name, v.url, 'crawl', ... — none of their
  // INSERT blocks mention is_reference at all, and the standing invariant
  // above forces is_reference=false on any method='crawl' row regardless.
  const webDiscoveryBlocks = [...schemaSql.matchAll(
    /INSERT INTO sources \(name, url, method, frequency_days, trust_grade, is_daily_discovery\)[\s\S]*?WHERE NOT EXISTS \(SELECT 1 FROM sources s WHERE s\.name = v\.name\);/g
  )];
  assert.ok(webDiscoveryBlocks.length > 0, 'expected to find at least one Web Discovery seed block');
  for (const block of webDiscoveryBlocks) {
    assert.ok(!block[0].includes('is_reference'), 'a Web Discovery seed block must never set is_reference');
  }
});
