import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";

import { openD1Shim } from "./db.js";
import { memoryBucket, openConsoleContext } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { openFolders } from "../src/folders.js";
import { openProjectData } from "../src/project-data.js";
import { handleConsole } from "../src/console.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><title>Probni</title></head><body><h1>Bok</h1></body></html>`;

async function services() {
  const db = openD1Shim();
  const store = openStore(db);
  const bucket = memoryBucket();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner",
    passwordHash: "{}",
  }));
  return {
    db, store, owner, bucket,
    artifacts: openArtifacts({ db, bucket, masterKeyHex: MASTER, settings: store.settings }),
    folders: openFolders({ db, masterKeyHex: MASTER }),
  };
}

test("a folder answers on its id until it is named, then on its slug", async () => {
  const { owner, folders } = await services();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Zelena šuma" }));

  assert.match(folder.id, /^[a-f0-9]{20}$/);                  // the 80-bit path width
  assert.equal(folder.slug, null);
  assert.equal(await Effect.runPromise(folders.name(folder)), "Zelena šuma");
  assert.equal(folders.path(folder), `/${folder.id}/`);
  assert.equal((await Effect.runPromise(folders.byPath(folder.id)))?.id, folder.id);

  const named = await Effect.runPromise(folders.rename(folder.id, "zelena-suma"));
  assert.equal(folders.path(named), "/zelena-suma/");
  assert.equal((await Effect.runPromise(folders.byPath("zelena-suma")))?.id, folder.id);
  assert.equal((await Effect.runPromise(folders.byPath(folder.id)))?.id, folder.id);       // the id still resolves

  const renamed = await Effect.runPromise(folders.rename(folder.id, "zs"));
  assert.equal((await Effect.runPromise(folders.byPath("zelena-suma")))?.id, folder.id);   // previous path aliased
  assert.equal((await Effect.runPromise(folders.byPath("zs")))?.id, folder.id);
  assert.equal(renamed.slug, "zs");
});

test("the reserved themes route rejects folder claims while legacy holders stay id-addressable", async () => {
  const { db, owner, folders } = await services();
  const candidate = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Candidate", slug: "candidate" }));
  await assert.rejects(
    () => Effect.runPromise(folders.create({ ownerId: owner.id, name: "Taken", slug: "themes" })),
    (error: unknown) => asCodeError(error).code === "slug-taken",
  );
  await assert.rejects(
    () => Effect.runPromise(folders.rename(candidate.id, "themes")),
    (error: unknown) => asCodeError(error).code === "slug-taken",
  );
  await assert.rejects(
    () => Effect.runPromise(folders.alias("themes", candidate.id)),
    (error: unknown) => asCodeError(error).code === "slug-taken",
  );

  const legacy = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Existing holder", slug: "legacy-holder" }));
  await db.prepare("UPDATE folders SET slug = ? WHERE id = ?").bind("themes", legacy.id).run();
  assert.equal((await Effect.runPromise(folders.byPath(legacy.id)))?.id, legacy.id);
  const renamed = await Effect.runPromise(folders.rename(legacy.id, "legacy-themes-holder"));
  assert.equal(renamed.id, legacy.id);
  assert.equal((await Effect.runPromise(folders.byPath(legacy.id)))?.id, legacy.id);
});

test("a 1.x folder index link survives as an alias", async () => {
  const { owner, folders } = await services();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Stari klijent" }));

  await Effect.runPromise(folders.alias("9f8e7d6c5b4a39281706", folder.id));
  assert.equal((await Effect.runPromise(folders.byPath("9f8e7d6c5b4a39281706")))?.id, folder.id);
  assert.equal(await Effect.runPromise(folders.byPath("nema-me")), null);
  assert.equal(await Effect.runPromise(folders.byPath("a/b")), null);                    // a 1.x artefact link names no folder
  await assert.rejects(() => Effect.runPromise(folders.alias("tri/segmenta/previse", folder.id)), (e: unknown) => asCodeError(e).code === "invalid-path");
});

test("a folder index lists exactly the artefacts published into that folder", async () => {
  const { owner, artifacts, folders } = await services();
  const first = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Prvi", slug: "prvi" }));
  const second = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Drugi", slug: "drugi" }));

  await Effect.runPromise(artifacts.create({ ownerId: owner.id, folderId: first.id, title: "A", html: HTML, slug: "a-artefakt", authorId: owner.id }));
  await Effect.runPromise(artifacts.create({ ownerId: owner.id, folderId: first.id, title: "B", html: HTML, slug: "b-artefakt", password: "ws", authorId: owner.id }));
  await Effect.runPromise(artifacts.create({ ownerId: owner.id, folderId: second.id, title: "C", html: HTML, slug: "c-artefakt", authorId: owner.id }));

  const listed = await Effect.runPromise(artifacts.listByFolder(first.id));
  assert.deepEqual(listed.map((a) => a.slug).sort(), ["a-artefakt", "b-artefakt"]);
  assert.equal(listed.every((a) => a.folderId === first.id), true);
  assert.equal((await Effect.runPromise(artifacts.listByFolder(second.id))).length, 1);
});

test("a folder alias cannot take a path something else answers to", async () => {
  const { owner, folders, artifacts } = await services();
  const mine = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Moj" }));
  const other = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Drugi", slug: "zauzeti" }));
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "A", html: HTML, authorId: owner.id }));

  await assert.rejects(() => Effect.runPromise(folders.alias("zauzeti", mine.id)), (error: unknown) => asCodeError(error).code === "slug-taken");
  await assert.rejects(() => Effect.runPromise(folders.alias(artifact.id, mine.id)), (error: unknown) => asCodeError(error).code === "slug-taken");
  // Its own retired path is fine, twice, and resolves.
  assert.equal(await Effect.runPromise(folders.alias("stari-put", mine.id)), "stari-put");
  assert.equal(await Effect.runPromise(folders.alias("stari-put", mine.id)), "stari-put");
  assert.equal((await Effect.runPromise(folders.byPath("stari-put")))?.id, mine.id);
  assert.equal((await Effect.runPromise(folders.byPath("zauzeti")))?.id, other.id);
});

test("one path cannot be claimed by two things", async () => {
  const { owner, artifacts, folders } = await services();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Klijent" }));
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Artefakt", html: HTML, slug: "zajednicki", authorId: owner.id }));

  // A folder may not take a live artefact path, nor that artefact's id — either would hijack it.
  await assert.rejects(() => Effect.runPromise(folders.create({ ownerId: owner.id, name: "X", slug: "zajednicki" })),
    (e: unknown) => asCodeError(e).code === "slug-taken");
  await assert.rejects(() => Effect.runPromise(folders.rename(folder.id, artifact.id)), (e: unknown) => asCodeError(e).code === "slug-taken");

  // ...and the artefact may not take the folder's path or id either.
  await assert.rejects(() => Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Y", html: HTML, slug: folder.id, authorId: owner.id })),
    (e: unknown) => asCodeError(e).code === "slug-taken");
  await assert.rejects(() => Effect.runPromise(artifacts.rename(artifact.id, folder.id)), (e: unknown) => asCodeError(e).code === "slug-taken");

  // Renaming a folder to its own current path is a no-op, not a collision.
  assert.equal((await Effect.runPromise(folders.rename(folder.id, folder.id))).id, folder.id);
});

test("a preserved alias is a claim too, in both directions", async () => {
  const { owner, artifacts, folders } = await services();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Klijent" }));
  const legacy = "9f8e7d6c5b4a39281706";

  await Effect.runPromise(folders.alias(legacy, folder.id));
  // An alias is a live path: neither an artefact nor a fresh folder may claim it.
  await assert.rejects(
    () => Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "X", html: HTML, slug: legacy, authorId: owner.id })),
    (error: unknown) => asCodeError(error).code === "slug-taken",
  );
  await assert.rejects(() => Effect.runPromise(folders.create({ ownerId: owner.id, name: "Y", slug: legacy })),
    (error: unknown) => asCodeError(error).code === "slug-taken");

  // ...and the same the other way round: an artefact alias blocks a folder.
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "A", html: HTML, authorId: owner.id }));
  const artifactAlias = "1a2b3c4d5e6f70819273";
  await Effect.runPromise(artifacts.alias(artifactAlias, artifact.id));
  await assert.rejects(() => Effect.runPromise(folders.create({ ownerId: owner.id, name: "Z", slug: artifactAlias })),
    (error: unknown) => asCodeError(error).code === "slug-taken");
  await assert.rejects(() => Effect.runPromise(folders.rename(folder.id, artifactAlias)), (error: unknown) => asCodeError(error).code === "slug-taken");
});

test("a folder nests under a same-owner parent only (ADR 0025)", async () => {
  const { store, owner, folders } = await services();
  const other = await Effect.runPromise(store.users.create({
    id: "other000000000b2", email: "other@example.test", name: "Other", role: "member", passwordHash: "{}",
  }));
  const parent = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Roditelj" }));
  const foreign = await Effect.runPromise(folders.create({ ownerId: other.id, name: "Tuđi" }));

  const child = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Dijete", parentId: parent.id }));
  assert.equal(child.parentId, parent.id);
  assert.equal((await Effect.runPromise(folders.byId(child.id)))?.parentId, parent.id);

  await assert.rejects(() => Effect.runPromise(folders.create({ ownerId: owner.id, name: "X", parentId: "nema-me" })),
    (error: unknown) => asCodeError(error).code === "not-found");
  await assert.rejects(() => Effect.runPromise(folders.create({ ownerId: owner.id, name: "X", parentId: foreign.id })),
    (error: unknown) => asCodeError(error).code === "forbidden");                       // never into another estate
});

test("setParent moves a folder, refuses its own descendant, and keeps the path flat", async () => {
  const { owner, folders } = await services();
  const a = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "A", slug: "mapa-a" }));
  const b = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "B" }));
  const c = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "C", parentId: b.id }));

  assert.equal((await Effect.runPromise(folders.setParent(b.id, a.id))).parentId, a.id);   // B nests under A
  assert.equal(folders.path(b), `/${b.id}/`);                            // the path never changes

  await assert.rejects(() => Effect.runPromise(folders.setParent(a.id, c.id)),              // A under its own grandchild
    (error: unknown) => asCodeError(error).code === "folder-cycle");
  await assert.rejects(() => Effect.runPromise(folders.setParent(a.id, a.id)),              // A under itself
    (error: unknown) => asCodeError(error).code === "folder-cycle");
  await assert.rejects(() => Effect.runPromise(folders.setParent("nema-me", a.id)),
    (error: unknown) => asCodeError(error).code === "not-found");

  assert.equal((await Effect.runPromise(folders.setParent(b.id, null))).parentId, null);    // back to the root
  assert.equal((await Effect.runPromise(folders.byId(b.id)))?.parentId, null);
});

test("folder work is lazy and a failed change Effect propagates after the atomic move", async () => {
  const { folders, owner } = await services();
  const create = folders.create({ ownerId: owner.id, name: "Child" });
  assert.deepEqual(await Effect.runPromise(folders.all()), []);
  const child = await Effect.runPromise(create);
  const parent = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Parent" }));
  const failure = Object.assign(new Error("folder share synchronization failed"), { code: "share-sync" });
  folders.onChange = () => Effect.fail(failure);
  const move = folders.setParent(child.id, parent.id);
  assert.equal((await Effect.runPromise(folders.byId(child.id)))?.parentId, null);
  await assert.rejects(Effect.runPromise(move), (error: unknown) => error === failure);
  assert.equal((await Effect.runPromise(folders.byId(child.id)))?.parentId, parent.id);
});

test("a folder that owns collections cannot be nested", async () => {
  const { db, owner, folders } = await services();
  const run = Effect.runPromise;
  const projectData = openProjectData({ db, masterKeyHex: MASTER });
  const a = await run(folders.create({ ownerId: owner.id, name: "A" }));
  const b = await run(folders.create({ ownerId: owner.id, name: "B" }));
  const c = await run(folders.create({ ownerId: owner.id, name: "C" }));
  await run(projectData.define(a.id, "offers", { kind: "records", fields: { title: { type: "text" } } }));
  await assert.rejects(() => run(folders.setParent(a.id, b.id)), (error: unknown) => asCodeError(error).code === "project-data");
  assert.equal((await run(folders.byId(a.id)))?.parentId, null);
  assert.equal((await run(folders.setParent(b.id, a.id))).parentId, a.id);   // b owns nothing
  await run(projectData.removeCollection(a.id, "offers", "records"));
  assert.equal((await run(folders.setParent(a.id, c.id))).parentId, c.id);
});

test("the console refuses to nest a folder that owns project data", async (t) => {
  const db = openD1Shim();
  t.after(() => db.close());
  const ctx = openConsoleContext(db, MASTER);
  const run = Effect.runPromise;
  await run(ctx.store.users.create({ id: "owner", email: "owner@example.test", name: "owner", role: "member", passwordHash: "{}" }));
  const a = await run(ctx.folders.create({ ownerId: "owner", name: "A", slug: "a" }));
  const b = await run(ctx.folders.create({ ownerId: "owner", name: "B", slug: "b" }));
  await run(ctx.projectData.define(a.id, "offers", { kind: "records", fields: { title: { type: "text" } } }));
  const session = await run(ctx.store.sessions.create("owner", { pending2fa: false }));
  const response = await run(handleConsole(new Request("https://example.test/app/f/a/move", {
    method: "POST", headers: { Cookie: `wsa_session=${session.id}`, "Content-Type": "application/json", Origin: "https://example.test" },
    body: JSON.stringify({ csrf: session.csrf, parent: b.id }),
  }), ctx, { area: "app", rest: "f/a/move" }));
  assert.equal(response.status, 409);
  assert.equal((await run(ctx.folders.byId(a.id)))?.parentId, null);
});
