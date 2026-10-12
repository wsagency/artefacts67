import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Effect } from "effect";

import { memoryBucket, TEST_MASTER } from "./doubles.js";
import { openD1Shim } from "./db.js";
import { openStore } from "../src/store.js";
import { openFolders } from "../src/folders.js";
import { openProjectData } from "../src/project-data.js";
import { FILE_LIMITS, SEAL_OVERHEAD, openProjectFiles, type FileLimits } from "../src/project-files.js";
import { PART_BYTES } from "../src/http.js";
import { hex, sha256 } from "../src/crypto.js";
import type { CodeError } from "../src/types.js";

const run = <A>(effect: Effect.Effect<A, CodeError>) => Effect.runPromise(effect);
const failure = <A>(effect: Effect.Effect<A, CodeError>) => Effect.runPromise(Effect.flip(effect));
const readAll = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());
const MARKER = new TextEncoder().encode("PLAINTEXT-MARKER");
/** Deterministic content; every part that has room starts with the plaintext marker. */
const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n).map((_, i) => (i * seed + seed) % 251);
  for (let offset = 0; offset + MARKER.length <= n; offset += PART_BYTES) out.set(MARKER, offset);
  return out;
};
/** A part body that is being read until `open()`. */
const held = (body: Uint8Array) => {
  let open!: () => void, pulled!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; }), reading = new Promise<void>((resolve) => { pulled = resolve; });
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { pulled(); await gate; controller.enqueue(body); controller.close(); } });
  return { request: new Request("https://example.test/part", { method: "PUT", body: stream, duplex: "half", headers: { "Content-Length": String(body.byteLength) } } as RequestInit), open, reading };
};
const DOCS = { kind: "records", fields: { title: { type: "text" }, doc: { type: "file", accept: [".pdf", "image/*"] },
  big: { type: "file", maxBytes: 3 * PART_BYTES }, tiny: { type: "file", maxBytes: 10 }, huge: { type: "file", maxBytes: 104_857_600 } } };

async function files(limits?: FileLimits) {
  const db = openD1Shim();
  const store = openStore(db);
  const owner = await run(store.users.create({ id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}" }));
  const acme = await run(openFolders({ db, masterKeyHex: TEST_MASTER }).create({ ownerId: owner.id, slug: "acme" }));
  const data = openProjectData({ db, masterKeyHex: TEST_MASTER });
  await run(data.define(acme.id, "docs", DOCS));
  let clock = Date.parse("2026-10-12T09:00:00.000Z");
  const bucket = memoryBucket();
  const model = openProjectFiles({ db, bucket, masterKeyHex: TEST_MASTER, now: () => clock, ...(limits ? { limits } : {}) });
  const collection = (await run(data.collection(acme.id, "docs")))!;
  const start = (actor: string, field: string, name: string, size: unknown, extra: { type?: unknown; lastModified?: unknown } = {}) =>
    model.start({ folderId: acme.id, collection, field, actorKey: actor, name, type: "", lastModified: null, size, ...extra });
  const request = (body: Uint8Array<ArrayBuffer>, length = String(body.byteLength)) =>
    new Request("https://example.test/part", { method: "PUT", body, headers: { "Content-Length": length } });
  const putPart = (actor: string, id: string, n: number, body: Uint8Array<ArrayBuffer>) => model.putPart(acme.id, "docs", id, actor, n, request(body));
  const sendAll = async (actor: string, id: string, content: Uint8Array<ArrayBuffer>) => {
    for (let n = 1; (n - 1) * PART_BYTES < content.byteLength; n++) await run(putPart(actor, id, n, content.slice((n - 1) * PART_BYTES, n * PART_BYTES)));
  };
  const upload = async (actor: string, field: string, content: Uint8Array<ArrayBuffer>, name = "a.pdf", type = "") => {
    const { upload } = await run(start(actor, field, name, content.byteLength, { type }));
    await sendAll(actor, upload.id, content);
    return (await run(model.complete(acme.id, "docs", upload.id, actor))).file;
  };
  const attach = (id: string, recordId: string) =>
    db.prepare("UPDATE project_files SET status = 'attached', record_id = ?, expires_at = NULL WHERE id = ?").bind(recordId, id).run();
  const parts = (id: string) => db.prepare("SELECT COUNT(*) AS n FROM project_file_parts WHERE file_id = ?").bind(id).first<{ n: number }>()!.n;
  const row = (id: string) => db.prepare("SELECT * FROM project_files WHERE id = ?").bind(id).first<Record<string, unknown>>()!;
  return { db, bucket, acme, model, collection, start, request, putPart, sendAll, upload, attach, parts, row,
    clock: () => clock, advance: (ms: number) => { clock += ms; } };
}

test("start validates field, size, name, type, accept and lastModified", async () => {
  // Every accepted start below opens one more session for "A"; the per-actor cap is tested apart.
  const { model, acme, collection, start, clock } = await files({ ...FILE_LIMITS, openPerActor: 100 });
  assert.equal((await failure(start("A", "nope", "a.pdf", 1))).issues?.[0]?.field, "nope");
  assert.equal((await failure(start("A", "title", "a.pdf", 1))).issues?.[0]?.field, "title");     // not a file field
  assert.equal((await failure(model.start({ folderId: acme.id, collection, field: 7, actorKey: "A", name: "a.pdf", type: "", size: 1, lastModified: null }))).issues?.[0]?.field, "field");
  for (const size of [0, 1.5, -1, "5"]) assert.equal((await failure(start("A", "doc", "a.pdf", size))).issues?.[0]?.field, "doc");
  assert.equal((await failure(start("A", "tiny", "a.bin", 11))).code, "too-large");
  assert.equal((await failure(start("A", "doc", "a.pdf", 26_214_401))).code, "too-large");       // default maxBytes
  for (const name of ["", "a/b.pdf", "a\\b.pdf", "a\u0007.pdf", "x".repeat(252) + ".pdf", "a\ud800.pdf", "\udc00b.pdf", "evil\u202efdp.exe", "a\u2066.pdf", "a\u2069.pdf"]) assert.equal((await failure(start("A", "doc", name, 1))).code, "validation");
  assert.equal((await run(start("A", "doc", "😀 clip.pdf", 1))).upload.name, "😀 clip.pdf");       // paired surrogates are well-formed
  assert.equal((await failure(start("A", "doc", "x.exe", 1, { type: "application/x-msdownload" }))).issues?.[0]?.field, "doc");
  assert.equal((await run(start("A", "doc", "SCAN.PDF", 1, { type: "" }))).upload.type, "");        // extension, case-insensitive
  assert.equal((await run(start("A", "doc", "photo", 1, { type: "image/png" }))).upload.type, "image/png");
  assert.equal((await run(start("A", "big", "b.bin", 1, { type: "Image/PNG" }))).upload.type, "");   // invalid token stored as ""
  for (const lastModified of [-1, 1.5, "x"]) assert.equal((await failure(start("A", "doc", "l.pdf", 1, { lastModified }))).issues?.[0]?.field, "doc");
  assert.equal((await run(start("A", "doc", "n.pdf", 1, { lastModified: null }))).upload.lastModified, null);
  const fresh = await run(start("A", "big", "three.bin", 2 * PART_BYTES + 5, { lastModified: 7 }));
  assert.deepEqual({ ...fresh.upload, id: "", expiresAt: "" }, { id: "", collection: "docs", field: "big", name: "three.bin", type: "", size: 2 * PART_BYTES + 5,
    lastModified: 7, partBytes: PART_BYTES, parts: 3, received: [], status: "uploading", expiresAt: "" });
  assert.equal(fresh.upload.expiresAt, new Date(clock() + 86_400_000).toISOString());
  assert.equal(fresh.resumed, false);
  assert.equal((await run(start("A", "huge", "h.bin", 104_857_600))).upload.parts, 13);
  assert.equal((await failure(model.start({ folderId: acme.id, collection: { ...collection, name: "gone" }, field: "doc", actorKey: "A", name: "a.pdf", type: "", size: 1, lastModified: null }))).code, "not-found");
});

test("one-part and three-part files round-trip byte-identical and sealed", async () => {
  const { model, acme, bucket, start, sendAll, upload, attach, row } = await files();
  const one = bytes(100, 3);
  const small = await upload("A", "doc", one, "a.pdf", "application/pdf");
  assert.deepEqual(small, { id: small.id, name: "a.pdf", type: "application/pdf", size: 100 });
  const three = bytes(2 * PART_BYTES + 5, 7);
  const { upload: big } = await run(start("A", "big", "three.zip", three.byteLength, { type: "application/zip" }));
  await sendAll("A", big.id, three);
  assert.equal(bucket.uploads.size, 1);                                                  // multipart, still open
  const ref = (await run(model.complete(acme.id, "docs", big.id, "A"))).file;
  assert.equal(bucket.uploads.size, 0);
  assert.deepEqual(ref, { id: big.id, name: "three.zip", type: "application/zip", size: three.byteLength });
  for (const [file, content, parts] of [[small, one, 1], [ref, three, 3]] as const) {
    const object = bucket.objects.get(`file/${file.id}.enc`)!;
    assert.equal(object.byteLength, content.byteLength + parts * SEAL_OVERHEAD);
    assert.equal(Buffer.from(object).includes(Buffer.from(MARKER)), false);
    const raw = JSON.stringify(row(file.id));
    assert.ok(!raw.includes(file.name) && !raw.includes(file.type), raw);
    attach(file.id, "r1");
    assert.deepEqual(await readAll((await run(model.download(acme.id, "docs", "r1", file.id)))!.body), content);
    assert.equal(await run(model.download(acme.id, "docs", "r2", file.id)), null);
    assert.equal(await run(model.download(acme.id, "other", "r1", file.id)), null);
    assert.equal(await run(model.download("x", "docs", "r1", file.id)), null);
  }
});

test("resume returns the same session and its received parts", async () => {
  const { start, putPart } = await files();
  const size = 2 * PART_BYTES + 5, part1 = bytes(PART_BYTES, 2);
  const first = await run(start("A", "big", "r.bin", size, { lastModified: 1 }));
  const view = await run(putPart("A", first.upload.id, 1, part1));
  assert.deepEqual(view, { number: 1, size: PART_BYTES, sha256: hex(await run(sha256(part1))) });
  const again = await run(start("A", "big", "r.bin", size, { lastModified: 1 }));
  assert.deepEqual([again.resumed, again.upload.id, again.upload.received], [true, first.upload.id, [view]]);
  assert.notEqual((await run(start("A", "big", "r.bin", size, { lastModified: 2 }))).upload.id, first.upload.id);
  assert.notEqual((await run(start("B", "big", "r.bin", size, { lastModified: 1 }))).upload.id, first.upload.id);
  const other = bytes(PART_BYTES, 5);
  await run(putPart("A", first.upload.id, 1, other));
  const resent = await run(start("A", "big", "r.bin", size, { lastModified: 1 }));
  assert.deepEqual(resent.upload.received, [{ number: 1, size: PART_BYTES, sha256: hex(await run(sha256(other))) }]);
});

test("resume with changed bytes replaces differing parts", async () => {
  const { model, acme, start, putPart, sendAll, attach } = await files();
  const content = bytes(2 * PART_BYTES + 5, 4);
  const { upload } = await run(start("A", "big", "c.bin", content.byteLength));
  await sendAll("A", upload.id, content);
  const changed = content.slice(); changed.set(bytes(PART_BYTES, 9), PART_BYTES);
  await run(putPart("A", upload.id, 2, changed.slice(PART_BYTES, 2 * PART_BYTES)));
  const resumed = await run(start("A", "big", "c.bin", content.byteLength));
  assert.equal(resumed.upload.received[1].sha256, hex(await run(sha256(changed.slice(PART_BYTES, 2 * PART_BYTES)))));
  await run(model.complete(acme.id, "docs", upload.id, "A"));
  attach(upload.id, "r1");
  assert.deepEqual(await readAll((await run(model.download(acme.id, "docs", "r1", upload.id)))!.body), changed);
});

test("concurrent start resumes one session", async () => {
  const { db, bucket, model, acme, start } = await files();
  const [a, b] = await Promise.all([run(start("A", "big", "b.bin", 2 * PART_BYTES)), run(start("A", "big", "b.bin", 2 * PART_BYTES))]);
  assert.equal(a.upload.id, b.upload.id);
  assert.deepEqual([a.resumed, b.resumed].sort(), [false, true]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_files").first<{ n: number }>()!.n, 1);
  assert.equal(bucket.uploads.size, 1);                                  // the loser aborted its multipart upload
  await run(model.cancel(acme.id, "docs", a.upload.id, "A"));
  const again = await run(start("A", "big", "b.bin", 2 * PART_BYTES));    // a cancelled key is free again
  assert.deepEqual([again.resumed, again.upload.id !== a.upload.id], [false, true]);
});

test("parts must have the exact expected length", async () => {
  const { model, acme, start, putPart, request } = await files();
  const { upload } = await run(start("A", "big", "p.bin", 2 * PART_BYTES + 5));
  const part = (error: CodeError) => [error.code, error.issues?.[0]?.field];
  for (const n of [0, 4]) assert.deepEqual(part(await failure(putPart("A", upload.id, n, new Uint8Array(5)))), ["validation", "part"]);
  assert.deepEqual(part(await failure(putPart("A", upload.id, 1, new Uint8Array(PART_BYTES - 1)))), ["validation", "part"]);
  assert.equal((await failure(putPart("A", upload.id, 3, new Uint8Array(6)))).code, "too-large");
  assert.equal((await failure(putPart("A", upload.id, 1, new Uint8Array(PART_BYTES + 1)))).code, "too-large");
  assert.deepEqual(part(await failure(model.putPart(acme.id, "docs", upload.id, "A", 1, request(new Uint8Array(PART_BYTES), "1")))), ["validation", "part"]);
  await run(putPart("A", upload.id, 1, new Uint8Array(PART_BYTES)));
  await run(putPart("A", upload.id, 3, new Uint8Array(5)));
  assert.deepEqual(part(await failure(model.complete(acme.id, "docs", upload.id, "A"))), ["validation", "part"]);
});

test("complete is idempotent and moves the file to ready for 24 hours", async () => {
  const { model, acme, start, putPart, parts, row, clock } = await files();
  const { upload } = await run(start("A", "doc", "i.pdf", 5));
  await run(putPart("A", upload.id, 1, new Uint8Array(5)));
  const first = await run(model.complete(acme.id, "docs", upload.id, "A"));
  assert.equal(first.completed, true);
  assert.deepEqual(await run(model.complete(acme.id, "docs", upload.id, "A")), { ...first, completed: false });   // a repeat is no transition
  const state = await run(model.status(acme.id, "docs", upload.id, "A"));
  assert.deepEqual([state.status, state.received, state.expiresAt], ["ready", [], new Date(clock() + 86_400_000).toISOString()]);
  const stored = row(upload.id);
  assert.deepEqual([stored.resume_key, stored.multipart_id, stored.completed_at !== null], [null, null, true]);
  assert.equal(parts(upload.id), 0);                                       // part hashes are gone once the upload is closed
});

test("concurrent completes resolve to one FileRef", async () => {
  const { model, acme, start, sendAll, row } = await files();
  const content = bytes(2 * PART_BYTES + 5, 6);
  const { upload } = await run(start("A", "big", "cc.bin", content.byteLength));
  await sendAll("A", upload.id, content);
  const [a, b] = await Promise.all([run(model.complete(acme.id, "docs", upload.id, "A")), run(model.complete(acme.id, "docs", upload.id, "A"))]);
  assert.deepEqual(a.file, b.file);
  assert.equal(Number(a.completed) + Number(b.completed), 1);                       // exactly one call moved it to ready
  assert.equal(row(upload.id).status, "ready");
});

test("complete recovers a multipart upload completed before a lost D1 write", async () => {
  const { db, bucket, model, acme, start, sendAll, row } = await files();
  const finishBehindTheModel = async (id: string) => {
    const etags = db.prepare("SELECT number, etag FROM project_file_parts WHERE file_id = ? ORDER BY number").bind(id).all<{ number: number; etag: string }>().results;
    await bucket.resumeMultipartUpload(`file/${id}.enc`, row(id).multipart_id as string).complete(etags.map(({ number, etag }) => ({ partNumber: number, etag })));
  };
  const content = bytes(2 * PART_BYTES + 5, 8);
  const { upload } = await run(start("A", "big", "lost.bin", content.byteLength));
  await sendAll("A", upload.id, content);
  await finishBehindTheModel(upload.id);
  assert.equal((await run(model.complete(acme.id, "docs", upload.id, "A"))).file.size, content.byteLength);
  assert.equal(row(upload.id).status, "ready");
  const { upload: wrong } = await run(start("A", "big", "wrong.bin", content.byteLength));
  await sendAll("A", wrong.id, content);
  await finishBehindTheModel(wrong.id);
  await bucket.put(`file/${wrong.id}.enc`, new Uint8Array(3));
  assert.equal((await failure(model.complete(acme.id, "docs", wrong.id, "A"))).code, "conflict");
});

test("a failed complete clears received parts", async () => {
  const { db, model, acme, start, putPart, attach } = await files();
  const content = bytes(2 * PART_BYTES + 5, 3), id = (await run(start("A", "big", "c.bin", content.byteLength))).upload.id;
  for (const n of [1, 2, 3]) await run(putPart("A", id, n, content.slice((n - 1) * PART_BYTES, n * PART_BYTES)));
  db.prepare("UPDATE project_file_parts SET etag = 'stale' WHERE file_id = ? AND number = 2").bind(id).run();
  assert.equal((await failure(model.complete(acme.id, "docs", id, "A"))).code, "conflict");
  const resumed = await run(start("A", "big", "c.bin", content.byteLength));
  assert.deepEqual([resumed.resumed, resumed.upload.id, resumed.upload.received], [true, id, []]);   // nothing is skipped
  for (const n of [1, 2, 3]) await run(putPart("A", id, n, content.slice((n - 1) * PART_BYTES, n * PART_BYTES)));
  await run(model.complete(acme.id, "docs", id, "A"));
  attach(id, "r1");
  assert.deepEqual(await readAll((await run(model.download(acme.id, "docs", "r1", id)))!.body), content);
});

test("quotas count received bytes and are enforced per part", async () => {
  const bytes = await files({ ...FILE_LIMITS, projectBytes: 10 });
  const a = await run(bytes.start("A", "tiny", "a.bin", 6));
  const b = await run(bytes.start("A", "tiny", "b.bin", 6));                         // open sessions reserve nothing
  await run(bytes.putPart("A", a.upload.id, 1, new Uint8Array(6)));                   // usage 6
  assert.equal((await failure(bytes.start("A", "tiny", "c.bin", 5))).code, "quota-exceeded");                    // 6 + 5 > 10
  assert.equal((await failure(bytes.putPart("A", b.upload.id, 1, new Uint8Array(6)))).code, "quota-exceeded");   // 6 + 6 > 10
  assert.equal(bytes.parts(b.upload.id), 0);
  await run(bytes.putPart("A", a.upload.id, 1, new Uint8Array(6)));                   // re-sending replaces, does not add
  await run(bytes.model.complete(bytes.acme.id, "docs", a.upload.id, "A"));            // ready counts by size: still 6
  await run(bytes.start("A", "tiny", "d.bin", 4));                                   // exactly 10
  const count = await files({ ...FILE_LIMITS, projectFiles: 2 });
  const first = await run(count.start("A", "doc", "1.pdf", 1)); await run(count.start("B", "doc", "2.pdf", 1));
  assert.equal((await failure(count.start("C", "doc", "3.pdf", 1))).code, "quota-exceeded");
  await run(count.model.cancel(count.acme.id, "docs", first.upload.id, "A"));
  await run(count.start("C", "doc", "3.pdf", 1));                                    // a cancelled file no longer counts
  const open = await files();
  for (let i = 0; i < 5; i++) await run(open.start("A", "doc", `${i}.pdf`, 1));
  assert.equal((await failure(open.start("A", "doc", "5.pdf", 1))).code, "quota-exceeded");
  await run(open.start("B", "doc", "5.pdf", 1));                                     // per actor
  open.advance(86_400_001);
  await run(open.start("A", "doc", "6.pdf", 1));                                     // expired sessions do not count
});

test("a part held across complete cannot replace the completed file", async () => {
  const { model, acme, bucket, start, putPart, attach } = await files();
  const first = bytes(5, 3), late = held(bytes(5, 9));
  const { upload } = await run(start("A", "doc", "h.pdf", 5));
  await run(putPart("A", upload.id, 1, first));
  const pending = failure(model.putPart(acme.id, "docs", upload.id, "A", 1, late.request));
  await late.reading;                                                                 // the re-send passed its checks
  await run(model.complete(acme.id, "docs", upload.id, "A"));
  attach(upload.id, "r1");
  const stored = bucket.objects.get(`file/${upload.id}.enc`)!.slice();
  late.open();
  assert.equal((await pending).code, "not-found");
  assert.deepEqual(bucket.objects.get(`file/${upload.id}.enc`), stored);
  assert.deepEqual(await readAll((await run(model.download(acme.id, "docs", "r1", upload.id)))!.body), first);
});

test("transfers are capped per isolate", async () => {
  const { model, acme, start, putPart, attach, request } = await files();
  let admitted = 0;
  const admit = Effect.sync(() => { admitted++; });
  const ids: string[] = []; for (const name of ["1.pdf", "2.pdf", "3.pdf", "4.pdf"]) ids.push((await run(start("A", "doc", name, 5))).upload.id);
  const slow = ids.slice(0, 3).map(() => held(new Uint8Array(5)));
  const pending = slow.map((h, i) => run(model.putPart(acme.id, "docs", ids[i], "A", 1, h.request)));
  await Promise.all(slow.map((h) => h.reading));                                      // three bodies in flight
  const busy = await failure(model.putPart(acme.id, "docs", ids[3], "A", 1, request(new Uint8Array(5)), admit));
  assert.deepEqual([busy.code, busy.retryAfter, admitted], ["rate-limited", 1, 0]);   // a full isolate charges no admission
  slow.forEach((h) => h.open()); await Promise.all(pending);
  const refused = Effect.fail(Object.assign(new Error("hourly"), { code: "rate-limited", retryAfter: 60 }) as CodeError);
  assert.equal((await failure(model.putPart(acme.id, "docs", ids[3], "A", 1, request(new Uint8Array(5)), refused))).retryAfter, 60);
  await run(model.putPart(acme.id, "docs", ids[3], "A", 1, request(new Uint8Array(5)), admit));   // slots were released
  assert.equal(admitted, 1);
  for (const id of ids.slice(0, 3)) { await run(model.complete(acme.id, "docs", id, "A")); attach(id, "r1"); }
  const downloads = await Promise.all(ids.slice(0, 3).map(async (id) => (await run(model.download(acme.id, "docs", "r1", id)))!.body));
  assert.equal((await failure(model.download(acme.id, "docs", "r1", ids[0]))).code, "rate-limited"); // unread downloads hold their slots
  await downloads[0].cancel();
  assert.equal((await readAll(downloads[1])).byteLength, 5);                         // a finished stream releases too
  await run(putPart("A", ids[3], 1, new Uint8Array(5)));
  await downloads[2].cancel();
});

test("a download abandoned without a cancel frees its slot after the TTL", async () => {
  const { model, acme, start, putPart, attach, advance } = await files();
  const ids: string[] = []; for (const name of ["1.pdf", "2.pdf", "3.pdf", "4.pdf"]) ids.push((await run(start("A", "doc", name, 5))).upload.id);
  for (const id of ids.slice(0, 3)) { await run(putPart("A", id, 1, new Uint8Array(5))); await run(model.complete(acme.id, "docs", id, "A")); attach(id, "r1"); }
  // A download whose client disconnected without a request.signal abort (or a runtime without one).
  const abandoned = await Promise.all(ids.slice(0, 3).map(async (id) => (await run(model.download(acme.id, "docs", "r1", id)))!.body));
  advance(60 * 60_000);
  assert.equal((await failure(putPart("A", ids[3], 1, new Uint8Array(5)))).code, "rate-limited");   // within the TTL: still held
  advance(1);
  await run(putPart("A", ids[3], 1, new Uint8Array(5)));                                          // past it: pruned
  await Promise.all(abandoned.map((body) => body.cancel()));                                      // a late release frees nothing else
  const four = await Promise.all(ids.slice(0, 3).map(async (id) => (await run(model.download(acme.id, "docs", "r1", id)))!.body));
  assert.equal((await failure(model.download(acme.id, "docs", "r1", ids[0]))).code, "rate-limited");
  await Promise.all(four.map((body) => body.cancel()));
});

test("a download frees its slot when its request is aborted", async () => {
  const { model, acme, start, putPart, attach } = await files();
  const ids: string[] = []; for (const name of ["1.pdf", "2.pdf", "3.pdf", "4.pdf"]) ids.push((await run(start("A", "doc", name, 5))).upload.id);
  for (const id of ids.slice(0, 3)) { await run(putPart("A", id, 1, new Uint8Array(5))); await run(model.complete(acme.id, "docs", id, "A")); attach(id, "r1"); }
  // workerd aborts request.signal on a client disconnect but never cancels the response stream.
  const clients = ids.slice(0, 3).map(() => new AbortController());
  const abandoned = await Promise.all(ids.slice(0, 3).map(async (id, i) => (await run(model.download(acme.id, "docs", "r1", id, clients[i].signal)))!.body));
  assert.equal((await failure(putPart("A", ids[3], 1, new Uint8Array(5)))).code, "rate-limited");
  clients[0].abort();
  const held = new AbortController();
  const next = (await run(model.download(acme.id, "docs", "r1", ids[0], held.signal)))!.body;   // the aborted one's slot is free at once
  clients[0].abort(); await abandoned[0].cancel();                                              // repeats release nothing else
  assert.equal((await failure(putPart("A", ids[3], 1, new Uint8Array(5)))).code, "rate-limited");
  assert.equal((await readAll(next)).byteLength, 5);
  held.abort();                                                                                 // abort after the end is harmless
  await run(putPart("A", ids[3], 1, new Uint8Array(5)));
  clients.slice(1).forEach((c) => c.abort());
  await Promise.all(abandoned.slice(1).map((body) => body.cancel()));
});

test("a download whose request aborted before its slot was taken does not hold it", async () => {
  const { model, acme, start, putPart, attach } = await files();
  const ids: string[] = []; for (const name of ["1.pdf", "2.pdf", "3.pdf", "4.pdf"]) ids.push((await run(start("A", "doc", name, 5))).upload.id);
  for (const id of ids.slice(0, 3)) { await run(putPart("A", id, 1, new Uint8Array(5))); await run(model.complete(acme.id, "docs", id, "A")); attach(id, "r1"); }
  // The client disconnected during the D1 reads: the abort event has already fired.
  const gone = AbortSignal.abort();
  const bodies = await Promise.all(ids.slice(0, 3).map(async (id) => (await run(model.download(acme.id, "docs", "r1", id, gone)))!.body));
  await run(putPart("A", ids[3], 1, new Uint8Array(5)));
  await Promise.all(bodies.map((body) => body.cancel()));
});

test("sessions belong to their actor and expire", async () => {
  const { model, acme, start, putPart, advance } = await files();
  const { upload } = await run(start("A", "doc", "s.pdf", 5));
  const others: Array<Effect.Effect<unknown, CodeError>> = [model.status(acme.id, "docs", upload.id, "B"), putPart("B", upload.id, 1, new Uint8Array(5)),
    model.complete(acme.id, "docs", upload.id, "B"), model.cancel(acme.id, "docs", upload.id, "B")];   // cancel answers false; routes map it to not-found
  for (const effect of others) {
    const result = await run(Effect.result(effect));
    assert.ok(result._tag === "Failure" ? result.failure.code === "not-found" : result.success === false, JSON.stringify(result));
  }
  const { upload: done } = await run(start("A", "doc", "d.pdf", 5));
  await run(putPart("A", done.id, 1, new Uint8Array(5)));
  await run(model.complete(acme.id, "docs", done.id, "A"));
  advance(86_400_001);
  const expired = await failure(model.status(acme.id, "docs", upload.id, "A"));
  assert.deepEqual([expired.code, expired.message], ["not-found", "Upload expired or unknown."]);
  assert.equal((await failure(model.status(acme.id, "docs", done.id, "A"))).code, "not-found");
});

test("cancel deletes uploading and unattached ready files only", async () => {
  const { model, acme, start, putPart, upload, attach, parts, row } = await files();
  const { upload: open } = await run(start("A", "big", "u.bin", 2 * PART_BYTES));
  await run(putPart("A", open.id, 1, new Uint8Array(PART_BYTES)));
  assert.equal(await run(model.cancel(acme.id, "docs", open.id, "A")), true);
  assert.deepEqual([row(open.id).status, row(open.id).deleted_at !== null, parts(open.id)], ["deleted", true, 0]);
  const ready = await upload("A", "doc", bytes(5));
  assert.equal(await run(model.cancel(acme.id, "docs", ready.id, "A")), true);
  const attached = await upload("A", "doc", bytes(5), "b.pdf");
  attach(attached.id, "r1");
  assert.equal(await run(model.cancel(acme.id, "docs", attached.id, "A")), false);
  assert.equal(row(attached.id).status, "attached");
});

test("describe and session expose attached files only to describe", async () => {
  const { model, acme, upload, attach, row } = await files();
  const ref = await upload("A", "doc", bytes(5), "d.pdf", "application/pdf");
  assert.equal(await run(model.describe(acme.id, "docs", ref.id)), null);
  attach(ref.id, "r1");
  assert.deepEqual(await run(model.describe(acme.id, "docs", ref.id)), { ...ref, recordId: "r1", createdAt: row(ref.id).created_at });
  assert.deepEqual(await run(model.session(ref.id)), { id: ref.id, folderId: acme.id, collection: "docs", field: "doc", actorKey: "A", status: "attached" });
  assert.equal(await run(model.session("f".repeat(32))), null);
});

test("tampered, reordered or truncated ciphertext fails the download stream", async () => {
  const { db, bucket, model, acme, upload, attach } = await files();
  const { id } = await upload("A", "big", bytes(2 * PART_BYTES + 5, 2), "t.bin");
  attach(id, "r1");
  const object = bucket.objects.get(`file/${id}.enc`)!;
  const swapped = object.slice(); const n = PART_BYTES + SEAL_OVERHEAD;
  swapped.set(object.subarray(n, 2 * n), 0); swapped.set(object.subarray(0, n), n);
  bucket.objects.set(`file/${id}.enc`, swapped);
  await assert.rejects(readAll((await run(model.download(acme.id, "docs", "r1", id)))!.body));
  const flipped = object.slice(); flipped[flipped.length - 1] ^= 1; bucket.objects.set(`file/${id}.enc`, flipped);
  await assert.rejects(readAll((await run(model.download(acme.id, "docs", "r1", id)))!.body));
  bucket.objects.set(`file/${id}.enc`, object.slice(0, 2 * n));                    // only two sealed parts …
  db.prepare("UPDATE project_files SET parts = 2, size = ? WHERE id = ?").bind(2 * PART_BYTES, id).run();   // … and a row that agrees
  await assert.rejects(readAll((await run(model.download(acme.id, "docs", "r1", id)))!.body));         // part 2 is sealed "more", not "last"
});

test("sweep removes deleted and expired files, their parts and objects, and aborts multipart uploads", async () => {
  const { db, bucket, model, start, putPart, upload, attach, advance, clock } = await files();
  const markDeleted = (id: string) => db.prepare("UPDATE project_files SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(new Date(clock()).toISOString(), id).run();
  const a = (await upload("A", "doc", bytes(5), "a.pdf")).id; attach(a, "r1"); markDeleted(a);
  const b = (await run(start("A", "big", "b.bin", 2 * PART_BYTES + 5))).upload.id;
  await run(putPart("A", b, 1, bytes(PART_BYTES)));
  const c = (await upload("A", "doc", bytes(5), "c.pdf")).id;
  const e = (await upload("A", "doc", bytes(5), "e.pdf")).id; attach(e, "r2");
  advance(7_200_000);
  const d = (await upload("A", "doc", bytes(5), "d.pdf")).id;
  advance(86_400_000 - 7_200_000 + 3_600_001);
  const f = (await upload("B", "doc", bytes(5), "f.pdf")).id; attach(f, "r3"); markDeleted(f);
  assert.equal(await run(model.sweep()), 3);
  const left = db.prepare("SELECT id FROM project_files ORDER BY id").all<{ id: string }>().results.map((row) => row.id);
  assert.deepEqual(left, [d, e, f].sort());
  for (const id of [a, b, c]) assert.equal(bucket.objects.has(`file/${id}.enc`), false);
  assert.equal(bucket.uploads.size, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_file_parts WHERE file_id IN (?, ?, ?)").bind(a, b, c).first<{ n: number }>()!.n, 0);
});

test("sweep works in bounded batches and leaves rows when the bucket fails", async () => {
  const batched = await files({ ...FILE_LIMITS, sweepBatch: 2, sweepBatches: 1 });
  for (const name of ["1.pdf", "2.pdf", "3.pdf"]) await run(batched.start("A", "doc", name, 1));
  batched.advance(86_400_000 + 3_600_001);
  assert.equal(await run(batched.model.sweep()), 2);
  assert.equal(await run(batched.model.sweep()), 1);
  const flaky = await files();
  for (const name of ["1.pdf", "2.pdf"]) await flaky.upload("A", "doc", bytes(5), name);
  flaky.advance(86_400_000 + 3_600_001);
  const original = flaky.bucket.delete;
  flaky.bucket.delete = async () => { flaky.bucket.delete = original; throw new Error("bucket unavailable"); };
  assert.equal(await run(flaky.model.sweep()), 0);
  assert.equal(flaky.db.prepare("SELECT COUNT(*) AS n FROM project_files").first<{ n: number }>()!.n, 2);
  assert.equal(await run(flaky.model.sweep()), 2);
  assert.equal(flaky.bucket.objects.size, 0);
});

test("memory bucket follows the R2 binding rules", async () => {
  const MiB = 1024 * 1024, bucket = memoryBucket();
  await bucket.put("k", new Uint8Array([1, 2, 3, 4, 5, 6]));
  assert.deepEqual(await bucket.head("k"), { size: 6 });
  assert.deepEqual(new Uint8Array(await (await bucket.get("k", { range: { offset: 2, length: 3 } }))!.arrayBuffer()), new Uint8Array([3, 4, 5]));
  assert.equal(await bucket.head("missing"), null);
  // non-final part < 5 MiB → complete rejects
  const small = await bucket.createMultipartUpload("s");
  const s = bucket.resumeMultipartUpload("s", small.uploadId);
  const parts1 = [await s.uploadPart(1, new Uint8Array(4 * MiB)), await s.uploadPart(2, new Uint8Array(1))];
  await assert.rejects(s.complete(parts1));
  // non-uniform non-final parts → complete rejects
  const odd = await bucket.createMultipartUpload("o");
  const o = bucket.resumeMultipartUpload("o", odd.uploadId);
  await assert.rejects(o.complete([await o.uploadPart(1, new Uint8Array(6 * MiB)), await o.uploadPart(2, new Uint8Array(5 * MiB)), await o.uploadPart(3, new Uint8Array(1))]));
  // valid: 5 MiB, 5 MiB, 7 bytes → one object, upload gone
  const ok = await bucket.createMultipartUpload("m");
  const m = bucket.resumeMultipartUpload("m", ok.uploadId);
  const parts = [await m.uploadPart(1, new Uint8Array(5 * MiB).fill(1)), await m.uploadPart(2, new Uint8Array(5 * MiB).fill(2)), await m.uploadPart(3, new Uint8Array(7).fill(3))];
  await m.complete(parts);
  assert.equal(bucket.objects.get("m")!.byteLength, 10 * MiB + 7);
  assert.equal(bucket.objects.get("m")![5 * MiB], 2);
  assert.equal(bucket.uploads.has(ok.uploadId), false);
  await assert.rejects(m.uploadPart(1, new Uint8Array(1)));                 // completed → unknown
  await assert.rejects(m.abort());
  const gone = await bucket.createMultipartUpload("a");
  await bucket.resumeMultipartUpload("a", gone.uploadId).abort();
  assert.equal(bucket.uploads.has(gone.uploadId), false);
});
