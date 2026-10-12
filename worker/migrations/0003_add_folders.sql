-- Artefacts67 2.0 (M2): the folder grouping, its index paths, and platform settings.
-- Rides on 0001_init.sql and 0002_add_m1_auth.sql (both already applied — do not rewrite them).
-- Ruled by ADR 0017 (folders and the folder index) and ADR 0018 (version retention).
--
-- A folder is what used to be called a client (the owner's rename ruling): renamed as such, so
-- a member may use one for a client, a project, anything they like. 1.x carried it as a
-- directory with a meta.json per folder, and its index was a generated page at
-- `/<folderToken>/`. 2.0 makes an artefact user-owned (ADR 0012) but keeps the folder as the
-- container an artefact is published INTO — a plain label with its own public path, holding
-- no content of its own.

CREATE TABLE folders (
  id           TEXT PRIMARY KEY,
  slug         TEXT UNIQUE,          -- public path segment; NULL until named (like artifacts)
  name_sealed  TEXT NOT NULL,        -- display name, encrypted at rest (ADR 0014)
  owner_id     TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

ALTER TABLE artifacts ADD COLUMN folder_id TEXT REFERENCES folders(id);

CREATE INDEX idx_artifacts_folder ON artifacts(folder_id);

-- Retired folder paths: renames, and the 1.x `/<folderToken>/` index links at import.
CREATE TABLE folder_redirects (
  old_slug   TEXT PRIMARY KEY,
  folder_id  TEXT NOT NULL REFERENCES folders(id),
  created_at TEXT NOT NULL
);

-- Platform-wide settings: one row, id 'platform'. Retention is the version cap per artefact
-- (ADR 0018) — the platform owner edits it, and 100 is the shipped default.
CREATE TABLE platform_settings (
  id          TEXT PRIMARY KEY,
  retention   INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO platform_settings (id, retention, updated_at)
VALUES ('platform', 100, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
