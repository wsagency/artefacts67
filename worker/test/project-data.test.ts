import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";

import { openD1Shim } from "./db.js";
import { memoryBucket } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openFolders } from "../src/folders.js";
import {
  openProjectData, validateCollection, validateRecord, PROJECT_LIMITS,
  type ProjectLimits, type ProjectRecord, type RecordPage, type Submission,
} from "../src/project-data.js";
import { openProjectFiles, type FileRef } from "../src/project-files.js";
import type { CodeError } from "../src/types.js";
import type { JsonValue } from "../src/runtime-state.js";

const TEST_MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const run = <A>(effect: Effect.Effect<A, CodeError>) => Effect.runPromise(effect);
const failure = <A>(effect: Effect.Effect<A, CodeError>) => Effect.runPromise(Effect.flip(effect));

async function fixture(limits?: ProjectLimits) {
  const db = openD1Shim();
  const store = openStore(db);
  const owner = await run(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const folders = openFolders({ db, masterKeyHex: TEST_MASTER });
  const acme = await run(folders.create({ ownerId: owner.id, slug: "acme" }));
  const sub = await run(folders.create({ ownerId: owner.id, slug: "sub", parentId: acme.id }));
  const other = await run(folders.create({ ownerId: owner.id, slug: "other" }));
  let clock = Date.parse("2026-10-09T09:00:00.000Z");
  const data = openProjectData({ db, masterKeyHex: TEST_MASTER, now: () => (clock += 1000), ...(limits ? { limits } : {}) });
  const files = openProjectFiles({ db, bucket: memoryBucket(), masterKeyHex: TEST_MASTER, now: () => clock });
  const open = async (actor: string, field: string, name = "a.pdf", collection = "docs") => {
    const found = (await run(data.collection(acme.id, collection)))!;
    return (await run(files.start({ folderId: acme.id, collection: found, field, actorKey: actor, name, type: "", lastModified: null, size: 5 }))).upload;
  };
  /** A completed 5-byte upload, ready to attach. */
  const ready = async (actor: string, field: string, name = "a.pdf", collection = "docs"): Promise<FileRef> => {
    const upload = await open(actor, field, name, collection);
    const body = new Request("https://example.test/part", { method: "PUT", body: new Uint8Array(5), headers: { "Content-Length": "5" } });
    await run(files.putPart(acme.id, collection, upload.id, actor, 1, body));
    return (await run(files.complete(acme.id, collection, upload.id, actor))).file;
  };
  const row = (id: string) => db.prepare("SELECT * FROM project_files WHERE id = ?").bind(id).first<Record<string, unknown>>()!;
  const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()!.n;
  return { db, acme, sub, other, data, files, open, ready, row, count, advance: (ms: number) => { clock += ms; } };
}

const issuesOf = (result: { issues: unknown[] } | { value: unknown }) => "issues" in result ? result.issues as Array<{ field: string; message: string }> : [];
const TITLE = { kind: "records", fields: { title: { type: "text", required: true } } };
const meta = (actor: string): Submission => ({
  submittedAt: "2026-10-09T10:00:00.000Z", artifactId: "art1", artifactVersion: 3,
  submittedBy: { type: "share", shareId: `share-${actor}`, shareName: "Visitors" },
});

test("validateCollection rejects bad names, kinds, field types and limits", async () => {
  const fields = issuesOf(validateCollection({ kind: "table", fields: {} })).map((issue) => issue.field);
  assert.ok(fields.includes("kind"));
  assert.ok(fields.includes("fields"));
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, { type: "text" }]));
  assert.ok(issuesOf(validateCollection({ kind: "records", fields: many })).some((issue) => issue.field === "fields"));
  for (const options of [[], Array.from({ length: 101 }, (_, i) => `o${i}`), ["a", "a"]]) {
    assert.equal(issuesOf(validateCollection({ kind: "records", fields: { c: { type: "choice", options } } })).length > 0, true, JSON.stringify(options).slice(0, 20));
  }
  assert.ok(issuesOf(validateCollection({ kind: "records", fields: { t: { type: "text", maxLength: 10001 } } })).length > 0);
  const { acme, data } = await fixture();
  const error = await failure(data.define(acme.id, "Bad Name", TITLE));
  assert.equal(error.code, "validation");
  assert.equal(error.issues?.[0]?.field, "name");
});

test("validateRecord coerces form strings", () => {
  const schema = {
    n: { type: "number" as const, integer: true, min: 1, max: 10 },
    ok: { type: "boolean" as const },
    tags: { type: "choice" as const, options: ["a", "b"], multiple: true },
    when: { type: "date" as const },
  };
  assert.deepEqual(validateRecord(schema, { n: "3", ok: "on", tags: "a", when: "2026-02-28" }), { value: { n: 3, ok: true, tags: ["a"], when: "2026-02-28" } });
  assert.deepEqual(validateRecord(schema, {}), { value: { ok: false } });
  for (const [field, input] of [["n", { n: "3.5" }], ["n", { n: "11" }], ["when", { when: "2026-02-30" }], ["tags", { tags: ["c"] }]] as const) {
    const issues = issuesOf(validateRecord(schema, input));
    assert.equal(issues.length, 1, field);
    assert.equal(issues[0]?.field, field);
  }
});

test("empty strings are absent", () => {
  assert.deepEqual(validateRecord({ name: { type: "text" }, size: { type: "choice", options: ["s"] } }, { name: "", size: "" }), { value: {} });
  const issues = issuesOf(validateRecord({ name: { type: "text" }, size: { type: "choice", options: ["s"], required: true } }, { name: "", size: "" }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.field, "size");
  assert.match(issues[0]?.message ?? "", /required/);
});

test("a required boolean is a confirmation", () => {
  const schema = { confirm: { type: "boolean" as const, required: true } };
  assert.deepEqual(validateRecord(schema, { confirm: "on" }), { value: { confirm: true } });
  assert.equal(issuesOf(validateRecord(schema, {}))[0]?.field, "confirm");
  assert.equal(issuesOf(validateRecord(schema, { confirm: "false" }))[0]?.field, "confirm");
});

test("unknown fields and oversized text are rejected", () => {
  assert.equal(issuesOf(validateRecord({ a: { type: "text" } }, { extra: 1 }))[0]?.field, "extra");
  assert.equal(issuesOf(validateRecord({ a: { type: "text" } }, { a: "x".repeat(2001) }))[0]?.field, "a");
});

test("define creates, replaces fields and refuses a kind change", async () => {
  const { acme, data } = await fixture();
  const first = await run(data.define(acme.id, "offers", TITLE));
  assert.equal(first.created, true);
  assert.equal(first.collection.visitors, false);
  const second = await run(data.define(acme.id, "offers", { kind: "records", fields: { body: { type: "text" } }, visitors: true }));
  assert.equal(second.created, false);
  assert.deepEqual(Object.keys(second.collection.fields), ["body"]);
  assert.equal(second.collection.visitors, true);
  assert.equal(second.collection.createdAt, first.collection.createdAt);
  assert.equal((await failure(data.define(acme.id, "offers", { ...TITLE, kind: "responses" }))).code, "conflict");
  for (let i = 1; i < 50; i++) await run(data.define(acme.id, `c${i}`, TITLE));
  assert.equal((await failure(data.define(acme.id, "c50", TITLE))).code, "quota-exceeded");
  assert.equal((await run(data.collections(acme.id))).length, 50);
});

test("define refuses a nested folder", async () => {
  const { acme, sub, data } = await fixture();
  assert.equal((await failure(data.define(sub.id, "x", TITLE))).code, "not-top-level");
  assert.equal(await run(data.projectOf(sub.id)), acme.id);
  assert.equal(await run(data.projectOf(acme.id)), acme.id);
  assert.equal(await run(data.projectOf(null)), null);
});

test("records round-trip sealed with versions and ifVersion", async () => {
  const { db, acme, data } = await fixture();
  await run(data.define(acme.id, "offers", TITLE));
  const created = await run(data.create(acme.id, "offers", { title: "Plaintext-Offer" }));
  assert.equal(created.version, 1);
  assert.deepEqual(created.data, { title: "Plaintext-Offer" });
  const updated = await run(data.update(acme.id, "offers", created.id, { title: "Second" }, 1));
  assert.equal(updated.version, 2);
  assert.equal((await failure(data.update(acme.id, "offers", created.id, { title: "Third" }, 1))).code, "conflict");
  const current = await run(data.get(acme.id, "offers", created.id));
  assert.equal(current?.version, 2);
  assert.deepEqual(current?.data, { title: "Second" });
  assert.equal((await failure(data.remove(acme.id, "offers", created.id, 9))).code, "conflict");
  const raw = JSON.stringify(db.prepare("SELECT * FROM project_records").all().results);
  assert.ok(!raw.includes("Second") && !raw.includes("title"));
  assert.equal(await run(data.remove(acme.id, "offers", created.id)), true);
  assert.equal(await run(data.get(acme.id, "offers", created.id)), null);
});

test("pages are stable with an opaque cursor", async () => {
  const { acme, data } = await fixture();
  await run(data.define(acme.id, "offers", TITLE));
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await run(data.create(acme.id, "offers", { title: `t${i}` }))).id);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page++) {
    const result: RecordPage = await run(data.list(acme.id, "offers", { limit: 2, ...(cursor ? { cursor } : {}) }));
    seen.push(...result.records.map((record) => record.id));
    cursor = result.cursor;
  }
  assert.deepEqual(seen, ids);
  assert.equal(cursor, null);
  assert.equal((await failure(data.list(acme.id, "offers", { limit: 501 }))).code, "validation");
  assert.equal((await failure(data.list(acme.id, "offers", { cursor: "junk" }))).code, "validation");
});

test("projects are isolated", async () => {
  const { acme, other, data } = await fixture();
  await run(data.define(acme.id, "offers", TITLE));
  await run(data.define(other.id, "offers", TITLE));
  const created = await run(data.create(acme.id, "offers", { title: "A" }));
  assert.equal(await run(data.get(other.id, "offers", created.id)), null);
  assert.equal((await run(data.list(other.id, "offers"))).records.length, 0);
});

test("quotas are enforced atomically", async () => {
  const { db, acme, data } = await fixture({ ...PROJECT_LIMITS, records: 2 });
  await run(data.define(acme.id, "offers", { kind: "records", fields: { title: { type: "text", maxLength: 10000 } } }));
  await run(data.create(acme.id, "offers", { title: "a" }));
  await run(data.create(acme.id, "offers", { title: "b" }));
  assert.equal((await failure(data.create(acme.id, "offers", { title: "c" }))).code, "quota-exceeded");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_records").first<{ n: number }>()?.n, 2);

  const small = await fixture();
  await run(small.data.define(small.acme.id, "offers", { kind: "records", fields: { title: { type: "text", maxLength: 10000 } } }));
  const record = await run(small.data.create(small.acme.id, "offers", { title: "a" }));
  const bytes = small.db.prepare("SELECT LENGTH(data_sealed) AS n FROM project_records").first<{ n: number }>()!.n;
  const tight = openProjectData({ db: small.db, masterKeyHex: TEST_MASTER, limits: { ...PROJECT_LIMITS, projectBytes: bytes + 1 } });
  assert.equal((await failure(tight.update(small.acme.id, "offers", record.id, { title: "a".repeat(500) }))).code, "quota-exceeded");
  assert.equal((await run(tight.get(small.acme.id, "offers", record.id)))?.version, 1);

  await run(small.data.define(small.acme.id, "big", { kind: "records", fields: Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [`t${i}`, { type: "text", maxLength: 10000 }])) }));
  const huge = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`t${i}`, "x".repeat(10000)]));
  assert.equal((await failure(small.data.create(small.acme.id, "big", huge))).code, "too-large");
});

test("responses need submission metadata and are immutable", async () => {
  const { acme, data } = await fixture();
  await run(data.define(acme.id, "rsvp", { kind: "responses", fields: { name: { type: "text" } } }));
  await run(data.define(acme.id, "offers", TITLE));
  assert.equal((await failure(data.create(acme.id, "rsvp", { name: "A" }))).code, "wrong-kind");
  const a = await run(data.create(acme.id, "rsvp", { name: "A" }, { actorKey: "actor-a", meta: meta("a") }));
  assert.deepEqual(a.submission, meta("a"));
  await run(data.create(acme.id, "rsvp", { name: "B" }, { actorKey: "actor-b", meta: meta("b") }));
  assert.equal((await failure(data.update(acme.id, "rsvp", a.id, { name: "Z" }))).code, "wrong-kind");
  const mine = await run(data.list(acme.id, "rsvp", { actorKey: "actor-a" }));
  assert.deepEqual(mine.records.map((record) => record.id), [a.id]);
  assert.equal((await failure(data.create(acme.id, "offers", { title: "x" }, { actorKey: "actor-a", meta: meta("a") }))).code, "wrong-kind");
});

test("removeCollection deletes its records", async () => {
  const { db, acme, data } = await fixture();
  await run(data.define(acme.id, "offers", TITLE));
  await run(data.create(acme.id, "offers", { title: "A" }));
  assert.equal(await run(data.removeCollection(acme.id, "offers", "records")), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_records WHERE collection = ?").bind("offers").first<{ n: number }>()?.n, 0);
  assert.equal((await failure(data.create(acme.id, "offers", { title: "A" }))).code, "not-found");
  assert.equal(await run(data.removeCollection(acme.id, "offers", "records")), false);
});

test("removeCollection deletes nothing when the kind no longer matches", async () => {
  const { db, acme, data } = await fixture();
  await run(data.define(acme.id, "offers", TITLE));
  await run(data.create(acme.id, "offers", { title: "A" }));
  assert.equal(await run(data.removeCollection(acme.id, "offers", "responses")), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_records WHERE collection = ?").bind("offers").first<{ n: number }>()?.n, 1);
  assert.equal((await run(data.collection(acme.id, "offers")))?.kind, "records");
});

test("an absent optional field never reads an inherited property", () => {
  const schema = { constructor: { type: "text" as const }, toString: { type: "number" as const }, title: { type: "text" as const } };
  assert.deepEqual(validateRecord(schema, { title: "A" }), { value: { title: "A" } });
});

test("define reports created only for a new collection, even within one clock tick", async () => {
  const { db, acme } = await fixture();
  const data = openProjectData({ db, masterKeyHex: TEST_MASTER, now: () => Date.parse("2026-10-09T09:00:00.000Z") });
  assert.equal((await run(data.define(acme.id, "offers", TITLE))).created, true);
  assert.equal((await run(data.define(acme.id, "offers", TITLE))).created, false);
});

test("file fields validate maxBytes, accept and multiple", () => {
  const issue = (spec: unknown) => issuesOf(validateCollection({ kind: "records", fields: { f: spec } }))[0]?.field;
  for (const bad of [{ type: "file", maxBytes: 0 }, { type: "file", maxBytes: 104_857_601 }, { type: "file", maxBytes: 1.5 },
    { type: "file", accept: [] }, { type: "file", accept: ["PDF"] }, { type: "file", accept: ["pdf"] }, { type: "file", accept: [".pdf", ".pdf"] },
    { type: "file", accept: Array.from({ length: 51 }, (_, i) => `.e${i}`) }, { type: "file", accept: [".x".padEnd(18, "y")] },
    { type: "file", multiple: "yes" }]) assert.equal(issue(bad), "fields.f", JSON.stringify(bad));
  const good = { type: "file", maxBytes: 1_048_576, accept: ["application/pdf", "image/*", ".zip"], multiple: true, required: true };
  assert.deepEqual(validateCollection({ kind: "records", fields: { f: good } }), { value: { kind: "records", fields: { f: good }, visitors: false } });
  assert.deepEqual(validateCollection({ kind: "records", fields: { f: { type: "file" } } }), { value: { kind: "records", fields: { f: { type: "file" } }, visitors: false } });
});

test("file values are ids, objects with an id, or arrays when multiple", () => {
  const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
  const schema = { doc: { type: "file" as const }, pics: { type: "file" as const, multiple: true } };
  assert.deepEqual(validateRecord(schema, { doc: A, pics: [{ id: B, name: "ignored" }, C] }), { value: { doc: A, pics: [B, C] } });
  assert.deepEqual(validateRecord(schema, { doc: { id: A, name: "x", type: "y", size: 1 } }), { value: { doc: A } });
  assert.deepEqual(validateRecord(schema, { pics: B }), { value: { pics: [B] } });
  for (const input of [{ doc: [A] }, { doc: "nothex" }, { doc: { id: 7 } }, { pics: Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(32, "0")) }, { pics: [B, B] }])
    assert.equal(issuesOf(validateRecord(schema, input)).length, 1, JSON.stringify(input));
  assert.equal(issuesOf(validateRecord(schema, { doc: A, pics: [A] }))[0]?.field, "pics");          // duplicate across one write
  for (const empty of [null, "", []]) assert.deepEqual(validateRecord(schema, { doc: empty, pics: empty }), { value: {} });
  assert.deepEqual(issuesOf(validateRecord({ doc: { type: "file", required: true } }, { doc: [] })), [{ field: "doc", message: "This field is required." }]);
});

const FILES = { kind: "records", fields: { title: { type: "text" }, doc: { type: "file" }, pics: { type: "file", multiple: true } } };
const NOT_AVAILABLE = "File is not available. Upload it again.";

test("create attaches referenced files and stores descriptors", async () => {
  const { db, acme, data, ready, row } = await fixture();
  await run(data.define(acme.id, "docs", FILES));
  const doc = await ready("A", "doc");
  const record = await run(data.create(acme.id, "docs", { title: "x", doc: doc.id }, undefined, "A"));
  assert.deepEqual(record.data.doc, doc);
  assert.deepEqual([row(doc.id).status, row(doc.id).record_id, row(doc.id).expires_at], ["attached", record.id, null]);
  assert.match(db.prepare("SELECT last_write FROM project_records WHERE id = ?").bind(record.id).first<{ last_write: string }>()!.last_write, /^[0-9a-f]{32}$/);
});

test("files that are not attachable are refused on their field", async () => {
  const { acme, data, ready, count, advance } = await fixture();
  await run(data.define(acme.id, "docs", FILES));
  const doc = await ready("A", "doc");
  const other = await failure(data.create(acme.id, "docs", { doc: doc.id }, undefined, "B"));
  assert.deepEqual([other.code, other.issues], ["validation", [{ field: "doc", message: NOT_AVAILABLE }]]);
  assert.equal((await failure(data.create(acme.id, "docs", { doc: doc.id }))).code, "validation");             // no file actor
  assert.equal((await failure(data.create(acme.id, "docs", { pics: [doc.id] }, undefined, "A"))).issues?.[0]?.field, "pics"); // other field
  const late = await ready("A", "doc", "late.pdf"); advance(86_400_001);
  assert.equal((await failure(data.create(acme.id, "docs", { doc: late.id }, undefined, "A"))).code, "validation");    // expired ready
  assert.equal(count("project_records"), 0);
});

test("a required file field must be present", async () => {
  const { acme, data } = await fixture();
  await run(data.define(acme.id, "docs", { kind: "records", fields: { ...FILES.fields, need: { type: "file", required: true } } }));
  for (const input of [{ title: "x" }, { need: [] }]) {
    assert.deepEqual((await failure(data.create(acme.id, "docs", input, undefined, "A"))).issues, [{ field: "need", message: "This field is required." }]);
  }
});

test("update keeps attached files, attaches new ones and deletes dropped ones", async () => {
  const { acme, data, ready, row } = await fixture();
  await run(data.define(acme.id, "docs", FILES));
  const [p1, p2, p3] = [await ready("A", "pics", "1.png"), await ready("A", "pics", "2.png"), await ready("A", "pics", "3.png")];
  const record = await run(data.create(acme.id, "docs", { pics: [p1!.id, p2!.id] }, undefined, "A"));
  const updated = await run(data.update(acme.id, "docs", record.id, { pics: [(record.data.pics as JsonValue[])[0], p3!.id] }, 1, "A"));
  assert.deepEqual([updated.data.pics, updated.version], [[p1, p3], 2]);
  assert.deepEqual([row(p1!.id).status, row(p3!.id).status, row(p3!.id).record_id, row(p2!.id).status], ["attached", "attached", record.id, "deleted"]);
  assert.notEqual(row(p2!.id).deleted_at, null);
  const again = await run(data.update(acme.id, "docs", record.id, updated.data));                 // written back unchanged, no file actor
  assert.equal(again.version, 3);
  assert.deepEqual([p1, p2, p3].map((file) => row(file!.id).status), ["attached", "deleted", "attached"]);
});

test("two writes racing for one file attach it exactly once", async () => {
  const { db, acme, data, ready, count } = await fixture();
  await run(data.define(acme.id, "docs", FILES));
  const doc = await ready("A", "doc");
  const results = await Promise.allSettled([1, 2].map(() => run(data.create(acme.id, "docs", { doc: doc.id }, undefined, "A"))));
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(count("project_records"), 1);
  const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<ProjectRecord>).value;
  assert.equal(db.prepare("SELECT record_id FROM project_files WHERE id = ?").bind(doc.id).first<{ record_id: string }>()!.record_id, winner.id);
});

test("failed write leaves files ready", async () => {
  const unchanged = (row: Record<string, unknown>, expires: unknown) => assert.deepEqual([row.status, row.record_id, row.expires_at], ["ready", null, expires]);
  const full = await fixture({ ...PROJECT_LIMITS, records: 0 });
  await run(full.data.define(full.acme.id, "docs", FILES));
  const blocked = await full.ready("A", "doc");
  const expires = full.row(blocked.id).expires_at;
  assert.equal((await failure(full.data.create(full.acme.id, "docs", { doc: blocked.id }, undefined, "A"))).code, "quota-exceeded");
  unchanged(full.row(blocked.id), expires);

  const { acme, data, ready, row } = await fixture();
  await run(data.define(acme.id, "docs", FILES));
  const doc = await ready("A", "doc");
  const at = row(doc.id).expires_at;
  assert.equal((await failure(data.create(acme.id, "docs", { title: 42, doc: doc.id }, undefined, "A"))).issues?.[0]?.field, "title");
  unchanged(row(doc.id), at);
  const existing = await run(data.create(acme.id, "docs", { title: "x" }));
  assert.equal((await failure(data.update(acme.id, "docs", existing.id, { doc: doc.id }, existing.version + 1, "A"))).code, "conflict");
  unchanged(row(doc.id), at);
  const record = await run(data.create(acme.id, "docs", { doc: doc.id }, undefined, "A"));
  assert.deepEqual([row(doc.id).status, row(doc.id).record_id], ["attached", record.id]);
});

test("a submission's actor is its file actor", async () => {
  const { acme, data, ready, row } = await fixture();
  await run(data.define(acme.id, "rsvp", { kind: "responses", fields: { cv: { type: "file" } } }));
  const cv = await ready("V", "cv", "cv.pdf", "rsvp");
  const record = await run(data.create(acme.id, "rsvp", { cv: cv.id }, { actorKey: "V", meta: meta("V") }));
  assert.deepEqual([row(cv.id).status, row(cv.id).record_id], ["attached", record.id]);
  const second = await ready("V", "cv", "cv2.pdf", "rsvp");
  const stolen = await failure(data.create(acme.id, "rsvp", { cv: second.id }, { actorKey: "W", meta: meta("W") }));
  assert.deepEqual([stolen.code, stolen.issues], ["validation", [{ field: "cv", message: NOT_AVAILABLE }]]);
});

test("deleting a record or a collection marks its files deleted", async () => {
  const { acme, data, open, ready, row, count } = await fixture();
  await run(data.define(acme.id, "docs", FILES));
  await run(data.define(acme.id, "keep", FILES));
  const first = await ready("A", "doc");
  const record = await run(data.create(acme.id, "docs", { doc: first.id }, undefined, "A"));
  assert.equal(await run(data.remove(acme.id, "docs", record.id)), true);
  assert.deepEqual([row(first.id).status, typeof row(first.id).deleted_at], ["deleted", "string"]);

  const attached = await ready("A", "doc", "b.pdf");
  await run(data.create(acme.id, "docs", { doc: attached.id }, undefined, "A"));
  const loose = await ready("A", "doc", "c.pdf");
  const uploading = await open("A", "doc", "d.pdf");
  const elsewhere = await ready("A", "doc", "e.pdf", "keep");
  assert.equal(await run(data.removeCollection(acme.id, "docs", "records")), true);
  for (const id of [attached.id, loose.id, uploading.id]) assert.deepEqual([row(id).status, typeof row(id).deleted_at], ["deleted", "string"], id);
  assert.equal(row(elsewhere.id).status, "ready");
  assert.equal(count("project_files"), 5);                                                         // rows stay for the sweep
});
