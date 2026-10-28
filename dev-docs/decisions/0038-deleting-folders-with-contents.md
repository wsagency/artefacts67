# 38. Deleting a folder with its contents

Date: 2026-10-12
Status: Accepted 2026-10-12. The owner approved all eight recommended defaults of the ticket's owner questions (cap 200/100, typed name for every folder, no step-up, no trash, subfolder project data kept, daily byte removal, per-artefact audit rows, console only).
Supersedes (in part): [33](0033-deleting-empty-folders.md) (the emptiness rule, the stale-draft rule and `folder-not-empty`)
Extends: [18](0018-version-retention.md), [21](0021-folders-are-the-container.md), [25](0025-subfolders-and-moving.md), [26](0026-collaboration-shares-and-observations.md), [28](0028-opaque-artifact-applications-and-heroui-console.md), [31](0031-private-by-default-artefacts.md), [32](0032-project-data-responses-and-mcp.md), [35](0035-project-files.md)

Line references are to `origin/main` at `79e3e6d`.

## Context

ADR 0033 lets an owner delete only an empty folder (`0033:18-22`) and leaves a recursive delete
to "its own ruling on artefact purges, R2 cleanup, and partial failure" (`0033:76-77`). The owner
has asked for that: delete a folder together with everything in it. This ADR is that ruling. It
amends ADR 0033 by number rather than in place because it reverses 0033's central rule; the rest
of 0033 (tombstones, owner-only, console-only, revocation semantics) carries over unchanged.

### What exists today

- **Folder deletion** is `POST /app/f/<ref>/delete` (`worker/src/console.ts:970-974`,
  `1120-1132`): owner-only (`1122`), `confirm=delete` (`1123`), audit `folder.delete` with id, slug,
  parent and project-data counts (`1126-1129`). `folders.remove` (`worker/src/folders.ts:275-313`)
  runs one D1 batch (`279-304`) whose every statement repeats `EMPTY` (`98-107`): it tombstones the
  folder's id, slug and retired paths (`280-282`), deletes redirects, grants, project records and
  collections (`283-286`), deletes folder-share keys and revokes folder shares (`287-290`),
  withdraws drafts stranded for 15 minutes (`291-298`), unfiles withdrawn artefacts (`299`),
  deletes the folder (`300`) and then marks its project files `deleted` (`301-303`). The folder
  `DELETE` decides (`305`); otherwise `folder-not-empty` (`306-312`, console 409 at `135`).
  The console panel shows blockers instead of an action (`frontend/src/ui.tsx:161-169`,
  `frontend/src/estate.tsx:81`, counts from `worker/src/console.ts:1006` and
  `worker/src/folders.ts:109-116`, `264-270`).
- **Paths** are reserved by `path_tombstones` (`worker/migrations/0014_folder_deletion.sql:5-8`),
  which `paths.ts` counts as a holder (`worker/src/paths.ts:44-49`); `mintPathId` never returns a
  held path (`73-80`). A withdrawn artefact row keeps holding its id and slug, and its
  `slug_redirects` keep holding its aliases (`paths.ts:45-46`, `0010_artifact_lifecycle.sql:1-2`).
- **Artefact deletion** is `POST /app/a/<ref>/delete`, owner-only with `confirm=delete`
  (`worker/src/console.ts:1286-1288`), audited as `artifact.delete` with outcome
  `purged`/`withdrawn`/`failed` (`1289-1297`). `artifacts.remove` (`worker/src/artifacts.ts:444-467`)
  withdraws in one batch (`446-453`): `deleted_at`, `current_version = 0`, key wraps and gate
  verifier cleared (`447`), artefact API keys revoked (`449`), artefact shares revoked (`450`),
  share keys deleted (`451`), runtime state deleted (`452`). It then lists `art/<id>/` in R2 and
  deletes object by object (`454-460`), deletes the `artifact_versions` rows and sets `purged_at`
  (`461-464`); any failure is `purge-failed` (503, `console.ts:136`) and needs a manual retry
  (`artifacts.ts:465`). Migration 0010's triggers make withdrawal terminal and refuse a racing
  version insert (`0010_artifact_lifecycle.sql:9-25`). Project data is not touched by artefact
  deletion (ADR `0032:39-41`); records keep `artifact_id` as provenance without a foreign key
  (`0013_project_data.sql:15`).
- **Project data** lives only on a top-level folder: `define` requires `parent_id IS NULL`
  (`worker/src/project-data.ts:393-397`, `409`) and a folder that owns collections cannot be
  nested (`worker/src/folders.ts:216-228`). **Project files** have no foreign keys
  (`0016_project_files.sql:4-22`, ADR `0035:127-128`); a folder/collection/record delete marks
  them `deleted` (ADR `0035:386-389`), and the daily cron (`worker/wrangler.jsonc:37-41`,
  `worker/src/index.ts:193-202`) runs `projectFiles.sweep()`: ≤10 rounds of 100 rows, one hour of
  grace, multipart abort, one batched R2 `delete`, then rows; a bucket failure leaves the rows for
  the next run (`worker/src/project-files.ts:19`, `81-82`, `325-348`). An upload start is refused
  once the collection is gone and aborts its multipart upload (`project-files.ts:185-208`).
- **Visitor shares** are created for an artefact or a top-level folder (`worker/src/shares.ts:355`),
  but a shared folder that is later nested keeps its own share (ADR `0026:38`), so folder shares
  can target any folder of a subtree. Scope is evaluated live through ancestry
  (`shares.ts:200-212`); `share_keys` hold the per-artefact wraps (`0007_visitor_shares.sql:51-57`);
  `shares.target_id` has no foreign key (`0007_visitor_shares.sql:28`). Observations (`share_visits`, foreign keys to
  shares and artefacts, `0008_share_analytics.sql:5-16`) are pruned only by analytics retention.
- **Retention settings** of the platform owner: version retention (default 100, minimum 1, no
  maximum: `0003_add_folders.sql:34-41`, `worker/src/store.ts:286-303`, applied by
  `artifacts.ts:204-211`), and observation retention (1–365 days, default 90:
  `0008_share_analytics.sql:3`, `worker/src/analytics.ts:66-90`, ADR `0026:52`). Anonymous personal
  runtime entries expire after 365 days (`worker/src/instructions.ts:227`). **There is no trash,
  soft-delete or undo window** anywhere; `deleted_at` is a terminal tombstone, not a recycle bin.
  Outside the product, D1 Time Travel can restore the *whole database* to a point within 30 days
  ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)); that is operator disaster
  recovery which rolls back everything else too, and it cannot bring back purged R2 bytes.
- **Gap:** nothing ever purges an artefact whose `purged_at` stayed NULL: drafts withdrawn by
  0033's batch (`folders.ts:291-292`) and failed purges (`artifacts.ts:465`).

### Limits that shape the design

- A D1 batch is one SQL transaction: a failing statement rolls back the whole sequence
  ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), "Batched
  statements are SQL transactions").
- D1 ([limits](https://developers.cloudflare.com/d1/platform/limits/)): 100 bound parameters and
  100 KB per statement, each applying to every statement of a batch; 30 s maximum query duration,
  which also applies to the whole batch call; 1,000 queries per Worker invocation on Workers Paid;
  writes touching hundreds of thousands of rows must be chunked.
- Workers Paid: 10,000 subrequests per invocation by default
  ([changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)).
- R2 `delete` takes up to 1,000 keys per call; `list` returns up to 1,000 entries per page
  ([R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).
- D1 enforces foreign keys as `PRAGMA foreign_keys = on`
  ([D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)); SQLite checks an
  immediate constraint at the conclusion of each statement
  ([SQLite foreign keys](https://www.sqlite.org/foreignkeys.html) §4.2), so one `DELETE` may remove
  a parent folder and its children together.

## Considered options

1. **Client-side loop over existing deletes** (the console deletes each artefact through
   `/app/a/<ref>/delete`, then each folder bottom-up through today's empty-folder delete). No new
   server code, but not atomic: a closed tab, a `purge-failed`, or a colleague publishing into an
   already-emptied subfolder leaves a half-deleted tree with no record of intent; N requests each
   doing an inline R2 purge. **Rejected.**
2. **One server action: a guarded D1 batch, R2 bytes through the daily sweep.** One transaction
   decides the whole subtree; bytes are removed by the existing cron, which gains an artefact purge
   that also closes the gap above. Bounded by a cap. **Chosen.**
3. **Asynchronous job** (a `deleting` folder state worked off in chunks by a Queue, Workflow or
   Durable Object). Unbounded size, but every read path must learn to hide a half-deleted folder,
   it needs a migration, a new binding and a progress UI, and partial states become visible.
   **Rejected:** the cap plus bottom-up deletion (each step atomic) covers large trees.

## Decision

- **A folder is deleted with everything in it.** `folder-not-empty`, `EMPTY`, `BLOCKING`,
  `STALE_DRAFT` and `DRAFTS` (`folders.ts:98-108`, `305-312`, `console.ts:135`) are removed: an
  empty folder is simply the smallest subtree. There is one deletion path.
- **Authority: only the folder's owner** (`access.may(…, "own")`, `worker/src/access.ts:152-161`),
  as in ADR 0033 and artefact deletion. Editors, managers and platform Owner/Admin cannot.
- **A subtree has one owner.** Every write that puts something into a folder requires the same
  owner: folder create (`folders.ts:194-198`), folder move (`folders.ts:211-214`), artefact create
  (`artifacts.ts:254-259`), artefact move (`artifacts.ts:406-414`, `console.ts:1362`); content a
  colleague creates in a folder belongs to the folder's owner (`console.ts:936-937`, `1067-1068`);
  no code changes an owner. So the owner deleting a folder never deletes another user's content.
  The pre-read refuses with `forbidden` if any folder or artefact in the subtree has a different
  owner (defence against legacy data).
- **Scope.** For the root and every descendant folder, and every artefact filed in them:
  - **Artefacts** (published and unpublished) are withdrawn exactly as `artifacts.remove` withdraws
    them (`artifacts.ts:447-451`): `deleted_at`/`deleted_by`, `current_version = 0`, key wraps and
    gate verifier cleared, API keys and artefact shares revoked, share keys deleted. Withdrawn rows
    stay as path-holding tombstones with their aliases, then are unfiled (`folder_id = NULL`).
    Already-withdrawn artefacts are only unfiled.
  - **Versions, R2 objects and runtime state** go in the purge (below): the content keys are gone
    at commit, so the bytes are unreadable from that moment (crypto-shredded); runtime state is
    unreachable for a withdrawn artefact (`worker/src/runtime-state.ts:133`, `179-182`,
    `worker/src/artifact-runtime.ts:240`) and is deleted by the purge, which keeps the batch small
    (up to 4,096 keys per artefact, `instructions.ts:93`).
  - **Folders:** every path any of them answered to (id, slug, retired paths) is inserted into
    `path_tombstones`; their redirects and colleague grants are deleted; folder shares targeting any
    of them are revoked and their share keys deleted; then the folder rows are deleted in one
    statement.
  - **Project data:** only a top-level folder can own any (`project-data.ts:397`). If the root is
    top-level, its collections and records are deleted and its files marked `deleted` as today
    (`folders.ts:285-286`, `301-303`); the file sweep removes bytes, parts and open multipart
    uploads. Deleting a subfolder of a project leaves the project's data with the top-level folder,
    including records submitted from the deleted artefacts (ADR `0032:39-41`).
  - **Kept:** revoked share rows and their observations until analytics retention prunes them
    (ADR `0033:44-46`, `analytics.ts:77-80`); audit rows; artefact reports.
- **Paths stay reserved forever**, exactly as in ADR 0033: nothing resolves through a tombstone,
  and an old link answers the neutral page of an unknown path (ADR `0031:15`).
- **One guarded batch decides.**
  1. *Pre-read* (one request, before the batch): the subtree's folder ids (the recursive CTE of
     `folders.ts:176-185`), the non-withdrawn artefact ids filed in them, and the counts shown to
     the owner. Its **snapshot** is the SHA-256 of the sorted folder ids and the sorted artefact
     ids. The confirmation form posts the snapshot the owner saw; a different current snapshot is
     `folder-changed` (409, "This folder changed since you opened it. Review the counts and confirm
     again."), and nothing changes.
  2. *First statement:* `INSERT OR IGNORE INTO path_tombstones` of all subtree paths, `WHERE` the
     live subtree's folder set and non-withdrawn artefact set equal the pre-read sets (bound as two
     JSON arrays, compared by count and `NOT IN json_each`). A live folder id is never in
     `path_tombstones` (`paths.ts:44-49`, `73-80`), so after this statement *"the root id is a
     tombstone and the root folder row still exists"* is true exactly when this batch's guard held.
  3. *Every later statement* repeats that predicate (`DECIDED`) and works on the bound id sets;
     inside one transaction nothing can change them in between. A concurrent move-in, move-out,
     publish of a new artefact or new subfolder that commits before the batch makes the guard fail
     and the whole batch a no-op; the model then reports `folder-changed`. The root folder
     `DELETE` row count decides success, as `folders.ts:305` does today.
  4. Statements after the folder `DELETE` (project files) are guarded by "root id tombstoned and
     root folder gone": `folders.ts:302-303`'s predicate plus the tombstone.
- **Writers racing the deletion** fail by the guards they already have: artefact create and move
  and folder create and move hit the foreign keys to `folders` once the rows are gone
  (`0003_add_folders.sql:21`, `0005_add_subfolders.sql:5`); a version insert after withdrawal is
  refused by the trigger (`0010_artifact_lifecycle.sql:9-16`) and `writeVersion` deletes its own
  object (`artifacts.ts:237-245`); grants hit their foreign key (`0006_folder_collaboration.sql:19`);
  collection define needs the folder (`project-data.ts:397`); an upload start needs the collection
  (`project-files.ts:191`, `202`); a share inserted after the batch is inert (ADR `0033:72-74`).
  Version counts and project-data volumes are not part of the guard: counts shown are read before
  the batch, and the batch decides (ADR `0033:75`). A version published before the batch is purged
  with the rest.
- **Readers** lose access at commit: ordinary and share access require a live artefact and current
  share (`artifact-runtime.ts:240`, `shares.ts:217`, `460`, ADR `0031:15-18`), share keys are gone, and the master and
  password wraps are cleared. A project file download already streaming may finish; its bytes are
  deleted no earlier than one hour later.
- **Cap instead of chunking.** A subtree with more than **200 non-withdrawn artefacts** or more
  than **100 folders** (root included) is refused with `folder-too-large` (409, "This folder holds
  N artefacts in M folders; delete or move some subfolders first. At most 200 artefacts and 100
  folders go in one deletion."). The panel shows the same message instead of the action.
  *Rationale:* one transaction keeps all-or-nothing semantics and needs no resumable state; the
  owner reaches any size by deleting subfolders first, each step atomic. The cap bounds the JSON
  parameters (~7 KB), share-key rows (shares × 200) and the purge backlog (two daily runs). The
  largest work left in the batch is a project's data, which today's empty-folder delete already
  does in one batch (≤20,000 records, ≤10,000 files).
- **Bytes go through the daily cron.** A new `artifacts.sweep()` runs next to
  `projectFiles.sweep()` (`index.ts:193-202`): up to 10 rounds of 10 artefacts with
  `deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at <= now − 1 h`, oldest first. Per
  artefact it runs the purge body extracted from `artifacts.remove` (`artifacts.ts:454-464`), with
  one batched R2 `delete` per `list` page instead of one call per object, and one D1 batch that
  deletes `artifact_versions` and `artifact_runtime_state` rows and sets `purged_at`; it refuses
  an artefact that is not withdrawn. A failed purge leaves its rows for the next run and is logged
  by artefact id only; the run goes on with the next artefact, within the same 100.
  `artifacts.remove` keeps its inline purge through the same body.
  This also purges 0033's withdrawn drafts and failed purges, so `purge-failed` no longer needs a
  manual retry. The hour of grace lets an in-flight publish finish (or fail and clean up) first.
- **Audit without content.** The deletion's batch writes `folder.delete` with `folder`, `slug`,
  `parent`, `recursive: true`, `subfolders` (their ids) and the pre-read counts (folders,
  artefacts, versions, collections, records, responses, files, active shares). The batch also
  writes one `artifact.delete` row per withdrawn artefact (`artifact_id` set, detail
  `{ outcome: "withdrawn", folder: <root id> }`), so an artefact's trail ends with its deletion as
  it does today (`console.ts:1289-1297`). No folder names, titles or record contents.
- **Console only.** `POST /app/f/<ref>/delete`, **Settings → Delete folder**. No `/_api` or MCP
  folder deletion, as in ADR 0033 and the agent guide (`instructions.ts:84`).
- **Confirmation.** The panel lists exact counts: subfolders, artefacts (published and
  unpublished), retained versions, collections, records, responses, files, and active visitor
  shares (artefact and folder shares in the subtree that are neither revoked nor expired). The
  dialog states that this is permanent, that links stop working and stay reserved, and that no
  retention setting keeps a copy. The owner types the folder's displayed name (`console.ts:996`),
  compared exactly after trimming on the client (enables the button) and on the server (else
  `bad-action`); it replaces `confirm=delete`.

## Consequences

- An owner removes a whole tree in one confirmed step; links, shares and grants end atomically,
  and no path can ever resolve to later content.
- Irreversible in the product: there is no trash, and deleted content is unreadable at commit.
  Bytes and version rows remain in R2/D1 for up to about a day (two daily runs at the cap),
  unreadable. Only a whole-database D1 Time Travel restore before the purge could bring rows back.
- `folder-not-empty` disappears from the console error map and documentation; `folder-changed`
  and `folder-too-large` are new console errors.
- The cron gains one bounded sweep: ≤100 artefacts per run, about four subrequests each.
- A subtree beyond the cap needs several deletions, bottom-up.
- Not addressed: bulk deletion through the API or MCP, an undo window, ownership transfer.
