-- One content-blind cumulative observation per signed document opening.
-- Retention removes observations, not shares or their audit trail.
ALTER TABLE platform_settings ADD COLUMN analytics_retention_days INTEGER NOT NULL DEFAULT 90;

CREATE TABLE share_visits (
  visit_id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0 CHECK (active_seconds BETWEEN 0 AND 14400),
  scroll_bucket INTEGER NOT NULL DEFAULT 0 CHECK (scroll_bucket IN (0,25,50,75,100))
);
CREATE INDEX idx_share_visits_opened ON share_visits(opened_at);
CREATE INDEX idx_share_visits_share ON share_visits(share_id, opened_at);
CREATE INDEX idx_share_visits_artifact ON share_visits(artifact_id, opened_at);
