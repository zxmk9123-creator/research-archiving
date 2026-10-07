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
  method TEXT CHECK (method IN ('rss','crawl','manual','institution')) DEFAULT 'manual',
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

-- Widen method's CHECK to add 'institution' (institutional PDF-report
-- adapter — see server/lib/institutionalIngest.js) and 'structured'
-- (structured statistical/data-series adapter — see
-- server/lib/structuredDataIngest.js) for databases created before these
-- methods existed. CREATE TABLE IF NOT EXISTS above is a no-op on an
-- existing table, so the constraint needs its own idempotent migration;
-- DROP+ADD by Postgres's default constraint name is safe to rerun on
-- every boot (no-op once already widened).
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_method_check;
ALTER TABLE sources ADD CONSTRAINT sources_method_check CHECK (method IN ('rss','crawl','manual','institution','structured'));

-- Daily Discovery Query Registry: a crawl-method source flagged here is
-- run once a day by the separate Daily Discovery job (dailyDiscovery.js),
-- independent of its own frequency_days/last_collected_at due-check used
-- by the existing hourly Research Sources scheduler (collector.js). A
-- source can be in both: the hourly scheduler may also pick it up on its
-- own weekly cadence — harmless, since exact-URL dedup in
-- webDiscoveryIngest.js already prevents re-ingesting the same candidate.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_daily_discovery BOOLEAN DEFAULT false;

-- Reference Source Library v1: catalogs high-value research/data sources
-- (authoritative statistics publishers, specification databases, industry
-- intelligence) that may have no RSS feed and no active ingestion at all,
-- but are still worth recording for human reference. is_reference is a
-- pure cataloging flag, deliberately ORTHOGONAL to `method` — `method`
-- alone still decides active-ingestion eligibility everywhere it already
-- did (collector.js/dailyDiscovery.js's WHERE method IN (...) clauses are
-- unchanged), so a reference source simply keeps method='manual' (already
-- excluded from every ingestion query) exactly like any other manual
-- source today. rss_available separately records whether RSS exists for
-- this source at all, independent of whether ingestion via it is active.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_reference BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS commodities TEXT[] DEFAULT '{}';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS coverage_note TEXT;
-- access_format: any mix of web/PDF/XLSX/CSV/API/RSS a source is actually
-- reachable through — an array since many sources offer more than one
-- (e.g. a dashboard with both a web UI and a CSV export).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS access_format TEXT[] DEFAULT '{}';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS update_frequency TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS usage_note TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_verified_at DATE;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS rss_available BOOLEAN NOT NULL DEFAULT false;

-- Reference Source Library v2: a Reference Source often serves several
-- distinct commodity/sector pages on the same institution's site (e.g. MPOB
-- publishes separate production and export statistics pages) — the single
-- `url` column can only ever point at one. sector_links holds the verified,
-- sector-specific pages as a JSON array of {sector, label, url}, additive
-- to `url` (kept as the source's single general/primary link, used where a
-- plain source-level link is still wanted — e.g. the 전체 Sources table).
-- Deliberately one JSONB column, not a child table: this is the smallest
-- extension of the existing model that still lets the UI render each
-- sector as its own clickable link. commodities (detailed commodity
-- coverage, free-text tags) is untouched — sector_links is for navigation
-- to verified pages, never a substitute for it.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sector_links JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Seed: a small, representative set of high-value Oil&Fats reference
-- sources with no RSS feed — authoritative statistics/report publishers a
-- reviewer should know about even though nothing here is auto-ingested.
-- Deliberately few: this is a starting catalog, not a bulk directory.
INSERT INTO sources (name, publisher, url, method, owner, trust_grade, is_reference, source_type, region, commodities, coverage_note, access_format, update_frequency, usage_note, last_verified_at, rss_available)
SELECT * FROM (VALUES
  ('USDA FAS PSD Online', 'USDA Foreign Agricultural Service', 'https://apps.fas.usda.gov/psdonline/app/index.html#/app/downloads', 'manual', 'reference-library', 'A', true,
   '정부/국제기구 통계', 'Global', ARRAY['팜유','대두유','유채씨유','해바라기유'],
   '세계 유지종자 생산·소비·교역 공식 통계(Production, Supply & Distribution), 국가별/품목별 월간 갱신',
   ARRAY['web','CSV','API'], 'Monthly', 'NBO 작성 시 공급/수요 기초 통계 1차 출처로 사용', '2026-10-01'::date, false),
  ('MPOB Palm Oil Statistics', 'Malaysian Palm Oil Board', 'https://bepi.mpob.gov.my/index.php/en/', 'manual', 'reference-library', 'A', true,
   '업계단체 통계', 'Malaysia', ARRAY['팜유'],
   '말레이시아 팜유 생산·재고·수출 월간 통계, 가격 동향',
   ARRAY['web','XLSX'], 'Monthly', '말레이시아 팜유 공급측 동향 확인용 1차 출처', '2026-10-01'::date, false),
  ('GAPKI Palm Oil Statistics', 'Indonesian Palm Oil Association (GAPKI)', 'https://gapki.id/en/news/category/statistic', 'manual', 'reference-library', 'B', true,
   '업계단체 통계', 'Indonesia', ARRAY['팜유'],
   '인도네시아 팜유 생산·수출 통계 및 산업 동향 보고서',
   ARRAY['web','PDF'], 'Monthly', '인도네시아 팜유 공급측 동향 확인용 보조 출처', '2026-10-01'::date, false),
  ('Bursa Malaysia Derivatives (FCPO)', 'Bursa Malaysia', 'https://www.bursamalaysia.com/trade/trading_resources/derivatives/fcpo', 'manual', 'reference-library', 'A', true,
   '거래소/가격데이터', 'Malaysia', ARRAY['팜유'],
   '팜유 선물(FCPO) 가격·거래량 데이터, 시장 벤치마크',
   ARRAY['web','API'], 'Daily', '팜유 선물가 벤치마크 확인 및 가격·물류 분석 보조 자료', '2026-10-01'::date, false),
  ('UN Comtrade', 'United Nations Statistics Division', 'https://comtradeplus.un.org/', 'manual', 'reference-library', 'A', true,
   '정부/국제기구 통계', 'Global', ARRAY['팜유','대두유','유채씨유','해바라기유'],
   '국가간 품목별 수출입 교역 통계(HS 코드 기준), 연/월 단위',
   ARRAY['web','API','CSV'], 'Monthly', '유지 교역 흐름/무역 통계 교차 검증용', '2026-10-01'::date, false)
) AS v(name, publisher, url, method, owner, trust_grade, is_reference, source_type, region, commodities, coverage_note, access_format, update_frequency, usage_note, last_verified_at, rss_available)
WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.name = v.name);

-- Backfill sector_links on the 5 sources seeded above (idempotent
-- UPDATE-by-name, same pattern as the is_daily_discovery backfill further
-- down) — each link is a verified page on the institution's own site
-- covering that specific commodity/statistics category, never the bare
-- organizational homepage.
UPDATE sources SET sector_links = '[
  {"sector": "유지종자(팜유·대두유 등) 공급·수요 데이터", "label": "PSD Online — 조회/다운로드", "url": "https://apps.fas.usda.gov/psdonline/app/index.html#/app/advQuery"},
  {"sector": "유지종자 시장 보고서", "label": "Oilseeds: World Markets and Trade", "url": "https://fas.usda.gov/data/oilseeds-world-markets-and-trade"}
]'::jsonb
WHERE name = 'USDA FAS PSD Online' AND sector_links = '[]'::jsonb;

UPDATE sources SET sector_links = '[
  {"sector": "팜유 생산 통계", "label": "Monthly Production Statistics", "url": "https://bepi.mpob.gov.my/index.php/en/statistics/production.html"},
  {"sector": "팜유 수출 통계", "label": "Monthly Export Statistics", "url": "https://bepi.mpob.gov.my/index.php/en/statistics/export.html"}
]'::jsonb
WHERE name = 'MPOB Palm Oil Statistics' AND sector_links = '[]'::jsonb;

UPDATE sources SET sector_links = '[
  {"sector": "팜유 생산·수출 통계", "label": "GAPKI Statistic", "url": "https://gapki.id/en/news/category/statistic"}
]'::jsonb
WHERE name = 'GAPKI Palm Oil Statistics' AND sector_links = '[]'::jsonb;

UPDATE sources SET sector_links = '[
  {"sector": "팜유 선물(FCPO) 가격·계약 명세", "label": "FCPO Trading Resources", "url": "https://www.bursamalaysia.com/trade/trading_resources/derivatives/fcpo"}
]'::jsonb
WHERE name = 'Bursa Malaysia Derivatives (FCPO)' AND sector_links = '[]'::jsonb;

UPDATE sources SET sector_links = '[
  {"sector": "유지종자·식물성유 교역 통계(HS 1507-1518)", "label": "Comtrade Plus 조회", "url": "https://comtradeplus.un.org/"}
]'::jsonb
WHERE name = 'UN Comtrade' AND sector_links = '[]'::jsonb;

-- Standing invariant, not a one-time cleanup: a source used for automated
-- RSS/Web Discovery/institutional/structured ingestion is an OPERATIONAL
-- source, never a Reference Source Library entry, even if someone later
-- flips is_reference by mistake while editing one. Re-asserted on every
-- boot (no-op once already false) rather than a single UPDATE, so this
-- can never silently drift back out of sync with `method`. The underlying
-- operational source row and its ingestion behavior are untouched — only
-- the cataloging flag is forced back to false.
UPDATE sources SET is_reference = false
WHERE method IN ('rss','crawl','institution','structured') AND is_reference = true;

-- One row per named background job, tracking the last calendar date (in
-- that job's own reference timezone) it ran — the guard against running
-- Daily Discovery more than once per day. Generic by job_name rather than
-- a single dedicated column so any future daily/periodic job can reuse it.
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  job_name TEXT PRIMARY KEY,
  last_run_date DATE
);

-- Seed the Discovery Query Registry's initial 12 queries (4 pre-existing +
-- 8 new) covering commodity/market news, logistics/shipping, regulation/
-- policy, major-company/IR, and reports/research papers. Idempotent by
-- name (sources.name has no UNIQUE constraint, so INSERT...WHERE NOT
-- EXISTS rather than ON CONFLICT) — safe to rerun every boot.
INSERT INTO sources (name, url, method, frequency_days, trust_grade, is_daily_discovery)
SELECT v.name, v.url, 'crawl', 7, 'B', true
FROM (VALUES
  ('Web Discovery: palm oil soybean oil price market news', 'palm oil soybean oil price market news today'),
  ('Web Discovery: edible oil tanker freight rates Baltic index', 'edible oil tanker freight rates Baltic index'),
  ('Web Discovery: EU deforestation regulation palm oil EUDR', 'EU deforestation regulation palm oil EUDR'),
  ('Web Discovery: Indonesia Malaysia palm oil export quota policy', 'Indonesia Malaysia palm oil export quota policy'),
  ('Web Discovery: Bunge ADM Louis Dreyfus edible oil investment', 'Bunge ADM Louis Dreyfus edible oil investment expansion'),
  ('Web Discovery: USDA oilseeds outlook report', 'USDA oilseeds outlook report'),
  ('Web Discovery: IGC grain market report oilseeds', 'IGC grain market report oilseeds'),
  ('Web Discovery: soybean crush margin market report', 'soybean crush margin market report')
) AS v(name, url)
WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.name = v.name);

-- Second Discovery Query Registry expansion: the initial 12 queries were
-- overwhelmingly news/article-shaped (see the 7-day backfill audit) with
-- zero research-literature coverage. These 8 add peer-reviewed/working-
-- paper research, institutional white papers, oilseed/shipping market
-- research, and company/IR — using domain-intent hints (journal, working
-- paper, site:edu/ssrn.com/researchgate.net for literature; investor
-- relations/annual report for company/IR) rather than any single
-- hardcoded publisher. Same idempotent INSERT...WHERE NOT EXISTS pattern,
-- same crawl/is_daily_discovery=true/7-day convention as the rest of the
-- registry — existing queries and pipeline behavior are untouched.
INSERT INTO sources (name, url, method, frequency_days, trust_grade, is_daily_discovery)
SELECT v.name, v.url, 'crawl', 7, 'B', true
FROM (VALUES
  ('Web Discovery: palm oil soybean oil peer-reviewed journal research', 'palm oil soybean oil price volatility peer-reviewed journal research study'),
  ('Web Discovery: edible oil market working paper academic research', 'edible oil vegetable oil market working paper academic research site:ssrn.com OR site:researchgate.net OR site:edu'),
  ('Web Discovery: institutional white paper oilseed market outlook', 'oilseed vegetable oil market outlook institutional white paper research institute'),
  ('Web Discovery: commodity oil price forecast research institute', 'commodity edible oil price forecast research institute working paper'),
  ('Web Discovery: vegetable oil tanker shipping economics research paper', 'vegetable oil tanker freight rate shipping economics academic research paper'),
  ('Web Discovery: palm oil sustainability journal study', 'palm oil sustainability deforestation journal study peer-reviewed research'),
  ('Web Discovery: edible oil company investor relations earnings', 'ADM Bunge Wilmar Cargill edible oils investor relations earnings report'),
  ('Web Discovery: palm oil company annual report investor presentation', 'palm oil company annual report investor presentation')
) AS v(name, url)
WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.name = v.name);

-- Third Discovery Query Registry expansion: fills 3 distinct research
-- intents the first 20 queries left thin — production/supply/demand
-- balance (distinct from spot price/market news), sunflower/rapeseed oil
-- specifically (the first 20 are overwhelmingly palm/soybean), and
-- Black Sea/Ukraine-Russia grain-and-oilseed export trade (distinct from
-- the general freight/shipping-rate query). Deliberately 3, not dozens —
-- near-duplicate coverage of an existing intent was avoided rather than
-- added. Same idempotent pattern, same crawl/is_daily_discovery=true/
-- 7-day convention; existing queries/pipeline behavior untouched.
INSERT INTO sources (name, url, method, frequency_days, trust_grade, is_daily_discovery)
SELECT v.name, v.url, 'crawl', 7, 'B', true
FROM (VALUES
  ('Web Discovery: palm oil soybean oil production supply demand balance', 'palm oil soybean oil production supply demand balance report'),
  ('Web Discovery: sunflower rapeseed canola oil market price EU', 'sunflower rapeseed canola oil market price EU production'),
  ('Web Discovery: Black Sea Ukraine Russia sunflower grain oilseed exports', 'Black Sea Ukraine Russia sunflower oil grain oilseed exports trade')
) AS v(name, url)
WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.name = v.name);

-- The 4 pre-existing Web Discovery sources are also part of the Daily
-- Discovery registry — backfill the flag on them by name (no-op once set).
UPDATE sources SET is_daily_discovery = true
WHERE method = 'crawl' AND name IN (
  'Web Discovery: palm oil export tariff regulation',
  'Web Discovery: crude oil price OPEC supply policy',
  'Web Discovery: vegetable oil tanker freight rates shipping',
  'Web Discovery: Wilmar Cargill palm oil investment expansion'
) AND is_daily_discovery IS DISTINCT FROM true;

-- Fourth Discovery Query Registry expansion: corporate deal/investment/
-- project coverage was thin — the existing company queries (IR/earnings,
-- annual report) skew toward disclosure documents, not deal announcements
-- (JV formation, M&A, plant construction/FID) themselves. These 2 add that
-- intent explicitly, with the first biased toward biofuel/SAF (named-case
-- examples requested: Mitsubishi Corp x ADM SAF partnership, LanzaJet's
-- Australian SAF plant) and the second covering the same deal/investment/
-- project intent across the rest of the oils-and-fats value chain (palm,
-- soy, sunflower/rapeseed, UCO/renewable diesel feedstocks), so biofuel/SAF
-- isn't the only sector tracked for this kind of news. Same idempotent
-- pattern, same crawl/is_daily_discovery=true/7-day convention; existing
-- queries/pipeline behavior untouched.
INSERT INTO sources (name, url, method, frequency_days, trust_grade, is_daily_discovery)
SELECT v.name, v.url, 'crawl', 7, 'B', true
FROM (VALUES
  ('Web Discovery: SAF biofuel company investment plant partnership deal', 'SAF sustainable aviation fuel biofuel company investment plant construction partnership deal'),
  ('Web Discovery: edible oil renewable diesel company M&A joint venture project', 'palm soybean sunflower edible oil renewable diesel UCO feedstock company merger acquisition joint venture investment project announcement')
) AS v(name, url)
WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.name = v.name);

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

-- Minimal persistent telemetry for judging AI provider (FreeLLMAPI) call
-- stability over several days without relying on platform log retention.
-- ai_failure_type mirrors provider.js's err.failureType (timeout/
-- rate_limit/server_error/auth/network/empty_response) and is NULL for a
-- successful call or a non-provider (application/contract) failure.
-- ai_latency_ms is the wall-clock duration of the provider call itself
-- (success or failure), NULL if the call never started (e.g. taxonomy
-- fetch failed first).
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_failure_type TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_latency_ms INTEGER;

-- Web Discovery 403 acquisition fallback (webDiscoveryIngest.js): when the
-- original candidate URL (source_url, unchanged — dedup still keys on it)
-- returns 403, a fallback searches for an alternate accessible source and
-- extracts from THAT page instead. acquisition_fallback_url records the
-- alternate actually fetched, kept separate from source_url for
-- traceability — NULL means no fallback was used (the original URL
-- answered directly, same as before this feature existed).
ALTER TABLE items ADD COLUMN IF NOT EXISTS acquisition_fallback_url TEXT;

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

-- Publication Quality Gate v1 (aiDraft.js: parseQaDecision/
-- applyAiDraftIfEligible): a FINAL, independent publish-worthiness verdict,
-- separate from ai_eligible — ai_eligible alone (screening succeeding) is
-- no longer sufficient to auto-publish; ai_qa_decision must also be the
-- literal 'PASS'. HOLD/REJECT (or NULL, e.g. an item generated before this
-- gate existed) are excluded from auto-publish exactly alike, and simply
-- leave the item as whatever it already was (normally Draft) — never
-- retroactively applied to already-Published items, since this column is
-- only ever set by a fresh generateAiDraftForItem() call.
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_qa_decision TEXT CHECK (ai_qa_decision IN ('PASS','HOLD','REJECT'));
ALTER TABLE items ADD COLUMN IF NOT EXISTS ai_qa_reason TEXT;

-- Archive / Daily Report split: a Published item's bucket for the Archive
-- UI's [Archive]/[Daily Report] toggle. Decided deterministically from the
-- existing `type` taxonomy at publish time (see deriveContentCategory() in
-- classification.js: '뉴스' → daily_report, everything else → archive) —
-- reused by both the autonomous publish path (aiDraft.js) and the manual
-- Review PATCH route, never a separate AI call of its own. NULL means not
-- yet published (a Draft has no category).
ALTER TABLE items ADD COLUMN IF NOT EXISTS content_category TEXT CHECK (content_category IN ('archive','daily_report'));

-- Backfill: every already-Published item gets a category now, using the
-- exact same type-based rule future publishes apply. Idempotent — only
-- fills rows that don't have one yet, so this is a safe no-op on repeat
-- boots and never touches a category a later code path explicitly set.
UPDATE items SET content_category = CASE WHEN type = '뉴스' THEN 'daily_report' ELSE 'archive' END
  WHERE status = 'Published' AND content_category IS NULL;

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

-- Seed: institutional PDF report PoC source — World Bank Commodity Markets
-- Outlook (method='institution'). Chosen because it directly covers
-- edible/vegetable oil price and market trends (squarely inside the
-- existing Research scope) and its listing page links its quarterly
-- reports as direct downloadable PDFs/repository "download" links, which
-- server/lib/adapters/institutionPdf.js discovers by regex. Verified
-- reachable (HTTP 200) with real PDF links from this repo's own sandbox
-- fetch during development; production's own fetch during collection is
-- the ongoing check, same convention as the RSS sources above.
INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'World Bank Commodity Markets Outlook', 'World Bank', 'https://www.worldbank.org/en/research/commodity-markets', 'institution', 90, 'poc-institutional', 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.worldbank.org/en/research/commodity-markets');

-- Seed: structured statistical-data PoC source — World Bank Commodity
-- Markets "Pink Sheet" monthly price data (method='structured'). Same
-- publisher/trust tier as the institutional PoC source above, but a
-- genuinely different ingestion shape: a single XLSX file with one row per
-- month rather than a document to discover — see
-- server/lib/adapters/structuredData.js and structuredDataIngest.js.
-- Verified reachable (HTTP 200, correct XLSX content-type) during
-- development; the file is periodically republished at the same URL by
-- the World Bank, same as the RSS/institution sources' ongoing-fetch
-- convention above.
INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'World Bank Commodity Markets Pink Sheet (Monthly)', 'World Bank', 'https://thedocs.worldbank.org/en/doc/18675f1d1639c7a34d463f59263ba0a2-0050012025/related/CMO-Historical-Data-Monthly.xlsx', 'structured', 30, 'poc-structured', 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://thedocs.worldbank.org/en/doc/18675f1d1639c7a34d463f59263ba0a2-0050012025/related/CMO-Historical-Data-Monthly.xlsx');

-- Seed: second institutional PDF PoC source — IFPRI (International Food
-- Policy Research Institute) publications, hosted on CGSpace (CGIAR's
-- shared repository). Validates the institutional adapter against a real
-- second publisher with a genuinely different listing-page shape (title
-- and download link joined by a shared data-identifier, not both in one
-- anchor) — see discoverFromCgspaceHtml() in
-- server/lib/adapters/institutionPdf.js. World Bank's source above is
-- untouched; this exercises the CGSpace-specific discovery branch only.
INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'IFPRI Publications', 'International Food Policy Research Institute', 'https://www.ifpri.org/publications/', 'institution', 14, 'poc-institutional', 'A'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'https://www.ifpri.org/publications/');

-- Seed: Web Research Discovery Query Registry v1 (method='crawl',
-- repurposing the previously-unimplemented 'crawl' enum value already
-- present in the sources_method_check constraint above — no schema
-- migration needed). Unlike every other method, `url` here holds a
-- fixed, hand-written search query rather than a listing page or file
-- URL — see server/lib/adapters/webSearch.js and
-- server/lib/webDiscoveryIngest.js. The "registry" is just these rows:
-- items.source_id already gives every discovered item full provenance
-- (which query/scope found it) via the normal FK, so no new column or
-- table is needed to track query identity.
--
-- One fixed query per existing research scope — never AI-generated,
-- never expanded automatically:
INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'Web Discovery: palm oil export tariff regulation', NULL, 'palm oil export tariff regulation', 'crawl', 7, 'poc-web-discovery', 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'palm oil export tariff regulation' AND method = 'crawl');

INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'Web Discovery: crude oil price OPEC supply policy', NULL, 'crude oil price OPEC supply policy', 'crawl', 7, 'poc-web-discovery', 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'crude oil price OPEC supply policy' AND method = 'crawl');

INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'Web Discovery: vegetable oil tanker freight rates shipping', NULL, 'vegetable oil tanker freight rates shipping', 'crawl', 7, 'poc-web-discovery', 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'vegetable oil tanker freight rates shipping' AND method = 'crawl');

INSERT INTO sources (name, publisher, url, method, frequency_days, owner, trust_grade)
SELECT 'Web Discovery: Wilmar Cargill palm oil investment expansion', NULL, 'Wilmar Cargill palm oil investment expansion', 'crawl', 7, 'poc-web-discovery', 'B'
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = 'Wilmar Cargill palm oil investment expansion' AND method = 'crawl');

-- AI Research Search operational telemetry (PostgreSQL-backed, so it
-- survives app restart/redeploy — console/process logs do not). Exactly
-- one row per POST /api/search request, written in server/routes/search.js.
-- Deliberately metadata-only: never the raw question, the AI's answer, or
-- any provider credential — question_fingerprint is a one-way SHA-256
-- hash (for correlating repeat questions), not the question itself.
CREATE TABLE IF NOT EXISTS ai_search_logs (
  id SERIAL PRIMARY KEY,
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  operation TEXT NOT NULL DEFAULT 'ai_search',
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'insufficient_evidence', 'invalid_request', 'retrieval_error', 'provider_error')),
  http_status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  candidate_count INTEGER,
  source_count INTEGER,
  provider TEXT,
  failure_type TEXT,
  is_followup BOOLEAN NOT NULL DEFAULT false,
  question_fingerprint TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_search_logs_created_at ON ai_search_logs(created_at);

-- Exact-URL dedup, made reliable at the DB level. Production investigation
-- (confirmed via the live items table) found two genuine exact-duplicate
-- source_url pairs — ids [233,234] (barchart.com futures quote) and
-- [237,238] (newsnow.co.uk palm oil feed), both pairs inserted ~2-100ms
-- apart under the same source_id. The application-level
-- "SELECT ... WHERE source_url = $1" dedup check every ingestion path
-- already does (collector.js, webDiscoveryIngest.js,
-- institutionalIngest.js, structuredDataIngest.js) is a classic
-- check-then-insert race: it only protects against a URL already
-- committed by an EARLIER, already-finished run — it cannot stop two
-- overlapping discovery operations (e.g. the hourly scheduler and a
-- manual "지금 수집"/backfill run, or two candidates resolving to the
-- same URL within one query's own result set) from both passing the
-- SELECT before either INSERT commits. A plain UNIQUE index is the
-- authoritative fix (Postgres treats NULL source_url values as mutually
-- distinct, so non-URL-bearing items are unaffected); each ingestion
-- path now catches the resulting 23505 unique-violation and treats it
-- as "someone else just inserted this" rather than a real failure.
--
-- Cleanup runs BEFORE the constraint is added, and only ever removes a
-- row that is a byte-for-byte source_url duplicate of a lower-id row
-- from the SAME investigation — never a guess, never based on content/
-- title similarity. Both known duplicate pairs are Draft/ai_status=failed
-- with no sectors/usages/Published state on either twin, so the higher-
-- id row carries nothing the lower-id row doesn't already have; this is
-- safe to run on a fresh/already-clean database too (the DELETE simply
-- matches zero rows). Child rows (item_sectors/item_usages/
-- item_companies/picks) cascade via their existing ON DELETE CASCADE.
DELETE FROM items a
USING items b
WHERE a.source_url IS NOT NULL
  AND a.source_url = b.source_url
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_url_unique ON items(source_url);
