-- Project files (ADR 0035). No foreign keys: rows outlive their folder/record until the sweep
-- removed the R2 object. Limits live in FILE_LIMITS (worker/src/project-files.ts).
ALTER TABLE project_records ADD COLUMN last_write TEXT;
CREATE TABLE project_files (
  id TEXT PRIMARY KEY,                 -- 32 hex; also the upload id
  folder_id TEXT NOT NULL,             -- the project (top-level folder)
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  actor_key TEXT NOT NULL,             -- uploader identity (see Authority)
  status TEXT NOT NULL CHECK (status IN ('uploading','ready','attached','deleted')),
  record_id TEXT,                      -- set when attached
  size INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  meta_sealed TEXT NOT NULL,
  key_sealed TEXT NOT NULL,
  resume_key TEXT,                     -- keyed hash; NULL once no longer uploading
  multipart_id TEXT,                   -- R2 uploadId while a multi-part upload is open
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,                     -- uploading: start+24h; ready: complete+24h; else NULL
  deleted_at TEXT
);
CREATE INDEX project_files_project ON project_files(folder_id, status);
CREATE INDEX project_files_record ON project_files(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX project_files_actor ON project_files(actor_key, status);
CREATE UNIQUE INDEX project_files_resume ON project_files(resume_key) WHERE resume_key IS NOT NULL;
CREATE INDEX project_files_sweep ON project_files(status, expires_at);
CREATE TABLE project_file_parts (
  file_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  sha256 TEXT NOT NULL,                -- hex SHA-256 of the plaintext part
  at TEXT NOT NULL,
  PRIMARY KEY (file_id, number)
);
