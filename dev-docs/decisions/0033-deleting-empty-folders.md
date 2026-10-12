# 33. Deleting empty folders

Date: 2026-10-10
Status: Accepted
Extends: [17](0017-folders-and-the-folder-index.md), [21](0021-folders-are-the-container.md), [25](0025-subfolders-and-moving.md), [26](0026-collaboration-shares-and-observations.md), [32](0032-project-data-responses-and-mcp.md)

## Context

Owners could create, rename, nest and move folders but never remove one, so throwaway and
finished folders stayed in the estate forever. A folder is not a leaf: rows in several tables
are keyed by it (subfolders, artefacts, retired paths, colleague grants, folder visitor shares,
project collections and records), and its paths live in the single namespace shared with
artefacts (ADRs 0016, 0017, 0021). Deletion must neither orphan anything nor let an old link
resolve to somebody else's later content.

## Decision

- **Only an empty folder can be deleted.** Empty means no subfolder and no artefact row whose
  `deleted_at` is NULL. That covers live artefacts and rows without a first version yet, since a
  publish can still make those live in the folder. A non-empty folder is refused with
  `folder-not-empty` (console 409) and a message naming the counts that block it; nothing changes.
  No recursive or cascading delete: the owner moves or deletes the contents first.
- **Withdrawn artefacts do not block.** A deleted artefact is a terminal tombstone (migration
  0010 triggers forbid reactivation), so it cannot come back into the folder. Its `folder_id` is
  set to NULL in the deleting batch (the foreign key would otherwise refuse the delete); the
  tombstone keeps reserving its own paths, keyed by owner as before.
- **A stranded draft stops blocking after 15 minutes.** A row created before its first version
  (`current_version = 0`) whose publish then failed is invisible in every listing, so the owner
  could never find it. Once it is older than 15 minutes it is no in-flight publish; the deleting
  batch withdraws it exactly like a deleted artefact (keys and shares revoked, key wraps cleared)
  and unfiles it. A younger draft still blocks as `unpublished`.
- **Only the folder's owner may delete it** (`access.may(…, "own")`): the same authority as
  moving a folder or managing colleague grants (ADR 0026), because deletion ends those grants and
  the folder's visitor shares. Editors and managers cannot; platform Owner/Admin status grants
  nothing here.
- **Everything keyed by the folder goes in one D1 batch**, and every statement in that batch
  repeats the emptiness predicate. A concurrent move-in, publish, or subfolder creation makes the
  whole batch a no-op instead of leaving an orphan. Other writers are protected by foreign keys
  (artefact create/move, child folders, grants, project records) or by their own `INSERT … SELECT`
  predicates (collection definition), so they fail once the folder is gone. The batch:
  - reserves every path the folder answered to (id, slug, retired paths) in `path_tombstones`;
  - deletes its `folder_redirects` and `folder_grants`;
  - deletes its `project_records` and `project_collections` (ADR 0032's requirement);
  - revokes its folder visitor shares (`revoked_at`, as artefact deletion does) and deletes their
    `share_keys`; the share rows and their bounded observations stay for the existing retention
    and audit, and a revoked share can never be reopened;
  - moves withdrawn artefacts out (`folder_id = NULL`), then deletes the folder row.
- **API keys need no change.** No key is scoped to a folder: master keys act for their user
  through live `access.may`, and artefact keys are bound to one artefact, which by definition is
  no longer in an empty folder (keys of withdrawn artefacts were already revoked). A later request
  naming the folder's path finds nothing.
- **Paths stay reserved forever.** Migration 0014 adds `path_tombstones(path, created_at)`, and
  `paths.ts` counts it as a holder, so neither a new folder nor an artefact can claim the id, slug
  or any retired path of a deleted folder. Nothing resolves through the table: an old link answers
  the same neutral landing as an unknown path (ADR 0031). *Rationale:* this matches artefact
  deletion ("paths remain reserved as tombstones"); freeing the path would let a link handed to a
  client silently open whatever is created there next, possibly in another estate.
- **Audit:** `folder.delete` with the folder id, slug, parent id and the deleted collection,
  record and response counts. No folder name (sealed) and no record contents.
- **Console only.** `POST /app/f/<ref>/delete` with `confirm=delete`, in the owner's
  **Settings → Delete folder** panel. The pane receives the folder's counts: when it is not empty
  the panel shows them and offers no action; otherwise the confirmation dialog states how many
  collections, records and responses will be permanently deleted. Success redirects to the parent
  folder or `/app`, and the returned page carries the refreshed sidebar tree. There is no
  `/_api` or MCP folder deletion.

## Consequences

- Owners can clean up their estate without risk to links or data integrity; project data still
  lives exactly as long as its folder.
- A deleted folder's paths can never be reused, the same accepted cost as deleted artefacts.
- A share created concurrently with the deletion can be inserted after the batch (`shares.target_id`
  has no foreign key). It is inert: it targets an id that no longer exists and can never be minted
  again.
- Counts shown in the console are read before the batch; the batch itself decides.
- Deleting a non-empty folder requires emptying it first. A recursive delete would need its own
  ruling on artefact purges, R2 cleanup, and partial failure.
