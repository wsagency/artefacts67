# 35. Project files: a `file` field type with resumable, sealed uploads

Date: 2026-10-12
Status: Accepted
Extends: [13](0013-cloudflare-storage-layout.md), [14](0014-crypto-tiering.md), [28](0028-opaque-artifact-applications-and-heroui-console.md), [31](0031-private-by-default-artefacts.md), [32](0032-project-data-responses-and-mcp.md), [33](0033-deleting-empty-folders.md)

## Context

The owner wants private file storage (zip, pdf, images, audio …) for artefact applications:
agents and editors upload files that readers can download or the artefact can display, and
clients upload files through `<input type="file">` inside artefacts. Today
`window.artefacts.data.submit` rejects file inputs ("File uploads are not supported."), every
API/runtime body is buffered JSON (80 KiB runtime, 2 MiB API), and `R2BucketLike` has no ranged
reads or multipart.

Typical files are ≤25 MB, the hard maximum is 100 MB, and an interrupted upload must be
resumable. The platform runs on Workers Paid: 30 s
CPU and 10,000 subrequests per request, 128 MB isolate memory, 100 MB request bodies.

Facts verified in Chromium 152 (headless, real CDP) before this decision:

- `<input type="file">` works inside the `sandbox="allow-scripts"` srcdoc frame: a user-gesture
  click, `showPicker()` or `input.click()` in a click handler requests the chooser (no
  `SecurityError`); a scripted click without user activation is refused ("File chooser dialog
  can only be shown with a user activation."). The native dialog itself cannot be observed
  headless.
- A `File` posted child → parent over the existing `MessagePort` arrives as a real `File` (same
  name, size, type, lastModified and SHA-256; 30 MB tested). The parent can `slice()` it in
  8 MiB chunks after the frame is removed and the port closed.
- A `Blob` posted parent → child can be shown with `URL.createObjectURL` (`blob:null/…`) under
  the production CSP: PNG `img.decode()` and WAV `loadedmetadata` succeed (video untested).
- A download started inside the frame is silently blocked; `<a download href="blob:…">` from the
  parent page works.

R2 facts (Workers binding reference): multipart parts must be ≥5 MiB except the last and uniform
except the last; at most 10,000 parts; the binding has no ListParts, so part numbers and ETags
must be persisted by the caller; `resumeMultipartUpload` works across requests without a
validity check; the default bucket lifecycle aborts incomplete multipart uploads after 7 days;
`abort` and `delete` are free.

## Decision

### File fields

- A new field type **`file`** joins ADR 0032's closed vocabulary:
  `file { maxBytes?: 1–104857600 (default 26214400), accept?: string[], multiple?: boolean, required?: boolean }`.
  - `accept`: 1–50 unique entries, each `type/subtype`, `type/*` (lowercase MIME tokens) or
    `.ext` (`^\.[a-z0-9][a-z0-9.+-]{0,15}$`). Omitted = any file.
  - `multiple`: at most **10** files per field value.
- **`accept` is checked against the declared MIME type and the file-name extension only**, at
  upload start. The server never inspects content; a renamed file passes.
- A write passes, per file field, a **file id** or an object with a string `id` (other keys are
  ignored, so a record read can be written back unchanged). A `multiple` field also accepts an
  array of those (a single one is stored as a one-element array, like `choice`); a non-`multiple`
  field rejects an array. Ids are 32 lowercase hex. A duplicate id inside one write is a
  `validation` issue.
- The stored and returned value is a **descriptor** `{ id, name, type, size }` (always an array
  when `multiple`). Descriptors live inside the sealed record data and count toward its 64 KiB.
- Empty means absent (ADR 0032): `null`, `""` and `[]` omit an optional field and fail a
  required one.

### Storage and encryption

- **One R2 object per file**: `file/<fileId>.enc`. `PART_BYTES = 8 MiB` (8,388,608), one constant
  for runtime, API and MCP. A file of `size` bytes has `parts = ceil(size / PART_BYTES)`; every
  part is exactly `PART_BYTES` except the last. Sizes are 1 byte–100 MiB, so 1–13 parts.
  Empty files are rejected (`validation`): an unselected `<input type="file">` contributes a
  0-byte, nameless `File` to `FormData`, which the SDK treats as absent.
- **Every file is an R2 multipart upload**, one part included, through the binding
  (`createMultipartUpload` at start, `resumeMultipartUpload(key, multipartId).uploadPart` per
  part, `complete` at the end). Sealed parts are `PART_BYTES + 28` bytes, ≥5 MiB and uniform; the
  last part (the only one of a 1-part file) may be smaller, so R2's part rules hold. *Rationale:*
  once completed, R2 refuses any later `uploadPart`, so a part request still in flight when the
  upload completes cannot replace the stored (possibly attached) object or leave an untracked
  object behind after a cancel and sweep. A plain `put` would be one Class A operation instead of
  three for a 1-part file, but it has no such seal.
- **Per-file key:** a random 256-bit key, stored as `key_sealed = scalarSeal(master, { k })`
  (the artefact `key_wrap_master` pattern).
- **Per-part sealing:** AES-256-GCM with a **random 12-byte IV per seal**, framed
  `iv(12) || ct || tag(16)` (+28 bytes), and AAD = UTF-8 of
  `file:<fileId>:<partNumber>:<last|more>`. `sealBlob`/`openBlob` gain an optional trailing
  `aad` argument; omitted, they behave exactly as today. *Rationale:* a deterministic IV
  (nonce ‖ part number) would reuse key+IV when a resumed part is re-sent with different bytes —
  catastrophic for GCM. The AAD stops parts being reordered, moved between files or truncated
  (a dropped final part fails because no remaining part carries `last`).
- **Name, type and `lastModified` are sealed** (`meta_sealed = scalarSeal(master, { name, type,
  lastModified })`). Size and part count are plain metadata (quota and streaming need them).
- Migration **`0016_project_files.sql`**:

  ```sql
  ALTER TABLE project_records ADD COLUMN last_write TEXT;
  CREATE TABLE project_files (
    id TEXT PRIMARY KEY,                 -- 32 hex; also the upload id
    folder_id TEXT NOT NULL,             -- the project (top-level folder)
    collection TEXT NOT NULL,
    field TEXT NOT NULL,
    actor_key TEXT NOT NULL,             -- uploader identity (see Authority)
    status TEXT NOT NULL CHECK (status IN ('uploading','ready','attached','deleted')),
    record_id TEXT,                      -- set when attached
    size INTEGER NOT NULL,
    parts INTEGER NOT NULL,
    meta_sealed TEXT NOT NULL,
    key_sealed TEXT NOT NULL,
    resume_key TEXT,                     -- keyed hash; NULL once no longer uploading
    multipart_id TEXT,                   -- R2 uploadId while a multi-part upload is open
    created_at TEXT NOT NULL,
    completed_at TEXT,
    expires_at TEXT,                     -- uploading: start+24h; ready: complete+24h; else NULL
    deleted_at TEXT
  );
  CREATE INDEX project_files_project ON project_files(folder_id, status);
  CREATE INDEX project_files_record ON project_files(record_id) WHERE record_id IS NOT NULL;
  CREATE INDEX project_files_actor ON project_files(actor_key, status);
  CREATE UNIQUE INDEX project_files_resume ON project_files(resume_key) WHERE resume_key IS NOT NULL;
  CREATE INDEX project_files_sweep ON project_files(status, expires_at);
  CREATE TABLE project_file_parts (
    file_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    sha256 TEXT NOT NULL,                -- hex SHA-256 of the plaintext part
    at TEXT NOT NULL,
    PRIMARY KEY (file_id, number)
  );
  ```

  **No foreign keys**: rows must outlive the folder and record rows they belong to, until the
  sweep has removed the R2 object (a dangling `project_files` row is the only pointer to it).
- `R2BucketLike` grows what the binding already offers: `put` resolves to `{ etag }`,
  `get(key, { range: { offset, length } })`, `head(key)`, `createMultipartUpload(key)` and
  `resumeMultipartUpload(key, uploadId)` (`uploadPart`, `complete`, `abort`). The test double
  implements them.

### Upload sessions and resume

- **`uploadId == fileId`.** One row carries the session and, after completion, the file.
- **Start** takes `{ field, name, type, size, lastModified? }` for a collection. It validates the
  field (exists, type `file`; the issue names that field, or `field` when it is not a string),
  `size` (1…`maxBytes`, else `too-large`), `name` (1–255 characters,
  well-formed UTF-16 (`isWellFormed()`), no control characters, no bidi overrides/isolates
  `U+202A–U+202E`, `U+2066–U+2069`, no `/` or `\`), `type` (empty or a lowercase `type/subtype`
  token of ≤127 characters; anything else is stored as `""`), `accept`, and `lastModified` (an
  integer ≥0 or absent).
- **Resume:** `resume_key = sha256hex(master ‖ actorKey ‖ folderId ‖ collection ‖ field ‖ name ‖
  size ‖ lastModified)` (keyed, so a database reader cannot confirm guessed names). A start whose
  `resume_key` matches an `uploading`, unexpired row of the same actor returns that session
  (`resumed: true`, HTTP 200) instead of creating one. The client hashes each local slice and
  re-sends only parts whose `sha256` or size differ. *A match is a heuristic; the per-part hash
  is the proof.* `resume_key` is **unique**: start first clears it from rows that are no longer
  open (`status <> 'uploading'` or expired), and the session `INSERT` ends with
  `ON CONFLICT DO NOTHING`, so two concurrent starts of the same file (a double-clicked submit)
  yield one session — the loser re-reads it and returns it with `resumed: true`.
- **Quota** is checked at start and enforced on every part. Project byte usage counts `ready`
  and `attached` files by `size` and `uploading` sessions by the bytes actually received
  (`COALESCE(SUM(project_file_parts.size), 0)`), so open sessions cannot reserve storage they
  never send. Start runs one guarded `INSERT … SELECT … WHERE` together with the collection's
  existence: per project ≤ **10,000** live files (live = `uploading`/`ready`/`attached`,
  unexpired), usage + `size` ≤ **10 GiB** plaintext, and ≤ **5** open `uploading` sessions per
  actor across the platform. The part upsert is guarded by usage (without this part's previous
  size) + the part's size ≤ 10 GiB. Exhaustion → `quota-exceeded`. Every start calls
  `createMultipartUpload` first, so a refused start has already cost one R2 Class A operation
  (aborted again at once), accepted rather than adding a pre-check round trip. A part refused by
  the quota guard has already been written to R2 (one Class A operation; the sweep removes it).
- **Part upload:** `n` is canonical decimal (`[1-9][0-9]{0,4}`; `01`, `1e0` or `0x1` is not a
  part route → 404). `Content-Length` must equal the expected plaintext part length (`PART_BYTES`,
  or the remainder for the last part); missing or smaller is `validation` (field `part`), larger
  is `too-large`. The Worker reads the body straight into one buffer of that length, hashes,
  seals and writes it with `uploadPart`, then upserts `project_file_parts`. **Re-sending a part
  replaces it.** A part whose `uploadPart` R2 refuses because the upload was completed or aborted
  meanwhile fails `not-found` ("Upload expired or unknown").
- **Complete** requires every part `1…parts` with the right sizes, completes the multipart upload,
  and in one D1 batch moves the row to `ready` with
  `expires_at = now + 24 h` and deletes its `project_file_parts` rows: **plaintext part hashes
  exist only while an upload is open (≤24 h)**. If R2 reports the multipart upload gone but
  `head(file/<id>.enc)` shows the expected sealed size (a previous complete whose D1 write was
  lost), the row is still moved to `ready`. If verification fails otherwise, complete deletes the
  session's parts rows and fails `conflict`; the next resume lists no received parts and re-sends
  everything. Completing an already `ready` file of the same actor returns its descriptor
  (idempotent); a complete whose `ready` transition changed nothing (a concurrent complete won)
  re-reads the row and returns the same descriptor, else `not-found`. Only the call that made the
  transition is audited (`project.file.complete`).
- **Cancel** (an explicit operation, also issued by the SDK when an upload's `AbortSignal`
  fires) marks an `uploading` or unattached `ready` file of the caller `deleted` and deletes its
  parts rows.
- **Session TTL 24 h** from start, below R2's 7-day multipart auto-abort backstop. An expired
  session is `not-found` ("Upload expired or unknown").

### Attaching files to records

- A completed file is `ready` and **unattached**, bound to project + collection + field + actor.
- `create`, `update` and `submit` attach referenced files in the **same D1 batch** as the record
  write. Each record write stores a random `last_write` token; the follow-up statements of the
  batch are guarded by `EXISTS (SELECT 1 FROM project_records WHERE id = ? AND last_write = ?)`,
  so they apply only when the guarded record write itself changed a row.
  1. The record `INSERT`/`UPDATE` adds a predicate: the number of referenced ids, expanded with
     `json_each(?)` over `[{ id, field }]`, that are **attachable** equals the number referenced.
     Attachable = same `folder_id`, `collection` and `field`, and either `status = 'ready' AND
     record_id IS NULL AND actor_key = <fileActor> AND expires_at > now`, or (update only)
     `status = 'attached' AND record_id = <this record>`.
  2. `UPDATE project_files SET status = 'attached', record_id = ?, expires_at = NULL` for the
     referenced ids.
  3. On update, `UPDATE project_files SET status = 'deleted', deleted_at = now` for files attached
     to this record that are no longer referenced.
- Before the batch, the model resolves the referenced rows to build descriptors (unsealing name
  and type) and reports a precise `validation` issue per field ("File is not available. Upload
  it again."). A lost race in the guarded statement reports the same issue.
- `create(folderId, name, data, submission?, fileActor?)` and
  `update(folderId, name, id, data, ifVersion?, fileActor?)` take the uploader identity; a
  submission's `actorKey` is its file actor. Without a file actor only already attached files
  are accepted.
- **Unattached `ready` files expire 24 h after completion.**

### Authority

| | `records` collection | `responses` collection |
|---|---|---|
| Runtime upload (start, part, complete, cancel) | `canWriteShared` (signed-in, live write, never via a share) | submit authority: signed-in readers with read authority; share visitors only when `visitors` is true |
| API/MCP upload | master key, `write` tier | **403** (`wrong-kind` → `forbidden`) |
| Runtime download | whoever may read the record: read authority; share visitors only when `visitors` is true | only the record's submitter (`actor_key` match), as `mine` |
| API/MCP download / file metadata | `read` tier | `manage` tier |

- The **file actor** is the runtime reader identity (`actorKey`, ADR 0028) or **`api:<userId>`**
  for master keys (any key of the same user may continue the upload). Status, parts, complete
  and cancel require the same actor.
- **Live authority is rechecked on every part, status, complete, cancel and download**: the
  runtime grant is authorized (artefact access, share state, suspension), the project is
  re-resolved, the collection reloaded and the table above re-applied. Artefact-scoped API keys
  remain 403 for project data.
- Download serves only `attached` files whose `record_id`, `collection` and `folder_id` match the
  path.

### Limits

| Bucket | Limit | Applies to |
|---|---|---|
| `runtime:<actorKey>:<artifactId>` | 180/min (existing) | every runtime file request too |
| `files-start:<actorKey>:<folderId>` | 20/h | runtime upload starts (new sessions and resumes) |
| `files-part:<actorKey>:<folderId>` | 128/h (= 1 GiB of 8 MiB parts) | runtime part PUTs |
| `runtime-ip:files-start:<ipKey>:<folderId>` | 60/h | signed-out runtime starts |
| `runtime-ip:files-part:<ipKey>:<folderId>` | 256/h (= 2 GiB) | signed-out runtime part PUTs |
| `api:<keyId>\|general` | 120/min (existing) | every API/MCP file request |

*Byte budgets are expressed as part counts:* the limiter counts hits, and every part but the last
is `PART_BYTES`, so counting parts bounds bytes without a second limiter primitive. The
`files-part` buckets are charged only once a part holds a transfer slot (before its body is
read): a part refused by a full isolate costs no hourly hit. The per-request buckets
(`runtime:…` and `api:…|general`) still count every request, as for every other request.

**Transfers per isolate:** at most **3** concurrent part bodies or downloads per Worker isolate
(a module-scope map of slots with their acquisition time, released in `finally` or when the
download stream ends). Above that, the request fails `rate-limited`
(HTTP 429, `Retry-After: 1`); the viewer and agents retry. Each in-flight transfer holds about
three parts (≈24 MiB: plaintext, ciphertext, framed copy), so transfers stay ≈72 MiB of the
128 MiB isolate. Aborted part bodies release their slot at once (the body read fails). workerd
does not cancel the stream of a download whose client disconnected (verified in local workerd:
three aborted downloads kept all three slots), so the Worker sets the `enable_request_signal`
compatibility flag and a download releases its slot when its `request.signal` aborts (verified
in local workerd: three aborted downloads, then an immediate fourth one is served; also when the
client left before the slot was taken). The age limit is a backstop only, for a release that
never comes: each acquire first prunes slots older than **1 hour**, so the ceiling is 3 extra slow
transfers per hour per isolate (a known ceiling, accepted). A shorter limit would evict live slow
transfers and let a slow trickle exceed the memory bound.

### Runtime transport (viewer ↔ Worker)

- **JSON operations** go through the existing `POST /_runtime/data` with the existing grant body
  `{ grant, op, collection, id?, data? }`:
  - `upload-start` — `data: { field, name, type, size, lastModified }` →
    `{ value: { upload: UploadView, resumed } }`
  - `upload-complete` — `id` → `{ value: { file: FileRef } }`
  - `upload-cancel` — `id` → `{ value: null }`
- **Binary routes** `^/_runtime/files/(?<rest>.+)$`, grant in header **`X-Artefacts-Grant`**,
  `Origin` must equal the Worker origin (otherwise 403):
  - `PUT /_runtime/files/uploads/<uploadId>/parts/<n>` — `Content-Type: application/octet-stream`
    (otherwise 403), body = the plaintext part with `Content-Length` = its expected length →
    `200 { value: { part: { number, size, sha256 } } }`.
  - `POST /_runtime/files/<collection>/<recordId>/<fileId>` (empty body) → the file bytes.
    *POST, not GET:* browsers attach `Origin` to every same-origin POST but not to GET, and the
    `Origin` check is the CSRF guard of the runtime surface.
- Errors on both routes use the runtime envelope `{ error, message, issues? }` and status map; a
  full isolate answers 429 `rate-limited` with `Retry-After: 1` (see Limits).
- Wire types (identical on runtime, API and MCP):

  ```ts
  type FileRef = { id: string; name: string; type: string; size: number };
  type PartView = { number: number; size: number; sha256: string };
  type UploadView = {
    id: string; collection: string; field: string;
    name: string; type: string; size: number; lastModified: number | null;
    partBytes: number; parts: number; received: PartView[];
    status: 'uploading' | 'ready'; expiresAt: string;
    partPath: string;   // append the part number: runtime "/_runtime/files/uploads/<id>/parts/",
                        // API "/_api/projects/<folderId>/collections/<name>/uploads/<id>/parts/"
  };
  ```

### Download response

The Worker streams the file part by part: `new ReadableStream({ pull }, { highWaterMark: 0 })`,
each `pull` a ranged `get` of `(n-1)·(PART_BYTES+28)` / `partSize+28`, `openBlob` with the part's
AAD, enqueue; nothing is read ahead of the consumer. A download holds one transfer slot until the
stream closes, errors or is cancelled, or the request's `signal` aborts (client disconnect), or
for at most 1 hour (see Limits). Headers:

- `Content-Type: application/octet-stream`
- `Content-Length: <size>`
- `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>`
  (control characters, `"`, `\`, `/` and non-ASCII replaced by `_` in the fallback)
- `X-Artefacts-File-Type: <declared type>` (only when non-empty; lets the viewer type the Blob
  for in-frame display)
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`

A part that fails to open aborts the stream; the short body is detectable against
`Content-Length`. **No HTTP `Range` support** in this decision.

### External API

Under `/_api/projects/{folder}/collections/{name}` with the ADR 0032 envelope, limiter and audit:

| Method | Path | Result |
|---|---|---|
| `POST` | `…/uploads` (JSON `{ field, name, type?, size, lastModified? }`) | `201 { upload }`, or `200 { upload }` when resumed |
| `GET` | `…/uploads/{id}` | `200 { upload }` |
| `PUT` | `…/uploads/{id}/parts/{n}` (raw body, `Content-Type: application/octet-stream`) | `200 { part }` |
| `POST` | `…/uploads/{id}/complete` | `200 { file }` |
| `DELETE` | `…/uploads/{id}` | `200 { ok: true, id }` |
| `GET` | `…/files/{fileId}` | `200 { file: FileRef & { recordId, createdAt, downloadPath } }` |
| `GET` | `…/records/{id}/files/{fileId}` | the file bytes (headers above) |

`downloadPath` is `/_api/projects/<folderId>/collections/<name>/records/<recordId>/files/<fileId>`.
A part body with another content type → 422 `validation` (field `part`). Error mapping follows
ADR 0032 (`quota-exceeded` → 409 `conflict`, `too-large` → 413, `wrong-kind` → 403). Audit
actions `project.file.upload` (new sessions only), `project.file.complete` (the transition only,
not idempotent repeats), `project.file.cancel` with detail `{ folderId, collection, fileId, size }`
only.

### MCP

Five tools join the eleven, delegating to `handleApi` like the others: `start_upload`
`{ folder, collection, field, name, type?, size, lastModified? }`, `get_upload`
`{ folder, collection, uploadId }`, `complete_upload` `{ folder, collection, uploadId }`,
`cancel_upload` `{ folder, collection, uploadId }`, `get_file` `{ folder, collection, fileId }`.
**Bytes never travel through MCP**: the agent PUTs each part over HTTP to `partPath` on the
Worker origin with the same `Authorization: Bearer` master key, and downloads `downloadPath` the
same way. Tool descriptions say so.

### SDK (`window.artefacts.data`)

- `upload(collection, field, file, { onProgress, signal })` → `FileRef`. `onProgress({ loaded,
  total })` fires after each acknowledged part (and once with `loaded = total` before resolving).
  An aborted `signal` rejects with an `AbortError` and cancels the session.
- `create`, `update` and `submit` accept `File` values in objects and forms (`FormData` file
  entries; a nameless 0-byte entry is absent), upload them first in field order and replace them
  with their ids; an optional last argument `{ onProgress }` reports
  `{ field, loaded, total }` across all files. The old "File uploads are not supported."
  rejection is removed. If the record write then fails, retrying the call uploads the files
  again as new sessions; the earlier, never-attached `ready` uploads stay until they expire
  (24 h after completion, swept after the 1 h grace) and count toward the project's quota until
  then.
- `file(collection, recordId, fileId)` → a `File` (a `Blob`) typed with the declared type, for
  in-frame display with `URL.createObjectURL` (images and audio/video; PDF and HTML preview are
  not supported by the CSP).
- `download(collection, recordId, fileId)` → resolves after the viewer has started the save
  (`<a download>` on the parent page with the server's file name). The saved Blob is always
  `application/octet-stream`; only `file()` carries the declared type.
- Port messages (child → parent, each with the usual `id`):
  `{ type: 'upload', collection, field, file }`, `{ type: 'cancel', upload: <message id> }`,
  `{ type: 'file', collection, recordId, fileId }`, `{ type: 'download', collection, recordId, fileId }`.
  Parent → child: `{ id, progress: { loaded, total } }` before the final `{ id, value }` or
  `{ id, error }`. `upload`, `file` and `download` are exempt from the 30 s request timeout; they
  still count toward the 32 in-flight requests.
- The viewer performs uploads from the parent page with `File.slice()`; a failed part is retried
  three times (1 s, 2 s, 4 s, or a 429/503 `Retry-After` of 1–30 s) before rejecting. **Resume
  after an interruption or a parent reload = calling `upload` again with the same file (re-picked
  after a reload)**. A second `upload` of the same file (collection, field, name, size,
  `lastModified`) while the first runs awaits the first one's result. Cancelling the first one
  cancels the shared transfer, so the waiting call rejects too, with error code `aborted`
  ("The upload was aborted."). Files are never persisted
  in IndexedDB or any browser storage.
- Uploads need a live runtime grant (1 h from opening); after "Runtime access expired", reopen
  the artefact and re-pick the file to resume.

### Deletion and the sweep

- **Record delete**, **collection delete** and **folder delete** (ADR 0038's guarded batch) mark
  the affected `project_files` rows `deleted` in the same D1 batch, each statement guarded by the
  parent row no longer existing (`NOT EXISTS` the record / collection / folder). Record updates
  delete dropped files as above. Artefact deletion still does not touch project data or files.
- The existing daily cron runs `projectFiles.sweep()`: up to 10 rounds of 100 rows that are
  `deleted` with `deleted_at <= now - 1 h`, or `uploading`/`ready` with `expires_at <= now - 1 h`
  (the hour of grace lets a part or complete already in flight finish before its object goes).
  Per row it aborts the multipart upload (errors ignored: already completed or aborted), deletes
  `file/<id>.enc` in one batched `delete`, then deletes the parts and file rows with the same
  predicate. Bucket failures leave the rows for the next run.

### Content-blind, scanning and gated artefacts

- Names, types and `lastModified` are sealed; audit, logs and errors carry only ids and sizes.
- **Files are not malware-scanned.** Delivery is always `attachment` with `nosniff` and
  `CSP: sandbox`; in-frame display happens only inside the opaque sandbox via `blob:` URLs.
- **Gated artefacts:** files are protected by **authorization, not by the document password**.
  The Worker holds the master wrap of every file key, as it does for artefact content (ADR 0014),
  so a password gate in front of an artefact does not encrypt its project's files.

## Consequences

- Artefacts can collect and present files without leaving the sandbox or relaxing its CSP; the
  only new browser authority is the parent executing transfers the child asks for.
- A file is reachable only through a record of its project; detached and abandoned uploads
  disappear within a day of expiry, deleted ones on the next daily sweep.
- R2 now holds `file/` objects next to `art/`; the bucket stays private and the Worker is the
  only reader.
- The runtime and API gain their first non-JSON request bodies; both stay bounded by `PART_BYTES`
  and by three concurrent transfers per isolate.
- File storage has its own quota (10 GiB / 10,000 files per project), separate from the 64 MiB
  record quota.
- ADR 0032's out-of-scope "file uploads" is lifted for `file` fields only.

## Out of scope

HTTP `Range` downloads and resumable downloads, a console file manager or file browser, PDF/HTML
preview inside artefacts, malware scanning, content sniffing or thumbnailing, presigned R2 URLs,
direct browser-to-R2 transfer, files outside project collections (per-artefact `personal`/`shared`
state stays JSON), password-derived file encryption, browser-side persistence of picked files,
and moving files between collections or projects.
