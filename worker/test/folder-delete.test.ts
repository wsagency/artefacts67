// Folder deletion (ADR 0038): the owner deletes a folder with everything in it. A recursive
// pre-read counts the subtree and pins it with a snapshot; one guarded D1 batch decides; every
// path stays reserved; the daily sweep purges the bytes.

import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";
import type { D1Statement } from "../src/types.js";

import { openD1Shim, type TestDatabase } from "./db.js";
import { openConsoleContext, type TestConsoleContext } from "./doubles.js";
import { handleConsole } from "../src/console.js";
import { pathTaken } from "../src/paths.js";
import { scalarSeal, sha256hex } from "../src/crypto.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><title>Probni</title></head><body><h1>Bok</h1></body></html>`;
const run = Effect.runPromise;
const code = (expected: string) => (error: unknown) => asCodeError(error).code === expected;
const SUBMISSION = { submittedAt: "2026-10-10T00:00:00.000Z", artifactId: "a", artifactVersion: 1, submittedBy: { type: "user" as const, userId: "owner", email: "owner@example.test", name: "Owner" } };
const CAP = (n: number, m: number) => `This folder holds ${n} artefact${n === 1 ? "" : "s"} in ${m} folder${m === 1 ? "" : "s"}; delete or move some subfolders first. At most 200 artefacts and 100 folders go in one deletion.`;

async function fixture() {
  const db = openD1Shim();
  const ctx = openConsoleContext(db, MASTER);
  await run(ctx.store.users.create({ id: "owner", email: "owner@example.test", name: "Owner", role: "member", passwordHash: "{}" }));
  await run(ctx.store.users.create({ id: "colleague", email: "colleague@example.test", name: "Colleague", role: "member", passwordHash: "{}" }));
  return { db, ctx };
}
const count = (db: TestDatabase, sql: string, ...params: unknown[]) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).bind(...params).first<{ n: number }>()?.n ?? 0);
const now = () => new Date().toISOString();
const snapshotOf = (folders: string[], artefacts: string[]) =>
  run(sha256hex(`${[...folders].sort().join(",")}|${[...artefacts].sort().join(",")}`));
/** A completed 5-byte upload in a file field, ready to attach. */
async function ready(ctx: TestConsoleContext, folderId: string, name: string, field: string, actorKey: string) {
  const collection = (await run(ctx.projectData.collection(folderId, name)))!;
  const { upload } = await run(ctx.projectFiles.start({ folderId, collection, field, actorKey, name: "a.pdf", type: "", lastModified: null, size: 5 }));
  const body = new Request("https://example.test/part", { method: "PUT", body: new Uint8Array(5), headers: { "Content-Length": "5" } });
  await run(ctx.projectFiles.putPart(folderId, name, upload.id, actorKey, 1, body));
  return (await run(ctx.projectFiles.complete(folderId, name, upload.id, actorKey))).file;
}
const insertArtefact = (db: TestDatabase, id: string, folderId: string, version = 1) =>
  db.prepare("INSERT INTO artifacts (id, owner_id, folder_id, title_sealed, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, "owner", folderId, "x", version, now(), now()).run();
const insertFolder = (db: TestDatabase, id: string, parentId: string) =>
  db.prepare("INSERT INTO folders (id, slug, name_sealed, owner_id, parent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, null, "x", "owner", parentId, now(), now()).run();

/** The ticket's counting tree: a top-level project, a subfolder, a nested shared subfolder. */
async function tree() {
  const { db, ctx } = await fixture();
  const root = await run(ctx.folders.create({ ownerId: "owner", name: "Tajni projekt", slug: "projekt" }));
  const sub = await run(ctx.folders.create({ ownerId: "owner", name: "Sub", slug: "sub", parentId: root.id }));
  const nested = await run(ctx.folders.create({ ownerId: "owner", name: "Nested", slug: "nested" }));
  const folderShare = await run(ctx.shares.create({ actorId: "owner", kind: "folder", targetId: nested.id, name: "Klijent" }));
  await run(ctx.folders.setParent(nested.id, sub.id));                          // a shared folder later nested keeps its share
  const a1 = await run(ctx.artifacts.create({ ownerId: "owner", folderId: root.id, title: "Jedan", html: HTML, slug: "jedan", authorId: "owner" }));
  await run(ctx.artifacts.publish({ artifactId: a1.id, html: HTML.replace("Bok", "Bok 2"), authorId: "owner" }));
  await run(ctx.artifacts.publish({ artifactId: a1.id, html: HTML.replace("Bok", "Bok 3"), authorId: "owner" }));
  const a2 = await run(ctx.artifacts.create({ ownerId: "owner", folderId: sub.id, title: "Dva", html: HTML, slug: "dva", authorId: "owner" }));
  const a3 = await run(ctx.artifacts.create({ ownerId: "owner", folderId: nested.id, title: "Tri", html: HTML, slug: "tri", authorId: "owner" }));
  insertArtefact(db, "pending0000000000001", sub.id, 0);
  const gone = await run(ctx.artifacts.create({ ownerId: "owner", folderId: nested.id, title: "Old", html: HTML, slug: "stari", authorId: "owner" }));
  await run(ctx.artifacts.remove(gone.id, { authorId: "owner" }));
  const artefactShare = await run(ctx.shares.create({ actorId: "owner", kind: "artifact", targetId: a1.id, name: "Jedan" }));
  const revoked = await run(ctx.shares.create({ actorId: "owner", kind: "artifact", targetId: a2.id, name: "Dva" }));
  await run(ctx.shares.revoke({ actorId: "owner", id: revoked.id }));
  await run(ctx.projectData.define(root.id, "offers", { kind: "records", fields: { title: { type: "text" }, doc: { type: "file" } } }));
  await run(ctx.projectData.define(root.id, "answers", { kind: "responses", fields: { ok: { type: "boolean" } } }));
  const file = await ready(ctx, root.id, "offers", "doc", "A");
  await run(ctx.projectData.create(root.id, "offers", { title: "A", doc: file.id }, undefined, "A"));
  for (const title of ["B", "C", "D"]) await run(ctx.projectData.create(root.id, "offers", { title }));
  for (let i = 0; i < 2; i++) await run(ctx.projectData.create(root.id, "answers", { ok: true }, { actorKey: `user:owner${i}`, meta: SUBMISSION }));
  return { db, ctx, root, sub, nested, a1, a2, a3, gone, folderShare, artefactShare, revoked,
    folderIds: [root.id, sub.id, nested.id], artefactIds: [a1.id, a2.id, a3.id, "pending0000000000001"] };
}

test("the pre-read counts the whole subtree, its shares and its project data", async () => {
  const t = await tree();
  const held = await run(t.ctx.folders.contents(t.root.id));
  assert.deepEqual({ ...held, snapshot: "", folderIds: [], artefactIds: [] }, {
    folders: 3, subfolders: 2, artefacts: 3, unpublished: 1, versions: 5, collections: 2, records: 4, responses: 2, files: 1, shares: 2,
    snapshot: "", tooLarge: null, folderIds: [], artefactIds: [], foreignOwned: false,
  });
  assert.deepEqual([...held.folderIds].sort(), [...t.folderIds].sort());
  assert.deepEqual([...held.artefactIds].sort(), [...t.artefactIds].sort());
  assert.equal(held.snapshot, await snapshotOf(t.folderIds, t.artefactIds));
  assert.match(held.snapshot, /^[0-9a-f]{64}$/);
  // A subfolder counts only its own subtree; the project's data belongs to the top-level folder.
  const sub = await run(t.ctx.folders.contents(t.sub.id));
  assert.deepEqual([sub.folders, sub.subfolders, sub.artefacts, sub.unpublished, sub.collections, sub.records, sub.files, sub.shares], [2, 1, 2, 1, 0, 0, 0, 1]);
});

test("the snapshot changes when the subtree changes, not when a version is published", async () => {
  const t = await tree();
  const snap = async () => (await run(t.ctx.folders.contents(t.root.id))).snapshot;
  const seen = new Set([await snap()]);
  await run(t.ctx.artifacts.publish({ artifactId: t.a2.id, html: HTML.replace("Bok", "Nova"), authorId: "owner" }));
  assert.ok(seen.has(await snap()));
  await run(t.ctx.folders.create({ ownerId: "owner", name: "New", parentId: t.sub.id }));
  seen.add(await snap());
  const outside = await run(t.ctx.artifacts.create({ ownerId: "owner", title: "Out", html: HTML, authorId: "owner" }));
  await run(t.ctx.artifacts.moveTo(outside.id, t.nested.id));
  seen.add(await snap());
  await run(t.ctx.artifacts.remove(t.a3.id, { authorId: "owner" }));
  seen.add(await snap());
  assert.equal(seen.size, 4);
});

test("over the cap the pre-read says why", async () => {
  const { db, ctx } = await fixture();
  const root = await run(ctx.folders.create({ ownerId: "owner", name: "Big" }));
  for (let i = 0; i < 200; i++) insertArtefact(db, `big${String(i).padStart(17, "0")}`, root.id);
  assert.equal((await run(ctx.folders.contents(root.id))).tooLarge, null);
  insertArtefact(db, "big-one-more00000000", root.id, 0);
  assert.equal((await run(ctx.folders.contents(root.id))).tooLarge, CAP(201, 1));

  const wide = await run(ctx.folders.create({ ownerId: "owner", name: "Wide" }));
  let parent = wide.id;
  for (let i = 0; i < 99; i++) { insertFolder(db, `wide${String(i).padStart(16, "0")}`, parent); parent = `wide${String(i).padStart(16, "0")}`; }
  assert.equal((await run(ctx.folders.contents(wide.id))).tooLarge, null);
  insertFolder(db, "wide-one-more0000000", wide.id);
  assert.equal((await run(ctx.folders.contents(wide.id))).tooLarge, CAP(0, 101));
});

test("a foreign-owned folder or artefact in the subtree is flagged", async () => {
  const t = await tree();
  assert.equal((await run(t.ctx.folders.contents(t.root.id))).foreignOwned, false);
  t.db.prepare("UPDATE artifacts SET owner_id = 'colleague' WHERE id = ?").bind(t.a3.id).run();
  assert.equal((await run(t.ctx.folders.contents(t.root.id))).foreignOwned, true);
  t.db.prepare("UPDATE artifacts SET owner_id = 'owner' WHERE id = ?").bind(t.a3.id).run();
  t.db.prepare("UPDATE folders SET owner_id = 'colleague' WHERE id = ?").bind(t.nested.id).run();
  assert.equal((await run(t.ctx.folders.contents(t.root.id))).foreignOwned, true);
});

/** Deletes `root` the way the console does: with the snapshot of a fresh pre-read. */
async function remove(ctx: TestConsoleContext, rootId: string) {
  const { snapshot } = await run(ctx.folders.contents(rootId));
  return run(ctx.folders.remove(rootId, { snapshot, actorId: "owner" }));
}
/** Runs `race` once, after every read the model did and just before its batch commits. */
function beforeBatch(db: TestDatabase, race: () => unknown) {
  const batch = db.batch.bind(db);
  db.batch = (statements: D1Statement[]) => {
    db.batch = batch;
    race();
    return batch(statements);
  };
}

test("deleting a folder removes the subtree in one batch and keeps every path reserved", async () => {
  const t = await tree();
  const { db, ctx } = t;
  await run(ctx.folders.rename(t.sub.id, "sub-novi"));                       // "sub" becomes a retired path
  await run(ctx.folders.alias("9f8e7d6c5b4a39281706", t.nested.id));
  await run(ctx.artifacts.rename(t.a2.id, "dva-novi"));                      // "dva" becomes a retired alias
  await run(ctx.access.grant({ actorId: "owner", folderId: t.nested.id, userId: "colleague", role: "editor" }));
  const key = await run(ctx.keys.mint({ userId: "owner", kind: "artifact", artifactId: t.a3.id, scopes: "read" }));
  db.prepare("INSERT INTO artifact_runtime_state (artifact_id, scope, actor_key, key_hash, value_sealed, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(t.a1.id, "shared", "owner", "k", "x", now()).run();
  const objects = [...ctx.bucket.objects.keys()].filter(k => k.startsWith("art/")).length;

  const removed = await remove(ctx, t.root.id);
  assert.equal(removed.artefacts, 3);
  for (const id of t.folderIds) assert.equal(await run(ctx.folders.byId(id)), null);
  for (const id of t.artefactIds) {
    const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").bind(id).first<Record<string, unknown>>()!;
    assert.ok(row.deleted_at, id);
    assert.equal(row.deleted_by, "owner");
    assert.equal(row.current_version, 0);
    assert.equal(row.key_wrap_master, null);
    assert.equal(row.key_wrap_password, null);
    assert.equal(row.password_verifier, null);
    assert.equal(row.purged_at, null);
  }
  assert.equal(count(db, "artifacts WHERE folder_id IS NOT NULL"), 0);
  assert.equal(count(db, "api_keys WHERE id = ? AND revoked_at IS NULL", key.record.id), 0);
  assert.equal(count(db, "shares WHERE revoked_at IS NULL"), 0);
  assert.equal(count(db, "share_keys"), 0);
  assert.equal(count(db, "folder_grants"), 0);
  assert.equal(count(db, "folder_redirects"), 0);
  assert.equal(count(db, "project_collections"), 0);
  assert.equal(count(db, "project_records"), 0);
  assert.equal(count(db, "project_files WHERE status <> 'deleted'"), 0);
  // Versions, runtime state and bytes wait for the purge; the keys are gone, so they are unreadable.
  assert.equal(count(db, "artifact_versions"), 5);
  assert.equal(count(db, "artifact_runtime_state"), 1);
  assert.equal([...ctx.bucket.objects.keys()].filter(k => k.startsWith("art/")).length, objects);

  for (const path of [...t.folderIds, "projekt", "sub", "sub-novi", "nested", "9f8e7d6c5b4a39281706",
    ...t.artefactIds, "jedan", "dva", "dva-novi", "tri", "stari"]) {
    assert.equal(await run(pathTaken(db, path)), true, path);
    assert.equal(await run(ctx.folders.byPath(path)), null, path);
    const artifact = await run(ctx.artifacts.byPath(path));
    assert.ok(!artifact || artifact.deletedAt, path);
  }
  await assert.rejects(run(ctx.folders.create({ ownerId: "colleague", name: "Hijack", slug: "sub-novi" })), code("slug-taken"));
  await assert.rejects(run(ctx.artifacts.create({ ownerId: "colleague", title: "Hijack", html: HTML, slug: "dva", authorId: "colleague" })), code("slug-taken"));
});

test("one artifact.delete audit row per withdrawn artefact, without content", async () => {
  const t = await tree();
  await remove(t.ctx, t.root.id);
  const rows = t.db.prepare("SELECT actor_type, actor_id, artifact_id, detail FROM audit_log WHERE action = 'artifact.delete' AND artifact_id <> ?")
    .bind(t.gone.id).all<{ actor_type: string; actor_id: string; artifact_id: string; detail: string }>().results;
  assert.deepEqual(rows.map(r => r.artifact_id).sort(), [...t.artefactIds].sort());
  for (const row of rows) {
    assert.equal(row.actor_type, "user");
    assert.equal(row.actor_id, "owner");
    assert.deepEqual(JSON.parse(row.detail), { outcome: "withdrawn", folder: t.root.id });
  }
});

test("readers lose access at commit, before any purge", async () => {
  const t = await tree();
  await remove(t.ctx, t.root.id);
  const a1 = await run(t.ctx.artifacts.byId(t.a1.id));
  assert.equal(t.ctx.artifacts.live(a1), false);
  await assert.rejects(run(t.ctx.artifacts.document(a1)), code("not-found"));
  assert.ok(t.db.prepare("SELECT revoked_at FROM shares WHERE id = ?").bind(t.artefactShare.id).first<{ revoked_at: string }>()?.revoked_at);
  assert.equal(count(t.db, "share_keys WHERE share_id IN (?, ?)", t.artefactShare.id, t.folderShare.id), 0);
  assert.ok([...t.ctx.bucket.objects.keys()].some(k => k.startsWith(`art/${t.a1.id}/`)));
});

test("the file sweep removes a deleted project's file bytes", async () => {
  const t = await tree();
  const key = `file/${t.db.prepare("SELECT id FROM project_files").first<{ id: string }>()!.id}.enc`;
  assert.ok(t.ctx.bucket.objects.has(key));
  await remove(t.ctx, t.root.id);
  t.db.prepare("UPDATE project_files SET deleted_at = ?").bind(new Date(Date.now() - 2 * 3_600_000).toISOString()).run();
  assert.equal(await run(t.ctx.projectFiles.sweep()), 1);
  assert.equal(t.ctx.bucket.objects.has(key), false);
  assert.equal(count(t.db, "project_files"), 0);
  assert.equal(count(t.db, "project_file_parts"), 0);
});

test("deleting a project subfolder keeps the project's data and the ancestor share", async () => {
  const t = await tree();
  const top = await run(t.ctx.shares.create({ actorId: "owner", kind: "folder", targetId: t.root.id, name: "Cijeli projekt" }));
  // A password share keeps one key wrap per covered artefact; seeded directly, the wraps' content is not under test.
  for (const a of [t.a1, t.a2, t.a3]) t.db.prepare("INSERT INTO share_keys (share_id, artifact_id, key_wrap, updated_at) VALUES (?,?,?,?)").bind(top.id, a.id, "{}", now()).run();
  const keyed = () => t.db.prepare("SELECT artifact_id FROM share_keys WHERE share_id = ?").bind(top.id).all<{ artifact_id: string }>().results.map(r => r.artifact_id).sort();
  await remove(t.ctx, t.sub.id);
  assert.deepEqual(keyed(), [t.a1.id]);
  assert.equal(t.db.prepare("SELECT revoked_at FROM shares WHERE id = ?").bind(top.id).first<{ revoked_at: string | null }>()?.revoked_at, null);
  assert.ok(t.db.prepare("SELECT revoked_at FROM shares WHERE id = ?").bind(t.folderShare.id).first<{ revoked_at: string | null }>()?.revoked_at);
  assert.equal(count(t.db, "project_collections WHERE folder_id = ?", t.root.id), 2);
  assert.equal(count(t.db, "project_records WHERE folder_id = ?", t.root.id), 6);
  assert.equal(count(t.db, "project_files WHERE folder_id = ? AND status = 'attached'", t.root.id), 1);
  assert.ok(await run(t.ctx.folders.byId(t.root.id)));
  assert.equal((await run(t.ctx.artifacts.byId(t.a1.id)))?.deletedAt, null);
  assert.ok((await run(t.ctx.artifacts.byId(t.a2.id)))?.deletedAt);
});

test("a stale snapshot, a foreign owner or the cap refuses and changes nothing", async () => {
  const t = await tree();
  const unchanged = async () => {
    assert.ok(await run(t.ctx.folders.byId(t.root.id)));
    assert.equal(count(t.db, "path_tombstones"), 0);
    assert.equal(count(t.db, "artifacts WHERE deleted_at IS NOT NULL"), 1);
  };
  const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
  await assert.rejects(run(t.ctx.folders.remove(t.root.id, { snapshot: "0".repeat(64), actorId: "owner" })), (error: unknown) =>
    asCodeError(error).code === "folder-changed" && /changed since you opened it/.test(asCodeError(error).message));
  await unchanged();
  t.db.prepare("UPDATE artifacts SET owner_id = 'colleague' WHERE id = ?").bind(t.a3.id).run();
  await assert.rejects(run(t.ctx.folders.remove(t.root.id, { snapshot, actorId: "owner" })), code("forbidden"));
  await unchanged();
  t.db.prepare("UPDATE artifacts SET owner_id = 'owner' WHERE id = ?").bind(t.a3.id).run();
  for (let i = 0; i < 197; i++) insertArtefact(t.db, `big${String(i).padStart(17, "0")}`, t.sub.id);
  const big = await run(t.ctx.folders.contents(t.root.id));
  await assert.rejects(run(t.ctx.folders.remove(t.root.id, { snapshot: big.snapshot, actorId: "owner" })), (error: unknown) =>
    asCodeError(error).code === "folder-too-large" && asCodeError(error).message === CAP(201, 3));
  await unchanged();
  await assert.rejects(run(t.ctx.folders.remove("nema-me", { snapshot, actorId: "owner" })), code("not-found"));
  // Bottom-up: the subfolder holding most of the tree goes first, then the root fits under the cap.
  await remove(t.ctx, t.sub.id);
  await remove(t.ctx, t.root.id);
  assert.equal(await run(t.ctx.folders.byId(t.root.id)), null);
});

test("the guard is inside the batch: a racing change makes it a no-op", async () => {
  const races: Array<[string, (t: Awaited<ReturnType<typeof tree>>, outside: { folder: string; artefact: string }) => void]> = [
    ["artefact created", t => insertArtefact(t.db, "racing00000000000001", t.nested.id, 0)],
    ["artefact moved out", (t, o) => t.db.prepare("UPDATE artifacts SET folder_id = ? WHERE id = ?").bind(o.folder, t.a3.id).run()],
    ["artefact moved in", (t, o) => t.db.prepare("UPDATE artifacts SET folder_id = ? WHERE id = ?").bind(t.sub.id, o.artefact).run()],
    ["subfolder created", t => insertFolder(t.db, "racing00000000000002", t.nested.id)],
    ["folder moved in", (t, o) => t.db.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(t.sub.id, o.folder).run()],
    ["folder moved out", t => t.db.prepare("UPDATE folders SET parent_id = NULL WHERE id = ?").bind(t.nested.id).run()],
    ["artefact withdrawn", t => t.db.prepare("UPDATE artifacts SET deleted_at = ?, current_version = 0, key_wrap_master = NULL WHERE id = ?").bind(now(), t.a2.id).run()],
  ];
  for (const [name, race] of races) {
    const t = await tree();
    const folder = await run(t.ctx.folders.create({ ownerId: "owner", name: "Outside" }));
    const artefact = await run(t.ctx.artifacts.create({ ownerId: "owner", folderId: folder.id, title: "Out", html: HTML, authorId: "owner" }));
    const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
    beforeBatch(t.db, () => race(t, { folder: folder.id, artefact: artefact.id }));
    await assert.rejects(run(t.ctx.folders.remove(t.root.id, { snapshot, actorId: "owner" })), code("folder-changed"), name);
    assert.equal(count(t.db, "path_tombstones"), 0, name);
    assert.equal(count(t.db, "audit_log WHERE action = 'artifact.delete' AND artifact_id <> ?", t.gone.id), 0, name);
    assert.equal(count(t.db, "audit_log WHERE action = 'folder.delete'"), 0, name);
    for (const id of t.folderIds) assert.ok(await run(t.ctx.folders.byId(id)), name);
    assert.equal(count(t.db, "project_collections"), 2, name);
  }
});

test("a publish that reaches D1 after the batch fails and revives nothing", async () => {
  const t = await tree();
  const before = [...t.ctx.bucket.objects.keys()].filter(k => k.startsWith(`art/${t.a2.id}/`)).length;
  const artifact = (await run(t.ctx.artifacts.byId(t.a2.id)))!;
  const keyHex = await run(t.ctx.artifacts.contentKey(artifact));
  await remove(t.ctx, t.root.id);
  // The publisher read the live artefact (and its key) before the deletion committed.
  t.ctx.artifacts.byId = () => Effect.succeed({ ...artifact });
  t.ctx.artifacts.contentKey = () => Effect.succeed(keyHex);
  await assert.rejects(run(t.ctx.artifacts.publish({ artifactId: t.a2.id, html: HTML, authorId: "owner" })), code("publish-conflict"));
  const row = t.db.prepare("SELECT deleted_at, current_version, key_wrap_master FROM artifacts WHERE id = ?").bind(t.a2.id).first<Record<string, unknown>>()!;
  assert.ok(row.deleted_at);
  assert.equal(row.current_version, 0);
  assert.equal(row.key_wrap_master, null);
  assert.equal([...t.ctx.bucket.objects.keys()].filter(k => k.startsWith(`art/${t.a2.id}/`)).length, before);
});

test("writes into a deleted folder fail", async () => {
  const t = await tree();
  const other = await run(t.ctx.folders.create({ ownerId: "owner", name: "Other" }));
  const loose = await run(t.ctx.artifacts.create({ ownerId: "owner", folderId: other.id, title: "Loose", html: HTML, authorId: "owner" }));
  const collection = (await run(t.ctx.projectData.collection(t.root.id, "offers")))!;
  await remove(t.ctx, t.root.id);
  await assert.rejects(run(t.ctx.artifacts.create({ ownerId: "owner", folderId: t.sub.id, title: "X", html: HTML, authorId: "owner" })), code("not-found"));
  await assert.rejects(run(t.ctx.artifacts.moveTo(loose.id, t.sub.id)), code("not-found"));
  await assert.rejects(run(t.ctx.folders.create({ ownerId: "owner", name: "X", parentId: t.sub.id })), code("not-found"));
  await assert.rejects(run(t.ctx.folders.setParent(other.id, t.sub.id)), code("not-found"));
  const uploads = t.ctx.bucket.uploads.size;
  await assert.rejects(run(t.ctx.projectFiles.start({ folderId: t.root.id, collection, field: "doc", actorKey: "A", name: "b.pdf", type: "", lastModified: null, size: 5 })), code("not-found"));
  assert.equal(t.ctx.bucket.uploads.size, uploads);
});

test("two deletes of one folder: one wins", async () => {
  const t = await tree();
  const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
  const batch = t.db.batch.bind(t.db);
  // The other delete, confirmed against the same snapshot, reaches D1 first with the same batch.
  t.db.batch = (statements: D1Statement[]) => {
    t.db.batch = batch;
    batch(statements);
    return batch(statements);
  };
  await assert.rejects(run(t.ctx.folders.remove(t.root.id, { snapshot, actorId: "owner" })), code("not-found"));
  assert.equal(await run(t.ctx.folders.byId(t.root.id)), null);
  assert.equal(count(t.db, "audit_log WHERE action = 'artifact.delete' AND artifact_id <> ?", t.gone.id), t.artefactIds.length);
  assert.equal(count(t.db, "audit_log WHERE action = 'folder.delete'"), 1);
});

test("an empty folder goes through the same path", async () => {
  const { db, ctx } = await fixture();
  const folder = await run(ctx.folders.create({ ownerId: "owner", name: "Prazno", slug: "prazno" }));
  const removed = await remove(ctx, folder.id);
  assert.deepEqual([removed.folders, removed.subfolders, removed.artefacts], [1, 0, 0]);
  assert.equal(await run(ctx.folders.byId(folder.id)), null);
  assert.equal(count(db, "path_tombstones WHERE path IN (?, ?)", folder.id, "prazno"), 2);
});

/** A signed-in console request as `userId`: a form POST when `form` is given, else a GET. */
async function consoleAs(ctx: TestConsoleContext, userId: string, path: string, form?: Record<string, string>) {
  const session = await run(ctx.store.sessions.create(userId, { pending2fa: false }));
  const headers = { Cookie: `wsa_session=${session.id}`, Origin: "https://example.test" };
  return run(handleConsole(new Request(`https://example.test${path}`, form ? {
    method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: session.csrf, ...form }),
  } : { headers }), ctx, { area: "app", rest: path.replace(/^\/app\//, "") }));
}
const paneProps = async (response: Response) =>
  JSON.parse(/<script id="ws-bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(await response.text())![1]).props;

test("only the owner deletes, by typing the folder's name", async () => {
  const t = await tree();
  await run(t.ctx.store.users.create({ id: "editor", email: "editor@example.test", name: "Editor", role: "member", passwordHash: "{}" }));
  await run(t.ctx.access.grant({ actorId: "owner", folderId: t.sub.id, userId: "colleague", role: "manager" }));
  await run(t.ctx.access.grant({ actorId: "owner", folderId: t.root.id, userId: "editor", role: "editor" }));
  const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
  const sub = await run(t.ctx.folders.contents(t.sub.id));
  assert.equal((await consoleAs(t.ctx, "colleague", "/app/f/sub/delete", { snapshot: sub.snapshot, confirm: "Sub" })).status, 403);
  assert.equal((await consoleAs(t.ctx, "editor", "/app/f/nested/delete", { snapshot: sub.snapshot, confirm: "Nested" })).status, 403);
  const refused: Record<string, string>[] = [{ confirm: "Tajni projekt" }, { snapshot, confirm: "delete" }, { snapshot, confirm: "tajni projekt" }, { snapshot, confirm: "" }];
  for (const form of refused) {
    assert.equal((await consoleAs(t.ctx, "owner", "/app/f/projekt/delete", form)).status, 400, JSON.stringify(form));
  }
  for (const id of t.folderIds) assert.ok(await run(t.ctx.folders.byId(id)));
  assert.equal(count(t.db, "path_tombstones"), 0);
  const done = await consoleAs(t.ctx, "owner", "/app/f/projekt/delete", { snapshot, confirm: "  Tajni projekt " });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/app");
  for (const id of t.folderIds) assert.equal(await run(t.ctx.folders.byId(id)), null);
});

test("the pane carries counts and snapshot to the owner only", async () => {
  const t = await tree();
  await run(t.ctx.access.grant({ actorId: "owner", folderId: t.root.id, userId: "colleague", role: "manager" }));
  const mine = (await paneProps(await consoleAs(t.ctx, "owner", "/app/f/projekt"))).folderContents;
  assert.match(mine.snapshot, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...mine, snapshot: "" }, {
    folders: 3, subfolders: 2, artefacts: 3, unpublished: 1, versions: 5, collections: 2, records: 4, responses: 2, files: 1, shares: 2,
    snapshot: "", tooLarge: null,
  });
  assert.equal((await paneProps(await consoleAs(t.ctx, "colleague", "/app/f/projekt"))).folderContents, undefined);
});

test("a changed or oversized folder answers 409 with its message", async () => {
  const t = await tree();
  const stale = await consoleAs(t.ctx, "owner", "/app/f/projekt/delete", { snapshot: "0".repeat(64), confirm: "Tajni projekt" });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /This folder changed since you opened it/);
  for (let i = 0; i < 197; i++) insertArtefact(t.db, `big${String(i).padStart(17, "0")}`, t.sub.id);
  // The 409 re-renders the pane, which lists these titles.
  t.db.prepare("UPDATE artifacts SET title_sealed = ? WHERE id LIKE 'big%'").bind(await run(scalarSeal(MASTER, { t: "Big" }))).run();
  const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
  const big = await consoleAs(t.ctx, "owner", "/app/f/projekt/delete", { snapshot, confirm: "Tajni projekt" });
  assert.equal(big.status, 409);
  assert.match(await big.text(), /At most 200 artefacts and 100 folders go in one deletion/);
  assert.ok(await run(t.ctx.folders.byId(t.root.id)));
});

test("the audit row lists the subtree without names", async () => {
  const t = await tree();
  const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
  assert.equal((await consoleAs(t.ctx, "owner", "/app/f/projekt/delete", { snapshot, confirm: "Tajni projekt" })).status, 303);
  const rows = t.db.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'folder.delete'").all<{ actor_id: string; detail: string }>().results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, "owner");
  const detail = JSON.parse(rows[0].detail);
  assert.deepEqual({ ...detail, subfolders: [...detail.subfolders].sort() }, {
    folder: t.root.id, slug: "projekt", parent: null, recursive: true, subfolders: [t.sub.id, t.nested.id].sort(),
    folders: 3, artefacts: 4, versions: 5, collections: 2, records: 4, responses: 2, files: 1, shares: 2,
  });
  for (const secret of ["Tajni", "Jedan", "Dva", "Bok"]) assert.equal(rows[0].detail.includes(secret), false, secret);
});

test("an unnamed folder is confirmed by its slug, and a resubmit is a 404", async () => {
  const { db, ctx } = await fixture();
  const parent = await run(ctx.folders.create({ ownerId: "owner", name: "Roditelj", slug: "roditelj" }));
  const folder = await run(ctx.folders.create({ ownerId: "owner", slug: "bez-imena", parentId: parent.id }));
  const { snapshot } = await run(ctx.folders.contents(folder.id));
  const done = await consoleAs(ctx, "owner", "/app/f/bez-imena/delete", { snapshot, confirm: "bez-imena" });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/app/f/roditelj");
  assert.equal((await consoleAs(ctx, "owner", "/app/f/bez-imena/delete", { snapshot, confirm: "bez-imena" })).status, 404);
  assert.equal(count(db, "audit_log WHERE action = 'folder.delete'"), 1);
});

test("a double-click: the click that loses the race is a 404, never a 500", async () => {
  const t = await tree();
  const { snapshot } = await run(t.ctx.folders.contents(t.root.id));
  const form = { snapshot, confirm: "Tajni projekt" };
  const batch = t.db.batch.bind(t.db);
  let first: Response | undefined;
  // Both clicks read the live folder; the other one's whole request commits before this one's batch.
  t.db.batch = ((statements: D1Statement[]) => {
    t.db.batch = batch;
    return consoleAs(t.ctx, "owner", "/app/f/projekt/delete", form).then(response => (first = response, batch(statements)));
  }) as unknown as typeof batch;
  const second = await consoleAs(t.ctx, "owner", "/app/f/projekt/delete", form);
  assert.equal(first?.status, 303);
  assert.equal(second.status, 404);
  assert.match(await second.text(), /Page not found/);
  for (const id of t.folderIds) assert.equal(await run(t.ctx.folders.byId(id)), null);
  assert.equal(count(t.db, "audit_log WHERE action = 'folder.delete'"), 1);
});
