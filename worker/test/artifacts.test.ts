import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";

import { openD1Shim } from "./db.js";
import { memoryBucket, openAsVisitor } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { PBKDF2_ITER } from "../src/crypto.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><title>Probni artefakt</title></head><body><h1>Bok</h1></body></html>`;
const HTML2 = HTML.replace("<h1>Bok</h1>", "<h1>Bok, drugo izdanje</h1>");
const HTML3 = HTML.replace("<h1>Bok</h1>", "<h1>Treće izdanje</h1>");
const HTML4 = HTML.replace("<h1>Bok</h1>", "<h1>Četvrto izdanje</h1>");

async function services() {
  const db = openD1Shim();
  const store = openStore(db);
  const bucket = memoryBucket();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner",
    passwordHash: "{}",
  }));
  return { db, store, bucket, owner, artifacts: openArtifacts({ db, bucket, masterKeyHex: MASTER, settings: store.settings }) };
}

test("an ungated artefact is sealed content the Worker opens with the master key", async () => {
  const { owner, bucket, artifacts } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Probni", html: HTML, authorId: owner.id }));

  assert.equal(artifact.currentVersion, 1);
  assert.equal(artifacts.gated(artifact), false);
  assert.equal(artifacts.live(artifact), true);
  // The default public path is the artefact id: for a secret-link artefact it IS the access
  // control, so it keeps 1.x's 80-bit width.
  assert.match(artifact.id, /^[a-f0-9]{20}$/);
  assert.equal(await Effect.runPromise(artifacts.title(artifact)), "Probni");
  assert.equal(await Effect.runPromise(artifacts.document(artifact)), HTML);
  assert.equal(artifacts.url(artifact, "https://example.test"), `https://example.test/${artifact.id}/`);

  // The content never lands in D1 or R2 as plaintext.
  const rows = await Effect.runPromise(artifacts.versions(artifact.id));
  const stored = bucket.objects.get(rows[0].r2Key);
  assert.ok(stored instanceof Uint8Array && stored.length > HTML.length);
  assert.equal(new TextDecoder().decode(stored).includes("<h1>Bok</h1>"), false);
  assert.deepEqual(rows.map((r) => r.version), [1]);
  assert.equal(rows[0].size, HTML.length);
});

test("a gated artefact releases a key the visitor derives from the password", async () => {
  const { owner, artifacts } = await services();
  const artifact = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, title: "Zaštićeni", html: HTML, password: "ws", authorId: owner.id,
  }));

  assert.equal(artifacts.gated(artifact), true);
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(artifact, "ws")), true);
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(artifact, "WS")), false);
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(artifact, "")), false);

  const payload = await Effect.runPromise(artifacts.gatePayload(artifact));
  assert.equal(await openAsVisitor(payload, "ws"), HTML);
  // The released payload carries no plaintext, only the wrapped key and the ciphertext.
  assert.equal(JSON.stringify(payload).includes("<h1>Bok</h1>"), false);
  assert.equal(payload.wrap.iter, PBKDF2_ITER);
});

test("publishing a new version keeps the password and the content key", async () => {
  const { owner, artifacts } = await services();
  const first = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, title: "Probni", html: HTML, password: "ws", authorId: owner.id,
  }));
  const before = first.wrapMaster;

  await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: HTML2, authorId: owner.id, note: "drugo izdanje" }));
  const after = await Effect.runPromise(artifacts.byId(first.id));
  assert.ok(after);

  assert.equal(after.currentVersion, 2);
  assert.deepEqual(after.wrapMaster, before);                       // the key was not re-wrapped
  assert.equal(await Effect.runPromise(artifacts.document(after)), HTML2);             // the live version is the new one
  assert.equal(await openAsVisitor(await Effect.runPromise(artifacts.gatePayload(after)), "ws"), HTML2);
  assert.deepEqual((await Effect.runPromise(artifacts.versions(first.id))).map((v) => v.version), [2, 1]);
  assert.equal((await Effect.runPromise(artifacts.versions(first.id)))[0].note, "drugo izdanje");
});

test("rotation re-wraps the content key and never re-encrypts the content", async () => {
  const { owner, bucket, artifacts } = await services();
  const created = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, title: "Probni", html: HTML, password: "stara", authorId: owner.id,
  }));
  const [{ r2Key }] = await Effect.runPromise(artifacts.versions(created.id));
  const objectBefore = bucket.objects.get(r2Key);

  const rotated = await Effect.runPromise(artifacts.setPassword(created.id, "nova"));
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(rotated, "stara")), false);
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(rotated, "nova")), true);
  assert.equal(await openAsVisitor(await Effect.runPromise(artifacts.gatePayload(rotated)), "nova"), HTML);
  assert.deepEqual(bucket.objects.get(r2Key), objectBefore);

  // Clearing the gate leaves a secret-link artefact the Worker still serves.
  const cleared = await Effect.runPromise(artifacts.setPassword(created.id, null));
  assert.equal(artifacts.gated(cleared), false);
  assert.equal(await Effect.runPromise(artifacts.document(cleared)), HTML);
  assert.equal(cleared.verifier, null);
});

test("renaming keeps every link that was already handed out", async () => {
  const { owner, artifacts } = await services();
  const created = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Probni", html: HTML, authorId: owner.id }));

  const named = await Effect.runPromise(artifacts.rename(created.id, "kvartalno-izvjesce"));
  assert.equal(named.slug, "kvartalno-izvjesce");
  assert.equal((await Effect.runPromise(artifacts.byPath("kvartalno-izvjesce")))?.id, created.id);
  assert.equal((await Effect.runPromise(artifacts.byPath(created.id)))?.id, created.id);          // the id still resolves
  assert.equal((await Effect.runPromise(artifacts.byPath("kvartalno-izvjesce/")))?.id, created.id);
  assert.equal(artifacts.url(named, "https://example.test"), "https://example.test/kvartalno-izvjesce/");

  const renamed = await Effect.runPromise(artifacts.rename(created.id, "godisnje-izvjesce"));
  assert.equal((await Effect.runPromise(artifacts.byPath("kvartalno-izvjesce")))?.id, created.id);  // previous slug aliased
  assert.equal((await Effect.runPromise(artifacts.byPath("godisnje-izvjesce")))?.id, created.id);
});

test("a legacy two-segment link resolves through an alias", async () => {
  const { owner, artifacts } = await services();
  const created = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Probni", html: HTML, authorId: owner.id }));

  await Effect.runPromise(artifacts.alias("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", created.id));
  const found = await Effect.runPromise(artifacts.byPath("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"));
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal((await Effect.runPromise(artifacts.byPath("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/nope"))), null);
});

test("a retired path is a claim too: an alias cannot steal one", async () => {
  const { owner, artifacts } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Prvi", html: HTML, slug: "zivi-slug", authorId: owner.id }));
  const second = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Drugi", html: HTML, authorId: owner.id }));

  // A live slug belongs to its artefact, and another artefact cannot alias it away.
  await assert.rejects(() => Effect.runPromise(artifacts.alias("zivi-slug", second.id)), (error: unknown) => asCodeError(error).code === "slug-taken");
  await assert.rejects(() => Effect.runPromise(artifacts.alias(first.id, second.id)), (error: unknown) => asCodeError(error).code === "slug-taken");

  // Aliasing one's own retired path is idempotent, and the alias resolves.
  const legacy = "9f8e7d6c5b4a39281706/4a44af232e96f56aa956";
  assert.equal(await Effect.runPromise(artifacts.alias(legacy, second.id)), legacy);
  assert.equal(await Effect.runPromise(artifacts.alias(legacy, second.id)), legacy);
  assert.equal((await Effect.runPromise(artifacts.byPath(legacy)))?.id, second.id);
  await assert.rejects(() => Effect.runPromise(artifacts.alias(legacy, first.id)), (error: unknown) => asCodeError(error).code === "slug-taken");
});

test("public paths that could never resolve stay unresolved", async () => {
  const { owner, artifacts } = await services();
  await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Probni", html: HTML, slug: "zauzeti-slug", authorId: owner.id }));

  assert.equal(await Effect.runPromise(artifacts.byPath("nema-me")), null);
  assert.equal(await Effect.runPromise(artifacts.byPath("")), null);
  assert.equal(await Effect.runPromise(artifacts.byPath("a/b/c")), null);
  assert.equal(await Effect.runPromise(artifacts.byPath("/Zauzeti/")), null);          // uppercase is not a segment
  assert.equal((await Effect.runPromise(artifacts.byPath("zauzeti-slug")))?.slug, "zauzeti-slug");
});

test("retention keeps the newest versions and drops the rest", async () => {
  const { store, bucket, owner, artifacts } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Retencija", html: HTML, authorId: owner.id }));
  const keys = [(await Effect.runPromise(artifacts.versions(artifact.id)))[0].r2Key];
  await Effect.runPromise(store.settings.setRetention(2));

  for (const html of [HTML2, HTML3, HTML4]) {
    await Effect.runPromise(artifacts.publish({ artifactId: artifact.id, html, authorId: owner.id }));
    keys.push((await Effect.runPromise(artifacts.versions(artifact.id)))[0].r2Key);
  }

  assert.deepEqual((await Effect.runPromise(artifacts.versions(artifact.id))).map((v) => v.version), [4, 3]);
  assert.equal(bucket.objects.has(keys[0]), false);
  assert.equal(bucket.objects.has(keys[1]), false);
  assert.equal(bucket.objects.has(keys[3]), true);
  assert.equal(await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(artifact.id)))), HTML4);

  // Retention never touches the live version, however low the cap is set.
  await Effect.runPromise(store.settings.setRetention(1));
  await Effect.runPromise(artifacts.publish({ artifactId: artifact.id, html: HTML, authorId: owner.id }));
  assert.deepEqual((await Effect.runPromise(artifacts.versions(artifact.id))).map((v) => v.version), [5]);
  assert.equal(await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(artifact.id)))), HTML);
});

test("a slug cannot squat another artefact's id or slug", async () => {
  const { owner, artifacts } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Prvi", html: HTML, slug: "prvi", authorId: owner.id }));
  const second = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Drugi", html: HTML, authorId: owner.id }));

  await assert.rejects(
    () => Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Treći", html: HTML, slug: "prvi", authorId: owner.id })),
    (error: unknown) => asCodeError(error).code === "slug-taken",
  );
  await assert.rejects(
    () => Effect.runPromise(artifacts.rename(second.id, first.id)),                    // the id of a live link
    (error: unknown) => asCodeError(error).code === "slug-taken",
  );
  await assert.rejects(() => Effect.runPromise(artifacts.rename(second.id, "Velika-Slova")), (error: unknown) => asCodeError(error).code === "invalid-slug");
  await assert.rejects(
    () => Effect.runPromise(artifacts.alias("tri/segmenta/previse", second.id)),
    (error: unknown) => asCodeError(error).code === "invalid-path",
  );
});
test("moveTo re-files an artefact within the owner's estate only (ADR 0025)", async () => {
  const { store, owner, artifacts } = await services();
  const { openFolders } = await import("../src/folders.js");
  const folders = openFolders({ db: store.db, masterKeyHex: MASTER });
  const other = await Effect.runPromise(store.users.create({
    id: "other000000000b2", email: "other@example.test", name: "Other", role: "member", passwordHash: "{}",
  }));
  const from = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Od" }));
  const to = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "U" }));
  const foreign = await Effect.runPromise(folders.create({ ownerId: other.id, name: "Tuđi" }));
  const artifact = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: from.id, title: "Dokument", html: HTML, slug: "dokument", authorId: owner.id,
  }));

  const moved = await Effect.runPromise(artifacts.moveTo(artifact.id, to.id));
  assert.equal(moved.folderId, to.id);
  assert.equal((await Effect.runPromise(artifacts.byId(artifact.id)))?.folderId, to.id);
  assert.equal(artifacts.path(moved), "/dokument/");              // the link never changes

  await assert.rejects(() => Effect.runPromise(artifacts.moveTo(artifact.id, foreign.id)),
    (error: unknown) => asCodeError(error).code === "forbidden");                       // never into another estate's index
  await assert.rejects(() => Effect.runPromise(artifacts.moveTo(artifact.id, "nema-me")),
    (error: unknown) => asCodeError(error).code === "not-found");
  await assert.rejects(() => Effect.runPromise(artifacts.moveTo("nema-me", to.id)),
    (error: unknown) => asCodeError(error).code === "not-found");
});

test("artifact work is lazy and a failed downstream change keeps the committed publication usable", async () => {
  const { artifacts, owner, bucket } = await services();
  const create = artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id });
  assert.deepEqual(await Effect.runPromise(artifacts.listByOwner(owner.id)), []);
  assert.equal(bucket.objects.size, 0);
  const artifact = await Effect.runPromise(create);
  const failure = Object.assign(new Error("share synchronization failed"), { code: "share-sync" });
  artifacts.setOnChange(() => Effect.fail(failure));
  const publish = artifacts.publish({ artifactId: artifact.id, html: HTML2, authorId: owner.id });
  assert.equal((await Effect.runPromise(artifacts.byId(artifact.id)))?.currentVersion, 1);
  assert.equal((await Effect.runPromise(publish)).version, 2);
  const current = await Effect.runPromise(artifacts.byId(artifact.id));
  assert.equal(current?.currentVersion, 2);
  assert.equal(await Effect.runPromise(artifacts.document(current)), HTML2);
});
