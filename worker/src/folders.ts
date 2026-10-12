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

import { scalarSeal, scalarUnseal } from "./crypto.js";
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
/** What a folder holds. The first three block deletion; project data goes with the folder. */
export interface FolderContents {
  subfolders: number; artefacts: number; unpublished: number;
  collections: number; records: number; responses: number;
}

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
  contents(folderId: string): Effect.Effect<FolderContents, CodeError>;
  remove(folderId: string): Effect.Effect<FolderContents, CodeError>;
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

// Deletion's one rule (ADR 0033), repeated inside every statement of the deleting batch so a
// concurrent move-in, publish or new subfolder makes the whole batch a no-op. A withdrawn
// artefact is a terminal tombstone and does not block; every other artefact row could still be
// (re)published into the folder — except a draft whose first publish failed (no version after
// 15 minutes, invisible in every listing), which the batch withdraws like a deleted artefact.
const STALE_DRAFT = "deleted_at IS NULL AND current_version = 0" +
  " AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')";
const BLOCKING = `deleted_at IS NULL AND NOT (${STALE_DRAFT})`;
const EMPTY = "NOT EXISTS (SELECT 1 FROM folders WHERE parent_id = ?1)" +
  ` AND NOT EXISTS (SELECT 1 FROM artifacts WHERE folder_id = ?1 AND ${BLOCKING})`;
const DRAFTS = `SELECT id FROM artifacts WHERE folder_id = ?1 AND ${STALE_DRAFT}`;
const CONTENTS = "SELECT (SELECT COUNT(*) FROM folders WHERE parent_id = ?1) AS subfolders," +
  " (SELECT COUNT(*) FROM artifacts WHERE folder_id = ?1 AND deleted_at IS NULL AND current_version > 0) AS artefacts," +
  ` (SELECT COUNT(*) FROM artifacts WHERE folder_id = ?1 AND ${BLOCKING} AND current_version = 0) AS unpublished,` +
  " (SELECT COUNT(*) FROM project_collections WHERE folder_id = ?1) AS collections," +
  " (SELECT COUNT(*) FROM project_records r JOIN project_collections c ON c.folder_id = r.folder_id" +
  "   AND c.name = r.collection WHERE r.folder_id = ?1 AND c.kind = 'records') AS records," +
  " (SELECT COUNT(*) FROM project_records r JOIN project_collections c ON c.folder_id = r.folder_id" +
  "   AND c.name = r.collection WHERE r.folder_id = ?1 AND c.kind = 'responses') AS responses";

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
      const { results } = yield* io(() => db.prepare(
        "WITH RECURSIVE tree(id) AS (" +
        "  SELECT id FROM folders WHERE id = ?" +
        "  UNION" +
        "  SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id)" +
        " SELECT id FROM tree",
      ).bind(String(folderId ?? "")).all<{ id: string }>());
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
      // The cycle predicate, project-data guard and move are atomic even for concurrent opposite moves.
      // A project is a top-level folder (ADR 0032); nesting one would orphan its collections.
      const result = yield* io(() => db.prepare(
        "WITH RECURSIVE descendants(id) AS (" +
        " SELECT id FROM folders WHERE id = ? UNION" +
        " SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id)" +
        " UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?" +
        " AND (? IS NULL OR ? NOT IN (SELECT id FROM descendants))" +
        " AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ?))",
      ).bind(folder.id, parent?.id ?? null, nowIso(), folder.id, parent?.id ?? null, parent?.id ?? null, parent?.id ?? null, folder.id).run());
      if (!result.meta?.changes) {
        const owns = yield* io(() => db.prepare("SELECT 1 AS owns FROM project_collections WHERE folder_id = ? LIMIT 1").bind(folder.id).first());
        if (owns) return yield* Effect.fail(coded("project-data", "This folder owns project data collections; delete them before nesting it."));
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
    contents: Effect.fn(function* (folderId: string) {
      const row = yield* io(() => db.prepare(CONTENTS).bind(folderId).first<Record<keyof FolderContents, number>>());
      return {
        subfolders: Number(row?.subfolders ?? 0), artefacts: Number(row?.artefacts ?? 0), unpublished: Number(row?.unpublished ?? 0),
        collections: Number(row?.collections ?? 0), records: Number(row?.records ?? 0), responses: Number(row?.responses ?? 0),
      };
    }),
    // One batch, every statement guarded by EMPTY: the folder goes with its project data,
    // aliases and grants; its folder shares are revoked like a deleted artefact's; withdrawn
    // artefacts become unfiled tombstones; and every path it answered to stays reserved.
    // Returns what the folder held as read just before the batch.
    remove: Effect.fn(function* (folderId: string) {
      const folder = yield* required(folderId);
      const held = yield* self.contents(folder.id);
      const at = nowIso();
      const results = yield* io(() => db.batch([
        db.prepare("INSERT OR IGNORE INTO path_tombstones (path, created_at) SELECT path, ?2 FROM (" +
          " SELECT id AS path FROM folders WHERE id = ?1 UNION SELECT slug FROM folders WHERE id = ?1 AND slug IS NOT NULL" +
          ` UNION SELECT old_slug FROM folder_redirects WHERE folder_id = ?1) WHERE ${EMPTY}`).bind(folder.id, at),
        db.prepare(`DELETE FROM folder_redirects WHERE folder_id = ?1 AND ${EMPTY}`).bind(folder.id),
        db.prepare(`DELETE FROM folder_grants WHERE folder_id = ?1 AND ${EMPTY}`).bind(folder.id),
        db.prepare(`DELETE FROM project_records WHERE folder_id = ?1 AND ${EMPTY}`).bind(folder.id),
        db.prepare(`DELETE FROM project_collections WHERE folder_id = ?1 AND ${EMPTY}`).bind(folder.id),
        db.prepare("DELETE FROM share_keys WHERE share_id IN (SELECT id FROM shares WHERE kind = 'folder' AND target_id = ?1)" +
          ` AND ${EMPTY}`).bind(folder.id),
        db.prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?2) WHERE kind = 'folder' AND target_id = ?1" +
          ` AND ${EMPTY}`).bind(folder.id, at),
        // Stale drafts are withdrawn exactly as artifacts.remove withdraws (no versions exist to purge;
        // purged_at stays NULL in case a failed first publish left an object behind), then unfiled.
        db.prepare(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?2) WHERE artifact_id IN (${DRAFTS}) AND ${EMPTY}`).bind(folder.id, at),
        db.prepare(`UPDATE shares SET revoked_at = COALESCE(revoked_at, ?2) WHERE kind = 'artifact' AND target_id IN (${DRAFTS}) AND ${EMPTY}`).bind(folder.id, at),
        db.prepare(`DELETE FROM share_keys WHERE artifact_id IN (${DRAFTS}) AND ${EMPTY}`).bind(folder.id),
        db.prepare(`DELETE FROM artifact_runtime_state WHERE artifact_id IN (${DRAFTS}) AND ${EMPTY}`).bind(folder.id),
        db.prepare("UPDATE artifacts SET deleted_at = ?2, purged_at = NULL, password_salt = NULL, password_verifier = NULL," +
          ` key_wrap_password = NULL, key_wrap_master = NULL, updated_at = ?2 WHERE folder_id = ?1 AND ${STALE_DRAFT} AND ${EMPTY}`).bind(folder.id, at),
        db.prepare(`UPDATE artifacts SET folder_id = NULL WHERE folder_id = ?1 AND deleted_at IS NOT NULL AND ${EMPTY}`).bind(folder.id),
        db.prepare(`DELETE FROM folders WHERE id = ?1 AND ${EMPTY}`).bind(folder.id),
        // After the folder statement: its files go to the sweep only once the folder is gone.
        db.prepare("UPDATE project_files SET status = 'deleted', deleted_at = ?2 WHERE folder_id = ?1 AND status <> 'deleted'" +
          " AND NOT EXISTS (SELECT 1 FROM folders WHERE id = ?1)").bind(folder.id, at),
      ]));
      if (results.at(-2)?.meta?.changes) return held;
      yield* required(folder.id);
      const now = yield* self.contents(folder.id);
      const blockers = ([[now.subfolders, "subfolder"], [now.artefacts, "artefact"], [now.unpublished, "unpublished artefact"]] as const)
        .filter(([n]) => n > 0).map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`);
      return yield* Effect.fail(coded("folder-not-empty", blockers.length
        ? `This folder still contains ${blockers.join(" and ")}. Move or delete them first, then delete the folder.`
        : "This folder changed while it was being deleted. Check it and try again."));
    }),
    path: (folder) => `/${folder.slug ?? folder.id}/`,
  };
  return self;
}
