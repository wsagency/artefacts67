-- 0014: folder deletion (ADR 0033). A deleted folder's row and aliases go, but every path it
-- answered to — its id, its slug and each retired path — stays reserved here, so an old link
-- can never resolve to somebody else's later folder or artefact (ADRs 0016, 0017, 0021).
-- paths.ts counts these rows as holders; nothing resolves through them.
CREATE TABLE path_tombstones (
  path       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
