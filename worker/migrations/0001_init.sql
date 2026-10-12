-- Artefacts67 2.0 initial schema (M0).
-- Model per ADRs 0012 (roles), 0014 (crypto tiering), 0015 (key hierarchy).
-- Columns suffixed *_sealed / *_wrap hold AES-256-GCM ciphertext (base64);
-- verifiers are PBKDF2-600k; token_hash / password_hash are one-way.
-- Content itself never lives here — R2 holds art/<artifactId>/<version>.enc.

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT,
  role                TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  password_hash       TEXT NOT NULL,            -- PBKDF2 600k, salt and hash encoded
  totp_secret_sealed  TEXT,                     -- recovery factor, encrypted at rest
  passkeys            TEXT NOT NULL DEFAULT '[]', -- JSON array of WebAuthn credentials
  settings_sealed     TEXT,                     -- per-user settings, encrypted at rest
  invited_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  last_login_at       TEXT
);

CREATE TABLE artifacts (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users(id),
  slug                TEXT UNIQUE,              -- friendly path; NULL until named
  title_sealed        TEXT NOT NULL,            -- encrypted at rest (ADR 0014)
  header_ui           INTEGER NOT NULL DEFAULT 1,
  current_version     INTEGER NOT NULL DEFAULT 0,
  password_salt       TEXT,                     -- gate verifier salt (distinct from KEK salt)
  password_verifier   TEXT,                     -- PBKDF2 600k verifier
  key_wrap_password   TEXT,                     -- content key wrapped under password-derived KEK
  key_wrap_master     TEXT,                     -- content key wrapped under platform master key
  max_versions        INTEGER,                  -- NULL = platform default retention
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_artifacts_owner ON artifacts(owner_id);

CREATE TABLE artifact_versions (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id),
  version       INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,                -- art/<artifactId>/<version>.enc
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  author_type   TEXT NOT NULL CHECK (author_type IN ('user', 'api_key')),
  author_id     TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('master', 'artifact')),
  artifact_id  TEXT REFERENCES artifacts(id),  -- required when kind = 'artifact'
  token_hash   TEXT NOT NULL UNIQUE,           -- sha256 of the presented key
  prefix       TEXT NOT NULL,                  -- display prefix, e.g. wak_1a2b3c4d
  scopes       TEXT NOT NULL CHECK (scopes IN ('master', 'read', 'write', 'read_write')),
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id     TEXT NOT NULL REFERENCES users(id),
  artifact_id TEXT REFERENCES artifacts(id),  -- set when kind = 'artifact'
  kind        TEXT NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'artifact')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE slug_redirects (
  old_slug    TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,                  -- e.g. artifact.update, key.mint, user.invite
  artifact_id TEXT,
  detail      TEXT,                           -- small JSON
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);

CREATE INDEX idx_audit_artifact ON audit_log(artifact_id);
