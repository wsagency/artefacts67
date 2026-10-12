// Internal collaboration: who, besides the owner, may reach a folder's estate.
//
// One question is asked everywhere — `may(userId, resource, need)` — and one table answers
// it (`folder_grants`, migration 0006). A grant is recorded on a folder and inherited by
// every folder nested beneath it; where two grants meet on one chain the strongest wins.
// Ownership is orthogonal and absolute: the owner is always `owner`, a grant never moves
// ownership, and only the owner may hand out or take back access.
//
// Three things this module refuses to do, each deliberately:
//   * It never consults the platform role. An `admin` reaches no estate but their own —
//     platform administration (users, invites, settings) is a different authority from
//     seeing a colleague's documents.
//   * It never caches. Every question is a live query, so a revoked grant stops working on
//     the next request rather than at the end of a session, and a suspended colleague loses
//     every granted reach the moment their status flips.
//   * It never imports another model. Grants are resolved against the `folders` and `users`
//     tables directly (the folder projection below matches folders.js row for row), because
//     keys.js, api.js, shares.js and the console all depend on this module and a cycle
//     through any of them would be a worse problem than one duplicated projection.
//
// Ancestor walks carry visited ids, so a corrupt cycle terminates without imposing a
// product-level nesting limit on otherwise valid trees.

import { Effect } from "effect";
import type { Folder, FolderRow } from "./folders.js";
import type { Audit } from "./store.js";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";

const nowIso = () => new Date().toISOString();

const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

export type GrantRole = "viewer" | "editor" | "manager";
export type EstateRole = GrantRole | "owner";
export type Permission = "read" | "write" | "manage" | "own";
export interface AccessResource { ownerId?: string | null; folderId?: string | null }
export interface GrantInput { actorId: string; folderId: string; userId: string; role: unknown }
export interface Grant {
  folderId: string; userId: string; role: GrantRole; grantedBy: string; createdAt: string; updatedAt: string;
}
export interface ColleagueGrant {
  userId: string; email: string; name: string; role: GrantRole; folderId: string;
  inherited: boolean; active: boolean; createdAt: string;
}
interface ChainGrantRow { folder_id: string; role: GrantRole; depth: number }
interface ColleagueRow extends ChainGrantRow {
  user_id: string; created_at: string; email: string; name: string | null; status: string;
}
export interface Access {
  role(userId: unknown, folderId: unknown): Effect.Effect<EstateRole | null, CodeError>;
  may(userId: unknown, resource?: AccessResource, need?: string): Effect.Effect<boolean, CodeError>;
  foldersFor(userId: unknown): Effect.Effect<Folder[], CodeError>;
  grant(input: GrantInput): Effect.Effect<Grant, CodeError>;
  revoke(input: Omit<GrantInput, "role">): Effect.Effect<boolean, CodeError>;
  grants(input: { actorId: string; folderId: string }): Effect.Effect<ColleagueGrant[], CodeError>;
}

/** Role rank and requested capability share one scale, validated before any shortcut. */
const RANK: Record<EstateRole, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 };
const PERMISSIONS: Record<Permission, number> = { read: 1, write: 2, manage: 3, own: 4 };
const isGrantRole = (role: unknown): role is GrantRole => role === "viewer" || role === "editor" || role === "manager";
const isPermission = (need: string): need is Permission =>
  need === "read" || need === "write" || need === "manage" || need === "own";

/** A folder and every folder above it, nearest first (`depth` 0 is the folder itself). */
const CHAIN = `
  WITH RECURSIVE chain(id, parent_id, depth, visited) AS (
    SELECT id, parent_id, 0, '|' || id || '|' FROM folders WHERE id = ?
    UNION ALL
    SELECT f.id, f.parent_id, c.depth + 1, c.visited || f.id || '|'
      FROM folders f JOIN chain c ON f.id = c.parent_id
     WHERE instr(c.visited, '|' || f.id || '|') = 0
  )`;

/** Every grant on that chain for one user, nearest first. Inactive users resolve to nothing. */
const CHAIN_GRANTS = `${CHAIN}
  SELECT g.folder_id AS folder_id, g.role AS role, c.depth AS depth
    FROM chain c
    JOIN folder_grants g ON g.folder_id = c.id
    JOIN users u ON u.id = g.user_id AND u.status = 'active'
   WHERE g.user_id = ?
   ORDER BY c.depth`;

/** The management view: every grant on the chain, with the colleague behind it. */
const CHAIN_COLLEAGUES = `${CHAIN}
  SELECT g.folder_id AS folder_id, g.user_id AS user_id, g.role AS role,
         g.created_at AS created_at, u.email AS email, u.name AS name, u.status AS status,
         c.depth AS depth
    FROM chain c
    JOIN folder_grants g ON g.folder_id = c.id
    JOIN users u ON u.id = g.user_id
   ORDER BY c.depth`;

/** Every reachable folder, with UNION terminating any corrupt descendant cycle. */
const REACHABLE = `
  WITH RECURSIVE shared(id) AS (
    SELECT g.folder_id
      FROM folder_grants g
      JOIN users u ON u.id = g.user_id AND u.status = 'active'
     WHERE g.user_id = ?
    UNION
    SELECT f.id FROM folders f JOIN shared s ON f.parent_id = s.id
  )
  SELECT * FROM folders
   WHERE owner_id = ? OR id IN (SELECT id FROM shared)
   ORDER BY created_at`;

export function openAccess({ db, audit }: { db: DatabaseLike; audit: Pick<Audit, "write"> }): Access {
  const active = Effect.fn(function* (userId: string) {
    return (yield* io(() => db.prepare("SELECT status FROM users WHERE id = ?")
      .bind(userId).first<{ status: string }>()))?.status === "active";
  });
  const ownerOf = Effect.fn(function* (folderId: string) {
    return (yield* io(() => db.prepare("SELECT owner_id FROM folders WHERE id = ?")
      .bind(folderId).first<{ owner_id: string }>()))?.owner_id ?? null;
  });
  // The same pure projection as folders.ts; no runtime model dependency is needed.
  const toFolder = (row: FolderRow): Folder => ({
    id: row.id, slug: row.slug ?? null, nameSealed: row.name_sealed,
    ownerId: row.owner_id, parentId: row.parent_id ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const strongest = (rows: ChainGrantRow[]): ChainGrantRow | null => {
    let best: ChainGrantRow | null = null;
    for (const row of rows) {
      if (!isGrantRole(row.role)) continue;
      if (!best || RANK[row.role] > RANK[best.role]) best = row;
    }
    return best;
  };
  const requireOwner = Effect.fn(function* (actorId: string, folderId: string, message: string) {
    const ownerId = yield* ownerOf(folderId);
    if (!ownerId) return yield* Effect.fail(coded("not-found", "no such folder"));
    if (ownerId !== String(actorId ?? "") || !(yield* active(ownerId))) {
      return yield* Effect.fail(coded("forbidden", message));
    }
    return ownerId;
  });

  const self: Access = {
    role: Effect.fn(function* (userId: unknown, folderId: unknown) {
      const uid = String(userId ?? ""), fid = String(folderId ?? "");
      if (!uid || !fid) return null;
      const ownerId = yield* ownerOf(fid);
      if (!ownerId) return null;
      if (ownerId === uid) return (yield* active(uid)) ? "owner" as const : null;
      const { results } = yield* io(() => db.prepare(CHAIN_GRANTS).bind(fid, uid).all<ChainGrantRow>());
      return strongest(results)?.role ?? null;
    }),
    may: Effect.fn(function* (userId: unknown, { ownerId = null, folderId = null }: AccessResource = {}, need = "read") {
      const uid = String(userId ?? "");
      if (!uid) return false;
      if (!isPermission(need)) return yield* Effect.fail(coded("invalid-need", `unknown permission '${need}'`));
      const floor = PERMISSIONS[need];
      if (ownerId != null && String(ownerId) === uid) return yield* active(uid);
      if (floor === PERMISSIONS.own || !folderId) return false;
      const role = yield* self.role(uid, folderId);
      return role != null && RANK[role] >= floor;
    }),
    foldersFor: Effect.fn(function* (userId: unknown) {
      const uid = String(userId ?? "");
      if (!uid || !(yield* active(uid))) return [];
      const { results } = yield* io(() => db.prepare(REACHABLE).bind(uid, uid).all<FolderRow>());
      return results.map(toFolder);
    }),
    grant: Effect.fn(function* ({ actorId, folderId, userId, role }: GrantInput) {
      const fid = String(folderId ?? ""), uid = String(userId ?? "");
      const ownerId = yield* requireOwner(actorId, fid, "only the active folder owner shares it");
      if (!isGrantRole(role)) return yield* Effect.fail(coded("invalid-role", "role must be viewer, editor or manager"));
      if (!uid) return yield* Effect.fail(coded("invalid-user", "a grant needs the colleague it is for"));
      if (uid === ownerId) return yield* Effect.fail(coded("invalid-user", "the owner already has every permission"));
      const user = yield* io(() => db.prepare("SELECT id, status FROM users WHERE id = ?")
        .bind(uid).first<{ id: string; status: string }>());
      if (!user) return yield* Effect.fail(coded("not-found", "no such user"));
      if (user.status !== "active") return yield* Effect.fail(coded("invalid-user", "that colleague's account is suspended"));
      const at = nowIso();
      yield* io(() => db.prepare(
        "INSERT INTO folder_grants (folder_id, user_id, role, granted_by, created_at, updated_at) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(folder_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at",
      ).bind(fid, uid, role, ownerId, at, at).run());
      yield* audit.write({ actorType: "user", actorId: ownerId, action: "access.grant", detail: { folder: fid, user: uid, role } });
      return { folderId: fid, userId: uid, role, grantedBy: ownerId, createdAt: at, updatedAt: at };
    }),
    revoke: Effect.fn(function* ({ actorId, folderId, userId }: Omit<GrantInput, "role">) {
      const fid = String(folderId ?? ""), uid = String(userId ?? "");
      const ownerId = yield* requireOwner(actorId, fid, "only the active folder owner shares it");
      const existing = yield* io(() => db.prepare("SELECT role FROM folder_grants WHERE folder_id = ? AND user_id = ?")
        .bind(fid, uid).first<{ role: GrantRole }>());
      if (!existing) return false;
      yield* io(() => db.prepare("DELETE FROM folder_grants WHERE folder_id = ? AND user_id = ?").bind(fid, uid).run());
      yield* audit.write({ actorType: "user", actorId: ownerId, action: "access.revoke", detail: { folder: fid, user: uid, role: existing.role } });
      return true;
    }),
    grants: Effect.fn(function* ({ actorId, folderId }: { actorId: string; folderId: string }) {
      const fid = String(folderId ?? "");
      yield* requireOwner(actorId, fid, "only the active folder owner sees who it is shared with");
      const { results } = yield* io(() => db.prepare(CHAIN_COLLEAGUES).bind(fid).all<ColleagueRow>());
      return results.map((row) => ({
        userId: row.user_id, email: row.email, name: row.name ?? "", role: row.role,
        folderId: row.folder_id, inherited: row.folder_id !== fid, active: row.status === "active", createdAt: row.created_at,
      })).sort((a, b) => a.email.localeCompare(b.email));
    }),
  };
  return self;
}
