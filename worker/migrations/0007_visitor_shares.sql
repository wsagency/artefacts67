-- 0007: visitor shares — a named recipient's own link into one artefact or one folder subtree.
-- Rides on 0001..0006 (already applied — do not rewrite them).
--
-- A share is NOT a second secret link to the same door. The base link
-- (/<slug>/) and its artefact password are untouched and never revealed by a share; a share is
-- its own bearer token with its own expiry, its own optional password, and its own key
-- material. Revoking a share therefore costs nothing else: no path changes, no key rotation,
-- no other recipient is disturbed.
--
-- Key material (ADR 0014 tiering, extended one level):
--   * a share holds a random 256-bit SHARE KEY, stored twice — wrapped under the share's own
--     password-derived KEK (`key_wrap_password`, the only copy a visitor can open) and sealed
--     under the platform master key (`key_wrap_master`, so the Worker can wrap NEW documents
--     into an existing share without ever holding the visitor's password);
--   * `share_keys` holds one row per in-scope artefact: that artefact's content key sealed
--     under the SHARE key. The gated visitor path releases wrap + row + ciphertext and the
--     browser does all three unwraps, so the Worker never decrypts a gated share's document.
-- An UNGATED share carries no share key and no `share_keys` rows at all: it may only ever
-- serve artefacts that are themselves ungated, which the Worker already serves openly.
--
-- The token is stored twice for two different jobs: `token_hash` is the lookup key (a visitor
-- presents the plaintext), `token_sealed` is how the console re-prints the link in the share
-- list without keeping a plaintext bearer token in a D1 dump.

CREATE TABLE shares (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('artifact', 'folder')),
  target_id         TEXT NOT NULL,            -- artifacts.id or folders.id, by `kind`
  owner_id          TEXT NOT NULL REFERENCES users(id),   -- the target's owner (platform counts)
  created_by        TEXT NOT NULL REFERENCES users(id),   -- the manager who handed the link out
  token_hash        TEXT NOT NULL UNIQUE,     -- sha256 of the 40-hex bearer token (lookup)
  token_prefix      TEXT NOT NULL,            -- first 8 hex: the audit/display identity
  token_sealed      TEXT NOT NULL,            -- the token itself, sealed under the master key
  recipient_sealed  TEXT NOT NULL,            -- { e: <email> }, sealed under the master key
  password_salt     TEXT,                     -- share gate verifier salt (NULL = ungated)
  password_verifier TEXT,                     -- JSON { viter, vhash }
  key_wrap_password TEXT,                     -- share key under the share password's KEK
  key_wrap_master   TEXT,                     -- share key under the platform master key
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,            -- every share expires: 30 days default, 365 max
  revoked_at        TEXT,
  last_sent_at      TEXT                      -- when the invitation mail last went out
);

CREATE INDEX idx_shares_target ON shares(kind, target_id);
CREATE INDEX idx_shares_owner ON shares(owner_id);

-- One in-scope artefact of one share. Written whenever the subtree changes (creation, publish,
-- move, password change) and deleted the moment the artefact leaves the scope — a missing row
-- is a closed door, which is what makes "moved out of the folder" take effect immediately.
CREATE TABLE share_keys (
  share_id    TEXT NOT NULL REFERENCES shares(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  key_wrap    TEXT NOT NULL,                  -- artefact content key sealed under the share key
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (share_id, artifact_id)
);

CREATE INDEX idx_share_keys_artifact ON share_keys(artifact_id);
