-- Deleted rows and aliases permanently reserve every handed-out path. Content is purged,
-- not archived: purged_at records successful physical cleanup, deleted_at withdraws first.
ALTER TABLE artifacts ADD COLUMN deleted_at TEXT;
ALTER TABLE artifacts ADD COLUMN deleted_by TEXT;
ALTER TABLE artifacts ADD COLUMN purged_at TEXT;
CREATE INDEX idx_artifacts_live_owner ON artifacts(owner_id, deleted_at, current_version);

-- A publication racing withdrawal must never reactivate the row or add a retained version.
CREATE TRIGGER artifact_version_live_insert BEFORE INSERT ON artifact_versions
WHEN NOT EXISTS (
  SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND deleted_at IS NULL
    AND current_version = NEW.version - 1
)
BEGIN
  SELECT RAISE(ABORT, 'publish-conflict: artefact withdrawn or version changed');
END;

CREATE TRIGGER artifact_tombstone_terminal BEFORE UPDATE ON artifacts
WHEN OLD.deleted_at IS NOT NULL AND (
  NEW.deleted_at IS NULL OR NEW.current_version != 0 OR NEW.key_wrap_master IS NOT NULL
  OR NEW.key_wrap_password IS NOT NULL OR NEW.password_verifier IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'not-found: artefact permanently withdrawn');
END;
