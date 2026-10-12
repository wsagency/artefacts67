// Folder deletion (ADR 0033): only an empty folder goes, together with everything keyed by it,
// in one guarded D1 batch; its paths stay reserved; only its owner may do it.

import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";
import type { D1Statement } from "../src/types.js";

import { openD1Shim, type TestDatabase } from "./db.js";
import { openConsoleContext, type TestConsoleContext } from "./doubles.js";
import { handleConsole } from "../src/console.js";
import { pathTaken } from "../src/paths.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><title>Probni</title></head><body><h1>Bok</h1></body></html>`;
const run = Effect.runPromise;
const code = (expected: string) => (error: unknown) => asCodeError(error).code === expected;
const SUBMISSION = { submittedAt: "2026-10-10T00:00:00.000Z", artifactId: "a", artifactVersion: 1, submittedBy: { type: "user" as const, userId: "owner", email: "owner@example.test", name: "Owner" } };

async function fixture() {
  const db = openD1Shim();
  const ctx = openConsoleContext(db, MASTER);
  await run(ctx.store.users.create({ id: "owner", email: "owner@example.test", name: "Owner", role: "member", passwordHash: "{}" }));
  await run(ctx.store.users.create({ id: "colleague", email: "colleague@example.test", name: "Colleague", role: "member", passwordHash: "{}" }));
  return { db, ctx };
}
const count = (db: TestDatabase, sql: string, ...params: unknown[]) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).bind(...params).first<{ n: number }>()?.n ?? 0);
/** A completed 5-byte upload in a file field, ready to attach. */
async function ready(ctx: TestConsoleContext, folderId: string, name: string, field: string, actorKey: string) {
  const collection = (await run(ctx.projectData.collection(folderId, name)))!;
  const { upload } = await run(ctx.projectFiles.start({ folderId, collection, field, actorKey, name: "a.pdf", type: "", lastModified: null, size: 5 }));
  const body = new Request("https://example.test/part", { method: "PUT", body: new Uint8Array(5), headers: { "Content-Length": "5" } });
  await run(ctx.projectFiles.putPart(folderId, name, upload.id, actorKey, 1, body));
  return (await run(ctx.projectFiles.complete(folderId, name, upload.id, actorKey))).file;
}

test("deleting a folder marks its project files deleted", async () => {
  const { db, ctx } = await fixture();
  const folder = await run(ctx.folders.create({ ownerId: "owner", name: "Files", slug: "files" }));
  await run(ctx.projectData.define(folder.id, "docs", { kind: "records", fields: { doc: { type: "file" } } }));
  const attached = await ready(ctx, folder.id, "docs", "doc", "A");
  await run(ctx.projectData.create(folder.id, "docs", { doc: attached.id }, undefined, "A"));
  await ready(ctx, folder.id, "docs", "doc", "A");
  await run(ctx.folders.remove(folder.id));
  assert.equal(count(db, "project_files WHERE folder_id = ? AND status = 'deleted' AND deleted_at IS NOT NULL", folder.id), 2);
});

test("an empty folder is deleted with everything keyed by it, and its paths stay reserved", async () => {
  const { db, ctx } = await fixture();
  const folder = await run(ctx.folders.create({ ownerId: "owner", name: "Projekt", slug: "projekt" }));
  await run(ctx.folders.rename(folder.id, "projekt-novi"));                  // "projekt" becomes a retired path
  await run(ctx.folders.alias("9f8e7d6c5b4a39281706", folder.id));
  await run(ctx.access.grant({ actorId: "owner", folderId: folder.id, userId: "colleague", role: "editor" }));
  const share = await run(ctx.shares.create({ actorId: "owner", kind: "folder", targetId: folder.id, name: "Klijent" }));
  await run(ctx.projectData.define(folder.id, "offers", { kind: "records", fields: { title: { type: "text" } } }));
  await run(ctx.projectData.define(folder.id, "answers", { kind: "responses", fields: { ok: { type: "boolean" } } }));
  await run(ctx.projectData.create(folder.id, "offers", { title: "A" }));
  await run(ctx.projectData.create(folder.id, "offers", { title: "B" }));
  await run(ctx.projectData.create(folder.id, "answers", { ok: true }, { actorKey: "user:owner", meta: SUBMISSION }));
  // A withdrawn artefact is a terminal tombstone: it never blocks, and keeps its own path reserved.
  const gone = await run(ctx.artifacts.create({ ownerId: "owner", folderId: folder.id, title: "Old", html: HTML, slug: "stari", authorId: "owner" }));
  await run(ctx.artifacts.remove(gone.id, { authorId: "owner" }));

  assert.deepEqual(await run(ctx.folders.contents(folder.id)),
    { subfolders: 0, artefacts: 0, unpublished: 0, collections: 2, records: 2, responses: 1 });
  const removed = await run(ctx.folders.remove(folder.id));
  assert.deepEqual(removed, { subfolders: 0, artefacts: 0, unpublished: 0, collections: 2, records: 2, responses: 1 });

  assert.equal(await run(ctx.folders.byId(folder.id)), null);
  assert.equal(count(db, "project_collections WHERE folder_id = ?", folder.id), 0);
  assert.equal(count(db, "project_records WHERE folder_id = ?", folder.id), 0);
  assert.equal(count(db, "folder_redirects WHERE folder_id = ?", folder.id), 0);
  assert.equal(count(db, "folder_grants WHERE folder_id = ?", folder.id), 0);
  assert.equal(count(db, "share_keys WHERE share_id = ?", share.id), 0);
  assert.notEqual(db.prepare("SELECT revoked_at FROM shares WHERE id = ?").bind(share.id).first<{ revoked_at: string | null }>()?.revoked_at, null);
  assert.equal(db.prepare("SELECT folder_id FROM artifacts WHERE id = ?").bind(gone.id).first<{ folder_id: string | null }>()?.folder_id, null);

  // Every handed-out path of the folder stays spoken for and resolves to nothing.
  for (const path of [folder.id, "projekt", "projekt-novi", "9f8e7d6c5b4a39281706"]) {
    assert.equal(await run(ctx.folders.byPath(path)), null, path);
    assert.equal(await run(pathTaken(db, path)), true, path);
  }
  await assert.rejects(run(ctx.folders.create({ ownerId: "colleague", name: "Hijack", slug: "projekt-novi" })), code("slug-taken"));
  await assert.rejects(run(ctx.artifacts.create({ ownerId: "colleague", title: "Hijack", html: HTML, slug: "projekt", authorId: "colleague" })), code("slug-taken"));
  assert.equal(await run(pathTaken(db, "stari")), true);                     // the tombstone still holds its own path
});

test("a folder with a subfolder, a live artefact or an unpublished artefact is refused and nothing changes", async () => {
  const { db, ctx } = await fixture();
  const parent = await run(ctx.folders.create({ ownerId: "owner", name: "Parent", slug: "parent" }));
  await run(ctx.projectData.define(parent.id, "offers", { kind: "records", fields: { title: { type: "text" }, doc: { type: "file" } } }));
  const file = await ready(ctx, parent.id, "offers", "doc", "A");
  await run(ctx.projectData.create(parent.id, "offers", { title: "A", doc: file.id }, undefined, "A"));
  await run(ctx.folders.alias("stari-parent", parent.id));
  const child = await run(ctx.folders.create({ ownerId: "owner", name: "Child", parentId: parent.id }));
  await assert.rejects(run(ctx.folders.remove(parent.id)), (error: unknown) =>
    asCodeError(error).code === "folder-not-empty" && /1 subfolder/.test(asCodeError(error).message));
  assert.ok(await run(ctx.folders.byId(parent.id)));
  assert.equal(count(db, "project_records WHERE folder_id = ?", parent.id), 1);
  assert.equal(count(db, "project_files WHERE folder_id = ? AND status = 'attached'", parent.id), 1);
  assert.equal(count(db, "folder_redirects WHERE folder_id = ?", parent.id), 1);
  assert.equal(count(db, "path_tombstones"), 0);

  const live = await run(ctx.artifacts.create({ ownerId: "owner", folderId: child.id, title: "Live", html: HTML, authorId: "owner" }));
  await assert.rejects(run(ctx.folders.remove(child.id)), (error: unknown) =>
    asCodeError(error).code === "folder-not-empty" && /1 artefact/.test(asCodeError(error).message));
  await run(ctx.artifacts.remove(live.id, { authorId: "owner" }));

  // A row without a first version is not withdrawn: a publish can still bring it live, so it blocks.
  const at = new Date().toISOString();
  db.prepare("INSERT INTO artifacts (id, owner_id, folder_id, title_sealed, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind("pending0000000000001", "owner", child.id, "x", 0, at, at).run();
  assert.equal((await run(ctx.folders.contents(child.id))).unpublished, 1);
  await assert.rejects(run(ctx.folders.remove(child.id)), (error: unknown) =>
    asCodeError(error).code === "folder-not-empty" && /unpublished/.test(asCodeError(error).message));
  assert.ok(await run(ctx.folders.byId(child.id)));
  await assert.rejects(run(ctx.folders.remove("nema-me")), code("not-found"));
});

test("a draft stranded by a failed first publish stops blocking after 15 minutes and is withdrawn with the folder", async () => {
  const { db, ctx } = await fixture();
  const folder = await run(ctx.folders.create({ ownerId: "owner", name: "Drafts" }));
  const insert = (id: string, at: string) => db.prepare("INSERT INTO artifacts (id, owner_id, folder_id, title_sealed, current_version, key_wrap_master, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, "owner", folder.id, "x", 0, "{}", at, at).run();
  insert("stale000000000000001", new Date(Date.now() - 16 * 60_000).toISOString());
  insert("fresh000000000000001", new Date(Date.now() - 14 * 60_000).toISOString());
  assert.equal((await run(ctx.folders.contents(folder.id))).unpublished, 1);
  await assert.rejects(run(ctx.folders.remove(folder.id)), code("folder-not-empty"));   // an in-flight publish still blocks
  assert.equal(count(db, "artifacts WHERE id = ? AND deleted_at IS NULL", "stale000000000000001"), 1);

  db.prepare("DELETE FROM artifacts WHERE id = ?").bind("fresh000000000000001").run();
  assert.deepEqual(await run(ctx.folders.contents(folder.id)),
    { subfolders: 0, artefacts: 0, unpublished: 0, collections: 0, records: 0, responses: 0 });
  await run(ctx.folders.remove(folder.id));
  assert.equal(await run(ctx.folders.byId(folder.id)), null);
  const row = db.prepare("SELECT folder_id, deleted_at, purged_at, current_version, key_wrap_master FROM artifacts WHERE id = ?")
    .bind("stale000000000000001").first<Record<string, unknown>>();
  assert.equal(row?.folder_id, null);
  assert.ok(row?.deleted_at);
  assert.equal(row?.purged_at, null);
  assert.equal(row?.key_wrap_master, null);
  assert.equal(row?.current_version, 0);
});

test("the emptiness check is part of the deleting batch, so a racing move-in wins cleanly", async () => {
  const { db, ctx } = await fixture();
  const target = await run(ctx.folders.create({ ownerId: "owner", name: "Target", slug: "target" }));
  const elsewhere = await run(ctx.folders.create({ ownerId: "owner", name: "Elsewhere" }));
  const artifact = await run(ctx.artifacts.create({ ownerId: "owner", folderId: elsewhere.id, title: "A", html: HTML, authorId: "owner" }));
  await run(ctx.projectData.define(target.id, "offers", { kind: "records", fields: { title: { type: "text" } } }));
  // The move lands after any read the model did, immediately before its batch commits.
  const batch = db.batch.bind(db);
  db.batch = (statements: D1Statement[]) => {
    db.batch = batch;
    db.prepare("UPDATE artifacts SET folder_id = ? WHERE id = ?").bind(target.id, artifact.id).run();
    return batch(statements);
  };
  await assert.rejects(run(ctx.folders.remove(target.id)), code("folder-not-empty"));
  assert.ok(await run(ctx.folders.byId(target.id)));
  assert.equal(count(db, "project_collections WHERE folder_id = ?", target.id), 1);
  assert.equal(count(db, "path_tombstones"), 0);
  assert.equal((await run(ctx.artifacts.byId(artifact.id)))?.folderId, target.id);
});

async function post(ctx: TestConsoleContext, userId: string, ref: string, body: Record<string, string>) {
  const session = await run(ctx.store.sessions.create(userId, { pending2fa: false }));
  return run(handleConsole(new Request(`https://example.test/app/f/${ref}/delete`, {
    method: "POST", headers: { Cookie: `wsa_session=${session.id}`, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://example.test" },
    body: new URLSearchParams({ csrf: session.csrf, ...body }),
  }), ctx, { area: "app", rest: `f/${ref}/delete` }));
}

test("the console deletes only the owner's empty, confirmed folder and audits it without content", async () => {
  const { db, ctx } = await fixture();
  const parent = await run(ctx.folders.create({ ownerId: "owner", name: "Parent", slug: "parent" }));
  const child = await run(ctx.folders.create({ ownerId: "owner", name: "Tajno ime", slug: "child", parentId: parent.id }));
  await run(ctx.access.grant({ actorId: "owner", folderId: parent.id, userId: "colleague", role: "manager" }));

  assert.equal((await post(ctx, "colleague", "child", { confirm: "delete" })).status, 403);   // a manager is not the owner
  assert.equal((await post(ctx, "owner", "child", {})).status, 400);                         // unconfirmed
  assert.ok(await run(ctx.folders.byId(child.id)));

  const refused = await post(ctx, "owner", "parent", { confirm: "delete" });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /1 subfolder/);
  assert.ok(await run(ctx.folders.byId(parent.id)));

  const deleted = await post(ctx, "owner", "child", { confirm: "delete" });
  assert.equal(deleted.status, 303);
  assert.equal(deleted.headers.get("location"), "/app/f/parent");
  assert.equal(await run(ctx.folders.byId(child.id)), null);
  const audit = db.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'folder.delete'").all<{ actor_id: string; detail: string }>().results;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, "owner");
  assert.equal(JSON.parse(audit[0].detail).folder, child.id);
  assert.doesNotMatch(audit[0].detail, /Tajno/);

  const top = await post(ctx, "owner", "parent", { confirm: "delete" });
  assert.equal(top.status, 303);
  assert.equal(top.headers.get("location"), "/app");
  assert.equal((await post(ctx, "owner", "parent", { confirm: "delete" })).status, 404);    // already gone
});
