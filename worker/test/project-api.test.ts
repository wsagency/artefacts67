import * as Effect from "effect/Effect";
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding } from "./doubles.js";
import { openStore, type Store } from "../src/store.js";
import { openKeys } from "../src/keys.js";
import { openAccess } from "../src/access.js";
import { openFolders } from "../src/folders.js";
import { openProjectData, type Collection, type ProjectRecord } from "../src/project-data.js";
import { openProjectFiles, type FileRef, type PartView, type UploadView } from "../src/project-files.js";
import { openArtifacts } from "../src/artifacts.js";
import { openProjectThemes } from "../src/themes.js";
import { openRateLimiter } from "../src/ratelimit.js";
import { contract } from "../src/contract.js";
import { handleApi } from "../src/api.js";
import { THEME_FONT_SOURCE, validThemeDefinition } from "./theme-fixtures.js";
import { PART_BYTES } from "../src/http.js";

interface ApiOptions { key?: string; method?: string; body?: unknown }
interface ErrorResponse { error: { code: string; message: string; details?: Array<{ field: string; message: string }> } }
interface RecordResponse { record: ProjectRecord }
interface PageResponse { records: ProjectRecord[]; cursor: string | null }

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Form</title></head><body><h1>Form</h1></body></html>`;
const OFFERS = { kind: "records", fields: { title: { type: "text", required: true } } };
const RSVP = { kind: "responses", fields: { name: { type: "text", required: true } } };
const DOCS = { kind: "records", fields: { title: { type: "text", required: true }, doc: { type: "file" } } };
const RSVP_FILES = { kind: "responses", fields: { cv: { type: "file" } } };

const addUser = (store: Store, id: string) =>
  Effect.runPromise(store.users.create({ id, email: `${id}@example.test`, name: id, role: "member", passwordHash: "{}" }));

async function environment() {
  const DB = openD1Shim();
  const store = openStore(DB);
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const access = openAccess({ db: DB, audit: store.audit });
  const keys = openKeys({ db: DB, audit: store.audit, access });
  const folders = openFolders({ db: DB, masterKeyHex: MASTER });
  const projectData = openProjectData({ db: DB, masterKeyHex: MASTER });
  const masterFor = async (userId: string) => (await Effect.runPromise(keys.mint({ userId, kind: "master", scopes: "master", label: "Agent" }))).key;
  const master = await masterFor(owner.id);
  const bucket = memoryBucket();
  const projectFiles = openProjectFiles({ db: DB, bucket, masterKeyHex: MASTER });
  const env = { DB, ARTIFACTS: bucket, ARTEFACTS_MASTER_KEY: MASTER, RATELIMIT: rateLimitBinding() };
  const api = (path: string, { key = master, method = "GET", body }: ApiOptions = {}) =>
    worker.fetch(new Request(`https://example.test/_api/${path}`, {
      method,
      headers: body === undefined ? { authorization: `Bearer ${key}` } : { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  const published = await api("artifacts", { method: "POST", body: { folder: "acme", slug: "form", title: "Form", html: HTML } });
  assert.equal(published.status, 201);
  const artifactId = (await published.json<{ artifact: { id: string } }>()).artifact.id;
  const acme = (await Effect.runPromise(folders.byPath("acme")))!;
  // A constructed Request carries no Content-Length of its own; readBytes requires it.
  const put = (path: string, bytes: Uint8Array<ArrayBuffer>, { key = master, type = "application/octet-stream" } = {}) =>
    worker.fetch(new Request(`https://example.test${path}`, { method: "PUT",
      headers: { authorization: `Bearer ${key}`, "content-type": type, "content-length": String(bytes.byteLength) }, body: bytes }), env);
  const raw = (path: string, key = master) => worker.fetch(new Request(`https://example.test${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
  const direct = (request: Request, files: typeof projectFiles, themes = openProjectThemes({ db: DB, masterKeyHex: MASTER })) => Effect.runPromise(handleApi(request, {
    keys, folders, access, projectData, store, contract, publicOrigin: "https://example.test", projectFiles: files,
    themes,
    artifacts: openArtifacts({ db: DB, bucket, masterKeyHex: MASTER, settings: store.settings }), limiter: openRateLimiter(env),
  }, { rest: new URL(request.url).pathname.replace(/^\/_api\//, "") }));
  return { DB, store, owner, access, keys, folders, projectData, projectFiles, master, masterFor, api, put, raw, direct, acme, artifactId };
}

const records = "projects/acme/collections/offers/records";

test("master key defines a collection and seeds records", async () => {
  const env = await environment();
  const defined = await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS });
  assert.equal(defined.status, 201);
  assert.equal((await defined.json<{ collection: Collection }>()).collection.kind, "records");
  assert.equal((await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS })).status, 200);
  const listed = await (await env.api("projects/acme/collections")).json<{ collections: Collection[] }>();
  assert.deepEqual(listed.collections.map((collection) => collection.name), ["offers"]);

  const created = await env.api(records, { method: "POST", body: { data: { title: "A" } } });
  assert.equal(created.status, 201);
  const record = (await created.json<RecordResponse>()).record;
  assert.equal(record.version, 1);
  const page = await (await env.api(records)).json<PageResponse>();
  assert.deepEqual(page.records.map((item) => item.id), [record.id]);
  assert.deepEqual((await (await env.api(`${records}/${record.id}`)).json<RecordResponse>()).record.data, { title: "A" });

  const updated = await env.api(`${records}/${record.id}`, { method: "PUT", body: { data: { title: "B" }, ifVersion: 1 } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json<RecordResponse>()).record.version, 2);
  const stale = await env.api(`${records}/${record.id}`, { method: "PUT", body: { data: { title: "C" }, ifVersion: 1 } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json<ErrorResponse>()).error.code, "conflict");
  const removed = await env.api(`${records}/${record.id}?ifVersion=2`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, id: record.id });
  assert.equal((await env.api(`${records}/${record.id}`)).status, 404);
  const dropped = await env.api("projects/acme/collections/offers", { method: "DELETE" });
  assert.deepEqual(await dropped.json(), { ok: true, name: "offers" });
});

test("artifact keys cannot reach project data", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS });
  const scoped = (await Effect.runPromise(env.keys.mint({ userId: env.owner.id, kind: "artifact", artifactId: env.artifactId, scopes: "read_write" }))).key;
  assert.equal((await env.api("projects/acme/collections", { key: scoped })).status, 403);
  assert.equal((await env.api(records, { key: scoped, method: "POST", body: { data: { title: "A" } } })).status, 403);
});

test("tiers follow folder grants", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS });
  await env.api("projects/acme/collections/rsvp", { method: "PUT", body: RSVP });
  const keyFor = async (id: string, role: "viewer" | "editor" | "manager") => {
    await addUser(env.store, id);
    await Effect.runPromise(env.access.grant({ actorId: env.owner.id, folderId: env.acme.id, userId: id, role }));
    return env.masterFor(id);
  };
  const viewer = await keyFor("viewer", "viewer");
  assert.equal((await env.api(records, { key: viewer })).status, 200);
  assert.equal((await env.api("projects/acme/collections/offers", { key: viewer, method: "PUT", body: OFFERS })).status, 403);
  assert.equal((await env.api(records, { key: viewer, method: "POST", body: { data: { title: "A" } } })).status, 403);
  const editor = await keyFor("editor", "editor");
  assert.equal((await env.api(records, { key: editor, method: "POST", body: { data: { title: "A" } } })).status, 201);
  assert.equal((await env.api("projects/acme/collections/rsvp/records", { key: editor })).status, 403);
  assert.equal((await env.api("projects/acme/collections/rsvp", { key: editor, method: "DELETE" })).status, 403);
  const manager = await keyFor("manager", "manager");
  assert.equal((await env.api("projects/acme/collections/rsvp/records", { key: manager })).status, 200);
});

test("responses are immutable for agents", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/rsvp", { method: "PUT", body: RSVP });
  const seeded = await Effect.runPromise(env.projectData.create(env.acme.id, "rsvp", { name: "Ana" }, { actorKey: "actor", meta: {
    submittedAt: "2026-10-09T10:00:00.000Z", artifactId: env.artifactId, artifactVersion: 1,
    submittedBy: { type: "user", userId: env.owner.id, email: "owner@example.test", name: "Owner" },
  } }));
  const path = "projects/acme/collections/rsvp/records";
  assert.equal((await env.api(path, { method: "POST", body: { data: { name: "Bo" } } })).status, 403);
  assert.equal((await env.api(`${path}/${seeded.id}`, { method: "PUT", body: { data: { name: "Bo" } } })).status, 403);
  const read = await (await env.api(`${path}/${seeded.id}`)).json<RecordResponse>();
  assert.equal(read.record.submission?.submittedBy.type, "user");
  assert.equal((await env.api(`${path}/${seeded.id}`, { method: "DELETE" })).status, 200);
});

test("non-top-level and unknown folders", async () => {
  const env = await environment();
  await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, slug: "inner", parentId: env.acme.id }));
  const nested = await env.api("projects/inner/collections");
  assert.equal(nested.status, 422);
  assert.equal((await nested.json<ErrorResponse>()).error.details?.[0]?.field, "folder");
  assert.equal((await env.api("projects/nowhere/collections")).status, 404);
  await addUser(env.store, "stranger");
  await Effect.runPromise(env.folders.create({ ownerId: "stranger", slug: "theirs" }));
  assert.equal((await env.api("projects/theirs/collections")).status, 403);
  assert.equal((await env.api("projects/acme/collections/missing/records")).status, 404);
});

test("validation issues keep their field names", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS });
  const empty = await env.api(records, { method: "POST", body: { data: { title: "" } } });
  assert.equal(empty.status, 422);
  const body = await empty.json<ErrorResponse>();
  assert.equal(body.error.code, "validation");
  assert.deepEqual(body.error.details?.map((issue) => issue.field), ["title"]);
  const badName = await env.api("projects/acme/collections/Bad%20Name", { method: "PUT", body: OFFERS });
  assert.equal(badName.status, 422);
  assert.equal((await badName.json<ErrorResponse>()).error.details?.[0]?.field, "name");
  const kind = await env.api("projects/acme/collections/offers", { method: "PUT", body: { ...OFFERS, kind: "responses" } });
  assert.equal(kind.status, 409);
  assert.equal((await kind.json<ErrorResponse>()).error.code, "conflict");
  const wide = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`t${i}`, { type: "text", maxLength: 10000 }]));
  await env.api("projects/acme/collections/big", { method: "PUT", body: { kind: "records", fields: wide } });
  const huge = await env.api("projects/acme/collections/big/records", { method: "POST", body: {
    data: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`t${i}`, "x".repeat(10000)])) } });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json<ErrorResponse>()).error.code, "too-large");
});

test("audit rows never contain record contents", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS });
  const created = await (await env.api(records, { method: "POST", body: { data: { title: "secret-title" } } })).json<RecordResponse>();
  await env.api(`${records}/${created.record.id}`, { method: "PUT", body: { data: { title: "secret-two" } } });
  await env.api(`${records}/${created.record.id}`, { method: "DELETE" });
  const { results } = env.DB.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'project.%' ORDER BY rowid").all<{ action: string; detail: string }>();
  assert.deepEqual(results.map((row) => row.action), ["project.collection.define", "project.record.create", "project.record.update", "project.record.delete"]);
  assert.deepEqual(JSON.parse(results[1]!.detail), { folderId: env.acme.id, collection: "offers", recordId: created.record.id });
  assert.equal(results.some((row) => row.detail.includes("secret")), false);
});

test("list limit and cursor", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/offers", { method: "PUT", body: OFFERS });
  const first = (await (await env.api(records, { method: "POST", body: { data: { title: "1" } } })).json<RecordResponse>()).record;
  const second = (await (await env.api(records, { method: "POST", body: { data: { title: "2" } } })).json<RecordResponse>()).record;
  assert.equal((await env.api(`${records}?limit=501`)).status, 422);
  const one = await (await env.api(`${records}?limit=1`)).json<PageResponse>();
  assert.equal(one.records.length, 1);
  assert.ok(one.cursor);
  const next = await (await env.api(`${records}?limit=1&cursor=${encodeURIComponent(one.cursor!)}`)).json<PageResponse>();
  assert.deepEqual(new Set([...one.records, ...next.records].map((record) => record.id)), new Set([first.id, second.id]));
});

const UPLOAD = { field: "doc", name: "offer.pdf", type: "application/pdf", size: 5, lastModified: 1 };
type Env = Awaited<ReturnType<typeof environment>>;
/** Start, send and complete a 5-byte upload in `docs` through the API. */
async function uploaded(env: Env, name = "offer.pdf") {
  const { upload } = await (await env.api("projects/acme/collections/docs/uploads", { method: "POST", body: { ...UPLOAD, name } })).json<{ upload: UploadView }>();
  assert.equal((await env.put(`${upload.partPath}1`, new Uint8Array([1, 2, 3, 4, 5]))).status, 200);
  return (await (await env.api(`projects/acme/collections/docs/uploads/${upload.id}/complete`, { method: "POST" })).json<{ file: FileRef }>()).file;
}

test("agents upload, attach and download a file", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/docs", { method: "PUT", body: DOCS });
  const start = await env.api("projects/acme/collections/docs/uploads", { method: "POST", body: UPLOAD });
  assert.equal(start.status, 201);
  const { upload } = await start.json<{ upload: UploadView }>();
  assert.equal(upload.partPath, `/_api/projects/${env.acme.id}/collections/docs/uploads/${upload.id}/parts/`);
  const resumed = await env.api("projects/acme/collections/docs/uploads", { method: "POST", body: UPLOAD });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json<{ upload: UploadView }>()).upload.id, upload.id);
  const wrongType = await env.put(`${upload.partPath}1`, new Uint8Array(5), { type: "text/plain" });
  assert.equal(wrongType.status, 422);
  assert.equal((await wrongType.json<ErrorResponse>()).error.details?.[0]?.field, "part");
  for (const n of ["01", "1e0", "0x1"]) assert.equal((await env.put(`${upload.partPath}${n}`, new Uint8Array(5))).status, 404, n);
  const part = await env.put(`${upload.partPath}1`, new Uint8Array([1, 2, 3, 4, 5]));
  assert.deepEqual((await part.json<{ part: PartView }>()).part.number, 1);
  assert.equal((await env.api(`projects/acme/collections/docs/uploads/${upload.id}`)).status, 200);
  const done = await env.api(`projects/acme/collections/docs/uploads/${upload.id}/complete`, { method: "POST" });
  const { file } = await done.json<{ file: FileRef }>();
  assert.deepEqual(file, { id: upload.id, name: "offer.pdf", type: "application/pdf", size: 5 });
  const again = await env.api(`projects/acme/collections/docs/uploads/${upload.id}/complete`, { method: "POST" });
  assert.deepEqual(await again.json<{ file: FileRef }>(), { file });                   // idempotent, audited once
  const created = await (await env.api("projects/acme/collections/docs/records", { method: "POST", body: { data: { title: "A", doc: file.id } } })).json<RecordResponse>();
  assert.deepEqual(created.record.data.doc, file);
  assert.deepEqual((await (await env.api(`projects/acme/collections/docs/records/${created.record.id}`)).json<RecordResponse>()).record.data.doc, file);
  const meta = (await (await env.api(`projects/acme/collections/docs/files/${file.id}`)).json<{ file: FileRef & { recordId: string; createdAt: string; downloadPath: string } }>()).file;
  assert.equal(meta.recordId, created.record.id);
  assert.equal(meta.downloadPath, `/_api/projects/${env.acme.id}/collections/docs/records/${created.record.id}/files/${file.id}`);
  const bytes = await env.raw(meta.downloadPath);
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(bytes.headers.get("content-disposition"), "attachment; filename=\"offer.pdf\"; filename*=UTF-8''offer.pdf");
  const audit = env.DB.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'project.file.%' ORDER BY rowid").all<{ action: string; detail: string }>().results;
  assert.deepEqual(audit.map((row) => row.action), ["project.file.upload", "project.file.complete"]);
  assert.deepEqual(JSON.parse(audit[0]!.detail), { folderId: env.acme.id, collection: "docs", fileId: file.id, size: 5 });
  assert.ok(!audit.some((row) => row.detail.includes("offer.pdf")));
});

test("cancel removes an upload", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/docs", { method: "PUT", body: DOCS });
  const { upload } = await (await env.api("projects/acme/collections/docs/uploads", { method: "POST", body: UPLOAD })).json<{ upload: UploadView }>();
  const cancelled = await env.api(`projects/acme/collections/docs/uploads/${upload.id}`, { method: "DELETE" });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { ok: true, id: upload.id });
  assert.equal((await env.api(`projects/acme/collections/docs/uploads/${upload.id}`)).status, 404);
  const audit = env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'project.file.cancel'").all<{ detail: string }>().results;
  assert.deepEqual(audit.map((row) => JSON.parse(row.detail)), [{ folderId: env.acme.id, collection: "docs", fileId: upload.id, size: 5 }]);
});

test("file routes follow tiers and kinds", async () => {
  const env = await environment();
  await env.api("projects/acme/collections/docs", { method: "PUT", body: DOCS });
  await env.api("projects/acme/collections/rsvp", { method: "PUT", body: RSVP_FILES });
  const keyFor = async (id: string, role: "viewer" | "editor" | "manager") => {
    await addUser(env.store, id);
    await Effect.runPromise(env.access.grant({ actorId: env.owner.id, folderId: env.acme.id, userId: id, role }));
    return env.masterFor(id);
  };
  const scoped = (await Effect.runPromise(env.keys.mint({ userId: env.owner.id, kind: "artifact", artifactId: env.artifactId, scopes: "read_write" }))).key;
  assert.equal((await env.api("projects/acme/collections/docs/uploads", { key: scoped, method: "POST", body: UPLOAD })).status, 403);
  const [viewer, editor, manager] = [await keyFor("viewer", "viewer"), await keyFor("editor", "editor"), await keyFor("manager", "manager")];
  assert.equal((await env.api("projects/acme/collections/docs/uploads", { key: viewer, method: "POST", body: UPLOAD })).status, 403);
  const doc = await uploaded(env);
  await env.api("projects/acme/collections/docs/records", { method: "POST", body: { data: { title: "A", doc: doc.id } } });
  assert.equal((await env.api(`projects/acme/collections/docs/files/${doc.id}`, { key: viewer })).status, 200);
  const refused = await env.api("projects/acme/collections/rsvp/uploads", { method: "POST", body: { ...UPLOAD, field: "cv" } });
  assert.deepEqual([refused.status, (await refused.json<ErrorResponse>()).error.code], [403, "forbidden"]);

  const rsvp = (await Effect.runPromise(env.projectData.collection(env.acme.id, "rsvp")))!;
  const { upload } = await Effect.runPromise(env.projectFiles.start({ folderId: env.acme.id, collection: rsvp, field: "cv", actorKey: "visitor", name: "cv.pdf", type: "", lastModified: null, size: 3 }));
  await Effect.runPromise(env.projectFiles.putPart(env.acme.id, "rsvp", upload.id, "visitor", 1,
    new Request("https://example.test/p", { method: "PUT", body: new Uint8Array([4, 5, 6]), headers: { "Content-Length": "3" } })));
  await Effect.runPromise(env.projectFiles.complete(env.acme.id, "rsvp", upload.id, "visitor"));
  const response = await Effect.runPromise(env.projectData.create(env.acme.id, "rsvp", { cv: upload.id }, { actorKey: "visitor", meta: {
    submittedAt: "2026-10-12T10:00:00.000Z", artifactId: env.artifactId, artifactVersion: 1, submittedBy: { type: "share", shareId: "s", shareName: "Visitors" } } }));
  const download = `/_api/projects/${env.acme.id}/collections/rsvp/records/${response.id}/files/${upload.id}`;
  const managed = await env.raw(download, manager);
  assert.equal(managed.status, 200);
  assert.deepEqual(new Uint8Array(await managed.arrayBuffer()), new Uint8Array([4, 5, 6]));
  assert.equal((await env.raw(download, editor)).status, 403);
  assert.equal((await env.raw(download, viewer)).status, 403);

  const { upload: open } = await (await env.api("projects/acme/collections/docs/uploads", { method: "POST", body: { ...UPLOAD, name: "big.pdf" } })).json<{ upload: UploadView }>();
  assert.equal((await env.put(`${open.partPath}1`, new Uint8Array(PART_BYTES + 1))).status, 413);
  const busy = await env.direct(new Request(`https://example.test${open.partPath}1`, { method: "PUT", body: new Uint8Array(5),
    headers: { authorization: `Bearer ${env.master}`, "content-type": "application/octet-stream", "content-length": "5" } }),
    { ...env.projectFiles, putPart: () => Effect.fail(Object.assign(new Error("busy"), { code: "rate-limited", retryAfter: 1 })) });
  assert.deepEqual([busy.status, (await busy.json<ErrorResponse>()).error.code, busy.headers.get("Retry-After")], [429, "rate-limited", "1"]);
});

test("project theme routes share live role gates and audit sealed definitions", async () => {
  const env = await environment();
  const keyFor = async (id: string, role: "viewer" | "editor" | "manager") => {
    await addUser(env.store, id);
    await Effect.runPromise(env.access.grant({ actorId: env.owner.id, folderId: env.acme.id, userId: id, role }));
    return env.masterFor(id);
  };
  const viewer = await keyFor("themeviewer", "viewer");
  const editor = await keyFor("themeeditor", "editor");
  const manager = await keyFor("thememanager", "manager");
  const definition = validThemeDefinition("brand");

  assert.equal((await env.api("projects/acme/themes", { key: viewer })).status, 200);
  assert.equal((await env.api("projects/acme/themes/brand", { key: viewer })).status, 404);
  assert.equal((await env.api("projects/acme/themes/brand", { key: viewer, method: "PUT", body: definition })).status, 403);
  const created = await env.api("projects/acme/themes/brand", { key: editor, method: "PUT", body: definition });
  assert.equal(created.status, 201);
  const invalidDefinition = structuredClone(definition);
  (invalidDefinition.tokens.light as Record<string, unknown>).unknown = "#000000";
  assert.equal((await env.api("projects/acme/themes/invalid", { key: editor, method: "PUT", body: invalidDefinition })).status, 422);
  const listed = await (await env.api("projects/acme/themes", { key: viewer })).json<{ themes: Array<Record<string, unknown>> }>();
  assert.equal(listed.themes[0]?.slug, "brand");
  assert.equal(JSON.stringify(listed).includes("tokens"), false);
  const got = await env.api("projects/acme/themes/brand", { key: viewer });
  assert.equal(got.status, 200);
  const themeResponse = (await got.json<{ theme: { scope: string; slug: string; revision: number; definition: unknown } }>()).theme;
  assert.deepEqual({ scope: themeResponse.scope, slug: themeResponse.slug, revision: themeResponse.revision },
    { scope: "project", slug: "brand", revision: 1 });
  assert.deepEqual(themeResponse.definition, definition);

  assert.equal((await env.api("projects/acme/theme-default", { key: viewer, method: "PUT", body: {
    theme: { scope: "platform", slug: "editorial" },
  } })).status, 403);
  assert.equal((await env.api("projects/acme/theme-default", { key: editor, method: "PUT", body: {
    theme: { scope: "platform", slug: "editorial" },
  } })).status, 200);
  assert.equal((await env.api("projects/acme/theme-default", { key: editor, method: "PUT", body: { theme: "launch" } })).status, 422);
  assert.equal((await env.api("projects/acme/theme-brand-lock", { key: editor, method: "PUT", body: { brandLock: true } })).status, 403);
  assert.equal((await env.api("projects/acme/theme-brand-lock", { key: manager, method: "PUT", body: { brandLock: true } })).status, 200);
  assert.equal((await env.api("projects/acme/themes/brand", { key: editor, method: "DELETE" })).status, 200);

  await Effect.runPromise(env.access.revoke({ actorId: env.owner.id, folderId: env.acme.id, userId: "themeeditor" }));
  assert.equal((await env.api("projects/acme/themes/brand", { key: editor, method: "PUT", body: definition })).status, 403);
  const events = await env.DB.prepare("SELECT action,detail FROM audit_log WHERE action LIKE 'project.theme.%' ORDER BY at").all<{ action: string; detail: string }>();
  assert.ok(events.results.some(event => event.action === "project.theme.define"));
  assert.ok(events.results.some(event => event.action === "project.theme.default.set"));
  assert.ok(events.results.some(event => event.action === "project.theme.brand-lock.set"));
  assert.ok(events.results.some(event => event.action === "project.theme.read" && event.detail.includes('"outcome":"failure"')));
  assert.ok(events.results.some(event => event.action === "project.theme.define" && event.detail.includes('"outcome":"failure"')));
  assert.ok(events.results.some(event => event.action === "project.theme.delete" && event.detail.includes('"outcome":"success"')));
  assert.equal(JSON.stringify(events.results).includes("system-ui"), false);
});
test("project theme routes map parsing and revision conflicts to documented client responses", async () => {
  const env = await environment();
  const headers = { authorization: `Bearer ${env.master}`, "content-type": "application/json" };
  const call = (body: string, extra: Record<string, string> = {}) => env.direct(new Request(
    "https://example.test/_api/projects/acme/themes/brand", { method: "PUT", headers: { ...headers, ...extra }, body },
  ), env.projectFiles);
  const malformed = await call("{");
  assert.equal(malformed.status, 422);
  assert.equal((await malformed.json<ErrorResponse>()).error.code, "validation");
  const oversized = await call(JSON.stringify({ name: "x".repeat(65 * 1024) }));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json<ErrorResponse>()).error.code, "too-large");
  const created = await env.api("projects/acme/themes/brand", { method: "PUT", body: validThemeDefinition("brand") });
  assert.equal(created.status, 201);
  const conflict = await call(JSON.stringify({ ...validThemeDefinition("brand"), name: "Stale" }), { "if-revision": "0" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json<{ error: { details?: { currentRevision?: number } } }>()).error.details?.currentRevision, 1);
});
test("theme font provider outages return unavailable rather than invalid-definition", async () => {
  const env = await environment();
  const themes = openProjectThemes({ db: env.DB, masterKeyHex: MASTER, fetcher: async () => { throw new Error("provider offline"); } });
  const definition = { ...validThemeDefinition("offline-font"), fontSources: [THEME_FONT_SOURCE] };
  definition.fonts.heading = { family: "Example", stack: '"Example", system-ui, sans-serif' };
  const response = await env.direct(new Request("https://example.test/_api/projects/acme/themes/offline-font", {
    method: "PUT", headers: { authorization: `Bearer ${env.master}`, "content-type": "application/json" },
    body: JSON.stringify(definition),
  }), env.projectFiles, themes);
  assert.equal(response.status, 503);
  assert.equal((await response.json<ErrorResponse>()).error.code, "unavailable");
});
