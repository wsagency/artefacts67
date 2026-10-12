-- A new passwordless share deliberately grants bearer access even to protected content.
-- Existing passwordless links must retain their former exclusion of protected artefacts.
-- Only new link creation opts in; no existing tokens, gates or observations are changed.
ALTER TABLE shares ADD COLUMN allow_protected INTEGER NOT NULL DEFAULT 0
  CHECK (allow_protected IN (0, 1));
