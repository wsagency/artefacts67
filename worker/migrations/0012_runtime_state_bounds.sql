-- Runtime state bounds (0011 introduced the sealed table; 0012 adds the accounting columns
-- the per-artefact aggregate ceilings and the anonymous expiry predicates rely on).
--
-- Two columns, both maintained exclusively by runtime-state.mjs:
--   anonymous  1 for anonymous personal rows (anonymous personal state carries its own
--              2048-key / 8 MiB per-artefact ceiling inside the 4096-key / 32 MiB aggregate
--              and a 365-day idle expiry); signed-in personal and shared rows stay 0.
--   expires_at ISO timestamp after which an anonymous entry no longer counts and scheduled
--              cleanup removes it; NULL means the row is permanent (signed-in, shared).
--
-- Numeric limits live in runtime-state.mjs (STATE_LIMITS) so code and docs share one source.

ALTER TABLE artifact_runtime_state ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_runtime_state ADD COLUMN expires_at TEXT;

-- Cleanup and the expiry predicates touch only expiring rows; permanent rows never enter
-- this index, so the scheduled sweep stays a bounded scan no matter how much state exists.
CREATE INDEX artifact_runtime_state_expiry
  ON artifact_runtime_state(expires_at) WHERE expires_at IS NOT NULL;
