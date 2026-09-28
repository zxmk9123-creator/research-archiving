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

-- Seed: MECE sector tree (2 levels)
INSERT INTO sectors (name, parent_id) VALUES ('식용유지', NULL) ON CONFLICT DO NOTHING;
INSERT INTO sectors (name, parent_id) VALUES ('비식용유지', NULL) ON CONFLICT DO NOTHING;

INSERT INTO sectors (name, parent_id)
SELECT v.name, p.id FROM (VALUES ('팜유'),('대두유'),('유채씨유'),('해바라기유'),('기타 식용유지')) AS v(name)
CROSS JOIN (SELECT id FROM sectors WHERE name='식용유지' AND parent_id IS NULL) p
ON CONFLICT DO NOTHING;

INSERT INTO sectors (name, parent_id)
SELECT v.name, p.id FROM (VALUES ('UCO'),('UCOME'),('SAF'),('Tallow'),('FAME'),('기타 비식용유지')) AS v(name)
CROSS JOIN (SELECT id FROM sectors WHERE name='비식용유지' AND parent_id IS NULL) p
ON CONFLICT DO NOTHING;

-- Seed: flat usage tags
INSERT INTO usages (name) VALUES
  ('NBO 작성'), ('업체 프로파일'), ('시장 전망'), ('가격·물류'), ('규제 대응')
ON CONFLICT DO NOTHING;
