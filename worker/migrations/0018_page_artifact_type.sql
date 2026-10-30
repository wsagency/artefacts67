ALTER TABLE artifact_versions ADD COLUMN type TEXT NOT NULL DEFAULT 'site' CHECK (type IN ('site', 'page'));
ALTER TABLE artifact_versions ADD COLUMN theme_scope TEXT CHECK (theme_scope IS NULL OR theme_scope IN ('platform', 'project'));
ALTER TABLE artifact_versions ADD COLUMN theme_id TEXT;
ALTER TABLE artifact_versions ADD COLUMN theme_slug TEXT;
ALTER TABLE artifact_versions ADD COLUMN theme_overrides_sealed BLOB;
ALTER TABLE artifact_versions ADD COLUMN brand_lock INTEGER NOT NULL DEFAULT 0 CHECK (brand_lock IN (0, 1));

CREATE INDEX idx_artifact_versions_theme ON artifact_versions(theme_scope, theme_id);
