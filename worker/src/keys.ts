// The API-key model (ADR 0015): a per-user master key and per-artifact scoped keys.
//
// Two tiers, one table. A key is `wak_` + 40 lowercase hex (master: acts for its user on
// that user's own artefacts, and mints the user's artifact keys) or `waa_` + 40 hex
// (artifact: bound to exactly one artefact, scopes read/write/read_write). Only
// sha256(plaintext) is stored (`token_hash`); the plaintext is shown exactly once, at mint
// or rotate, and is never persisted, returned in a list, or written to a log. `prefix` —
// the first 8 characters — is the display identity in lists and audit rows.
//
// The authorization spine lives here so it is testable without HTTP: `hasScope` is what a
// key may do, `may` is whose rows it may touch — an artifact key never crosses artefacts,
// and neither tier ever lists the platform (that is an Owner/Admin console capability, not
// a key capability). Revocation is a flag, never a delete: the audit trail outlives the key
// it describes.
//
// A key acts for exactly one user, and internal collaboration widened what that means: a
// user's reach is their own estate PLUS the folders shared with them (access.js). So `may`
// is asynchronous and asks the grant table live, on every request, and takes the depth it
// is being asked about — `read`, `write`, `manage` or `own`. Live is the point: revoking a
// colleague kills every key they minted against that estate on the next call, including a
// scoped key whose plaintext they still hold, and including the moment of a mint or a
// rotate — neither may hand back reach the user no longer has. The access module is
// injected; there is no ownership-only fallback that could bypass live authorization.

import { Effect } from "effect";
import type { Access, AccessResource, Permission } from "./access.js";
import type { ArtifactRow } from "./artifacts.js";
import type { Audit, UserRow } from "./store.js";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";

import { randomHex, sha256hex } from "./crypto.js";

const nowIso = () => new Date().toISOString();

const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

export type KeyKind = "master" | "artifact";
export type KeyScopes = "master" | "read" | "write" | "read_write";
export interface KeyRow {
  id: string; user_id: string; kind: KeyKind; artifact_id: string | null;
  label: string | null; token_hash: string; prefix: string; scopes: KeyScopes;
  created_at: string; revoked_at: string | null; last_used_at: string | null;
}
export interface Key {
  id: string; userId: string; kind: KeyKind; artifactId: string | null; label: string;
  prefix: string; scopes: KeyScopes; createdAt: string; revokedAt: string | null; lastUsedAt: string | null;
}
export interface MintKey {
  userId: string; kind: unknown; artifactId?: string | null; scopes: unknown; label?: unknown;
}
export interface MintedKey { key: string; record: Key }
export interface KeyAuthentication { key: Key; user: UserRow; artifact: ArtifactRow | null }
export interface KeyResource extends AccessResource { artifactId?: string | null }
export interface Keys {
  toKey(row: KeyRow): Key;
  toKey(row: KeyRow | null | undefined): Key | null;
  byId(id: unknown): Effect.Effect<Key | null, CodeError>;
  mint(input: MintKey): Effect.Effect<MintedKey, CodeError>;
  authenticate(request: Pick<Request, "headers">): Effect.Effect<KeyAuthentication | null, CodeError>;
  hasScope(key: Pick<Key, "kind" | "scopes">, need: string): boolean;
  may(key: Key | null | undefined, resource?: KeyResource, need?: string): Effect.Effect<boolean, CodeError>;
  list(userId: string): Effect.Effect<Key[], CodeError>;
  revoke(id: unknown, userId: unknown): Effect.Effect<boolean, CodeError>;
  rotate(id: unknown, userId: unknown): Effect.Effect<MintedKey | null, CodeError>;
}

/** A well-formed presented key: `Bearer ` + the two-tier plaintext shape, nothing else. */
const BEARER = /^Bearer ((?:wak|waa)_[0-9a-f]{40})$/;

const isArtifactScope = (scopes: unknown): scopes is Exclude<KeyScopes, "master"> =>
  scopes === "read" || scopes === "write" || scopes === "read_write";

/** The estate permission a scoped key's own scopes stand for: anything that may write is a
 *  write, so a read_write key is never minted by someone who may only read. */
const needFor = (scopes: KeyScopes): Permission => scopes === "read" ? "read" : "write";


function toKey(row: KeyRow): Key;
function toKey(row: KeyRow | null | undefined): Key | null;
function toKey(row: KeyRow | null | undefined): Key | null {
  return row ? {
    id: row.id, userId: row.user_id, kind: row.kind, artifactId: row.artifact_id ?? null,
    label: row.label ?? "", prefix: row.prefix, scopes: row.scopes, createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null, lastUsedAt: row.last_used_at ?? null,
  } : null;
}

export function openKeys({ db, audit, access }: {
  db: DatabaseLike; audit: Pick<Audit, "write">; access: Pick<Access, "may">;
}): Keys {
  if (!access) throw coded("invalid-access", "the key model requires the access module");
  const reaches = Effect.fn(function* (userId: string, artifactId: string | null, need: string, ownerId: string | null = null) {
    const row = yield* io(() => db.prepare("SELECT owner_id, folder_id, deleted_at FROM artifacts WHERE id = ?")
      .bind(String(artifactId ?? "")).first<Pick<ArtifactRow, "owner_id" | "folder_id" | "deleted_at">>());
    if (!row || row.deleted_at) return false;
    if (ownerId !== null && ownerId !== row.owner_id) return false;
    return yield* access.may(userId, { ownerId: row.owner_id, folderId: row.folder_id ?? null }, need);
  });

  const self: Keys = {
    toKey,
    byId: Effect.fn(function* (id: unknown) {
      return toKey(yield* io(() => db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(String(id ?? "")).first<KeyRow>()));
    }),
    mint: Effect.fn(function* ({ userId, kind, artifactId = null, scopes: rawScopes, label = null }: MintKey) {
      if (!userId) return yield* Effect.fail(coded("invalid-user", "a key needs its owner"));
      if (kind !== "master" && kind !== "artifact") return yield* Effect.fail(coded("invalid-kind", "kind must be 'master' or 'artifact'"));
      if (kind === "master" && artifactId != null) return yield* Effect.fail(coded("invalid-artifact", "a master key is never bound to one artefact"));
      if (kind === "artifact" && artifactId == null) return yield* Effect.fail(coded("invalid-artifact", "an artifact key must name its artefact"));
      const scopes = rawScopes === "master" || isArtifactScope(rawScopes) ? rawScopes : null;
      if (scopes === null || (kind === "master" ? scopes !== "master" : scopes === "master")) {
        return yield* Effect.fail(coded("invalid-scopes", "a master key takes scopes 'master'; an artifact key takes 'read', 'write' or 'read_write'"));
      }
      let cleanLabel = "";
      if (label != null) {
        if (typeof label !== "string" || label.trim() === "" || label.length > 120) {
          return yield* Effect.fail(coded("invalid-label", "label must be a non-empty string of at most 120 characters"));
        }
        cleanLabel = label;
      }
      const bound = kind === "artifact" ? String(artifactId) : null;
      if (bound && !(yield* reaches(userId, bound, needFor(scopes)))) {
        return yield* Effect.fail(coded("forbidden", "that artefact is not this user's to key"));
      }
      const key = `${kind === "master" ? "wak" : "waa"}_${yield* randomHex(20)}`;
      const prefix = key.slice(0, 8), id = yield* randomHex(8), at = nowIso();
      const hash = yield* sha256hex(key);
      yield* io(() => db.prepare(
        "INSERT INTO api_keys (id, user_id, kind, artifact_id, token_hash, prefix, scopes, label, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(id, userId, kind, bound, hash, prefix, scopes, cleanLabel, at).run());
      yield* audit.write({ actorType: "user", actorId: userId, action: "key.mint", artifactId: bound, detail: { kind, artifactId: bound, prefix } });
      return { key, record: { id, userId, kind, artifactId: bound, label: cleanLabel, prefix, scopes, createdAt: at, revokedAt: null, lastUsedAt: null } };
    }),
    authenticate: Effect.fn(function* (request: Pick<Request, "headers">) {
      const presented = BEARER.exec(request.headers.get("authorization") ?? "");
      if (!presented) return null;
      const hash = yield* sha256hex(presented[1]);
      const row = yield* io(() => db.prepare("SELECT * FROM api_keys WHERE token_hash = ?").bind(hash).first<KeyRow>());
      if (!row || row.revoked_at) return null;
      const user = yield* io(() => db.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first<UserRow>());
      if (!user || user.status !== "active") return null;
      let artifact: ArtifactRow | null = null;
      if (row.kind === "artifact") {
        artifact = yield* io(() => db.prepare("SELECT * FROM artifacts WHERE id = ?").bind(row.artifact_id).first<ArtifactRow>());
        if (!artifact || artifact.deleted_at) return null;
      }
      // Best-effort telemetry stays within the request's Effect instead of escaping its lifetime.
      yield* io(() => db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .bind(nowIso(), row.id).run()).pipe(Effect.catch(() => Effect.void));
      return { key: toKey(row), user, artifact };
    }),
    hasScope: (key, need) => key.kind === "master" || key.scopes === "read_write" || key.scopes === need,
    may: Effect.fn(function* (key: Key | null | undefined, { ownerId = null, artifactId = null, folderId = null }: KeyResource = {}, need = "read") {
      if (!key) return false;
      if (key.kind === "artifact" && (!artifactId || key.artifactId !== artifactId)) return false;
      if (artifactId) return yield* reaches(key.userId, artifactId, need, ownerId);
      return yield* access.may(key.userId, { ownerId, folderId }, need);
    }),
    list: Effect.fn(function* (userId: string) {
      const { results } = yield* io(() => db.prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC")
        .bind(userId).all<KeyRow>());
      return results.map(row => toKey(row));
    }),
    revoke: Effect.fn(function* (id: unknown, userId: unknown) {
      const row = yield* io(() => db.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?")
        .bind(String(id ?? ""), String(userId ?? "")).first<KeyRow>());
      if (!row || row.revoked_at) return false;
      yield* io(() => db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(nowIso(), row.id).run());
      yield* audit.write({ actorType: "user", actorId: row.user_id, action: "key.revoke", artifactId: row.artifact_id, detail: { kind: row.kind, artifactId: row.artifact_id, prefix: row.prefix } });
      return true;
    }),
    rotate: Effect.fn(function* (id: unknown, userId: unknown) {
      const row = yield* io(() => db.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?")
        .bind(String(id ?? ""), String(userId ?? "")).first<KeyRow>());
      if (!row || row.revoked_at) return null;
      if (row.kind === "artifact" && !(yield* reaches(row.user_id, row.artifact_id, needFor(row.scopes)))) {
        return yield* Effect.fail(coded("forbidden", "that artefact is no longer this user's to key"));
      }
      const key = `${row.kind === "master" ? "wak" : "waa"}_${yield* randomHex(20)}`, prefix = key.slice(0, 8);
      const hash = yield* sha256hex(key);
      yield* io(() => db.prepare("UPDATE api_keys SET token_hash = ?, prefix = ? WHERE id = ?").bind(hash, prefix, row.id).run());
      yield* audit.write({ actorType: "user", actorId: row.user_id, action: "key.rotate", artifactId: row.artifact_id, detail: { kind: row.kind, artifactId: row.artifact_id, prefix } });
      return { key, record: { ...toKey(row), prefix } };
    }),
  };
  return self;
}
