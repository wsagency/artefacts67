-- Artefacts67 2.0 (M3): the write API's artefact metadata and the platform mail identity.
-- Rides on 0001-0003 (already applied — do not rewrite them).
-- Ruled by ADR 0019 (the 2.0 write API) and the product ruling that the platform mail sender
-- is editable by the platform owner.

-- Artefact language (BCP-47): `en` is the default, client-facing artefacts are usually `hr`.
-- The document carries its own <html lang>; this column is the metadata the API and the UI read.
ALTER TABLE artifacts ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';

-- The From address for platform e-mail (invitations, and later shares and notifications).
-- Owner-editable in /_admin/settings; empty means "fall back to the SMTP_FROM worker var".
ALTER TABLE platform_settings ADD COLUMN mail_from TEXT NOT NULL DEFAULT '';


-- A human label for an API key ("an agent's key", "Acme integration"). 1.x tokens had one
-- (lib/tokens.mjs, ≤120 chars); the 2.0 key table was drafted without it, and a list of
-- per-artifact keys is unusable without a name to tell them apart.
ALTER TABLE api_keys ADD COLUMN label TEXT NOT NULL DEFAULT '';