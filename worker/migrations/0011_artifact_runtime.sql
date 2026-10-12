-- Runtime values and report reasons are sealed under the platform master key.
CREATE TABLE artifact_runtime_state (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'shared')),
  actor_key TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  value_sealed TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, scope, actor_key, key_hash)
);

CREATE TABLE artifact_reports (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  reporter_key TEXT NOT NULL,
  reason_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id)
);
CREATE INDEX artifact_reports_pending ON artifact_reports(resolved_at, created_at);
