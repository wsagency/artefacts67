// Project files (ADR 0035): resumable upload sessions for `file` fields, sealed per part in one
// R2 object per file (`file/<id>.enc`), streamed back part by part. Quota, existence and
// ownership are decided in guarded SQL statements (the project-data pattern). Attaching files to
// records happens in project-data.ts with its own SQL; this model imports no other model.

import { Effect } from "effect";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike, type R2BucketLike } from "./types.js";
import type { Collection } from "./project-data.js";
import { hex, openBlob, randomHex, scalarSeal, scalarUnseal, sealBlob, sha256, sha256hex } from "./crypto.js";
import { PART_BYTES, readBytes } from "./http.js";

export const SEAL_OVERHEAD = 28;                // iv 12 + tag 16
export interface FileLimits {
  maxBytes: number; defaultMaxBytes: number; projectBytes: number; projectFiles: number; openPerActor: number;
  sessionMs: number; readyMs: number; sweepBatch: number; sweepBatches: number;
}
export const FILE_LIMITS: FileLimits = {
  maxBytes: 104_857_600, defaultMaxBytes: 26_214_400, projectBytes: 10 * 1024 ** 3, projectFiles: 10_000, openPerActor: 5,
  sessionMs: 86_400_000, readyMs: 86_400_000, sweepBatch: 100, sweepBatches: 10,
};
export interface FileRef { id: string; name: string; type: string; size: number }
export interface PartView { number: number; size: number; sha256: string }
export interface UploadState {
  id: string; collection: string; field: string; name: string; type: string; size: number;
  lastModified: number | null; partBytes: number; parts: number; received: PartView[]; status: "uploading" | "ready"; expiresAt: string;
}
export type UploadView = UploadState & { partPath: string };   // partPath added by the route layer
export interface FileSession { id: string; folderId: string; collection: string; field: string; actorKey: string; status: "uploading" | "ready" | "attached" | "deleted" }
export interface ProjectFiles {
  session(id: string): Effect.Effect<FileSession | null, CodeError>;
  start(input: { folderId: string; collection: Collection; field: unknown; actorKey: string; name: unknown; type: unknown; size: unknown; lastModified: unknown }):
    Effect.Effect<{ upload: UploadState; resumed: boolean }, CodeError>;
  status(folderId: string, collection: string, id: string, actorKey: string): Effect.Effect<UploadState, CodeError>;
  /** `admit` runs inside the transfer slot, before the body is read: charge per-part limits there. */
  putPart(folderId: string, collection: string, id: string, actorKey: string, number: number, body: Request, admit?: Effect.Effect<void, CodeError>): Effect.Effect<PartView, CodeError>;
  /** `completed` is true only for the call that moved the upload to `ready`. */
  complete(folderId: string, collection: string, id: string, actorKey: string): Effect.Effect<{ file: FileRef; completed: boolean }, CodeError>;
  cancel(folderId: string, collection: string, id: string, actorKey: string): Effect.Effect<boolean, CodeError>;
  describe(folderId: string, collection: string, fileId: string): Effect.Effect<(FileRef & { recordId: string; createdAt: string }) | null, CodeError>;
  /** `signal` is the incoming request's: its abort (a client disconnect) frees the transfer slot. */
  download(folderId: string, collection: string, recordId: string, fileId: string, signal?: AbortSignal): Effect.Effect<{ file: FileRef; body: ReadableStream<Uint8Array> } | null, CodeError>;
  sweep(): Effect.Effect<number, CodeError>;
}

const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const invalid = (field: string, message: string): CodeError =>
  Object.assign(new Error(message), { code: "validation", issues: [{ field, message }] });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });
const gone = () => fail("not-found", "Upload expired or unknown.");
const full = () => fail("quota-exceeded", "This project's file storage is full.");

/** Additional data binding a sealed part to its file, position and finality. */
export function partAad(fileId: string, n: number, last: boolean): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`file:${fileId}:${n}:${last ? "last" : "more"}`);
}

// Transfer slots: part bodies and downloads in flight, shared by every model in the isolate,
// each with its acquisition time. workerd never cancels the stream of a download whose client
// disconnected; the route's request.signal (`enable_request_signal`) frees that slot instead.
// ponytail: per-isolate, not a global limit; isolates are independent. SLOT_TTL_MS is only a backstop
// for a release that never comes: the next acquire prunes slots older than 1 h, so the ceiling is 3
// extra slow transfers per hour per isolate. Shorter, it would evict live slow transfers and let a
// slow trickle exceed the memory bound.
const transfers = new Map<symbol, number>();
const MAX_TRANSFERS = 3, SLOT_TTL_MS = 60 * 60_000;
const busy = () => Object.assign(fail("rate-limited", "Too many file transfers right now. Retry in a second."), { retryAfter: 1 });
const acquire = (at: number) => Effect.suspend(() => {
  for (const [slot, since] of transfers) if (at - since > SLOT_TTL_MS) transfers.delete(slot);
  if (transfers.size >= MAX_TRANSFERS) return Effect.fail(busy());
  const slot = Symbol("transfer");
  transfers.set(slot, at);
  return Effect.succeed(slot);
});
const release = (slot: symbol) => Effect.sync(() => { transfers.delete(slot); });

const NAME_FORBIDDEN = /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const COLUMNS = "id, folder_id, collection, field, actor_key, status, record_id, size, parts, meta_sealed, key_sealed, multipart_id, created_at, expires_at";
// Swept one hour after deletion or expiry, so a part or complete already in flight can finish.
const DEAD = "((status = 'deleted' AND deleted_at <= ?) OR (status IN ('uploading','ready') AND expires_at <= ?))";
const SWEEP_GRACE_MS = 3_600_000;

interface FileRow {
  id: string; folder_id: string; collection: string; field: string; actor_key: string; status: FileSession["status"];
  record_id: string | null; size: number; parts: number; meta_sealed: string; key_sealed: string; multipart_id: string | null;
  created_at: string; expires_at: string | null;
}
interface Meta { name: string; type: string; lastModified: number | null }

const objectKey = (id: string) => `file/${id}.enc`;
const partSize = (row: { size: number; parts: number }, n: number) => n === row.parts ? row.size - (row.parts - 1) * PART_BYTES : PART_BYTES;

export function openProjectFiles({ db, bucket, masterKeyHex, now = Date.now, limits = FILE_LIMITS }: {
  db: DatabaseLike; bucket: R2BucketLike; masterKeyHex: string; now?: () => number; limits?: FileLimits;
}): ProjectFiles {
  const iso = (ms: number) => new Date(ms).toISOString();
  // Project byte usage: ready/attached files by size, open sessions by the bytes they received.
  // Bindings: folderId, now, folderId, now.
  const USAGE = `((SELECT COALESCE(SUM(size), 0) FROM project_files WHERE folder_id = ? AND status IN ('ready','attached') AND (expires_at IS NULL OR expires_at > ?))
    + (SELECT COALESCE(SUM(p.size), 0) FROM project_file_parts AS p JOIN project_files AS f ON f.id = p.file_id
       WHERE f.folder_id = ? AND f.status = 'uploading' AND f.expires_at > ?))`;

  const readRow = (id: string) => io(() => db.prepare(`SELECT ${COLUMNS} FROM project_files WHERE id = ?`).bind(id).first<FileRow>());
  const unseal = <A>(sealed: string) => Effect.flatMap(scalarUnseal<A>(masterKeyHex, sealed),
    (value) => value ? Effect.succeed(value) : Effect.fail(fail("secrets-auth", "file metadata could not be opened")));
  const toRef = (row: FileRow) => Effect.map(unseal<Meta>(row.meta_sealed),
    (meta): FileRef => ({ id: row.id, name: meta.name, type: meta.type, size: Number(row.size) }));
  const fileKey = (row: FileRow) => Effect.map(unseal<{ k: string }>(row.key_sealed), ({ k }) => k);
  const received = (id: string) => Effect.map(io(() => db.prepare(
    "SELECT number, size, sha256 FROM project_file_parts WHERE file_id = ? ORDER BY number",
  ).bind(id).all<PartView>()), ({ results }) => results.map(({ number, size, sha256 }) => ({ number: Number(number), size: Number(size), sha256 })));
  const toState = Effect.fn(function* (row: FileRow) {
    const meta = yield* unseal<Meta>(row.meta_sealed);
    return {
      id: row.id, collection: row.collection, field: row.field, name: meta.name, type: meta.type, size: Number(row.size),
      lastModified: meta.lastModified, partBytes: PART_BYTES, parts: Number(row.parts), received: yield* received(row.id),
      status: row.status as UploadState["status"], expiresAt: row.expires_at as string,
    } satisfies UploadState;
  });
  /** The caller's own, unexpired session in this folder and collection, in one of `statuses`. */
  const own = Effect.fn(function* (folderId: string, collection: string, id: string, actorKey: string, statuses: FileRow["status"][]) {
    const row = yield* readRow(id);
    if (!row || row.folder_id !== folderId || row.collection !== collection || row.actor_key !== actorKey
      || !statuses.includes(row.status) || !row.expires_at || row.expires_at <= iso(now())) return yield* Effect.fail(gone());
    return row;
  });

  /** Complete the multipart upload; once completed, R2 refuses any late part for this object. */
  const verify = (row: FileRow) => Effect.gen(function* () {
    const key = objectKey(row.id), sealedSize = Number(row.size) + Number(row.parts) * SEAL_OVERHEAD;
    const { results } = yield* io(() => db.prepare("SELECT number, etag FROM project_file_parts WHERE file_id = ? ORDER BY number")
      .bind(row.id).all<{ number: number; etag: string }>());
    // A rejected complete may mean an earlier complete succeeded and its D1 write was lost.
    return yield* io(() => bucket.resumeMultipartUpload(key, row.multipart_id as string)
      .complete(results.map(({ number, etag }) => ({ partNumber: Number(number), etag })))).pipe(
      Effect.as(true), Effect.catch(() => Effect.map(io(() => bucket.head(key)), (head) => head?.size === sealedSize)));
  });

  return {
    session: Effect.fn(function* (id: string) {
      const row = yield* readRow(id);
      return row ? { id: row.id, folderId: row.folder_id, collection: row.collection, field: row.field, actorKey: row.actor_key, status: row.status } : null;
    }),

    start: Effect.fn(function* (input) {
      const { folderId, collection, actorKey } = input;
      const spec = typeof input.field === "string" && Object.hasOwn(collection.fields, input.field) ? collection.fields[input.field] : undefined;
      if (!spec || spec.type !== "file") return yield* Effect.fail(invalid(typeof input.field === "string" ? input.field : "field", "Unknown file field."));
      const field = input.field as string;
      const size = input.size;
      if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return yield* Effect.fail(invalid(field, "A file has at least 1 byte."));
      const max = Math.min(spec.maxBytes ?? limits.defaultMaxBytes, limits.maxBytes);
      if (size > max) return yield* Effect.fail(fail("too-large", `Files in this field are at most ${max} bytes.`));
      const name = input.name;
      if (typeof name !== "string" || name.length < 1 || [...name].length > 255 || !name.isWellFormed() || NAME_FORBIDDEN.test(name)) {
        return yield* Effect.fail(invalid(field, "File names have 1–255 characters, without control or bidi characters, / or \\."));
      }
      const type = typeof input.type === "string" && input.type.length <= 127 && MIME.test(input.type) ? input.type : "";
      if (spec.accept && !spec.accept.some((entry) => entry.startsWith(".") ? name.toLowerCase().endsWith(entry)
        : entry.endsWith("/*") ? type.startsWith(entry.slice(0, -1)) : type === entry)) {
        return yield* Effect.fail(invalid(field, "This kind of file is not accepted here."));
      }
      const lastModified = input.lastModified ?? null;
      if (lastModified !== null && (typeof lastModified !== "number" || !Number.isInteger(lastModified) || lastModified < 0)) {
        return yield* Effect.fail(invalid(field, "lastModified is a non-negative integer."));
      }

      const at = now(), nowIso = iso(at);
      // The JSON array is the unambiguous concatenation; the master key makes the hash keyed.
      const resumeKey = yield* sha256hex(JSON.stringify([masterKeyHex, actorKey, folderId, collection.name, field, name, size, lastModified]));
      // The unique index must not be held by closed or expired sessions.
      yield* io(() => db.prepare("UPDATE project_files SET resume_key = NULL WHERE resume_key = ? AND (status <> 'uploading' OR expires_at <= ?)")
        .bind(resumeKey, nowIso).run());
      const resumable = Effect.flatMap(io(() => db.prepare(
        `SELECT ${COLUMNS} FROM project_files WHERE resume_key = ? AND actor_key = ? AND status = 'uploading' AND expires_at > ?`,
      ).bind(resumeKey, actorKey, nowIso).first<FileRow>()), (row) => row ? Effect.map(toState(row), (upload) => ({ upload, resumed: true })) : Effect.succeed(null));
      const existing = yield* resumable;
      if (existing) return existing;

      const id = yield* randomHex(16);
      const parts = Math.ceil(size / PART_BYTES);
      // Every file is multipart, even one part: completing it seals the object against late parts.
      // A refused start costs this one Class A operation (ADR 0035 § Upload sessions).
      const multipartId = (yield* io(() => bucket.createMultipartUpload(objectKey(id)))).uploadId;
      const keySealed = yield* scalarSeal(masterKeyHex, { k: yield* randomHex(32) });
      const metaSealed = yield* scalarSeal(masterKeyHex, { name, type, lastModified } satisfies Meta);
      const result = yield* io(() => db.prepare(`INSERT INTO project_files
        (id, folder_id, collection, field, actor_key, status, size, parts, meta_sealed, key_sealed, resume_key, multipart_id, created_at, expires_at)
        SELECT ?,?,?,?,?,'uploading',?,?,?,?,?,?,?,? WHERE
          EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ? AND name = ?)
          AND ${USAGE} + ? <= ${limits.projectBytes}
          AND (SELECT COUNT(*) FROM project_files WHERE folder_id = ? AND status IN ('uploading','ready','attached') AND (expires_at IS NULL OR expires_at > ?)) < ${limits.projectFiles}
          AND (SELECT COUNT(*) FROM project_files WHERE actor_key = ? AND status = 'uploading' AND expires_at > ?) < ${limits.openPerActor}
        ON CONFLICT DO NOTHING`)
        .bind(id, folderId, collection.name, field, actorKey, size, parts, metaSealed, keySealed, resumeKey, multipartId, nowIso, iso(at + limits.sessionMs),
          folderId, collection.name,
          folderId, nowIso, folderId, nowIso, size,
          folderId, nowIso,
          actorKey, nowIso).run());
      if (!result.meta?.changes) {
        yield* io(() => bucket.resumeMultipartUpload(objectKey(id), multipartId).abort()).pipe(Effect.ignore);
        // A concurrent start of the same file won the unique resume key: continue its session.
        const winner = yield* resumable;
        if (winner) return winner;
        const exists = yield* io(() => db.prepare("SELECT 1 AS ok FROM project_collections WHERE folder_id = ? AND name = ?")
          .bind(folderId, collection.name).first<{ ok: number }>());
        return yield* Effect.fail(exists ? full() : fail("not-found", "No such collection."));
      }
      const row = yield* readRow(id);
      if (!row) return yield* Effect.fail(gone());
      return { upload: yield* toState(row), resumed: false };
    }),

    status: Effect.fn(function* (folderId: string, collection: string, id: string, actorKey: string) {
      return yield* toState(yield* own(folderId, collection, id, actorKey, ["uploading", "ready"]));
    }),

    putPart: Effect.fn(function* (folderId: string, collection: string, id: string, actorKey: string, number: number, body: Request, admit: Effect.Effect<void, CodeError> = Effect.void) {
      const row = yield* own(folderId, collection, id, actorKey, ["uploading"]);
      const parts = Number(row.parts);
      if (!Number.isInteger(number) || number < 1 || number > parts) return yield* Effect.fail(invalid("part", `Parts are numbered 1–${parts}.`));
      const expected = partSize({ size: Number(row.size), parts }, number);
      const key = yield* fileKey(row);
      // The slot covers the memory-heavy span: one plaintext buffer, its seal and the R2 write.
      const { etag, sha } = yield* Effect.acquireUseRelease(acquire(now()), () => Effect.gen(function* () {
        yield* admit;
        const bytes = yield* readBytes(body, expected);
        const sha = hex(yield* sha256(bytes));
        const sealed = yield* sealBlob(key, bytes, partAad(id, number, number === parts));
        // R2 refuses a part after complete or abort; the session then reads as gone.
        const { etag } = yield* io(() => bucket.resumeMultipartUpload(objectKey(id), row.multipart_id as string).uploadPart(number, sealed)).pipe(
          Effect.catch((error) => Effect.andThen(own(folderId, collection, id, actorKey, ["uploading"]), Effect.fail(error))));
        return { etag, sha };
      }), release);
      const nowIso = iso(now());
      // The quota check excludes this part's previous size, so a re-send replaces rather than adds.
      const result = yield* io(() => db.prepare(`INSERT INTO project_file_parts (file_id, number, size, etag, sha256, at)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM project_files WHERE id = ? AND status = 'uploading' AND actor_key = ? AND expires_at > ?)
          AND ${USAGE} - COALESCE((SELECT size FROM project_file_parts WHERE file_id = ? AND number = ?), 0) + ? <= ${limits.projectBytes}
        ON CONFLICT(file_id, number) DO UPDATE SET size = excluded.size, etag = excluded.etag, sha256 = excluded.sha256, at = excluded.at`)
        .bind(id, number, expected, etag, sha, nowIso, id, actorKey, nowIso, folderId, nowIso, folderId, nowIso, id, number, expected).run());
      if (!result.meta?.changes) {
        // The refused part's R2 write stays until the session is swept (ADR 0035 § Quota).
        yield* own(folderId, collection, id, actorKey, ["uploading"]);
        return yield* Effect.fail(full());
      }
      return { number, size: expected, sha256: sha };
    }),

    complete: Effect.fn(function* (folderId: string, collection: string, id: string, actorKey: string) {
      const row = yield* own(folderId, collection, id, actorKey, ["uploading", "ready"]);
      if (row.status === "ready") return { file: yield* toRef(row), completed: false };
      const parts = Number(row.parts), size = Number(row.size);
      const have = yield* received(id);
      for (let n = 1; n <= parts; n++) {
        if (have[n - 1]?.number !== n || have[n - 1].size !== partSize({ size, parts }, n)) return yield* Effect.fail(invalid("part", `Part ${n} is missing.`));
      }
      const settled = Effect.gen(function* () {   // a concurrent complete may have won
        const again = yield* readRow(id);
        return again?.status === "ready" && again.actor_key === actorKey ? { file: yield* toRef(again), completed: false } : null;
      });
      if (!(yield* verify(row))) {
        const won = yield* settled;
        if (won) return won;
        // The next resume lists no received parts, so the client re-sends everything.
        yield* io(() => db.prepare("DELETE FROM project_file_parts WHERE file_id = ?").bind(id).run());
        return yield* Effect.fail(fail("conflict", "The upload could not be completed. Send the file again."));
      }
      const at = now();
      const [moved] = yield* io(() => db.batch([
        db.prepare(`UPDATE project_files SET status = 'ready', resume_key = NULL, multipart_id = NULL, completed_at = ?, expires_at = ?
          WHERE id = ? AND status = 'uploading' AND actor_key = ? AND expires_at > ?`).bind(iso(at), iso(at + limits.readyMs), id, actorKey, iso(at)),
        db.prepare("DELETE FROM project_file_parts WHERE file_id = ? AND EXISTS (SELECT 1 FROM project_files WHERE id = ? AND status = 'ready')").bind(id, id),
      ]));
      if (!moved?.meta?.changes) return (yield* settled) ?? (yield* Effect.fail(gone()));
      return { file: yield* toRef(row), completed: true };
    }),

    cancel: Effect.fn(function* (folderId: string, collection: string, id: string, actorKey: string) {
      const [marked] = yield* io(() => db.batch([
        db.prepare(`UPDATE project_files SET status = 'deleted', deleted_at = ?, resume_key = NULL
          WHERE id = ? AND folder_id = ? AND collection = ? AND actor_key = ? AND (status = 'uploading' OR (status = 'ready' AND record_id IS NULL))`)
          .bind(iso(now()), id, folderId, collection, actorKey),
        db.prepare("DELETE FROM project_file_parts WHERE file_id = ? AND EXISTS (SELECT 1 FROM project_files WHERE id = ? AND status = 'deleted')").bind(id, id),
      ]));
      return Boolean(marked?.meta?.changes);
    }),

    describe: Effect.fn(function* (folderId: string, collection: string, fileId: string) {
      const row = yield* readRow(fileId);
      if (!row || row.status !== "attached" || row.folder_id !== folderId || row.collection !== collection) return null;
      return { ...(yield* toRef(row)), recordId: row.record_id as string, createdAt: row.created_at };
    }),

    download: Effect.fn(function* (folderId: string, collection: string, recordId: string, fileId: string, signal?: AbortSignal) {
      const row = yield* readRow(fileId);
      if (!row || row.status !== "attached" || row.folder_id !== folderId || row.collection !== collection || row.record_id !== recordId) return null;
      const file = yield* toRef(row);
      const key = yield* fileKey(row);
      const parts = Number(row.parts), size = Number(row.size);
      // A full isolate fails before any byte. Held until the stream ends or is cancelled, the
      // request aborts (workerd never cancels a disconnected client's stream) or the slot ages out.
      const slot = yield* acquire(now());
      let n = 0;
      const done = () => { transfers.delete(slot); };   // idempotent: end, cancel, error and abort may all fire
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();   // the client left during the reads above: the event already fired
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (++n > parts) { done(); return controller.close(); }
          const last = n === parts, plain = partSize({ size, parts }, n);
          try {
            const object = await bucket.get(objectKey(fileId), { range: { offset: (n - 1) * (PART_BYTES + SEAL_OVERHEAD), length: plain + SEAL_OVERHEAD } });
            if (!object) throw fail("not-found", "File bytes are missing.");
            controller.enqueue(await Effect.runPromise(openBlob(key, await object.arrayBuffer(), partAad(fileId, n, last))));
          } catch (error) { done(); controller.error(error); }
        },
        cancel: done,
      }, { highWaterMark: 0 });   // pull only when the consumer reads: one part in memory, never a read-ahead
      // workerd sends a known Content-Length for a FixedLengthStream body; Node has none.
      return { file, body: typeof FixedLengthStream === "function" ? stream.pipeThrough(new FixedLengthStream(size)) : stream };
    }),

    sweep: Effect.fn(function* () {
      const cutoff = iso(now() - SWEEP_GRACE_MS);
      let removed = 0;
      for (let round = 0; round < limits.sweepBatches; round++) {
        const { results } = yield* io(() => db.prepare(`SELECT id, multipart_id FROM project_files WHERE ${DEAD} ORDER BY id LIMIT ${limits.sweepBatch}`)
          .bind(cutoff, cutoff).all<{ id: string; multipart_id: string | null }>());
        if (!results.length) break;
        for (const { id, multipart_id } of results) {
          // Already completed or aborted uploads reject; either way nothing is left open.
          if (multipart_id) yield* io(() => bucket.resumeMultipartUpload(objectKey(id), multipart_id).abort()).pipe(Effect.ignore);
        }
        const deleted = yield* io(() => bucket.delete(results.map(({ id }) => objectKey(id)))).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
        if (!deleted) return removed;   // the rows stay for the next run
        const ids = JSON.stringify(results.map(({ id }) => id));
        const [, files] = yield* io(() => db.batch([
          db.prepare(`DELETE FROM project_file_parts WHERE file_id IN (SELECT value FROM json_each(?))
            AND file_id IN (SELECT id FROM project_files WHERE ${DEAD})`).bind(ids, cutoff, cutoff),
          db.prepare(`DELETE FROM project_files WHERE id IN (SELECT value FROM json_each(?)) AND ${DEAD}`).bind(ids, cutoff, cutoff),
        ]));
        removed += Number(files?.meta?.changes ?? 0);
        if (results.length < limits.sweepBatch) break;
      }
      return removed;
    }),
  };
}
