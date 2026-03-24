-- Construct App Registry — D1 Schema
-- This is a read replica of the GitHub registry repo.
-- Synced on every merge to main via GitHub Actions.

CREATE TABLE IF NOT EXISTS apps (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  long_description  TEXT,
  author_name       TEXT NOT NULL,
  author_url        TEXT,
  repo_owner        TEXT NOT NULL,
  repo_name         TEXT NOT NULL,
  icon_path         TEXT DEFAULT 'icon.png',
  screenshot_count  INTEGER DEFAULT 0,
  category          TEXT NOT NULL DEFAULT 'utilities',
  tags              TEXT DEFAULT '',
  latest_version    TEXT NOT NULL,
  latest_commit     TEXT NOT NULL,
  install_count     INTEGER DEFAULT 0,
  avg_rating        REAL DEFAULT 0,
  rating_count      INTEGER DEFAULT 0,
  featured          INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active',
  has_ui            INTEGER DEFAULT 0,
  tools_json        TEXT,
  permissions_json  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category);
CREATE INDEX IF NOT EXISTS idx_apps_featured ON apps(featured) WHERE featured = 1;
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);

CREATE TABLE IF NOT EXISTS app_versions (
  app_id        TEXT NOT NULL,
  version       TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  changelog     TEXT,
  manifest_json TEXT NOT NULL,
  published_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, version),
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  user_name   TEXT,
  rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(app_id, user_id),
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_apps (
  collection_id TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  sort_order    INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, app_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Curated integrations — verified to work with Construct.
-- Managed via curated.json in the registry repo.
CREATE TABLE IF NOT EXISTS curated_apps (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'productivity',
  source      TEXT NOT NULL DEFAULT 'composio',
  icon_url    TEXT,
  sort_order  INTEGER DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curated_category ON curated_apps(category);
CREATE INDEX IF NOT EXISTS idx_curated_source ON curated_apps(source);
