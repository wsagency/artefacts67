# 32. Project application data, client responses and the MCP endpoint

Date: 2026-10-09
Status: Accepted; implemented
Extends: [13](0013-cloudflare-storage-layout.md), [15](0015-api-key-hierarchy.md), [19](0019-write-api-v2.md), [21](0021-folders-are-the-container.md), [26](0026-collaboration-shares-and-observations.md), [28](0028-opaque-artifact-applications-and-heroui-console.md), [31](0031-private-by-default-artefacts.md)

## Context

The owner wants artefacts to be dynamic applications: an authorized agent publishes a
questionnaire or offer, defines the data it needs, seeds records, and later retrieves the
answers and explicit confirmations clients submitted through native browser forms — over the
external API and MCP. Several artefacts of one project must use the same data, unrelated
projects must stay isolated, and the sandbox, private-by-default access and the no-source-read
API floor must not weaken.

Existing runtime state (ADR 0028) is per artefact (`personal`, `shared`) and has no cross-artefact
space, no agent access and no submission authority. There is no project entity; folders are the
only container (ADR 0021) and top-level folders already carry visitor shares (ADR 0026).

## Decision

### Project identity and binding

- **A project is an artefact's top-level folder**: the root of its folder chain, resolved live on
  every request. Placement in that subtree is the binding — consistent with top-level folder
  visitor shares. No separate project entity or binding table exists.
- **Unfiled artefacts have no project**; SDK data calls fail with code `no-project`.
- **Moving an artefact between projects rebinds it**; data stays with the project it was written to.
- **A top-level folder that owns collections cannot be moved under another folder** (409,
  code `project-data`). The guard is a predicate inside `folders.setParent`'s single `UPDATE`,
  and collection definition requires `parent_id IS NULL` inside its single `INSERT`, so a
  concurrent move and definition cannot both win. Moving a folder without collections, any
  subfolder, or a folder to the top level stays allowed (the latter starts an empty project).
  *Rationale:* data is never silently orphaned or merged into another project.
- **Folder deletion:** project data lives as long as its folder. Folder deletion is ruled by
  [ADR 0033](0033-deleting-empty-folders.md): only an empty folder can be deleted, and its
  `project_collections` and `project_records` are deleted in the same D1 batch as the folder.
- **Artefact deletion does not touch project data.** Records and responses belong to the project;
  a response keeps its `artifactId` as provenance after the artefact is withdrawn. Artefact
  deletion still purges that artefact's own `personal`/`shared` state (ADR 0028).
- **Duplicate, restore and publish** do not copy, rewind or reset project data. A duplicate binds
  to the project of its destination folder.

### Data model: declarative collections, no SQL

- A **collection** has a name `^[a-z][a-z0-9_-]{0,63}$`, a kind `records` or `responses`
  (immutable after creation; redefining with another kind → 409 `conflict`), a `fields` map of
  1–64 fields and a `visitors` boolean (default `false`). At most 50 collections per project.
  *Rationale:* a closed vocabulary validates writes without exposing a query language or
  platform tables to untrusted code.
- **Field names** match `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (they are usually HTML control names).
  Types: `text {maxLength 1–10000, default 2000}`, `email` (≤254 characters),
  `number {min, max, integer}`, `boolean`, `date` (`YYYY-MM-DD`, a real calendar date),
  `choice {options: 1–100 unique strings of 1–200 characters, multiple}`. Each field may be
  `required`; a **required boolean must be `true`** — that is the explicit confirmation.
- **Writes are validated** against the current definition. Unknown fields are rejected. The
  server coerces form strings: numbers from numeric strings; booleans from `true`/`false`/`"on"`/
  `"true"`/`"false"`; multiple choice from a string or an array. An absent boolean is stored as
  `false`. An empty string means "absent" for every type, so an optional empty control is omitted
  and a required one fails. Failures return `validation` with `issues: [{ field, message }]`.
- **Schema evolution:** `PUT` replaces `fields` and `visitors`; existing records are not rewritten;
  validation applies to writes only. Readers must tolerate records written under older definitions.
- Collection names and definitions are unsealed metadata (like slugs). Record data and
  submission metadata are sealed.

### Storage

- Migration `0013_project_data.sql`: `project_collections(folder_id, name, kind, schema_json,
  visitors, created_at, updated_at, PRIMARY KEY(folder_id, name))` and `project_records(id,
  folder_id, collection, version, data_sealed, submission_sealed, actor_key, artifact_id,
  created_at, updated_at)` with indexes `(folder_id, collection, created_at, id)` and
  `(folder_id, collection, actor_key)`.
- `data_sealed` and `submission_sealed` use `scalarSeal` under the master key, as runtime state does.
- **Quotas:** a record serializes to ≤64 KiB; ≤20,000 records and ≤64 MiB sealed bytes per
  project. Each insert/update decides quota, collection existence and kind in **one
  `INSERT … SELECT … WHERE` / `UPDATE … WHERE` statement**, so concurrent writers cannot both take
  the last slot (the runtime-state pattern).
- **Conflicts:** records carry an integer `version` starting at 1. Update and delete accept an
  optional `ifVersion`; a mismatch is 409 `conflict` and changes nothing. Without it, last write wins.
- The model is `worker/src/project-data.ts` (`openProjectData`), injected through `index.ts` ctx;
  it imports no other model and resolves the top-level folder with its own recursive query.

### Authority

- **External API and MCP accept master keys only.** An artifact key (`waa_`) gets 403: a leaked
  single-artefact key must not reach project-wide data.
- Through `keys.may(key, { ownerId, folderId: <top-level folder> }, need)`:
  - `read`: list collections; list/get records in a `records` collection.
  - `write`: define a collection; create/update/delete records; delete a `records` collection.
  - `manage`: list/get/delete records in a `responses` collection and delete a `responses`
    collection — the same tier that sees share observations.
- **Responses are client submissions:** agents can neither create nor edit them (403).
- **Viewer runtime** (the existing `/_runtime` grant, live authorization and rate limits):
  - `records`: read by signed-in readers with current read authority on the artefact; by share
    visitors only when `visitors` is true. Writes only when the existing `canWriteShared` holds
    (signed-in, live artefact write, never through a share).
  - `responses`: submit by signed-in readers with read authority; by share visitors only when
    `visitors` is true. `mine` returns only rows whose `actor_key` is the caller's reader identity
    in that collection; never other submitters'. Clients cannot update or delete responses.
  - A request through a share source counts as a share visitor even when the browser is signed in
    (same rule as `canWriteShared`).
  - Submissions additionally hit a limiter bucket of 30 per hour per reader per project, so one
    visitor cannot exhaust the 20,000-record quota at the general 180/minute rate. A signed-out
    reader's identity is a cookie that a client can drop, so signed-out submissions also share a
    ceiling of 120 per hour per client IP per project.
- Any reader with authority on any artefact of a project can, through the SDK, reach every
  `records` collection of that project that their role permits. The binding is the folder, not
  the artefact's code; place artefacts accordingly.

### Responses and confirmation

- Server-written submission metadata (sealed): `submittedAt` (server ISO time), `artifactId`,
  `artifactVersion` (the artefact's `currentVersion` at submission), and `submittedBy`:
  `{ type: "user", userId, email, name }` or `{ type: "share", shareId, shareName }`.
  `shareName` is the share's display name (its recipient address when unnamed).
- Responses are append-only for clients. Runtime views of a client's own responses expose only
  `submittedAt` and `artifactVersion` from the metadata.
- Confirmation is a **product acknowledgement**: a submitted required boolean through a recorded
  authority path. It is not an e-signature and not identity proof; a share link can be forwarded.
  Opening a link, visits and observations are never confirmation. Later revocation of access does
  not delete earlier submissions.

### External API

Under the existing `/_api` envelope, general limiter and audit:

| Method | Path |
|---|---|
| `GET` | `/_api/projects/{folder}/collections` |
| `PUT`, `DELETE` | `/_api/projects/{folder}/collections/{name}` |
| `GET`, `POST` | `/_api/projects/{folder}/collections/{name}/records` (`GET ?limit` default 100, max 500, `&cursor`) |
| `GET`, `PUT`, `DELETE` | `/_api/projects/{folder}/collections/{name}/records/{id}` (`PUT {data, ifVersion?}`; `DELETE ?ifVersion=`) |

`{folder}` resolves like publish (slug, id or retired alias); a non-top-level folder → 422
`validation` (field `folder`). Record view: `{ id, collection, version, data, createdAt,
updatedAt, submission? }`. Pages are ordered by `(createdAt, id)` ascending with an opaque cursor.
Quota exhaustion maps to 409 `conflict`, an oversized record to 413 `too-large`; the envelope's
code set is unchanged. Writes are audited without record contents. **API reads of artefact source
remain impossible.**

### MCP

- `POST /_mcp` (and `/_mcp/`): MCP Streamable HTTP, stateless, JSON responses only (no SSE;
  `GET`/`DELETE` → 405), JSON-RPC 2.0, no new dependency. Same `Authorization: Bearer` master key.
- A present `Origin` header that is not the Worker's own origin → 403 (DNS-rebinding guard).
- Methods: `initialize` (supports `2025-06-18` and `2025-03-26`; echoes a supported client
  version, otherwise answers `2025-06-18`; `capabilities: { tools: {} }`; `serverInfo`),
  `notifications/*` and client response messages (an `id` with `result`/`error`, no `method`) →
  202 with an empty body, `ping`, `tools/list`, `tools/call`. Unknown method → `-32601`; batch
  arrays and an `id` that is not a string or number → `-32600`. An unsupported
  `MCP-Protocol-Version` header → 400.
- Tools delegate to `handleApi` with a synthetic `Request` carrying the caller's Authorization,
  so authority, rate limits and audit have one path: `list_folders`, `list_artifacts`,
  `publish_artifact`, `list_collections`, `define_collection`, `delete_collection`,
  `list_records`, `get_record`, `create_record`, `update_record`, `delete_record`. Results are
  `content: [{ type: "text", text: <JSON> }]` plus `structuredContent`; API error envelopes set
  `isError: true`. Each tool publishes an `inputSchema`.

### SDK and native forms

- `window.artefacts.data` = `list(collection, { limit, cursor })`, `get(collection, id)`,
  `create(collection, data)`, `update(collection, id, data, { ifVersion })`,
  `delete(collection, id, { ifVersion })`, `submit(collection, eventOrFormOrObject)`,
  `mine(collection)`. A new bridge message `data` reaches `POST /_runtime/data` with the existing
  grant. Promises resolve only after the server committed; validation rejects with code
  `validation` and `issues`.
- `submit(collection, eventOrFormOrObject)` serializes `FormData` (from a `SubmitEvent`, including its submitter's
  name/value): repeated names become arrays, `File` values are rejected.
- No `allow-forms`, no CSP relaxation. Chromium (probed on 152) blocks every real submission in the
  `allow-scripts` sandbox before interactive validation and before the `submit` event, so a small
  child-script shim restores native submit semantics (submit-button clicks, implicit Enter
  submission, `requestSubmit()`, `novalidate`/`formnovalidate`, `method="dialog"`): after authored
  click handlers (an authored click `preventDefault()` cancels) it cancels the blocked default,
  runs `form.reportValidity()` and dispatches a cancelable `SubmitEvent` with the submitter;
  nested submission during that dispatch is a no-op. It never navigates and does not emulate
  `formaction`/`formmethod`/`formtarget`.
- A standalone exported file has no SDK; authored code must detect `window.artefacts?.data`.

## Consequences

- Agents can provision models, seed data and collect confirmations without touching HTML or SQL;
  publishing never resets project data.
- Per-artefact `personal`/`shared` keep their exact meanings; project data is a third, explicit
  surface, not a substitute.
- A top-level folder with collections is pinned to the top level until its collections are deleted.
- Record contents are sealed at rest; collection names and field definitions are not.
- Old records may not satisfy a newer definition; consumers handle that.
- ADR 0028's statement that the SDK provides no AI/MCP authority still holds: MCP is a separate,
  key-authenticated external surface over the same data.

## Out of scope

Realtime push, webhooks, external integrations, a form-builder UI, e-signature or identity proof,
SQL or query languages, file uploads, anonymous submission without a share, and agent access to
other readers' `personal` data.
