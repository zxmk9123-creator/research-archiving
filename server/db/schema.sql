-- Research Archiving Platform — MVP schema
-- 3 core tables (Source / Item / Pick) + supporting taxonomy + company watchlist.

CREATE TABLE IF NOT EXISTS sectors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES sectors(id) ON DELETE CASCADE,
  UNIQUE (name, parent_id)
);

CREATE TABLE IF NOT EXISTS usages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sources (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  publisher TEXT,
  url TEXT,
  method TEXT CHECK (method IN ('rss','crawl','manual')) DEFAULT 'manual',
  frequency_days INTEGER DEFAULT 1,
  owner TEXT,
  trust_grade CHAR(1) CHECK (trust_grade IN ('A','B','C')) DEFAULT 'A',
  last_collected_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- Watchlist companies: items whose title/summary mention these are auto-tagged.
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  aliases TEXT[] DEFAULT '{}',
  watched BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  pdf_url TEXT,
  published_at DATE,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  type TEXT CHECK (type IN ('뉴스','보고서','통계','규제')) NOT NULL,
  summary TEXT,
  insight TEXT,
  attribution TEXT,
  thumbnail_url TEXT,
  status TEXT CHECK (status IN ('Draft','Published','Archived')) DEFAULT 'Draft',
  collected_at TIMESTAMPTZ DEFAULT now()
);

-- AI draft layer: suggestions only, kept in their own columns so they can
-- never silently overwrite reviewer-confirmed summary/insight/tags. A
-- reviewer must explicitly apply a suggestion (client-side copy) before it
-- becomes part of the canonical record.
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_status TEXT CHECK (ai_status IN ('not_requested','pending','completed','failed')) DEFAULT 'not_requested';
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_key_takeaway TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_suggested_sectors INTEGER[] DEFAULT '{}';
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_suggested_usages INTEGER[] DEFAULT '{}';
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_error TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMPTZ;

-- Archive-eligibility recommendation: advisory only, same suggestion-layer
-- convention as the rest of ai_* — never auto-applied to status. NULL means
-- no recommendation yet (e.g. ai_status is not 'completed').
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_eligible BOOLEAN;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_eligibility_reason TEXT;

-- ai_summary stays strictly factual (see aiDraft.js); ai_insight is a
-- separate, explicitly-inferential field (implications/trends/points to
-- monitor) so a reader never has to guess which sentences are stated fact
-- vs. the model's reasoning. Advisory only, same suggestion-layer
-- convention as the rest of ai_*.
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_insight TEXT;

-- Reviewer's own eligibility call — deliberately a separate column from
-- ai_eligible, never overwritten by AI generation/regeneration, so it
-- survives across "다시 생성" retries and lets us compare AI vs. human
-- judgment later (e.g. to decide if auto-archiving is ever safe). NULL
-- means the reviewer hasn't confirmed or overridden a verdict yet.
ALTER TABLE items ADD COLUMN IF NOT EXISTS reviewer_eligible BOOLEAN;

CREATE TABLE IF NOT EXISTS item_sectors (
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  sector_id INTEGER REFERENCES sectors(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, sector_id)
);

CREATE TABLE IF NOT EXISTS item_usages (
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  usage_id INTEGER REFERENCES usages(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, usage_id)
);

CREATE TABLE IF NOT EXISTS item_companies (
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, company_id)
);

CREATE TABLE IF NOT EXISTS picks (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  user_email TEXT,
  kind TEXT CHECK (kind IN ('personal','team')) DEFAULT 'personal',
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at);

-- Root-level dedup guard: UNIQUE(name, parent_id) does NOT stop duplicate
-- roots, because Postgres treats every NULL in a unique key as distinct from
-- every other NULL. Since db:init runs on every deploy (see package.json
-- "start"), the old seed below re-inserted '식용유지'/'비식용유지' on each
-- boot, and each duplicate root then multiplied its children via the CROSS
-- JOIN subquery matching more than one row. Fix root cause at the data layer:
--
-- 1) merge any duplicates that already exist (idempotent, no-op once clean)
-- 2) add a partial unique index so root names can never duplicate again

-- Phase 1: merge duplicate ROOT sectors (parent_id IS NULL) by name into the
-- lowest id. Children are re-parented ONE AT A TIME (not a bulk UPDATE):
-- moving two rows named "UCO" under the same parent in one statement would
-- itself violate UNIQUE(name, parent_id) mid-statement, since Postgres checks
-- it per row, not at statement end. A child that collides with an existing
-- child of the canonical root is itself a duplicate and gets merged instead.
DO $$
DECLARE
  dup RECORD;
  child RECORD;
  existing_id INTEGER;
BEGIN
  FOR dup IN
    SELECT name, MIN(id) AS canonical_id, array_agg(id ORDER BY id) AS ids
    FROM sectors WHERE parent_id IS NULL
    GROUP BY name HAVING COUNT(*) > 1
  LOOP
    UPDATE item_sectors SET sector_id = dup.canonical_id
    WHERE sector_id = ANY(dup.ids) AND sector_id <> dup.canonical_id
      AND NOT EXISTS (SELECT 1 FROM item_sectors x WHERE x.item_id = item_sectors.item_id AND x.sector_id = dup.canonical_id);
    DELETE FROM item_sectors WHERE sector_id = ANY(dup.ids) AND sector_id <> dup.canonical_id;

    FOR child IN
      SELECT id, name FROM sectors WHERE parent_id = ANY(dup.ids) AND parent_id <> dup.canonical_id
    LOOP
      SELECT id INTO existing_id FROM sectors WHERE parent_id = dup.canonical_id AND name = child.name AND id <> child.id;
      IF existing_id IS NULL THEN
        UPDATE sectors SET parent_id = dup.canonical_id WHERE id = child.id;
      ELSE
        UPDATE item_sectors SET sector_id = existing_id
        WHERE sector_id = child.id
          AND NOT EXISTS (SELECT 1 FROM item_sectors x WHERE x.item_id = item_sectors.item_id AND x.sector_id = existing_id);
        DELETE FROM item_sectors WHERE sector_id = child.id;
        DELETE FROM sectors WHERE id = child.id;
      END IF;
    END LOOP;

    DELETE FROM sectors WHERE id = ANY(dup.ids) AND id <> dup.canonical_id;
  END LOOP;
END $$;

-- Phase 2: merge any remaining duplicate CHILD sectors (same name, same
-- non-null parent) — pre-existing corruption independent of root duplication.
-- Same per-row approach for any grandchildren these nodes might have.
DO $$
DECLARE
  dup RECORD;
  child RECORD;
  existing_id INTEGER;
BEGIN
  FOR dup IN
    SELECT name, parent_id, MIN(id) AS canonical_id, array_agg(id ORDER BY id) AS ids
    FROM sectors WHERE parent_id IS NOT NULL
    GROUP BY name, parent_id HAVING COUNT(*) > 1
  LOOP
    UPDATE item_sectors SET sector_id = dup.canonical_id
    WHERE sector_id = ANY(dup.ids) AND sector_id <> dup.canonical_id
      AND NOT EXISTS (SELECT 1 FROM item_sectors x WHERE x.item_id = item_sectors.item_id AND x.sector_id = dup.canonical_id);
    DELETE FROM item_sectors WHERE sector_id = ANY(dup.ids) AND sector_id <> dup.canonical_id;

    FOR child IN
      SELECT id, name FROM sectors WHERE parent_id = ANY(dup.ids) AND parent_id <> dup.canonical_id
    LOOP
      SELECT id INTO existing_id FROM sectors WHERE parent_id = dup.canonical_id AND name = child.name AND id <> child.id;
      IF existing_id IS NULL THEN
        UPDATE sectors SET parent_id = dup.canonical_id WHERE id = child.id;
      ELSE
        UPDATE item_sectors SET sector_id = existing_id
        WHERE sector_id = child.id
          AND NOT EXISTS (SELECT 1 FROM item_sectors x WHERE x.item_id = item_sectors.item_id AND x.sector_id = existing_id);
        DELETE FROM item_sectors WHERE sector_id = child.id;
        DELETE FROM sectors WHERE id = child.id;
      END IF;
    END LOOP;

    DELETE FROM sectors WHERE id = ANY(dup.ids) AND id <> dup.canonical_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sectors_root_name_uidx ON sectors(name) WHERE parent_id IS NULL;

-- Seed: MECE sector tree (2 levels)
INSERT INTO sectors (name, parent_id) VALUES ('식용유지', NULL) ON CONFLICT DO NOTHING;
INSERT INTO sectors (name, parent_id) VALUES ('비식용유지', NULL) ON CONFLICT DO NOTHING;

INSERT INTO sectors (name, parent_id)
SELECT v.name, p.id FROM (VALUES ('팜유'),('대두유'),('유채씨유'),('해바라기유'),('기타 식용유지')) AS v(name)
CROSS JOIN (SELECT id FROM sectors WHERE name='식용유지' AND parent_id IS NULL ORDER BY id LIMIT 1) p
ON CONFLICT DO NOTHING;

INSERT INTO sectors (name, parent_id)
SELECT v.name, p.id FROM (VALUES ('UCO'),('UCOME'),('SAF'),('Tallow'),('FAME'),('기타 비식용유지')) AS v(name)
CROSS JOIN (SELECT id FROM sectors WHERE name='비식용유지' AND parent_id IS NULL ORDER BY id LIMIT 1) p
ON CONFLICT DO NOTHING;

-- Seed: flat usage tags
INSERT INTO usages (name) VALUES
  ('NBO 작성'), ('업체 프로파일'), ('시장 전망'), ('가격·물류'), ('규제 대응')
ON CONFLICT DO NOTHING;

-- Seed: minimal E2E test source registry (3 sources) for verifying the
-- production RSS ingestion pipeline end-to-end. This is deliberately NOT
-- the full 10-20 source registry — just enough to prove Source -> collect
-- -> dedup -> Item -> AI draft -> Review works in the real deployment.
-- These feed URLs were NOT pre-verified outside production (the dev
-- sandbox's outbound network is blocked); production's own fetch during
-- collection is the actual verification.
INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'FAO News', 'Food and Agriculture Organization (UN)', 'https://www.fao.org/news/rss-feed/en/', 'rss', 1, 'e2e-test', 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.fao.org/news/rss-feed/en/');

INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'Hellenic Shipping News', 'Hellenic Shipping News', 'https://www.hellenicshippingnews.com/feed/', 'rss', 1, 'e2e-test', 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.hellenicshippingnews.com/feed/');

INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'OilPrice.com', 'OilPrice.com', 'https://oilprice.com/rss/main', 'rss', 1, 'e2e-test', 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://oilprice.com/rss/main');

-- Seed: registry expansion batch 2 (5 sources) — agriculture/commodities,
-- trade/regulation, food/edible oils, shipping/logistics, macro/geopolitics.
-- FAO News excluded (prior batch found it returns 404). As before, these
-- URLs are not pre-verified from this sandbox (outbound network blocked
-- here) — production's own fetch during collection is the verification.
INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'USDA Newsroom', 'U.S. Department of Agriculture', 'https://www.usda.gov/rss/latest-releases.xml', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.usda.gov/rss/latest-releases.xml');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'WTO News', 'World Trade Organization', 'https://www.wto.org/english/news_e/news_e.rss', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.wto.org/english/news_e/news_e.rss');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'IMF News', 'International Monetary Fund', 'https://www.imf.org/en/News/rss?language=eng', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.imf.org/en/News/rss?language=eng');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'FoodNavigator', 'FoodNavigator (William Reed)', 'https://www.foodnavigator.com/rss', 'rss', 1, 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.foodnavigator.com/rss');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'FreightWaves', 'FreightWaves', 'https://www.freightwaves.com/news/feed', 'rss', 1, 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.freightwaves.com/news/feed');

-- Seed: replacement batch for feeds that failed in production (USDA/IMF: 403,
-- FoodNavigator: 404, WTO: fetched 0). Not pre-verified from this sandbox
-- (outbound network blocked here) — production's own fetch is the check.
INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'Reuters Agriculture', 'Reuters', 'https://www.reutersagency.com/feed/?best-sectors=agriculture&post_type=best', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.reutersagency.com/feed/?best-sectors=agriculture&post_type=best');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'European Commission Trade News', 'European Commission', 'https://policy.trade.ec.europa.eu/news_en.rss', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://policy.trade.ec.europa.eu/news_en.rss');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'just-food', 'GlobalData (just-food)', 'https://www.just-food.com/feed/', 'rss', 1, 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.just-food.com/feed/');

-- Seed: registry expansion batch 4 (5 sources) — trade/regulation,
-- shipping/logistics, agriculture/commodities, energy, edible oils/food.
-- Not pre-verified from this sandbox (outbound network blocked here) —
-- production's own fetch during collection is the check.
INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'World Bank News', 'World Bank', 'https://www.worldbank.org/en/news/all.rss', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.worldbank.org/en/news/all.rss');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'gCaptain', 'gCaptain', 'https://gcaptain.com/feed/', 'rss', 1, 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://gcaptain.com/feed/');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'Farm Policy News', 'University of Illinois', 'https://farmpolicynews.illinois.edu/feed/', 'rss', 1, 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://farmpolicynews.illinois.edu/feed/');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'U.S. EIA Today in Energy', 'U.S. Energy Information Administration', 'https://www.eia.gov/rss/todayinenergy.xml', 'rss', 1, 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.eia.gov/rss/todayinenergy.xml');

INSERT INTO sources (name, publisher, url, method, frequency_days, trust_grade)
SELECT 'Food Business News — Edible Oils', 'Sosland Publishing', 'https://www.foodbusinessnews.net/rss/topic/79-edible-oils', 'rss', 1, 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.foodbusinessnews.net/rss/topic/79-edible-oils');
