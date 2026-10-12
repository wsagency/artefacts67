-- Project application data (ADR 0032). A project is a top-level folder. Record data and
-- submission metadata are sealed under the platform master key; collection definitions are
-- unsealed metadata. Limits live in PROJECT_LIMITS (worker/src/project-data.ts).
CREATE TABLE project_collections (
  folder_id TEXT NOT NULL REFERENCES folders(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('records', 'responses')),
  schema_json TEXT NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (folder_id, name)
);

-- artifact_id carries provenance only: no foreign key, so purging an artefact never blocks.
CREATE TABLE project_records (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  collection TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_sealed TEXT NOT NULL,
  submission_sealed TEXT,
  actor_key TEXT,
  artifact_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX project_records_page ON project_records(folder_id, collection, created_at, id);
CREATE INDEX project_records_actor ON project_records(folder_id, collection, actor_key);
