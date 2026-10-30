CREATE TABLE project_themes (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 48 AND
    substr(slug, 1, 1) GLOB '[a-z]' AND
    slug NOT GLOB '*[^a-z0-9-]*'
  ),
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (folder_id, slug),
  UNIQUE (id, folder_id)
);

CREATE TABLE project_theme_revisions (
  theme_id TEXT NOT NULL REFERENCES project_themes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_sealed BLOB NOT NULL,
  fonts_sealed BLOB NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  own_fonts_sealed BLOB NOT NULL,
  PRIMARY KEY (theme_id, revision)
);

CREATE TRIGGER project_theme_revisions_immutable
BEFORE UPDATE ON project_theme_revisions
BEGIN
  SELECT RAISE(ABORT, 'project theme revisions are immutable');
END;

CREATE TRIGGER project_theme_restrict_delete
BEFORE DELETE ON project_themes
WHEN EXISTS (
  SELECT 1 FROM artifact_versions
  WHERE theme_scope = 'project' AND theme_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'project-theme-referenced');
END;

CREATE TRIGGER artifact_versions_project_theme_insert
BEFORE INSERT ON artifact_versions
WHEN NEW.theme_scope = 'project' AND (
  NEW.theme_id IS NULL OR NOT EXISTS (SELECT 1 FROM project_themes WHERE id = NEW.theme_id)
)
BEGIN
  SELECT RAISE(ABORT, 'project-theme-missing');
END;

CREATE TRIGGER artifact_versions_project_theme_update
BEFORE UPDATE OF theme_scope, theme_id ON artifact_versions
WHEN NEW.theme_scope = 'project' AND (
  NEW.theme_id IS NULL OR NOT EXISTS (SELECT 1 FROM project_themes WHERE id = NEW.theme_id)
)
BEGIN
  SELECT RAISE(ABORT, 'project-theme-missing');
END;

CREATE TABLE project_theme_settings (
  folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  default_theme_scope TEXT CHECK (default_theme_scope IN ('platform', 'project')),
  default_theme_slug TEXT,
  default_theme_id TEXT REFERENCES project_themes(id) ON DELETE RESTRICT,
  brand_lock INTEGER NOT NULL DEFAULT 0 CHECK (brand_lock IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK (COALESCE(
    (default_theme_scope IS NULL AND default_theme_slug IS NULL AND default_theme_id IS NULL) OR
    (default_theme_scope = 'platform' AND default_theme_slug IS NOT NULL AND default_theme_id IS NULL) OR
    (default_theme_scope = 'project' AND default_theme_id IS NOT NULL),
    0
  ) = 1)
);
