// The folder grouping (ADR 0017).
//
// A folder is the container an artefact is published INTO — a label with its own public path
// that the folder is handed, holding no content of its own. A folder is what used to be called
// a client (the owner's rename ruling): renamed as such, so a member may use one for a client,
// a project, anything they like. Artefacts point at a folder (`artifacts.folder_id`); the
// folder index is rendered from that pointer, so it can never disagree with what is published.
//
// 1.x kept this as a directory with a meta.json per folder and a generated page at
// `/<folderToken>/`. 2.0 keeps the path shape and the promise behind it (a handed-out link
// stays valid): the id is the folder's path until it is named, and retiring either is an
// alias (see paths.js).
//
// A folder is also the unit of internal collaboration (access.js): a colleague is granted
// viewer, editor or manager on a folder and inherits it down the nesting. That makes two
// things invariants of this model rather than of its callers — a folder always belongs to
// the same owner as its parent (so an inherited grant can never walk into a second estate),
// and a move is announced, because moving a folder changes what a visitor share covers.

import { Effect } from "effect";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";

import { scalarSeal, scalarUnseal, sha256hex } from "./crypto.js";
import { mintPathId, normalizePath, pathTaken } from "./paths.js";

const nowIso = () => new Date().toISOString();

const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

export interface FolderRow {
  id: string;
  slug: string | null;
  name_sealed: string;
  owner_id: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  slug: string | null;
  nameSealed: string;
  ownerId: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FolderChange = (folderId: string) => Effect.Effect<unknown, CodeError>;
export interface CreateFolder {
  ownerId: string;
  name?: unknown;
  slug?: string | null;
  parentId?: string | null;
}
/** At most this much goes in one deletion (ADR 0038); larger trees are deleted bottom-up. */
export const FOLDER_DELETE_LIMITS = { artefacts: 200, folders: 100 } as const;
/** What deleting a folder removes, as its owner confirms it (ADR 0038). `artefacts` are
 *  published, `unpublished` have no first version; `snapshot` pins the subtree's folder and
 *  live artefact ids; `tooLarge` is the refusal when the subtree is over the cap. */
export interface FolderContents {
  folders: number; subfolders: number; artefacts: number; unpublished: number; versions: number;
  collections: number; records: number; responses: number; files: number; shares: number;
  snapshot: string; tooLarge: string | null;
}
/** The pre-read behind FolderContents: the id sets the deleting batch is guarded by. */
export interface FolderSubtree extends FolderContents { folderIds: string[]; artefactIds: string[]; foreignOwned: boolean }

export interface Folders {
  onChange: FolderChange | null;
  toFolder(row: FolderRow): Folder;
  toFolder(row: FolderRow | null | undefined): Folder | null;
  byId(id: unknown): Effect.Effect<Folder | null, CodeError>;
  bySlug(slug: unknown): Effect.Effect<Folder | null, CodeError>;
  aliasOf(path: string): Effect.Effect<Folder | null, CodeError>;
  aliasesFor(folderId: unknown): Effect.Effect<string[], CodeError>;
  byPath(path: unknown): Effect.Effect<Folder | null, CodeError>;
  all(): Effect.Effect<Folder[], CodeError>;
  ancestorIds(folderId: unknown): Effect.Effect<string[], CodeError>;
  subtreeIds(folderId: unknown): Effect.Effect<string[], CodeError>;
  name(folder: Folder | null | undefined): Effect.Effect<string, CodeError>;
  create(input: CreateFolder): Effect.Effect<Folder, CodeError>;
  setParent(folderId: string, parentId: string | null): Effect.Effect<Folder, CodeError>;
  rename(folderId: string, slug: unknown): Effect.Effect<Folder, CodeError>;
  alias(path: unknown, folderId: string): Effect.Effect<string, CodeError>;
  setName(folderId: string, name: unknown): Effect.Effect<Folder, CodeError>;
  contents(folderId: string): Effect.Effect<FolderSubtree, CodeError>;
  remove(folderId: string, confirm: { snapshot: string; actorId: string }): Effect.Effect<FolderSubtree, CodeError>;
  path(folder: Pick<Folder, "slug" | "id">): string;
}

function toFolder(row: FolderRow): Folder;
function toFolder(row: FolderRow | null | undefined): Folder | null;
function toFolder(row: FolderRow | null | undefined): Folder | null {
  return row ? {
    id: row.id, slug: row.slug ?? null, nameSealed: row.name_sealed,
    ownerId: row.owner_id, parentId: row.parent_id ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

// The folder ?1 and every folder below it.
const SUBTREE = "WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id = ?1" +
  " UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id)";
// The id sets a deletion was confirmed against (ADR 0038): ?3 the subtree's folders, ?4 its live artefacts, as JSON arrays.
const IN_FOLDERS = "IN (SELECT value FROM json_each(?3))", IN_ARTEFACTS = "IN (SELECT value FROM json_each(?4))";
// What goes with a subtree (?2 now), counted for the owner before they confirm.
const COUNTS = `SELECT (SELECT COUNT(*) FROM artifact_versions WHERE artifact_id ${IN_ARTEFACTS}) AS versions,` +
  ` (SELECT COUNT(*) FROM project_collections WHERE folder_id ${IN_FOLDERS}) AS collections,` +
  " (SELECT COUNT(*) FROM project_records r JOIN project_collections c ON c.folder_id = r.folder_id" +
  `   AND c.name = r.collection WHERE r.folder_id ${IN_FOLDERS} AND c.kind = 'records') AS records,` +
  " (SELECT COUNT(*) FROM project_records r JOIN project_collections c ON c.folder_id = r.folder_id" +
  `   AND c.name = r.collection WHERE r.folder_id ${IN_FOLDERS} AND c.kind = 'responses') AS responses,` +
  ` (SELECT COUNT(*) FROM project_files WHERE folder_id ${IN_FOLDERS} AND status IN ('uploading','ready','attached')) AS files,` +
  ` (SELECT COUNT(*) FROM shares WHERE ((kind = 'folder' AND target_id ${IN_FOLDERS}) OR (kind = 'artifact' AND target_id ${IN_ARTEFACTS}))` +
  "   AND revoked_at IS NULL AND expires_at > ?2) AS shares";
// The deleting batch's one rule, checked by its first statement only: the live subtree from ?1
// is exactly the confirmed folder set ?3 and holds exactly the confirmed live artefact set ?4,
// so a concurrent create, move, publish or withdrawal makes the whole batch a no-op.
const GUARD = `(${SUBTREE}, live(id) AS (SELECT id FROM artifacts WHERE folder_id IN (SELECT id FROM tree) AND deleted_at IS NULL)` +
  ` SELECT (SELECT COUNT(*) FROM tree) = json_array_length(?3) AND NOT EXISTS (SELECT 1 FROM tree WHERE id NOT ${IN_FOLDERS})` +
  ` AND (SELECT COUNT(*) FROM live) = json_array_length(?4) AND NOT EXISTS (SELECT 1 FROM live WHERE id NOT ${IN_ARTEFACTS}))`;
// Every later statement asks whether the first one fired: a live folder id is never a
// tombstone, so ?1 being both means this batch reserved it.
const DECIDED = "EXISTS (SELECT 1 FROM path_tombstones WHERE path = ?1) AND EXISTS (SELECT 1 FROM folders WHERE id = ?1)";

export function openFolders({ db, masterKeyHex, onChange = null }: {
  db: DatabaseLike;
  masterKeyHex: string;
  onChange?: FolderChange | null;
}): Folders {
  const required = Effect.fn(function* (id: string) {
    const folder = yield* self.byId(id);
    if (!folder) return yield* Effect.fail(coded("not-found", "no such folder"));
    return folder;
  });
  const changed = Effect.fn(function* (folderId: string) {
    if (self.onChange) yield* self.onChange(folderId);
  });

  const self: Folders = {
    // Injected after construction to avoid a cycle with the share model. Hook failures
    // propagate unchanged after the move lands, so callers can retry stale share wraps.
    onChange,
    toFolder,
    byId: Effect.fn(function* (id: unknown) {
      return toFolder(yield* io(() => db.prepare("SELECT * FROM folders WHERE id = ?")
        .bind(String(id ?? "")).first<FolderRow>()));
    }),
    bySlug: Effect.fn(function* (slug: unknown) {
      return toFolder(yield* io(() => db.prepare("SELECT * FROM folders WHERE slug = ?")
        .bind(String(slug ?? "")).first<FolderRow>()));
    }),
    aliasOf: Effect.fn(function* (path: string) {
      const row = yield* io(() => db.prepare("SELECT folder_id FROM folder_redirects WHERE old_slug = ?")
        .bind(path).first<{ folder_id: string }>());
      return row ? yield* self.byId(row.folder_id) : null;
    }),
    aliasesFor: Effect.fn(function* (folderId: unknown) {
      const { results } = yield* io(() => db.prepare("SELECT old_slug FROM folder_redirects WHERE folder_id = ? ORDER BY old_slug")
        .bind(String(folderId ?? "")).all<{ old_slug: string }>());
      return results.map((row) => row.old_slug);
    }),
    byPath: Effect.fn(function* (path: unknown) {
      const clean = normalizePath(path);
      if (!clean) return null;
      if (clean.includes("/")) return yield* self.aliasOf(clean);
      return (yield* self.bySlug(clean)) ?? (yield* self.byId(clean)) ?? (yield* self.aliasOf(clean));
    }),
    all: Effect.fn(function* () {
      const { results } = yield* io(() => db.prepare("SELECT * FROM folders ORDER BY created_at").all<FolderRow>());
      return results.map(row => toFolder(row));
    }),
    ancestorIds: Effect.fn(function* (folderId: unknown) {
      const { results } = yield* io(() => db.prepare(
        "WITH RECURSIVE chain(id, parent_id, depth, visited) AS (" +
        "  SELECT id, parent_id, 0, '|' || id || '|' FROM folders WHERE id = ?" +
        "  UNION ALL" +
        "  SELECT f.id, f.parent_id, c.depth + 1, c.visited || f.id || '|' FROM folders f JOIN chain c ON f.id = c.parent_id" +
        "   WHERE instr(c.visited, '|' || f.id || '|') = 0)" +
        " SELECT id FROM chain WHERE depth > 0 ORDER BY depth",
      ).bind(String(folderId ?? "")).all<{ id: string }>());
      return results.map((row) => row.id);
    }),
    subtreeIds: Effect.fn(function* (folderId: unknown) {
      const { results } = yield* io(() => db.prepare(`${SUBTREE} SELECT id FROM tree`)
        .bind(String(folderId ?? "")).all<{ id: string }>());
      return results.map((row) => row.id);
    }),
    name: Effect.fn(function* (folder: Folder | null | undefined) {
      return String((yield* scalarUnseal<{ n: string }>(masterKeyHex, folder?.nameSealed))?.n ?? "");
    }),
    create: Effect.fn(function* ({ ownerId, name = "", slug = null, parentId = null }: CreateFolder) {
      if (!ownerId) return yield* Effect.fail(coded("invalid-owner", "a folder needs an owner"));
      const clean = slug == null ? null : normalizePath(slug);
      if (slug != null && (!clean || clean.includes("/"))) return yield* Effect.fail(coded("invalid-slug", "slug must be one lowercase path segment"));
      if (clean && (yield* pathTaken(db, clean))) return yield* Effect.fail(coded("slug-taken", "that path is already in use"));
      let parent: Folder | null = null;
      if (parentId != null && parentId !== "") {
        parent = yield* self.byId(parentId);
        if (!parent) return yield* Effect.fail(coded("not-found", "no such parent folder"));
        if (parent.ownerId !== ownerId) return yield* Effect.fail(coded("forbidden", "a folder nests only inside its owner's estate"));
      }
      const id = yield* mintPathId(db);
      const at = nowIso();
      const nameSealed = yield* scalarSeal(masterKeyHex, { n: String(name ?? "") });
      yield* io(() => db.prepare(
        "INSERT INTO folders (id, slug, name_sealed, owner_id, parent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(id, clean, nameSealed, ownerId, parent?.id ?? null, at, at).run());
      return yield* required(id);
    }),
    setParent: Effect.fn(function* (folderId: string, parentId: string | null) {
      const folder = yield* required(folderId);
      let parent: Folder | null = null;
      if (parentId != null && parentId !== "") {
        parent = yield* self.byId(parentId);
        if (!parent) return yield* Effect.fail(coded("not-found", "no such parent folder"));
        if (parent.ownerId !== folder.ownerId) return yield* Effect.fail(coded("forbidden", "a folder nests only inside its owner's estate"));
      }
      // Ownership guards and the move are atomic: a top-level project cannot be nested while it owns
      // collections, project themes, or theme settings.
      const result = yield* io(() => db.prepare(
        "WITH RECURSIVE descendants(id) AS (" +
        " SELECT id FROM folders WHERE id = ? UNION" +
        " SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id)" +
        " UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?" +
        " AND (? IS NULL OR ? NOT IN (SELECT id FROM descendants))" +
        " AND (? IS NULL OR (NOT EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM project_themes WHERE folder_id = ?)" +
        " AND NOT EXISTS (SELECT 1 FROM project_theme_settings WHERE folder_id = ?)))",
      ).bind(folder.id, parent?.id ?? null, nowIso(), folder.id, parent?.id ?? null, parent?.id ?? null,
        parent?.id ?? null, folder.id, folder.id, folder.id).run());
      if (!result.meta?.changes) {
        const owns = yield* io(() => db.prepare(`SELECT 1 AS owns FROM project_collections WHERE folder_id = ?
          UNION ALL SELECT 1 FROM project_themes WHERE folder_id = ?
          UNION ALL SELECT 1 FROM project_theme_settings WHERE folder_id = ? LIMIT 1`)
          .bind(folder.id, folder.id, folder.id).first());
        if (owns) return yield* Effect.fail(coded("project-data", "This folder owns project data or themes; delete them before nesting it."));
        return yield* Effect.fail(coded("folder-cycle", "a folder cannot live inside itself"));
      }
      yield* changed(folder.id);
      return yield* required(folder.id);
    }),
    rename: Effect.fn(function* (folderId: string, slug: unknown) {
      const folder = yield* required(folderId);
      const clean = normalizePath(slug);
      if (!clean || clean.includes("/")) return yield* Effect.fail(coded("invalid-slug", "slug must be one lowercase path segment"));
      if (clean === folder.slug) return folder;
      if (yield* pathTaken(db, clean, { except: folderId })) return yield* Effect.fail(coded("slug-taken", "that path is already in use"));
      const at = nowIso();
      yield* io(() => db.batch([
        db.prepare("INSERT OR REPLACE INTO folder_redirects (old_slug, folder_id, created_at) VALUES (?,?,?)")
          .bind(folder.slug ?? folder.id, folderId, at),
        db.prepare("UPDATE folders SET slug = ?, updated_at = ? WHERE id = ?").bind(clean, at, folderId),
      ]));
      return yield* required(folderId);
    }),
    alias: Effect.fn(function* (path: unknown, folderId: string) {
      const clean = normalizePath(path);
      if (!clean) return yield* Effect.fail(coded("invalid-path", "an alias must be one path segment"));
      yield* required(folderId);
      if (yield* pathTaken(db, clean, { except: folderId })) return yield* Effect.fail(coded("slug-taken", "that path is already in use"));
      yield* io(() => db.prepare("INSERT OR REPLACE INTO folder_redirects (old_slug, folder_id, created_at) VALUES (?,?,?)")
        .bind(clean, folderId, nowIso()).run());
      return clean;
    }),
    setName: Effect.fn(function* (folderId: string, name: unknown) {
      yield* required(folderId);
      const nameSealed = yield* scalarSeal(masterKeyHex, { n: String(name ?? "") });
      yield* io(() => db.prepare("UPDATE folders SET name_sealed = ?, updated_at = ? WHERE id = ?")
        .bind(nameSealed, nowIso(), folderId).run());
      return yield* required(folderId);
    }),
    // The deletion pre-read: the subtree, its live artefacts, and what goes with them.
    contents: Effect.fn(function* (folderId: string) {
      const { results: folders } = yield* io(() => db.prepare(`${SUBTREE} SELECT f.id, f.owner_id FROM folders f JOIN tree USING (id)`)
        .bind(folderId).all<{ id: string; owner_id: string }>());
      const folderIds = folders.map(row => row.id), owner = folders.find(row => row.id === folderId)?.owner_id;
      const { results: live } = yield* io(() => db.prepare(`${SUBTREE} SELECT id, owner_id, current_version FROM artifacts` +
        " WHERE folder_id IN (SELECT id FROM tree) AND deleted_at IS NULL").bind(folderId).all<{ id: string; owner_id: string; current_version: number }>());
      const artefactIds = live.map(row => row.id);
      const row = yield* io(() => db.prepare(COUNTS).bind(folderId, nowIso(), JSON.stringify(folderIds), JSON.stringify(artefactIds))
        .first<Record<"versions" | "collections" | "records" | "responses" | "files" | "shares", number>>());
      const n = artefactIds.length, m = folderIds.length;
      return {
        folders: m, subfolders: Math.max(0, m - 1),
        artefacts: live.filter(a => Number(a.current_version) > 0).length, unpublished: live.filter(a => Number(a.current_version) === 0).length,
        versions: Number(row?.versions ?? 0), collections: Number(row?.collections ?? 0), records: Number(row?.records ?? 0),
        responses: Number(row?.responses ?? 0), files: Number(row?.files ?? 0), shares: Number(row?.shares ?? 0),
        snapshot: yield* sha256hex(`${[...folderIds].sort().join(",")}|${[...artefactIds].sort().join(",")}`),
        tooLarge: n > FOLDER_DELETE_LIMITS.artefacts || m > FOLDER_DELETE_LIMITS.folders
          ? `This folder holds ${n} artefact${n === 1 ? "" : "s"} in ${m} folder${m === 1 ? "" : "s"}; delete or move some subfolders first.` +
            ` At most ${FOLDER_DELETE_LIMITS.artefacts} artefacts and ${FOLDER_DELETE_LIMITS.folders} folders go in one deletion.`
          : null,
        folderIds, artefactIds,
        foreignOwned: folders.some(f => f.owner_id !== owner) || live.some(a => a.owner_id !== owner),
      };
    }),
    // One batch (ADR 0038), all or nothing: GUARD decides in the first statement, every later
    // one follows DECIDED. The subtree's folders go with their project data, aliases, grants and
    // shares; its live artefacts are withdrawn as artifacts.remove withdraws (their bytes, versions
    // and runtime state wait for the purge sweep) and every artefact is unfiled; every path the
    // subtree answered to stays reserved; the audit rows (one folder.delete, one artifact.delete per
    // artefact) hold ids and counts only. Returns the pre-read the owner confirmed.
    remove: Effect.fn(function* (folderId: string, { snapshot, actorId }: { snapshot: string; actorId: string }) {
      const folder = yield* required(folderId);
      const held = yield* self.contents(folder.id);
      if (held.foreignOwned) return yield* Effect.fail(coded("forbidden", "Part of this folder belongs to someone else; it cannot be deleted."));
      if (held.tooLarge) return yield* Effect.fail(coded("folder-too-large", held.tooLarge));
      const stale = coded("folder-changed", "This folder changed since you opened it. Review the counts and confirm again.");
      if (held.snapshot !== snapshot) return yield* Effect.fail(stale);
      const detail = JSON.stringify({
        folder: folder.id, slug: folder.slug, parent: folder.parentId ?? null, recursive: true,
        subfolders: held.folderIds.filter(id => id !== folder.id), folders: held.folders,
        artefacts: held.artefacts + held.unpublished, versions: held.versions, collections: held.collections,
        records: held.records, responses: held.responses, files: held.files, shares: held.shares,
      });
      const params = [folder.id, nowIso(), JSON.stringify(held.folderIds), JSON.stringify(held.artefactIds), actorId, detail];
      // Each statement binds ?1 up to the highest ?N it uses: D1 refuses surplus bindings.
      const bind = (sql: string) => db.prepare(sql).bind(...params.slice(0, Math.max(...[...sql.matchAll(/\?(\d)/g)].map(m => Number(m[1])))));
      const results = yield* io(() => db.batch([
        bind("INSERT OR IGNORE INTO path_tombstones (path, created_at) SELECT path, ?2 FROM (" +
          ` SELECT id AS path FROM folders WHERE id ${IN_FOLDERS} UNION SELECT slug FROM folders WHERE id ${IN_FOLDERS} AND slug IS NOT NULL` +
          ` UNION SELECT old_slug FROM folder_redirects WHERE folder_id ${IN_FOLDERS}) WHERE ${GUARD}`),
        bind(`DELETE FROM folder_redirects WHERE folder_id ${IN_FOLDERS} AND ${DECIDED}`),
        bind(`DELETE FROM folder_grants WHERE folder_id ${IN_FOLDERS} AND ${DECIDED}`),
        bind(`DELETE FROM project_records WHERE folder_id ${IN_FOLDERS} AND ${DECIDED}`),
        bind(`DELETE FROM project_collections WHERE folder_id ${IN_FOLDERS} AND ${DECIDED}`),
        bind(`DELETE FROM share_keys WHERE (share_id IN (SELECT id FROM shares WHERE kind = 'folder' AND target_id ${IN_FOLDERS})` +
          ` OR artifact_id ${IN_ARTEFACTS}) AND ${DECIDED}`),
        bind("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?2) WHERE ((kind = 'folder' AND target_id " +
          `${IN_FOLDERS}) OR (kind = 'artifact' AND target_id ${IN_ARTEFACTS})) AND ${DECIDED}`),
        bind(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?2) WHERE artifact_id ${IN_ARTEFACTS} AND ${DECIDED}`),
        bind("INSERT INTO audit_log (at, actor_type, actor_id, action, artifact_id, detail) SELECT ?2, 'user', ?5, 'artifact.delete'," +
          ` value, json_object('outcome', 'withdrawn', 'folder', ?1) FROM json_each(?4) WHERE ${DECIDED}`),
        bind(`INSERT INTO audit_log (at, actor_type, actor_id, action, detail) SELECT ?2, 'user', ?5, 'folder.delete', ?6 WHERE ${DECIDED}`),
        bind("UPDATE artifacts SET deleted_at = ?2, deleted_by = ?5, purged_at = NULL, current_version = 0, password_salt = NULL," +
          " password_verifier = NULL, key_wrap_password = NULL, key_wrap_master = NULL, updated_at = ?2" +
          ` WHERE id ${IN_ARTEFACTS} AND deleted_at IS NULL AND ${DECIDED}`),
        // Clear identity from every still-filed artifact, including previously withdrawn tombstones
        // omitted from the live-content snapshot, before cascading project theme deletion.
        bind(`UPDATE artifact_versions SET theme_scope = NULL, theme_slug = NULL, theme_id = NULL` +
          ` WHERE artifact_id IN (SELECT id FROM artifacts WHERE folder_id ${IN_FOLDERS})` +
          ` AND theme_scope = 'project' AND ${DECIDED}`),
        bind(`UPDATE artifacts SET folder_id = NULL WHERE folder_id ${IN_FOLDERS} AND ${DECIDED}`),
        bind(`DELETE FROM folders WHERE id ${IN_FOLDERS} AND ${DECIDED}`),
        // After the folder statement: the project's files go to the sweep only once the folder is gone.
        bind(`UPDATE project_files SET status = 'deleted', deleted_at = ?2 WHERE folder_id ${IN_FOLDERS} AND status <> 'deleted'` +
          " AND EXISTS (SELECT 1 FROM path_tombstones WHERE path = ?1) AND NOT EXISTS (SELECT 1 FROM folders WHERE id = ?1)"),
      ]));
      if (results.at(-2)?.meta?.changes) return held;
      yield* required(folder.id);
      return yield* Effect.fail(stale);
    }),
    path: (folder) => `/${folder.slug ?? folder.id}/`,
  };
  return self;
}
