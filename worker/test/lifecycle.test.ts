import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";
import { contract } from "../src/contract.js";
import { openRateLimiter } from "../src/ratelimit.js";
import type { FontFetcher } from "../src/fonts.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { openFolders } from "../src/folders.js";
import { openProjectData } from "../src/project-data.js";
import { openProjectFiles } from "../src/project-files.js";
import { openAccess } from "../src/access.js";
import { openKeys } from "../src/keys.js";
import { handleApi } from "../src/api.js";
import { scalarSeal, sealBlob, sha256hex } from "../src/crypto.js";
import { openRuntimeState } from "../src/runtime-state.js";
import { openReports } from "../src/reports.js";

interface ArtifactResponse { artifact: { id: string; gated: boolean; folder: { slug: string | null } | null } }
interface ValidationFailureResponse { error: { details: Array<{ code: string }> } }

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = "<!doctype html><html><head><title>Original</title></head><body>First</body></html>";
const NEXT = HTML.replace("First", "Second");
const FONT_HTML = HTML.replace("</head>", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Example"></head>');
async function services(fontFetch: FontFetcher = async () => new Response("unavailable", { status: 503 })) {
  const db = openD1Shim(), store = openStore(db), bucket = memoryBucket();
  const owner = await Effect.runPromise(store.users.create({ id: "lifecycle-owner", email: "lifecycle@example.test", name: "Owner", role: "owner", passwordHash: "{}" }));
  const access = openAccess({ db, audit: store.audit });
  const keys = openKeys({ db, audit: store.audit, access });
  const artifacts = openArtifacts({ db, bucket, masterKeyHex: MASTER, settings: store.settings, fontFetch });
  const folders = openFolders({ db, masterKeyHex: MASTER });
  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const ctx = { db, store, bucket, owner, access, keys, artifacts, folders, projectData: openProjectData({ db, masterKeyHex: MASTER }),
    projectFiles: openProjectFiles({ db, bucket, masterKeyHex: MASTER }), publicOrigin: "https://example.test",
    limiter: openRateLimiter({ RATELIMIT: rateLimitBinding() }), contract };
  const api = (rest: string, body: object) => Effect.runPromise(handleApi(new Request(`https://example.test/_api/${rest}`, {
    method: "POST", headers: { authorization: `Bearer ${master.key}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), ctx, { rest }));
  return { ...ctx, api, master };
}

test("restore appends retained content without rewinding history or changing the gate/key", async () => {
  const { artifacts, owner } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, password: "secret", authorId: owner.id }));
  await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id }));
  const restored = await Effect.runPromise(artifacts.restore({ artifactId: first.id, version: 1, authorId: owner.id }));
  const current = await Effect.runPromise(artifacts.byId(first.id));
  assert.ok(current);
  assert.equal(restored.version, 3);
  assert.equal(await Effect.runPromise(artifacts.document(current)), HTML);
  assert.equal(await Effect.runPromise(artifacts.document(current, 2)), NEXT);
  assert.deepEqual(current.wrapMaster, first.wrapMaster);
  assert.deepEqual(current.wrapPassword, first.wrapPassword);
  const versions = await Effect.runPromise(artifacts.versions(first.id));
  assert.deepEqual(versions.map((row) => row.version), [3, 2, 1]);
  assert.equal(versions[0].sha256, versions[2].sha256);
});

test("unretained versions cannot be read or restored even if their R2 object remains", async () => {
  const { artifacts, owner, db, bucket } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id }));
  const dropped = (await Effect.runPromise(artifacts.versions(first.id))).find((row) => row.version === 1);
  assert.ok(dropped);
  await db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?").bind(first.id, 1).run();
  assert.equal(bucket.objects.has(dropped.r2Key), true);
  await assert.rejects(Effect.runPromise(artifacts.document(first, 1)), { code: "not-found" });
  await assert.rejects(Effect.runPromise(artifacts.restore({ artifactId: first.id, version: 1, authorId: owner.id })), { code: "not-found" });
  await assert.rejects(Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(first.id)), "../../other")), { code: "invalid-version" });
  assert.equal((await Effect.runPromise(artifacts.byId(first.id)))?.currentVersion, 2);
});

test("duplicate copies current content into a fresh identity/key with an independent explicit gate", async () => {
  const { artifacts, owner, db } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, password: "source-secret", slug: "source", authorId: owner.id }));
  await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id }));
  const copy = await Effect.runPromise(artifacts.duplicate({ artifactId: first.id, ownerId: owner.id, title: "Copy", password: "copy-secret", authorId: owner.id }));
  assert.notEqual(copy.id, first.id);
  assert.notEqual(await Effect.runPromise(artifacts.contentKey(copy)), await Effect.runPromise(artifacts.contentKey(first)));
  assert.equal(await Effect.runPromise(artifacts.document(copy)), NEXT);
  assert.equal(copy.currentVersion, 1);
  assert.equal(copy.slug, null);
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(copy, "copy-secret")), true);
  assert.equal(await Effect.runPromise(artifacts.verifyPassword(copy, "source-secret")), false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM share_keys WHERE artifact_id = ?").bind(copy.id).first<{ n: number }>())?.n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE artifact_id = ?").bind(copy.id).first<{ n: number }>())?.n, 0);
});

test("deletion withdraws immediately, revokes keys, removes retained/orphan content and preserves paths", async () => {
  const { artifacts, keys, owner, bucket, master, db } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, slug: "old-name", authorId: owner.id }));
  await Effect.runPromise(artifacts.rename(first.id, "current-name"));
  await Effect.runPromise(artifacts.alias("legacy/token", first.id));
  const scoped = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: first.id, scopes: "read_write" }));
  await bucket.put(`art/${first.id}/99.enc`, new Uint8Array([1, 2]));
  const sealed = await Effect.runPromise(scalarSeal(MASTER, { value: "private state" }));
  for (const scope of ["personal", "shared"]) await db.prepare(
    "INSERT INTO artifact_runtime_state (artifact_id, scope, actor_key, key_hash, value_sealed, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(first.id, scope, owner.id, "key", sealed, new Date().toISOString()).run();
  await db.prepare("INSERT INTO artifact_reports (id, artifact_id, reporter_key, reason_sealed, created_at) VALUES (?,?,?,?,?)")
    .bind("report", first.id, "reporter", sealed, new Date().toISOString()).run();
  const deleted = await Effect.runPromise(artifacts.remove(first.id, { authorId: owner.id }));
  assert.equal(artifacts.live(deleted), false);
  assert.ok(deleted.deletedAt && deleted.purgedAt);
  assert.equal(bucket.objects.size, 0);
  assert.deepEqual(await Effect.runPromise(artifacts.versions(first.id)), []);
  assert.deepEqual(await Effect.runPromise(artifacts.listByOwner(owner.id)), []);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM artifact_runtime_state WHERE artifact_id = ?").bind(first.id).first<{ n: number }>())?.n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM artifact_reports WHERE artifact_id = ?").bind(first.id).first<{ n: number }>())?.n, 1);
  for (const path of [first.id, "old-name", "current-name", "legacy/token"]) {
    assert.equal(await Effect.runPromise(artifacts.pathTaken(path)), true);
    assert.equal((await Effect.runPromise(artifacts.byPath(path)))?.id, first.id);
  }
  await assert.rejects(Effect.runPromise(artifacts.document(first)), { code: "not-found" });
  await assert.rejects(Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id })), { code: "not-found" });
  await assert.rejects(Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, slug: "old-name", authorId: owner.id })), { code: "slug-taken" });
  assert.equal(await Effect.runPromise(keys.authenticate(new Request("https://example.test", { headers: { authorization: `Bearer ${scoped.key}` } }))), null);
  assert.equal(await Effect.runPromise(keys.may(master.record, { artifactId: first.id, ownerId: owner.id }, "write")), false);
  await assert.rejects(Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: first.id, scopes: "read" })), { code: "forbidden" });
});

test("failed purge stays withdrawn and retries physical cleanup without resurrecting content", async () => {
  const { artifacts, owner, bucket } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const removeObject = bucket.delete;
  bucket.delete = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(Effect.runPromise(artifacts.remove(first.id, { authorId: owner.id })), { code: "purge-failed" });
  const withdrawn = await Effect.runPromise(artifacts.byId(first.id));
  assert.ok(withdrawn);
  assert.ok(withdrawn.deletedAt);
  assert.equal(withdrawn.purgedAt, null);
  assert.equal(withdrawn.wrapMaster, null);
  await assert.rejects(Effect.runPromise(artifacts.document(first)), { code: "not-found" });
  bucket.delete = removeObject;
  const purged = await Effect.runPromise(artifacts.remove(first.id, { authorId: owner.id }));
  assert.equal(purged.deletedAt, withdrawn.deletedAt);
  assert.ok(purged.purgedAt);
  assert.equal(bucket.objects.size, 0);
});

test("API font capture failure leaves content, metadata and gate unchanged on publish and rotate", async () => {
  const { api, artifacts } = await services();
  const base = { folder: "font-test", slug: "font-art", title: "Original", html: HTML, password: "old-password" };
  const response = await api("artifacts", base);
  assert.equal(response.status, 201);
  const id = (await response.json() as ArtifactResponse).artifact.id;
  const first = await Effect.runPromise(artifacts.byId(id));
  assert.ok(first);
  for (const [path, body] of [["artifacts", { ...base, title: "Changed", html: FONT_HTML, password: "new-password" }],
    ["artifacts/rotate", { artifact: id, html: FONT_HTML, password: null }]] satisfies Array<[string, object]>) {
    const failure = await api(path, body);
    assert.equal(failure.status, 422);
    assert.equal((await failure.json() as ValidationFailureResponse).error.details[0].code, "font-fetch");
    const current = await Effect.runPromise(artifacts.byId(id));
    assert.ok(current);
    assert.equal(current.currentVersion, 1);
    assert.equal(await Effect.runPromise(artifacts.title(current)), "Original");
    assert.deepEqual(current.wrapPassword, first.wrapPassword);
    assert.equal(await Effect.runPromise(artifacts.document(current)), HTML);
  }
});

test("API cannot upsert a deleted path, even with the owning master key", async () => {
  const { api, artifacts, owner } = await services();
  const body = { folder: "lifecycle", slug: "retired", title: "Retired", html: HTML };
  const created = await api("artifacts", body);
  const id = (await created.json() as ArtifactResponse).artifact.id;
  await Effect.runPromise(artifacts.remove(id, { authorId: owner.id }));
  const rejected = await api("artifacts", body);
  assert.equal(rejected.status, 409);
  assert.equal((await Effect.runPromise(artifacts.byId(id)))?.currentVersion, 0);
});

test("model capture embeds assets but hashes authored bytes, including through restore and duplicate", async () => {
  const binary = new Uint8Array(48);
  binary.set(new TextEncoder().encode("wOF2"));
  new DataView(binary.buffer).setUint32(8, binary.length);
  let calls = 0;
  const { artifacts, owner } = await services(async (url) => {
    calls++;
    return url.startsWith("https://fonts.googleapis.com/")
      ? new Response("@font-face{font-family:Example;src:url(https://fonts.gstatic.com/s/example/v1/font.woff2)}", { headers: { "content-type": "text/css" } })
      : new Response(binary, { headers: { "content-type": "font/woff2" } });
  });
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: FONT_HTML, authorId: owner.id }));
  const stored = await Effect.runPromise(artifacts.document(first));
  assert.equal(stored.includes("data:font/woff2;base64,"), true);
  assert.equal((await Effect.runPromise(artifacts.versions(first.id)))[0].sha256, await Effect.runPromise(sha256hex(FONT_HTML)));
  const copy = await Effect.runPromise(artifacts.duplicate({ artifactId: first.id, ownerId: owner.id, authorId: owner.id }));
  await Effect.runPromise(artifacts.restore({ artifactId: first.id, version: 1, authorId: owner.id }));
  assert.equal(await Effect.runPromise(artifacts.document(copy)), stored);
  assert.equal((await Effect.runPromise(artifacts.versions(first.id)))[0].sha256, await Effect.runPromise(sha256hex(FONT_HTML)));
  assert.equal(calls, 2);
});

test("API create, upsert and rotate-content all synchronously capture fonts with authored hashes", async () => {
  const binary = new Uint8Array(48);
  binary.set(new TextEncoder().encode("wOF2"));
  new DataView(binary.buffer).setUint32(8, binary.length);
  let calls = 0;
  const { api, artifacts } = await services(async (url) => {
    calls++;
    return url.startsWith("https://fonts.googleapis.com/")
      ? new Response("@font-face{font-family:Example;src:url(https://fonts.gstatic.com/s/example/v1/font.woff2)}", { headers: { "content-type": "text/css" } })
      : new Response(binary, { headers: { "content-type": "font/woff2" } });
  });
  const body = { folder: "capture", slug: "captured", title: "Fonts", html: FONT_HTML };
  const created = await api("artifacts", body);
  assert.equal(created.status, 201);
  const id = (await created.json() as ArtifactResponse).artifact.id;
  const updated = await api("artifacts", { ...body, password: "new-password" });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as ArtifactResponse).artifact.gated, true);
  const rotated = await api("artifacts/rotate", { artifact: id, html: FONT_HTML, password: null });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json() as ArtifactResponse).artifact.gated, false);
  const artifact = await Effect.runPromise(artifacts.byId(id));
  assert.ok(artifact);
  assert.equal(artifact.currentVersion, 3);
  for (const version of await Effect.runPromise(artifacts.versions(id))) {
    assert.equal(version.sha256, await Effect.runPromise(sha256hex(FONT_HTML)));
    assert.equal((await Effect.runPromise(artifacts.document(artifact, version.version))).includes("data:font/woff2;base64,"), true);
  }
  assert.equal(calls, 6);
});

test("an orphan at the old deterministic next-version key cannot wedge publish or restore", async () => {
  const { artifacts, owner, bucket } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  // The pre-upgrade failure mode: an object stranded at the deterministic next-version key by
  // an interrupted write whose cleanup also failed.
  await bucket.put(`art/${first.id}/2.enc`, new Uint8Array([9, 9, 9]));
  const published = await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id }));
  assert.equal(published.version, 2);
  const current = await Effect.runPromise(artifacts.byId(first.id));
  assert.equal(await Effect.runPromise(artifacts.document(current)), NEXT);
  const row = (await Effect.runPromise(artifacts.versions(first.id)))[0];
  assert.notEqual(row.r2Key, `art/${first.id}/2.enc`);
  // Restore recovers the same way when the next key is occupied by an orphan again.
  await bucket.put(`art/${first.id}/3.enc`, new Uint8Array([8]));
  const restored = await Effect.runPromise(artifacts.restore({ artifactId: first.id, version: 1, authorId: owner.id }));
  assert.equal(restored.version, 3);
  assert.equal(await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(first.id)))), HTML);
  assert.notEqual((await Effect.runPromise(artifacts.versions(first.id)))[0].r2Key, `art/${first.id}/3.enc`);
});

test("a publication that loses the version race removes only its own attempt object", async () => {
  const { artifacts, owner, db, bucket } = await services();
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const before = [...bucket.objects.keys()];
  const batch = db.batch.bind(db);
  // The version rows never land, so the D1 trigger has already decided against this attempt
  // by the time the batch fails — every byte it wrote must be its own to remove.
  db.batch = () => { db.batch = batch; throw new Error("d1 unavailable"); };
  await assert.rejects(Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id })), { message: "d1 unavailable" });
  assert.deepEqual([...bucket.objects.keys()], before);
  const published = await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: NEXT, authorId: owner.id }));
  assert.equal(published.version, 2);
  assert.equal(await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(first.id)))), NEXT);
});

test("legacy retained content restores and duplicates byte-exactly without validation or refetch", async () => {
  const LEGACY = '<!doctype html><html><head><title>Legacy</title>'
    + '<style>.card{.child{color:blue}}a{filter:progid:DXImageTransform.Microsoft.gradient(startColorstr=#fff)}</style></head>'
    + '<body><a href="https://cdn.example/page">link</a><div style="width:{{w}}px;--x:{color:red}">x</div></body></html>';
  let calls = 0;
  const { artifacts, owner, db, bucket } = await services(async () => {
    calls++;
    throw new Error("stored content must never be refetched");
  });
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  // Rewind the first version to pre-upgrade storage: legacy bytes at the version's row and
  // object, which the new-publication pipeline would reject outright.
  const keyHex = await Effect.runPromise(artifacts.contentKey(first));
  const legacyBytes = new TextEncoder().encode(LEGACY);
  const stored = await db.prepare("SELECT r2_key FROM artifact_versions WHERE artifact_id = ? AND version = 1")
    .bind(first.id).first<{ r2_key: string }>();
  assert.ok(stored);
  await db.prepare("UPDATE artifact_versions SET size = ?, sha256 = ? WHERE artifact_id = ? AND version = 1")
    .bind(legacyBytes.byteLength, await Effect.runPromise(sha256hex(LEGACY)), first.id).run();
  await bucket.put(stored.r2_key, await Effect.runPromise(sealBlob(keyHex, legacyBytes)));

  const restored = await Effect.runPromise(artifacts.restore({ artifactId: first.id, version: 1, authorId: owner.id }));
  const current = await Effect.runPromise(artifacts.byId(first.id));
  assert.equal(await Effect.runPromise(artifacts.document(current)), LEGACY);
  const versions = await Effect.runPromise(artifacts.versions(first.id));
  assert.equal(versions[0].version, 2);
  assert.equal(versions[0].size, legacyBytes.byteLength);
  assert.equal(versions[0].sha256, await Effect.runPromise(sha256hex(LEGACY)));
  const copy = await Effect.runPromise(artifacts.duplicate({ artifactId: first.id, ownerId: owner.id, authorId: owner.id }));
  assert.equal(await Effect.runPromise(artifacts.document(copy)), LEGACY);
  assert.equal((await Effect.runPromise(artifacts.versions(copy.id)))[0].sha256, await Effect.runPromise(sha256hex(LEGACY)));
  assert.equal(calls, 0);
  // The same bytes through a new publication are still rejected: restore/duplicate bypass
  // publication-shape validation; ingestion does not.
  await assert.rejects(Effect.runPromise(artifacts.create({ ownerId: owner.id, html: LEGACY, authorId: owner.id })),
    (error: unknown) => asCodeError(error).code === "external-reference");
});

test("model honors a service-minted token and falls back to canonical capture otherwise", async () => {
  const binary = new Uint8Array(48);
  binary.set(new TextEncoder().encode("wOF2"));
  new DataView(binary.buffer).setUint32(8, binary.length);
  let calls = 0;
  const { artifacts, owner } = await services(async (url) => {
    calls++;
    return url.startsWith("https://fonts.googleapis.com/")
      ? new Response("@font-face{font-family:Example;src:url(https://fonts.gstatic.com/s/example/v1/font.woff2)}", { headers: { "content-type": "text/css" } })
      : new Response(binary, { headers: { "content-type": "font/woff2" } });
  });
  const token = await Effect.runPromise(artifacts.prepare(FONT_HTML));
  assert.equal(calls, 2);
  const first = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: FONT_HTML, authorId: owner.id, prepared: token }));
  // The token path stores exactly what canonical preparation stores — and the token itself
  // added no fetches: two of the four calls below minted the token, two made the twin.
  const canonical = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: FONT_HTML, authorId: owner.id }));
  assert.equal(await Effect.runPromise(artifacts.document(first)), await Effect.runPromise(artifacts.document(canonical)));
  assert.equal(calls, 4);
  // A token minted for different source bytes cannot publish those bytes: the model falls
  // back to preparing the html it was actually given.
  const other = HTML.replace("</body>", "<p>plain</p></body>");
  await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: other, authorId: owner.id, prepared: token }));
  assert.equal(await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(first.id)))), other);
  assert.equal(calls, 4);
  // Untrusted serialized input cannot pose as captured content either — the canonical
  // capture runs, embeds the fonts and never stores anything the token claimed.
  await Effect.runPromise(artifacts.publish({ artifactId: first.id, html: FONT_HTML, authorId: owner.id, prepared: "wsa-prepared-v1.garbage.garbage" }));
  assert.equal((await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(first.id))))).includes("data:font/woff2;base64,"), true);
  assert.equal(calls, 6);
});

test("API capture failure creates no folder and successful publication captures fonts only once", async () => {
  const binary = new Uint8Array(48);
  binary.set(new TextEncoder().encode("wOF2"));
  new DataView(binary.buffer).setUint32(8, binary.length);
  let calls = 0, healthy = false;
  const { api, artifacts, folders } = await services(async (url) => {
    calls++;
    if (!healthy) return new Response("unavailable", { status: 503 });
    return url.startsWith("https://fonts.googleapis.com/")
      ? new Response("@font-face{font-family:Example;src:url(https://fonts.gstatic.com/s/example/v1/font.woff2)}", { headers: { "content-type": "text/css" } })
      : new Response(binary, { headers: { "content-type": "font/woff2" } });
  });
  // A capture failure must not leave a fresh folder behind.
  const failing = await api("artifacts", { folder: "fresh", slug: "capture-fail", title: "Capture", html: FONT_HTML });
  assert.equal(failing.status, 422);
  assert.equal((await failing.json() as ValidationFailureResponse).error.details[0].code, "font-fetch");
  assert.equal(await Effect.runPromise(folders.byPath("fresh")), null);
  // Once capture succeeds, the folder is created and the model consumes the token without a
  // second fetch: two calls, the stylesheet and its font, for the whole request.
  healthy = true;
  calls = 0;
  const created = await api("artifacts", { folder: "fresh", slug: "captured", title: "Capture", html: FONT_HTML });
  assert.equal(created.status, 201);
  const view = (await created.json() as ArtifactResponse).artifact;
  assert.equal(view.folder?.slug, "fresh");
  assert.equal(calls, 2);
  assert.equal((await Effect.runPromise(artifacts.document(await Effect.runPromise(artifacts.byId(view.id))))).includes("data:font/woff2;base64,"), true);
  // The upsert route keeps the same single-capture shape.
  const updated = await api("artifacts", { folder: "fresh", slug: "captured", title: "Capture", html: FONT_HTML.replace("First", "Second") });
  assert.equal(updated.status, 200);
  assert.equal(calls, 4);
});

test("runtime state and reports are lazy, sealed Effects independent of published source", async () => {
  const { artifacts, owner, db } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const state = openRuntimeState({ db, masterKeyHex: MASTER });
  const reports = openReports({ db, masterKeyHex: MASTER });
  const reader = { artifactId: artifact.id, actorKey: owner.id, canWriteShared: true };
  const set = state.execute(reader, { op: "set", key: "draft", value: { text: "reader-private" } });
  const submit = reports.submit({ artifactId: artifact.id, actorKey: owner.id, reason: "  Private report  " });
  assert.equal(await Effect.runPromise(state.execute(reader, { op: "get", key: "draft" })), null);
  assert.deepEqual(await Effect.runPromise(reports.list()), []);
  await Effect.runPromise(set);
  const reportId = await Effect.runPromise(submit);
  const rawState = db.prepare("SELECT value_sealed FROM artifact_runtime_state WHERE artifact_id = ?")
    .bind(artifact.id).first<{ value_sealed: string }>();
  assert.ok(rawState);
  assert.equal(rawState.value_sealed.includes("reader-private"), false);
  await Effect.runPromise(artifacts.publish({ artifactId: artifact.id, html: NEXT, authorId: owner.id }));
  await Effect.runPromise(artifacts.restore({ artifactId: artifact.id, version: 1, authorId: owner.id }));
  assert.deepEqual(await Effect.runPromise(state.execute(reader, { op: "get", key: "draft" })), { text: "reader-private" });
  assert.equal(await Effect.runPromise(state.execute({ ...reader, actorKey: "another-reader" }, { op: "get", key: "draft" })), null);
  const copy = await Effect.runPromise(artifacts.duplicate({ artifactId: artifact.id, ownerId: owner.id, authorId: owner.id }));
  assert.equal(await Effect.runPromise(state.execute({ ...reader, artifactId: copy.id }, { op: "get", key: "draft" })), null);
  assert.equal((await Effect.runPromise(reports.list()))[0].reason, "Private report");
  assert.equal(await Effect.runPromise(reports.resolve(reportId, owner.id)), true);
  assert.equal(await Effect.runPromise(reports.resolve(reportId, owner.id)), false);
  await Effect.runPromise(artifacts.remove(artifact.id, { authorId: owner.id }));
  await assert.rejects(Effect.runPromise(state.execute(reader, { op: "set", key: "draft", value: "cannot revive" })), { code: "not-found" });
});
