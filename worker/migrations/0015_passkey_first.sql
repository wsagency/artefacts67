-- Passkey-first sign-in (ADR 0034). A 'login' challenge is issued before anyone is known:
-- the discoverable credential's userHandle names the user at completion, so its row has no
-- user_id. 'reg' and 'auth' challenges stay user-scoped.
--
-- SQLite cannot relax a NOT NULL or CHECK in place. Rows here are five-minute, one-shot
-- challenges, so the table is recreated rather than copied: an in-flight ceremony during
-- deploy simply fails and the person retries.

DROP TABLE webauthn_pending;
CREATE TABLE webauthn_pending (
  token       TEXT PRIMARY KEY,             -- one-shot 32-hex token (16 random bytes)
  challenge   TEXT NOT NULL,                -- issued b64url challenge
  kind        TEXT NOT NULL CHECK (kind IN ('reg', 'auth', 'login')),
  user_id     TEXT REFERENCES users(id),    -- NULL exactly for 'login'
  rp_id       TEXT NOT NULL,                -- host of the origin that issued the challenge
  origin      TEXT NOT NULL,                -- full origin that clientData.origin must equal
  created_at  TEXT NOT NULL,
  CHECK ((kind = 'login') = (user_id IS NULL))
);
-- Every new challenge sweeps expired rows; this keeps that sweep an index range scan.
CREATE INDEX webauthn_pending_created ON webauthn_pending(created_at);
