-- Artefacts67 2.0 (M1): multi-user platform auth.
-- Rides on 0001_init.sql (do not rewrite it — its `v1` tag is already applied).
-- Ruled by ADR 0012 (Owner/Admin/Member, per-user logins, passkeys as second factor).
--
-- Passkeys live in users.passkeys (JSON array of COSE records, one per user); the
-- confirmed TOTP recovery factor lives in users.totp_secret_sealed. Both were already
-- present in 0001. This migration adds only the state the login CEREMONIES need:
--   * sessions gain CSRF + a 2FA gate flag,
--   * a one-shot WebAuthn challenge table (user-scoped),
--   * a staged (unconfirmed) TOTP secret column for first-login enrollment.

ALTER TABLE sessions ADD COLUMN csrf TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN pending2fa INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN totp_secret_pending_sealed TEXT;

CREATE TABLE webauthn_pending (
  token       TEXT PRIMARY KEY,             -- one-shot 32-hex token (16 random bytes)
  challenge   TEXT NOT NULL,                -- issued b64url challenge
  kind        TEXT NOT NULL CHECK (kind IN ('reg', 'auth')),
  user_id     TEXT NOT NULL REFERENCES users(id),
  rp_id       TEXT NOT NULL,                -- host of the origin that issued the challenge
  origin      TEXT NOT NULL,                -- full origin that clientData.origin must equal
  created_at  TEXT NOT NULL
);