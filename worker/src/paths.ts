// The public path namespace (ADR 0016, ADR 0017).
//
// One segment is a folder index or an artefact — whichever claims it; two segments are a
// preserved 1.x link (`<folderToken>/<artToken>/`, and the `<folderToken>/` index link is one
// segment). Paths are unique across EVERY namespace — folder slugs and ids, artefact slugs and
// ids, and both alias tables — because two things answering to one path is link hijack, not a
// collision. Both the model and the router ask this module, so they can never disagree.

import { Effect } from "effect";
import { asCodeError } from "./types.js";
import type { CodeError, DatabaseLike } from "./types.js";
import { randomHex } from "./crypto.js";
import { SLUG_SEGMENT } from "./router.js";

/** 20 hex chars (~80 bits) — the width 1.x minted artefact tokens with, and the width every
 *  unguessable path segment keeps: for a secret-link artefact the path IS the access control
 *  (`CONTEXT.md`, *Secret link*), so it may not be narrower than it was. */
export const ID_BYTES = 10;

/** Site-owned first segments. A folder or artefact answering to one would shadow a route, so
 *  creation, rename, and alias all reject these names through `pathTaken`. Existing holders are
 *  never deleted: their id paths remain usable and owners can rename them to an unreserved slug.
 *  The `_`-prefixed machine namespaces need no entry here — the slug charset already excludes `_`. */
export const RESERVED_SEGMENTS = new Set([
  "app", "admin", "settings", "themes",
  "login", "logout", "register", "invite", "enroll", "2fa", "passkey",
  "instructions", "assets", "api", "health",
]);

/** A public path is one segment (slug or id) or the two-segment 1.x legacy link. */
const SEGMENT_RE = new RegExp(`^${SLUG_SEGMENT}$`);
const LEGACY_RE = new RegExp(`^${SLUG_SEGMENT}/${SLUG_SEGMENT}$`);

/** Normalize a caller-supplied public path; null when it could never resolve. */
export function normalizePath(path: unknown): string | null {
  const clean = String(path ?? "").replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  return SEGMENT_RE.test(clean) || LEGACY_RE.test(clean) ? clean : null;
}

/** Every id that already answers to this path, from all four namespaces and both alias tables,
 *  plus the paths of deleted folders (ADR 0033), held by no live id and so never `except`. */
const HOLDERS = `
  SELECT id FROM artifacts WHERE slug = ? OR id = ?
  UNION SELECT artifact_id FROM slug_redirects WHERE old_slug = ?
  UNION SELECT id FROM folders WHERE slug = ? OR id = ?
  UNION SELECT folder_id FROM folder_redirects WHERE old_slug = ?
  UNION SELECT '' FROM path_tombstones WHERE path = ?`;

/** One binding per placeholder above (seven). D1 rejects a count mismatch outright; the
 *  `node:sqlite` test double would silently bind NULL and hide exactly this bug. */
const HOLDER_BINDINGS = 7;

/**
 * Is this path already spoken for? `except` is the id (artefact or folder) allowed to hold it,
 * so a rename does not trip over itself. Both id spaces are 80-bit random, so one `except` id
 * cannot be ambiguous.
 */
export function pathTaken(db: DatabaseLike, path: string, { except = null }: { except?: string | null } = {}): Effect.Effect<boolean, CodeError> {
  return Effect.gen(function* () {
    const first = String(path ?? "").split("/")[0];
    if (RESERVED_SEGMENTS.has(first)) return true;
    const { results } = yield* Effect.tryPromise({
      try: () => Promise.resolve(db.prepare(HOLDERS).bind(...Array(HOLDER_BINDINGS).fill(path)).all<{ id: string }>()),
      catch: asCodeError,
    });
    return results.some((row) => row.id !== except);
  });
}

/** Mint an id that collides with nothing already reachable (both models mint this way). */
export function mintPathId(db: DatabaseLike): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    for (let i = 0; i < 8; i++) {
      const id = yield* randomHex(ID_BYTES);
      if (!(yield* pathTaken(db, id))) return id;
    }
    return yield* Effect.fail(Object.assign(new Error("could not mint a free public id"), { code: "id-exhausted" }));
  });
}