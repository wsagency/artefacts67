import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { openD1Shim } from "./db.js";
import { openConsoleContext, memoryBucket, rateLimitBinding } from "./doubles.js";
import { openArtifactRuntime, duplicateReadable, type RuntimeSource, type RuntimeObservation } from "../src/artifact-runtime.js";
import { openRuntimeState, STATE_LIMITS, type StateContext, type StateInput, type StateScope, type JsonValue } from "../src/runtime-state.js";
import type { ProjectRecord, RecordPage } from "../src/project-data.js";
import type { FileRef, UploadView } from "../src/project-files.js";
import { hex, scalarSeal, sha256, sha256hex } from "../src/crypto.js";
import { handleGate } from "../src/viewer.js";
import { handleConsole } from "../src/console.js";
import { asCodeError } from "../src/types.js";
import { clientIp, PART_BYTES } from "../src/http.js";
import worker from "../src/index.js";

interface ReaderGrant { grant: string; cookie: string }
interface RuntimeLoadBody { html: string; runtime: { grant: string }; observation: RuntimeObservation | null }
interface RuntimeStateBody { value?: JsonValue; error?: string; message?: string }
interface RuntimeDataBody { value?: (ProjectRecord & RecordPage) | null; error?: string; message?: string; issues?: Array<{ field: string; message: string }> }
interface RuntimeTestCaller {
  call(action: string, body: unknown, cookie?: string, origin?: string): Promise<Response>;
}

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const ORIGIN = "https://example.test";
const HTML = '<!doctype html><html lang="en"><head><title>App</title></head><body>Private application</body></html>';

async function fixture(t: TestContext) {
  const db = openD1Shim();
  t.after(() => db.close());
  const ctx = openConsoleContext(db, MASTER);
  const { store, access, folders, artifacts, shares, projectData } = ctx;
  for (const id of ["owner", "editor", "reader", "staff"]) await Effect.runPromise(store.users.create({ id, email: `${id}@example.test`,
    name: id, role: id === "staff" ? "admin" : "member", passwordHash: "{}" }));
  const folder = await Effect.runPromise(folders.create({ ownerId: "owner", name: "Apps", slug: "apps" }));
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: "owner", folderId: folder.id, title: "App", html: HTML, slug: "app-one", authorId: "owner" }));
  const visitorShare = await Effect.runPromise(shares.create({ actorId: "owner", kind: "artifact", targetId: artifact.id, name: "Visitors" }));
  const visitorSource: RuntimeSource = { kind: "share", path: "app-one", token: new URL(visitorShare.url).pathname.split("/s/")[1].split("/")[0], artifactId: artifact.id };
  let clock = Date.now();
  ctx.artifactRuntime = openArtifactRuntime({ db, masterKeyHex: MASTER, now: () => clock });
  const request = (body: unknown, cookie = "", origin = ORIGIN) => new Request(`${ORIGIN}/_runtime/state`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body),
  });
  const call = (action: string, body: unknown, cookie = "", origin = ORIGIN) => Effect.runPromise(ctx.artifactRuntime.handle(request(body, cookie, origin), ctx, { action }));
  const load = async (source: RuntimeSource = visitorSource, cookie = "") => {
    const response = await call("load", { source }, cookie);
    assert.equal(response.status, 200);
    const body = await response.json() as RuntimeLoadBody;
    return { grant: body.runtime.grant, cookie: response.headers.get("Set-Cookie")?.split(";")[0] ?? cookie, body };
  };
  const session = async (userId: string) => {
    const value = await Effect.runPromise(store.sessions.create(userId, { pending2fa: false }));
    return { cookie: `wsa_session=${value.id}`, value };
  };
  return { db, ctx, store, artifacts, artifact, folder, folders, access, shares, projectData, visitorShare, visitorSource, call, load, session, request, advance: (ms: number) => { clock += ms; } };
}

const state = async (f: RuntimeTestCaller, opened: ReaderGrant, input: StateInput & { actorKey?: string; artifactId?: string }) => {
  const response = await f.call("state", { ...input, grant: opened.grant }, opened.cookie);
  return { status: response.status, body: await response.json() as RuntimeStateBody };
};

const data = async (f: RuntimeTestCaller, opened: ReaderGrant, input: Record<string, unknown>) => {
  const response = await f.call("data", { ...input, grant: opened.grant }, opened.cookie);
  return { status: response.status, body: await response.json() as RuntimeDataBody };
};

// `apps` is the project: app-one at its root, app-two in apps/inner, plus one unfiled artefact.
async function project(t: TestContext) {
  const f = await fixture(t);
  const run = Effect.runPromise;
  const inner = await run(f.folders.create({ ownerId: "owner", name: "Inner", slug: "inner", parentId: f.folder.id }));
  const two = await run(f.artifacts.create({ ownerId: "owner", folderId: inner.id, title: "Two", html: HTML, slug: "app-two", authorId: "owner" }));
  const unfiled = await run(f.artifacts.create({ ownerId: "owner", title: "Loose", html: HTML, slug: "loose", authorId: "owner" }));
  await run(f.projectData.define(f.folder.id, "offers", { kind: "records", fields: { title: { type: "text", required: true } } }));
  const rsvp = { kind: "responses", visitors: true, fields: {
    name: { type: "text", required: true }, attend: { type: "choice", options: ["yes", "no"], required: true }, confirm: { type: "boolean", required: true },
  } };
  await run(f.projectData.define(f.folder.id, "rsvp", rsvp));
  await run(f.projectData.define(f.folder.id, "docs", { kind: "records", visitors: true,
    fields: { title: { type: "text", required: true }, doc: { type: "file", accept: [".pdf", "application/pdf"] } } }));
  await run(f.projectData.define(f.folder.id, "cvs", { kind: "responses", visitors: true,
    fields: { name: { type: "text", required: true }, cv: { type: "file", required: true } } }));
  await run(f.projectData.define(f.folder.id, "closed", { kind: "responses", visitors: false, fields: { cv: { type: "file" } } }));
  const owner = await f.session("owner");
  const direct = (artifactId: string, cookie = owner.cookie) => f.load({ kind: "console", artifactId }, cookie);
  return { ...f, run, inner, two, unfiled, rsvp, owner, direct };
}
const ANSWER = { name: "Ana", attend: "yes", confirm: true };

test("personal state persists across openings, is sealed, and cannot select another reader or artifact", async (t) => {
  const f = await fixture(t);
  const one = await f.load();
  const two = await f.load();
  assert.notEqual(one.cookie, two.cookie);
  assert.equal((await state(f, one, { op: "set", key: "draft", value: { secret: "reader-one-only" } })).status, 200);
  assert.deepEqual((await state(f, await f.load(undefined, one.cookie), { op: "get", key: "draft" })).body.value, { secret: "reader-one-only" });
  assert.equal((await state(f, two, { op: "get", key: "draft", actorKey: "owner", artifactId: f.artifact.id })).body.value, null);
  const stored = await f.db.prepare("SELECT * FROM artifact_runtime_state").all();
  assert.equal(JSON.stringify(stored).includes("reader-one-only"), false);
  assert.equal(JSON.stringify(stored).includes('"draft"'), false);
  const forged = await f.call("state", { grant: one.grant, op: "get", key: "draft" }, two.cookie);
  assert.equal(forged.status, 403);
  const other = await Effect.runPromise(f.artifacts.create({ ownerId: "owner", title: "Other", html: HTML, slug: "app-two", authorId: "owner" }));
  const otherShare = await Effect.runPromise(f.shares.create({ actorId: "owner", kind: "artifact", targetId: other.id, name: "Other visitors" }));
  const openedOther = await f.load({ kind: "share", path: "app-two", token: new URL(otherShare.url).pathname.split("/s/")[1].split("/")[0], artifactId: other.id }, one.cookie);
  assert.equal((await state(f, openedOther, { op: "get", key: "draft", artifactId: f.artifact.id })).body.value, null);
  assert.notEqual(other.id, f.artifact.id);
});

test("scheduled storage cleanup still removes expired rows when observation cleanup fails", async (t) => {
  const f = await fixture(t);
  const anonymous = await f.load();
  assert.equal((await state(f, anonymous, { op: "set", key: "expired", value: 1 })).status, 200);
  const signed = await f.session("owner");
  const owner = await f.load({ kind: "console", artifactId: f.artifact.id }, signed.cookie);
  assert.equal((await state(f, owner, { op: "set", key: "retained", value: 2 })).status, 200);
  f.db.prepare("UPDATE artifact_runtime_state SET expires_at = '2000-01-01T00:00:00.000Z' WHERE anonymous = 1").run();
  const failedDb = {
    prepare(sql: string) {
      if (sql.startsWith("DELETE FROM share_visits")) throw new Error("Observation cleanup unavailable");
      return f.db.prepare(sql);
    },
    batch: f.db.batch.bind(f.db),
  };
  const work: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledController, {
    DB: failedDb, ARTIFACTS: memoryBucket(), RATELIMIT: rateLimitBinding(),
    ARTEFACTS_MASTER_KEY: MASTER, PUBLIC_ORIGIN: ORIGIN,
  }, { waitUntil: (promise: Promise<unknown>) => { work.push(promise); } } as ExecutionContext);
  const results = await Promise.allSettled(work);
  assert.equal(work.length, 3);                                                  // the project file sweep joins
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const remaining = f.db.prepare("SELECT anonymous, actor_key FROM artifact_runtime_state").all();
  assert.deepEqual(remaining.results.map(row => row.actor_key), [await Effect.runPromise(sha256hex("user:owner"))]);
});

test("scheduled cleanup sweeps deleted project files", async (t) => {
  const f = await fixture(t);
  const id = "d".repeat(32), at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  f.db.prepare(`INSERT INTO project_files (id, folder_id, collection, field, actor_key, status, size, parts, meta_sealed, key_sealed, created_at, deleted_at)
    VALUES (?, ?, 'docs', 'doc', 'A', 'deleted', 5, 1, 'x', 'x', ?, ?)`).bind(id, f.folder.id, at, at).run();
  const bucket = memoryBucket();
  await bucket.put(`file/${id}.enc`, new Uint8Array(33));
  const work: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledController, {
    DB: f.db, ARTIFACTS: bucket, RATELIMIT: rateLimitBinding(), ARTEFACTS_MASTER_KEY: MASTER, PUBLIC_ORIGIN: ORIGIN,
  }, { waitUntil: (promise: Promise<unknown>) => { work.push(promise); } } as ExecutionContext);
  await Promise.allSettled(work);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM project_files").first<{ n: number }>()?.n, 0);
  assert.equal(bucket.objects.has(`file/${id}.enc`), false);
});

test("shared writes use live colleague authority and a share never borrows its signed-in holder's editing right", async (t) => {
  const f = await fixture(t);
  await Effect.runPromise(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "editor" }));
  const editor = await f.session("editor");
  const opened = await f.load({ kind: "console", artifactId: f.artifact.id }, editor.cookie);
  assert.equal((await state(f, opened, { op: "set", scope: "shared", key: "counter", value: 7 })).status, 200);
  const visitor = await f.load();
  assert.equal((await state(f, visitor, { op: "get", scope: "shared", key: "counter" })).body.value, 7);
  assert.equal((await state(f, visitor, { op: "set", scope: "shared", key: "counter", value: 8 })).status, 403);
  const share = await Effect.runPromise(f.shares.create({ actorId: "owner", kind: "artifact", targetId: f.artifact.id, name: "Visitors" }));
  const token = new URL(share.url).pathname.split("/s/")[1].split("/")[0];
  const throughShare = await f.load({ kind: "share", path: "app-one", token, artifactId: f.artifact.id }, editor.cookie);
  assert.equal((await state(f, throughShare, { op: "delete", scope: "shared", key: "counter" })).status, 403);
  await Effect.runPromise(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "viewer" }));
  assert.equal((await state(f, opened, { op: "set", scope: "shared", key: "counter", value: 9 })).status, 403);
  assert.equal((await state(f, opened, { op: "get", scope: "shared", key: "counter" })).body.value, 7);
  await Effect.runPromise(f.shares.revoke({ actorId: "owner", id: share.id }));
  assert.equal((await state(f, throughShare, { op: "get", scope: "shared", key: "counter" })).status, 403);
});

test("direct runtime grants expire and lose access on session end, gate rotation and deletion", async (t) => {
  const f = await fixture(t);
  const source: RuntimeSource = { kind: "public", path: "app-one" };
  const session = await f.session("owner");
  const signed = await f.load(source, session.cookie);
  await Effect.runPromise(f.store.sessions.destroy(session.value.id));
  assert.notEqual((await state(f, signed, { op: "list" })).status, 200);
  const active = await f.session("owner");
  const direct = await f.load(source, active.cookie);
  await Effect.runPromise(f.artifacts.setPassword(f.artifact.id, "first"));
  assert.equal((await state(f, direct, { op: "list" })).status, 403);
  assert.equal((await f.call("load", { source }, active.cookie)).status, 401);
  assert.equal((await f.call("load", { source })).status, 403);
  assert.ok((await f.load({ kind: "console", artifactId: f.artifact.id }, active.cookie)).body.html.includes("Private application"));
  const unlocked = await Effect.runPromise(handleGate(f.request({ password: "first" }, active.cookie), f.ctx, { rest: "app-one" }));
  assert.equal(unlocked.status, 200);
  const body = await unlocked.json() as RuntimeLoadBody;
  const gated = { grant: body.runtime.grant, cookie: active.cookie };
  assert.equal((await state(f, gated, { op: "set", key: "key", value: true })).status, 200);
  await Effect.runPromise(f.artifacts.setPassword(f.artifact.id, "second"));
  assert.equal((await state(f, gated, { op: "get", key: "key" })).status, 403);
  await Effect.runPromise(f.artifacts.setPassword(f.artifact.id, null));
  const fresh = await f.load(source, active.cookie);
  f.advance(3600000);
  assert.equal((await state(f, fresh, { op: "list" })).status, 403);
  const current = await f.load(source, active.cookie);
  await Effect.runPromise(f.artifacts.remove(f.artifact.id, { authorId: "owner" }));
  assert.equal((await state(f, current, { op: "list" })).status, 403);
});

test("direct grants recheck revoked folder access for every runtime action", async (t) => {
  const f = await fixture(t);
  await Effect.runPromise(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "reader", role: "viewer" }));
  const reader = await f.session("reader");
  const opened = await f.load({ kind: "public", path: "app-one" }, reader.cookie);
  assert.equal((await state(f, opened, { op: "set", key: "private", value: "retained" })).status, 200);
  await Effect.runPromise(f.access.revoke({ actorId: "owner", folderId: f.folder.id, userId: "reader" }));
  for (const action of ["check", "state", "report", "duplicate"]) {
    assert.equal((await f.call(action, { grant: opened.grant, op: "get", key: "private", reason: "denied", csrf: reader.value.csrf }, reader.cookie)).status, 403);
  }
  assert.equal((await f.call("load", { source: { kind: "public", path: "app-one" } }, reader.cookie)).status, 403);
});

test("pre-cutover anonymous ordinary runtime grants cannot survive as visitor access", async (t) => {
  const f = await fixture(t);
  const readerToken = "a".repeat(64);
  const actorKey = await Effect.runPromise(sha256hex(`reader:${readerToken}`));
  const issuedAt = Date.now() - 60000;
  // A valid envelope in the old anonymous ordinary-link format, not a malformed forgery.
  const grant = await Effect.runPromise(scalarSeal(MASTER, {
    purpose: "artifact-runtime", source: { kind: "public", path: "app-one" }, artifactId: f.artifact.id,
    revision: await Effect.runPromise(sha256hex("null")), actorKey, binding: actorKey,
    issuedAt, expiresAt: issuedAt + 3600000,
  }));
  for (const action of ["check", "state", "report", "duplicate"]) {
    assert.equal((await f.call(action, { grant, op: "get", key: "private", reason: "denied" },
      `__Host-artefacts-reader=${readerToken}`)).status, 403);
  }
});

test("owner suspension keeps visitor shares served while a suspended reader loses their direct grant", async (t) => {
  const f = await fixture(t);
  const publicReader = await f.load();
  assert.equal((await state(f, publicReader, { op: "set", key: "k", value: 1 })).status, 200);

  // The content owner is suspended: existing visitor shares keep serving.
  await Effect.runPromise(f.store.users.setStatus("owner", "suspended"));
  assert.equal((await f.call("load", { source: f.visitorSource })).status, 200);
  assert.equal((await state(f, publicReader, { op: "get", key: "k" })).body.value, 1);
  await Effect.runPromise(f.store.users.setStatus("owner", "active"));

  // A suspended signed-in reader: their user grant stops working immediately, and console
  // access is gone, while everyone else keeps reading the same content.
  await Effect.runPromise(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "editor" }));
  const editor = await f.session("editor");
  const opened = await f.load({ kind: "console", artifactId: f.artifact.id }, editor.cookie);
  assert.equal((await state(f, opened, { op: "set", scope: "shared", key: "s", value: 7 })).status, 200);
  await Effect.runPromise(f.store.users.setStatus("editor", "suspended"));
  assert.equal((await state(f, opened, { op: "get", scope: "shared", key: "s" })).status, 401);
  assert.equal((await f.call("load", { source: { kind: "console", artifactId: f.artifact.id } }, editor.cookie)).status, 403);
  const visitor = await f.load();
  assert.equal((await state(f, visitor, { op: "get", scope: "shared", key: "s" })).body.value, 7);
});

test("storage quota is atomic, existing keys remain writable, and deleting a key releases its slot", async (t) => {
  const f = await fixture(t);
  const context = { artifactId: f.artifact.id, actorKey: "test-reader", canWriteShared: false };
  const execute = (input: StateInput) => Effect.runPromise(f.ctx.runtimeState.execute(context, input));
  for (let i = 0; i < 127; i++) await execute({ op: "set", key: `k${i}`, value: i });
  const final = await Promise.allSettled([execute({ op: "set", key: "last-a", value: 1 }), execute({ op: "set", key: "last-b", value: 2 })]);
  assert.equal(final.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = final.find((r) => r.status === "rejected");
  assert.ok(rejected);
  assert.equal(asCodeError(rejected.reason).code, "quota-exceeded");
  await execute({ op: "set", key: "k0", value: { replaced: true } });
  assert.deepEqual(await execute({ op: "get", key: "k0" }), { replaced: true });
  await execute({ op: "delete", key: "k1" });
  await execute({ op: "set", key: "replacement", value: 3 });
  assert.deepEqual(await execute({ op: "list", prefix: "replacement" }), ["replacement"]);
  await assert.rejects(execute({ op: "set", key: "large", value: "x".repeat(65536) }), { code: "too-large" });
  await assert.rejects(execute({ op: "set", key: "x".repeat(129), value: true }), { code: "invalid-state" });
});

test("aggregate ceilings span actors and scopes; anonymous exhaustion leaves the reserved trusted capacity intact", async (t) => {
  const f = await fixture(t);
  const limits = { ...STATE_LIMITS };
  const model = openRuntimeState({ db: f.db, masterKeyHex: MASTER, limits });
  const anonA = { artifactId: f.artifact.id, actorKey: "anon-a", canWriteShared: false, anonymous: true };
  const anonB = { artifactId: f.artifact.id, actorKey: "anon-b", canWriteShared: false, anonymous: true };
  const userA = { artifactId: f.artifact.id, actorKey: "user-a", canWriteShared: true, anonymous: false };
  const userB = { artifactId: f.artifact.id, actorKey: "user-b", canWriteShared: true, anonymous: false };
  const set = (ctx: StateContext, key: string, value: JsonValue, scope: StateScope = "personal") => Effect.runPromise(model.execute(ctx, { op: "set", key, value, scope }));
  const sealedLen = async (ctx: StateContext, key: string, scope: StateScope = "personal") => (await f.db.prepare(
    "SELECT LENGTH(value_sealed) AS n FROM artifact_runtime_state WHERE artifact_id = ? AND scope = ? AND actor_key = ? AND key_hash = ?")
    .bind(ctx.artifactId, scope, scope === "shared" ? "shared" : ctx.actorKey, await Effect.runPromise(sha256hex(key))).first<{ n: number }>())!.n;

  // Measure one sealed row, then size every budget in sealed bytes, so the expectations are
  // exact no matter what the seal overhead is.
  await set(anonA, "probe", "x".repeat(900));
  const p = await sealedLen(anonA, "probe");
  limits.anonymousBytes = p;                        // the anonymous pool fits exactly one big row
  limits.artifactBytes = 3 * p + 200;               // …and the trusted rows keep their reserve

  // Anonymous pool exhausted: not even a tiny extra anonymous row fits.
  await assert.rejects(set(anonB, "tiny", 1), { code: "quota-exceeded" });
  // Reserved trusted capacity: registered personal and shared state still write their rows.
  await set(userA, "big1", "y".repeat(900));
  await set(userA, "sbig", "z".repeat(900), "shared");
  // A third trusted big row would cross the aggregate byte ceiling — cross-actor accounting.
  await assert.rejects(set(userB, "big2", "y".repeat(900)), { code: "quota-exceeded" });

  // Replacement accounts for the old row: shrinking always fits, growing is judged by the
  // projected total.
  await set(userA, "big1", "small");
  assert.equal(await Effect.runPromise(model.execute(userA, { op: "get", key: "big1" })), "small");
  await set(userA, "grow", "y".repeat(900));
  await assert.rejects(set(userA, "grow", "y".repeat(1100)), { code: "quota-exceeded" });
  const grown = await Effect.runPromise(model.execute(userA, { op: "get", key: "grow" }));
  assert.ok(typeof grown === "string");
  assert.equal(grown.length, 900);
});

test("per-artifact key ceilings: anonymous keys cap inside the aggregate, replacement and freed slots work, and concurrent writers cannot overshoot", async (t) => {
  const f = await fixture(t);
  const agg = await Effect.runPromise(f.artifacts.create({ ownerId: "owner", title: "Agg", html: HTML, slug: "agg", authorId: "owner" }));
  const limits = { ...STATE_LIMITS, artifactKeys: 5, anonymousKeys: 2 };
  const model = openRuntimeState({ db: f.db, masterKeyHex: MASTER, limits });
  const anonA = { artifactId: agg.id, actorKey: "anon-a", canWriteShared: false, anonymous: true };
  const anonB = { artifactId: agg.id, actorKey: "anon-b", canWriteShared: false, anonymous: true };
  const peerA = { artifactId: agg.id, actorKey: "user-a", canWriteShared: true, anonymous: false };
  const peerB = { artifactId: agg.id, actorKey: "user-b", canWriteShared: true, anonymous: false };
  const set = (ctx: StateContext, key: string, value: JsonValue) => Effect.runPromise(model.execute(ctx, { op: "set", key, value }));

  await set(anonA, "a1", 1);
  await set(anonA, "a2", 1);
  // The anonymous key pool is per artefact across actors: a third anonymous key from either
  // actor is refused even though the artefact aggregate has room.
  await assert.rejects(set(anonA, "a3", 1), { code: "quota-exceeded" });
  await assert.rejects(set(anonB, "b1", 1), { code: "quota-exceeded" });
  // Trusted state writes into the reserved capacity while anonymous is capped.
  await set(peerA, "u1", 1);
  await set(peerA, "u2", 1);
  await set(peerB, "v1", 1);
  // Fifth key of the artefact fills the aggregate; a sixth is refused whichever actor asks.
  await assert.rejects(set(peerB, "v2", 1), { code: "quota-exceeded" });
  await assert.rejects(set(peerA, "u3", 1), { code: "quota-exceeded" });
  // Replacement of a live key still works at the aggregate ceiling.
  await set(peerA, "u1", { replaced: true });
  assert.deepEqual(await Effect.runPromise(model.execute(peerA, { op: "get", key: "u1" })), { replaced: true });
  await Effect.runPromise(model.execute(peerB, { op: "delete", key: "v1" }));
  await set(peerA, "u3", 1);

  // Two concurrent new-key writes race for the one remaining aggregate slot: exactly one lands.
  await Effect.runPromise(model.execute(peerA, { op: "delete", key: "u2" }));
  const race = await Promise.allSettled([set(peerB, "v1", 1), set(peerB, "v9", 1)]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = race.find((r) => r.status === "rejected");
  assert.ok(rejected);
  assert.equal(asCodeError(rejected.reason).code, "quota-exceeded");
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM artifact_runtime_state WHERE artifact_id = ?").bind(agg.id).first<{ n: number }>())!.n, 5);
});

test("anonymous personal state expires after a year idle; signed-in personal and shared state never expire; cleanup reclaims rows physically", async (t) => {
  const f = await fixture(t);
  const DAY = 86_400_000;
  let clock = 1_700_000_000_000;
  const model = openRuntimeState({ db: f.db, masterKeyHex: MASTER, now: () => clock });
  const anon = { artifactId: f.artifact.id, actorKey: "anon-a", canWriteShared: false, anonymous: true };
  const signed = { artifactId: f.artifact.id, actorKey: "user-a", canWriteShared: false, anonymous: false };
  const shared = { artifactId: f.artifact.id, actorKey: "user-a", canWriteShared: true, anonymous: false };
  await Effect.runPromise(model.execute(anon, { op: "set", key: "temp", value: 1 }));
  await Effect.runPromise(model.execute(signed, { op: "set", key: "mine", value: 2 }));
  await Effect.runPromise(model.execute(shared, { op: "set", scope: "shared", key: "common", value: 3 }));
  const row = await f.db.prepare("SELECT expires_at, anonymous FROM artifact_runtime_state WHERE actor_key = 'anon-a'").first<{ expires_at: string; anonymous: number }>();
  assert.ok(row);
  assert.equal(row.anonymous, 1);
  assert.equal(new Date(row.expires_at).getTime(), clock + 365 * DAY);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM artifact_runtime_state WHERE expires_at IS NULL").first<{ n: number }>())!.n, 2);

  clock += 365 * DAY + 1000;
  // Expired anonymous entries answer nothing, list as nothing, and stop counting immediately:
  // the freed capacity is writable again without waiting for cleanup.
  assert.equal(await Effect.runPromise(model.execute(anon, { op: "get", key: "temp" })), null);
  assert.deepEqual(await Effect.runPromise(model.execute(anon, { op: "list" })), []);
  await Effect.runPromise(model.execute(anon, { op: "set", key: "fresh", value: 4 }));
  // Signed-in personal and shared state do not expire.
  assert.deepEqual(await Effect.runPromise(model.execute(signed, { op: "get", key: "mine" })), 2);
  assert.deepEqual(await Effect.runPromise(model.execute(shared, { op: "get", scope: "shared", key: "common" })), 3);
  clock += 100 * 365 * DAY;
  assert.deepEqual(await Effect.runPromise(model.execute(signed, { op: "get", key: "mine" })), 2);
  assert.deepEqual(await Effect.runPromise(model.execute(shared, { op: "get", scope: "shared", key: "common" })), 3);

  // Scheduled cleanup removes exactly the expired rows, physically, in bounded batches,
  // and a second pass finds nothing left.
  assert.equal(await Effect.runPromise(model.pruneExpired()), 2);
  const left = await f.db.prepare(
    "SELECT actor_key, scope FROM artifact_runtime_state WHERE artifact_id = ? ORDER BY scope, actor_key").bind(f.artifact.id).all<{ actor_key: string; scope: StateScope }>();
  assert.deepEqual(left.results.map((r) => `${r.actor_key}:${r.scope}`), ["user-a:personal", "shared:shared"]);
  assert.equal(await Effect.runPromise(model.pruneExpired()), 0);
});

test("anonymous entries survive past creation when kept active, but idle ones do not", async (t) => {
  const f = await fixture(t);
  const DAY = 86_400_000;
  let clock = 1_700_000_000_000;
  const model = openRuntimeState({ db: f.db, masterKeyHex: MASTER, now: () => clock });
  const anon = { artifactId: f.artifact.id, actorKey: "anon-a", canWriteShared: false, anonymous: true };
  await Effect.runPromise(model.execute(anon, { op: "set", key: "k", value: 1 }));
  clock += 300 * DAY;
  assert.deepEqual(await Effect.runPromise(model.execute(anon, { op: "get", key: "k" })), 1);
  // A successful read is activity: the idle year restarts from the read.
  const touched = await f.db.prepare("SELECT expires_at FROM artifact_runtime_state WHERE actor_key = 'anon-a'").first<{ expires_at: string }>();
  assert.ok(touched);
  assert.equal(new Date(touched.expires_at).getTime(), clock + 365 * DAY);
  clock += 300 * DAY;
  assert.deepEqual(await Effect.runPromise(model.execute(anon, { op: "get", key: "k" })), 1);
  clock += 366 * DAY;
  assert.equal(await Effect.runPromise(model.execute(anon, { op: "get", key: "k" })), null);
});

test("a write authorized before deletion cannot resurrect state on the tombstone", async (t) => {
  const f = await fixture(t);
  const execute = (input: StateInput) => Effect.runPromise(f.ctx.runtimeState.execute({ artifactId: f.artifact.id, actorKey: "racer", canWriteShared: true }, input));
  await execute({ op: "set", key: "before", value: 1 });
  await Effect.runPromise(f.artifacts.remove(f.artifact.id, { authorId: "owner" }));
  await assert.rejects(execute({ op: "set", key: "after", value: 2 }), { code: "not-found" });
  await assert.rejects(execute({ op: "set", key: "before", value: 3 }), { code: "not-found" });
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM artifact_runtime_state WHERE artifact_id = ?").bind(f.artifact.id).first<{ n: number }>())!.n, 0);

  // The window between withdrawal (deleted_at set) and the physical purge, reproduced
  // exactly: the row still exists, the artefact is dead, and the write must still lose.
  const other = await Effect.runPromise(f.artifacts.create({ ownerId: "owner", title: "Raced", html: HTML, slug: "raced", authorId: "owner" }));
  const racing = (input: StateInput) => Effect.runPromise(f.ctx.runtimeState.execute({ artifactId: other.id, actorKey: "racer", canWriteShared: true }, input));
  await racing({ op: "set", key: "live", value: 1 });
  await f.db.prepare("UPDATE artifacts SET deleted_at = ?, current_version = 0 WHERE id = ?")
    .bind(new Date().toISOString(), other.id).run();
  await assert.rejects(racing({ op: "set", key: "live", value: 2 }), { code: "not-found" });
  await assert.rejects(racing({ op: "set", key: "dead", value: 3 }), { code: "not-found" });
});

test("lifecycle validation failures surface as explicit client errors, not uncaught 500s", async (t) => {
  const f = await fixture(t);
  const session = await f.session("owner");
  // A console grant bound to the owner's session identity, so authorize() passes and the
  // duplicate model is actually reached.
  const signed = await f.load({ kind: "console", artifactId: f.artifact.id }, session.cookie);
  const original = f.ctx.artifacts.duplicate;
  const failingModel = (code: string) => () => Effect.fail(Object.assign(new Error("Document rejected by validation."), { code }));
  for (const code of ["external-reference", "incomplete-document", "not-utf8", "invalid-content"]) {
    f.ctx.artifacts.duplicate = failingModel(code);
    const response = await f.call("duplicate", { grant: signed.grant, title: "Copy", csrf: session.value.csrf }, session.cookie);
    assert.equal(response.status, 400, `${code} must map to a client error`);
    const body = await response.json() as RuntimeStateBody;
    assert.equal(body.error, code);
  }
  f.ctx.artifacts.duplicate = original;
});

test("null origins and forged grants cannot write; reports are sealed, rate limited and resolvable", async (t) => {
  const f = await fixture(t);
  const opened = await f.load();
  assert.equal((await f.call("state", { grant: opened.grant, op: "set", key: "no", value: true }, opened.cookie, "null")).status, 403);
  assert.equal((await f.call("state", { grant: opened.grant.slice(0, -8) + "tampered", op: "list" }, opened.cookie)).status, 403);
  const reason = "Confidential report reason";
  for (let i = 0; i < 10; i++) assert.equal((await f.call("report", { grant: opened.grant, reason }, opened.cookie)).status, 200);
  assert.equal((await f.call("report", { grant: opened.grant, reason }, opened.cookie)).status, 429);
  const rows = await Effect.runPromise(f.ctx.reports.list());
  assert.equal(rows[0].reason, reason);
  assert.equal(JSON.stringify(await f.db.prepare("SELECT * FROM artifact_reports").all()).includes(reason), false);
  await Effect.runPromise(f.ctx.reports.resolve(rows[0].id, "staff"));
  assert.ok((await Effect.runPromise(f.ctx.reports.list())).find((row) => row.id === rows[0].id)?.resolvedAt);
});

test("protected duplication requires an explicit new gate and never copies application state", async (t) => {
  const f = await fixture(t);
  await Effect.runPromise(f.artifacts.setPassword(f.artifact.id, "source-password"));
  const source = await Effect.runPromise(f.artifacts.byId(f.artifact.id));
  assert.ok(source);
  const user = await Effect.runPromise(f.store.users.byId("reader"));
  assert.ok(user);
  const active = { user };
  await assert.rejects(Effect.runPromise(duplicateReadable(f.ctx, active, source, { title: "Copy" })), { code: "password-choice" });
  await assert.rejects(Effect.runPromise(duplicateReadable(f.ctx, active, source, { title: "Copy", password: "new", folderId: f.folder.id })), { code: "forbidden" });
  await Effect.runPromise(f.ctx.runtimeState.execute({ artifactId: source.id, actorKey: "reader", canWriteShared: true }, { op: "set", scope: "shared", key: "secret", value: "not copied" }));
  const result = await Effect.runPromise(duplicateReadable(f.ctx, active, source, { title: "Copy", slug: "copy", password: "new-password" }));
  assert.equal(result.url, "/app/a/copy/view");
  const copy = await Effect.runPromise(f.artifacts.bySlug("copy"));
  assert.ok(copy);
  assert.equal(copy.ownerId, "reader");
  assert.equal(await Effect.runPromise(f.artifacts.verifyPassword(copy, "source-password")), false);
  assert.equal(await Effect.runPromise(f.artifacts.verifyPassword(copy, "new-password")), true);
  assert.equal(await Effect.runPromise(f.ctx.runtimeState.execute({ artifactId: copy.id, actorKey: "reader", canWriteShared: true }, { op: "get", scope: "shared", key: "secret" })), null);
  const ungated = await Effect.runPromise(duplicateReadable(f.ctx, active, source, { title: "Private copy", slug: "private-copy", password: "" }));
  assert.equal(ungated.url, "/app/a/private-copy/view");
  const ordinarySource: RuntimeSource = { kind: "public", path: "private-copy" };
  assert.equal((await f.call("load", { source: ordinarySource })).status, 403);
  const owner = await f.session("reader");
  assert.ok((await f.load(ordinarySource, owner.cookie)).body.html.includes("Private application"));
});

test("rotating anonymous identity cannot bypass grant issuance limits", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    await f.load(undefined, `__Host-artefacts-reader=${i.toString(16).padStart(64, "0")}`);
  }
  const blocked = await f.call("load", { source: f.visitorSource },
    `__Host-artefacts-reader=${"f".repeat(64)}`);
  assert.equal(blocked.status, 429);
});

test("anonymous requests share an IP window in addition to each actor's window", async (t) => {
  const f = await fixture(t);
  const readers = [await f.load(), await f.load()];
  for (let i = 0; i < 178; i++) {
    assert.equal((await state(f, readers[i % 2], { op: "get", key: "counter" })).status, 200);
  }
  assert.equal((await state(f, readers[0], { op: "get", key: "counter" })).status, 429);
});

test("report moderation requires staff and CSRF without granting document access", async (t) => {
  const f = await fixture(t);
  const id = await Effect.runPromise(f.ctx.reports.submit({ artifactId: f.artifact.id, actorKey: "reporter", reason: "Needs review" }));
  const reader = await f.session("reader");
  const staff = await f.session("staff");
  const list = (cookie: string) => Effect.runPromise(handleConsole(new Request(`${ORIGIN}/admin/reports`, { headers: { Cookie: cookie } }), f.ctx, { area: "admin", rest: "reports" }));
  assert.equal((await list(reader.cookie)).status, 403);
  const staffPage = await list(staff.cookie);
  assert.equal(staffPage.status, 200);
  const content = await staffPage.text();
  assert.equal(content.includes("Private application"), false);
  assert.equal(content.includes("/app-one/"), false);
  assert.equal((await f.call("load", { source: { kind: "console", artifactId: f.artifact.id } }, staff.cookie)).status, 403);
  const resolve = (csrf: string) => Effect.runPromise(handleConsole(new Request(`${ORIGIN}/admin/reports/${id}/resolve`, {
    method: "POST", headers: { Cookie: staff.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  }), f.ctx, { area: "admin", rest: `reports/${id}/resolve` }));
  assert.equal((await resolve("wrong")).status, 403);
  assert.equal((await Effect.runPromise(f.ctx.reports.list()))[0].resolvedAt, null);
  assert.equal((await resolve(staff.value.csrf)).status, 303);
  assert.ok((await Effect.runPromise(f.ctx.reports.list()))[0].resolvedAt);
});

test("a failed observation proof does not revoke an authorized share runtime grant", async (t) => {
  const f = await fixture(t);
  const share = await Effect.runPromise(f.shares.create({ actorId: "owner", kind: "artifact", targetId: f.artifact.id, name: "Visitors" }));
  const token = new URL(share.url).pathname.split("/s/")[1].split("/")[0];
  f.ctx.analytics.proof = () => Effect.fail(Object.assign(new Error("Analytics unavailable."), { code: "db-unavailable" }));
  const opened = await f.load({ kind: "share", path: "app-one", token, artifactId: f.artifact.id });
  assert.ok(opened.body.html.includes("Private application"));
  assert.equal(opened.body.observation, null);
  assert.equal((await state(f, opened, { op: "set", key: "draft", value: "still authorized" })).status, 200);
  assert.equal((await state(f, opened, { op: "get", key: "draft" })).body.value, "still authorized");
  const missingSelector = await Effect.runPromise(f.ctx.artifactRuntime.handle(f.request({ grant: opened.grant }, opened.cookie), f.ctx, {}));
  assert.equal(missingSelector.status, 404);
});

test("agent-seeded records are shared by artefacts of one project", async (t) => {
  const f = await project(t);
  const seeded = await f.run(f.projectData.create(f.folder.id, "offers", { title: "Seed" }));
  const one = await f.direct(f.artifact.id);
  const listed = await data(f, one, { op: "list", collection: "offers" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.value?.records.map(record => record.data), [{ title: "Seed" }]);
  assert.equal("submission" in (listed.body.value?.records[0] ?? {}), false);
  const updated = await data(f, one, { op: "update", collection: "offers", id: seeded.id, data: { title: "Edited" }, ifVersion: 1 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.value?.version, 2);
  const stale = await data(f, one, { op: "update", collection: "offers", id: seeded.id, data: { title: "Late" }, ifVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "conflict");
  const got = await data(f, await f.direct(f.two.id), { op: "get", collection: "offers", id: seeded.id });
  assert.equal(got.status, 200);
  assert.deepEqual([got.body.value?.version, got.body.value?.data], [2, { title: "Edited" }]);
});

test("records read and write follow the reader role", async (t) => {
  const f = await project(t);
  await f.run(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "reader", role: "viewer" }));
  await f.run(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "editor" }));
  const viewer = await f.direct(f.artifact.id, (await f.session("reader")).cookie);
  assert.equal((await data(f, viewer, { op: "list", collection: "offers" })).status, 200);
  assert.equal((await data(f, viewer, { op: "create", collection: "offers", data: { title: "No" } })).status, 403);
  const editorCookie = (await f.session("editor")).cookie;
  const editor = await f.direct(f.artifact.id, editorCookie);
  assert.equal((await data(f, editor, { op: "create", collection: "offers", data: { title: "Yes" } })).status, 200);
  const visitor = await f.load();
  assert.equal((await data(f, visitor, { op: "list", collection: "offers" })).status, 403);
  await f.run(f.projectData.define(f.folder.id, "offers", { kind: "records", visitors: true, fields: { title: { type: "text", required: true } } }));
  const opened = await data(f, visitor, { op: "list", collection: "offers" });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.value?.records.length, 1);
  assert.equal((await data(f, visitor, { op: "create", collection: "offers", data: { title: "No" } })).status, 403);
  const editorAsVisitor = await f.load(f.visitorSource, editorCookie);
  assert.equal((await data(f, editorAsVisitor, { op: "create", collection: "offers", data: { title: "No" } })).status, 403);
});

test("two visitors submit and see only their own responses", async (t) => {
  const f = await project(t);
  const a = await f.load();
  const b = await f.load();
  const sent = await data(f, a, { op: "submit", collection: "rsvp", data: ANSWER });
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.body.value?.submission ?? {}).sort(), ["artifactVersion", "submittedAt"]);
  assert.equal((await data(f, b, { op: "submit", collection: "rsvp", data: { ...ANSWER, name: "Bo", attend: "no" } })).status, 200);
  for (const [reader, name] of [[a, "Ana"], [b, "Bo"]] as const) {
    const mine = await data(f, reader, { op: "mine", collection: "rsvp" });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.value?.records.length, 1);
    assert.equal(mine.body.value?.records[0].data.name, name);
    assert.deepEqual(Object.keys(mine.body.value?.records[0].submission ?? {}).sort(), ["artifactVersion", "submittedAt"]);
  }
  const id = sent.body.value?.id;
  for (const input of [{ op: "list" }, { op: "get", id }, { op: "update", id, data: ANSWER }, { op: "delete", id }]) {
    const refused = await data(f, a, { ...input, collection: "rsvp" });
    assert.equal(refused.status, 400, input.op);
    assert.equal(refused.body.error, "wrong-kind", input.op);
  }
});

test("submission metadata records version and authority", async (t) => {
  const f = await project(t);
  await f.run(f.artifacts.publish({ artifactId: f.artifact.id, html: HTML.replace("Private application", "Second edition"), authorId: "owner" }));
  const visitor = await f.load();
  const sent = await data(f, visitor, { op: "submit", collection: "rsvp", data: ANSWER });
  assert.equal(sent.status, 200);
  const stored = await f.run(f.projectData.get(f.folder.id, "rsvp", sent.body.value?.id ?? ""));
  assert.equal(stored?.submission?.artifactVersion, 2);
  assert.equal(stored?.submission?.artifactId, f.artifact.id);
  assert.deepEqual(stored?.submission?.submittedBy, { type: "share", shareId: f.visitorShare.id, shareName: "Visitors" });
  const own = await data(f, await f.direct(f.artifact.id), { op: "submit", collection: "rsvp", data: ANSWER });
  const ownStored = await f.run(f.projectData.get(f.folder.id, "rsvp", own.body.value?.id ?? ""));
  assert.deepEqual(ownStored?.submission?.submittedBy, { type: "user", userId: "owner", email: "owner@example.test", name: "owner" });
});

test("invalid submissions are not saved", async (t) => {
  const f = await project(t);
  const refused = await data(f, await f.load(), { op: "submit", collection: "rsvp", data: { name: "Ana", attend: "yes" } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "validation");
  assert.equal(refused.body.issues?.[0].field, "confirm");
  assert.equal((await f.run(f.projectData.list(f.folder.id, "rsvp"))).records.length, 0);
});

test("revoked shares and non-visitor collections deny submission", async (t) => {
  const f = await project(t);
  await f.run(f.projectData.define(f.folder.id, "closed", { ...f.rsvp, visitors: false }));
  const visitor = await f.load();
  assert.equal((await data(f, visitor, { op: "submit", collection: "closed", data: ANSWER })).status, 403);
  assert.equal((await data(f, visitor, { op: "submit", collection: "rsvp", data: ANSWER })).status, 200);
  await f.run(f.shares.revoke({ actorId: "owner", id: f.visitorShare.id }));
  assert.equal((await data(f, visitor, { op: "submit", collection: "rsvp", data: ANSWER })).status, 403);
});

test("unfiled artefacts have no project", async (t) => {
  const f = await project(t);
  const loose = await f.direct(f.unfiled.id);
  for (const input of [{ op: "list", collection: "offers" }, { op: "submit", collection: "rsvp", data: ANSWER }, { op: "mine", collection: "rsvp" }]) {
    const refused = await data(f, loose, input);
    assert.equal(refused.status, 409, input.op);
    assert.equal(refused.body.error, "no-project", input.op);
  }
});

test("moving an artefact rebinds its project live", async (t) => {
  const f = await project(t);
  await f.run(f.projectData.create(f.folder.id, "offers", { title: "Seed" }));
  const two = await f.direct(f.two.id);
  assert.equal((await data(f, two, { op: "list", collection: "offers" })).body.value?.records.length, 1);
  await f.run(f.folders.setParent(f.inner.id, null));
  const moved = await data(f, two, { op: "list", collection: "offers" });
  assert.equal(moved.status, 404);
  assert.equal(moved.body.error, "not-found");
});

test("submit is rate limited per reader and project", async (t) => {
  const f = await project(t);
  const visitor = await f.load();
  for (let i = 0; i < 30; i++) assert.equal((await data(f, visitor, { op: "submit", collection: "rsvp", data: ANSWER })).status, 200, `submit ${i}`);
  const limited = await data(f, visitor, { op: "submit", collection: "rsvp", data: ANSWER });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate-limited");
});

test("signed-out submissions also share a per-IP ceiling per project", async (t) => {
  const f = await project(t);
  const hits: Array<{ key: string; limit: number; windowMs: number }> = [];
  const limiter = f.ctx.limiter;
  f.ctx.limiter = { ...limiter, hit: (key, options) => { hits.push({ key, ...options }); return limiter.hit(key, options); } };
  const bucket = `runtime-ip:submit:${await Effect.runPromise(sha256hex(`${MASTER}:runtime-ip:${clientIp(f.request({}))}`))}:${f.folder.id}`;
  assert.equal((await data(f, await f.load(), { op: "submit", collection: "rsvp", data: ANSWER })).status, 200);
  assert.deepEqual(hits.filter(hit => hit.key === bucket), [{ key: bucket, limit: 120, windowMs: 3_600_000 }]);
  for (let i = 1; i < 120; i++) await Effect.runPromise(limiter.hit(bucket, { limit: 120, windowMs: 3_600_000 }));
  const fresh = await data(f, await f.load(), { op: "submit", collection: "rsvp", data: ANSWER });   // a new reader cookie, same IP
  assert.equal(fresh.status, 429);
  assert.equal(fresh.body.error, "rate-limited");
  hits.length = 0;
  assert.equal((await data(f, await f.direct(f.artifact.id), { op: "submit", collection: "rsvp", data: ANSWER })).status, 200);
  assert.equal(hits.some(hit => hit.key.startsWith("runtime-ip:submit:")), false);
});

type Project = Awaited<ReturnType<typeof project>>;
interface FilesInit { method: string; body?: Uint8Array<ArrayBuffer>; type?: string; origin?: string; grant?: string | null; headers?: Record<string, string> }
const filesCall = (f: Project, opened: ReaderGrant, rest: string, init: FilesInit, ctx = f.ctx) =>
  Effect.runPromise(ctx.artifactRuntime.files(new Request(`${ORIGIN}/_runtime/files/${rest}`, { method: init.method, body: init.body,
    headers: { Origin: init.origin ?? ORIGIN, Cookie: opened.cookie, ...(init.type ? { "Content-Type": init.type } : {}),
      ...(init.body ? { "Content-Length": String(init.body.byteLength) } : {}), ...init.headers,
      ...(init.grant === null ? {} : { "X-Artefacts-Grant": init.grant ?? opened.grant }) } }), ctx, { rest }));
const putPart = (f: Project, opened: ReaderGrant, id: string, n: number, body: Uint8Array<ArrayBuffer>, init: Partial<FilesInit> = {}, ctx = f.ctx) =>
  filesCall(f, opened, `uploads/${id}/parts/${n}`, { method: "PUT", body, type: "application/octet-stream", ...init }, ctx);
const startUpload = (f: Project, opened: ReaderGrant, collection: string, field: string, name: string, size: number, type = "application/pdf") =>
  data(f, opened, { op: "upload-start", collection, data: { field, name, type, size, lastModified: 1 } });
const startedId = (started: { body: RuntimeDataBody }) => (started.body.value as unknown as { upload: UploadView }).upload.id;
/** A 5-byte upload, completed and ready to attach. */
const readyFile = async (f: Project, opened: ReaderGrant, collection: string, field: string, name = "a.pdf") => {
  const id = startedId(await startUpload(f, opened, collection, field, name, 5));
  assert.equal((await putPart(f, opened, id, 1, new Uint8Array([1, 2, 3, 4, 5]))).status, 200);
  const done = await data(f, opened, { op: "upload-complete", collection, id });
  assert.equal(done.status, 200);
  return (done.body.value as unknown as { file: FileRef }).file;
};
const errorOf = async (response: Response) => ({ status: response.status, ...(await response.json() as { error?: string; issues?: Array<{ field: string }> }) });

test("files: an editor uploads, resumes, completes, attaches and downloads a record file", async (t) => {
  const f = await project(t);
  const owner = await f.direct(f.artifact.id);
  const size = PART_BYTES + 3, content = new Uint8Array(size).map((_, i) => i % 251);
  const started = await startUpload(f, owner, "docs", "doc", "Angebot – März.pdf", size);
  const { upload, resumed } = started.body.value as unknown as { upload: UploadView; resumed: boolean };
  assert.equal(resumed, false);
  assert.equal(upload.partPath, `/_runtime/files/uploads/${upload.id}/parts/`);
  assert.deepEqual([upload.parts, upload.partBytes, upload.status], [2, PART_BYTES, "uploading"]);
  const one = await putPart(f, owner, upload.id, 1, content.slice(0, PART_BYTES));
  assert.equal(one.status, 200);
  assert.deepEqual((await one.json() as { value: { part: unknown } }).value.part, { number: 1, size: PART_BYTES, sha256: hex(await f.run(sha256(content.subarray(0, PART_BYTES)))) });
  const again = (await startUpload(f, owner, "docs", "doc", "Angebot – März.pdf", size)).body.value as unknown as { upload: UploadView; resumed: boolean };
  assert.deepEqual([again.resumed, again.upload.id, again.upload.received.length], [true, upload.id, 1]);
  assert.equal((await putPart(f, owner, upload.id, 2, content.slice(PART_BYTES))).status, 200);
  const file = ((await data(f, owner, { op: "upload-complete", collection: "docs", id: upload.id })).body.value as unknown as { file: FileRef }).file;
  assert.deepEqual(file, { id: upload.id, name: "Angebot – März.pdf", type: "application/pdf", size });
  const record = (await data(f, owner, { op: "create", collection: "docs", data: { title: "A", doc: file.id } })).body.value as ProjectRecord;
  assert.deepEqual(record.data.doc, file);
  const got = await filesCall(f, owner, `docs/${record.id}/${file.id}`, { method: "POST", headers: { Range: "bytes=0-1" } });   // Range is ignored
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), content);
  assert.deepEqual(Object.fromEntries(["content-type", "content-length", "content-disposition", "x-artefacts-file-type", "x-content-type-options",
    "content-security-policy", "cache-control", "referrer-policy"].map((h) => [h, got.headers.get(h)])), {
    "content-type": "application/octet-stream", "content-length": String(size),
    "content-disposition": "attachment; filename=\"Angebot _ M_rz.pdf\"; filename*=UTF-8''Angebot%20%E2%80%93%20M%C3%A4rz.pdf",
    "x-artefacts-file-type": "application/pdf", "x-content-type-options": "nosniff", "content-security-policy": "sandbox",
    "cache-control": "no-store", "referrer-policy": "no-referrer" });

  const second = startedId(await startUpload(f, owner, "docs", "doc", "other.pdf", 5));
  const cancelled = await data(f, owner, { op: "upload-cancel", collection: "docs", id: second });
  assert.deepEqual([cancelled.status, cancelled.body], [200, { value: null }]);
  assert.equal((await data(f, owner, { op: "upload-complete", collection: "docs", id: second })).status, 404);
});

test("files: part requests are guarded by origin, content type, grant and size", async (t) => {
  const f = await project(t);
  const owner = await f.direct(f.artifact.id);
  const id = startedId(await startUpload(f, owner, "docs", "doc", "a.pdf", 5));
  const five = new Uint8Array(5);
  assert.deepEqual(await errorOf(await putPart(f, owner, id, 1, five, { origin: "https://evil.test" })), { status: 403, error: "forbidden" });
  assert.equal((await putPart(f, owner, id, 1, five, { type: "text/plain" })).status, 403);
  assert.equal((await putPart(f, owner, id, 1, five, { grant: null })).status, 403);
  const large = await errorOf(await putPart(f, owner, id, 1, new Uint8Array(PART_BYTES + 1)));
  assert.deepEqual([large.status, large.error], [413, "too-large"]);
  const short = await errorOf(await putPart(f, owner, id, 1, new Uint8Array(4)));
  assert.deepEqual([short.status, short.error, short.issues?.[0]?.field], [400, "validation", "part"]);
  assert.deepEqual(await errorOf(await filesCall(f, owner, "nope", { method: "POST" })), { status: 404, error: "not-found" });
  assert.equal((await filesCall(f, owner, `uploads/${id}/parts/1`, { method: "GET" })).status, 405);
  for (const n of ["01", "1e0", "0x1"]) assert.equal((await filesCall(f, owner, `uploads/${id}/parts/${n}`, { method: "PUT", body: five, type: "application/octet-stream" })).status, 404, n);
  // A full isolate refuses before admission: the hourly part bucket is charged only inside a slot.
  const keys: string[] = [];
  const ctx = { ...f.ctx, limiter: { ...f.ctx.limiter, hit: (key: string, options: { limit: number; windowMs: number }) => { keys.push(key); return f.ctx.limiter.hit(key, options); } },
    projectFiles: { ...f.ctx.projectFiles, putPart: () => Effect.fail(Object.assign(new Error("busy"), { code: "rate-limited", retryAfter: 1 })) } };
  const busy = await putPart(f, owner, id, 1, five, {}, ctx);
  assert.deepEqual([busy.status, (await busy.json() as { error: string }).error, busy.headers.get("Retry-After")], [429, "rate-limited", "1"]);
  assert.deepEqual(keys.filter((key) => key.includes("files-part:")), []);
});

test("files: share visitors upload responses only where the collection admits visitors", async (t) => {
  const f = await project(t);
  const visitor = await f.load();
  assert.equal((await startUpload(f, visitor, "closed", "cv", "cv.pdf", 5)).status, 403);
  const cv = await readyFile(f, visitor, "cvs", "cv", "cv.pdf");
  const submitted = await data(f, visitor, { op: "submit", collection: "cvs", data: { name: "Ana", cv: cv.id } });
  assert.equal(submitted.status, 200);
  const record = submitted.body.value as ProjectRecord;
  assert.deepEqual(record.data.cv, cv);
  assert.equal((await filesCall(f, await f.load(), `cvs/${record.id}/${cv.id}`, { method: "POST" })).status, 404);
  const mine = await filesCall(f, visitor, `cvs/${record.id}/${cv.id}`, { method: "POST" });
  assert.equal(mine.status, 200);
  assert.deepEqual(new Uint8Array(await mine.arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
  // Responses are the submitter's; managers read them through the API.
  assert.equal((await filesCall(f, await f.direct(f.artifact.id), `cvs/${record.id}/${cv.id}`, { method: "POST" })).status, 404);
});

test("files: records uploads need live shared-write authority", async (t) => {
  const f = await project(t);
  await f.run(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "editor" }));
  const editor = await f.session("editor");
  assert.equal((await startUpload(f, await f.load(f.visitorSource, editor.cookie), "docs", "doc", "a.pdf", 5)).status, 403);
  await f.run(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "reader", role: "viewer" }));
  const reader = await f.session("reader");
  assert.equal((await startUpload(f, await f.direct(f.artifact.id, reader.cookie), "docs", "doc", "a.pdf", 5)).status, 403);
  const owner = await f.direct(f.artifact.id);
  const doc = await readyFile(f, owner, "docs", "doc");
  const record = (await data(f, owner, { op: "create", collection: "docs", data: { title: "A", doc: doc.id } })).body.value as ProjectRecord;
  assert.equal((await filesCall(f, await f.load(), `docs/${record.id}/${doc.id}`, { method: "POST" })).status, 200);
});

test("files: a revoked share stops an upload between parts", async (t) => {
  const f = await project(t);
  const visitor = await f.load();
  const id = startedId(await startUpload(f, visitor, "cvs", "cv", "big.pdf", PART_BYTES + 1));
  assert.equal((await putPart(f, visitor, id, 1, new Uint8Array(PART_BYTES))).status, 200);
  await f.run(f.shares.revoke({ actorId: "owner", id: f.visitorShare.id }));
  assert.equal((await putPart(f, visitor, id, 2, new Uint8Array(1))).status, 403);
  assert.equal((await data(f, visitor, { op: "upload-complete", collection: "cvs", id })).status, 403);
});

test("files: a suspended reader stops between parts", async (t) => {
  const f = await project(t);
  await f.run(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "editor" }));
  const editor = await f.direct(f.artifact.id, (await f.session("editor")).cookie);
  const id = startedId(await startUpload(f, editor, "docs", "doc", "big.pdf", PART_BYTES + 1));
  assert.equal((await putPart(f, editor, id, 1, new Uint8Array(PART_BYTES))).status, 200);
  await f.run(f.store.users.setStatus("editor", "suspended"));
  // As for every runtime action, a suspended session leaves no reader identity: 401.
  assert.equal((await putPart(f, editor, id, 2, new Uint8Array(1))).status, 401);
  assert.equal((await data(f, editor, { op: "upload-complete", collection: "docs", id })).status, 401);
});

test("files: a part after the artefact left the project is not found", async (t) => {
  const f = await project(t);
  const two = await f.direct(f.two.id);
  const id = startedId(await startUpload(f, two, "docs", "doc", "a.pdf", 5));
  await f.run(f.folders.setParent(f.inner.id, null));
  assert.equal((await putPart(f, two, id, 1, new Uint8Array(5))).status, 404);
});

test("files: limiter buckets use the pinned keys and windows", async (t) => {
  const f = await project(t);
  const hits: Array<{ key: string; limit: number; windowMs: number }> = [];
  const limiter = f.ctx.limiter;
  f.ctx.limiter = { ...limiter, hit: (key, options) => { hits.push({ key, ...options }); return limiter.hit(key, options); } };
  const visitor = await f.load();
  const actorKey = await f.run(sha256hex(`reader:${visitor.cookie.split("=")[1]}`));
  const ipKey = await f.run(sha256hex(`${MASTER}:runtime-ip:${clientIp(f.request({}))}`));
  const hour = 3_600_000;
  const id = startedId(await startUpload(f, visitor, "cvs", "cv", "a.pdf", 5));
  for (const hit of [{ key: `files-start:${actorKey}:${f.folder.id}`, limit: 20, windowMs: hour },
    { key: `runtime-ip:files-start:${ipKey}:${f.folder.id}`, limit: 60, windowMs: hour }]) assert.ok(hits.some((seen) => JSON.stringify(seen) === JSON.stringify(hit)), hit.key);
  hits.length = 0;
  assert.equal((await putPart(f, visitor, id, 1, new Uint8Array(5))).status, 200);
  for (const hit of [{ key: `files-part:${actorKey}:${f.folder.id}`, limit: 128, windowMs: hour },
    { key: `runtime-ip:files-part:${ipKey}:${f.folder.id}`, limit: 256, windowMs: hour },
    { key: `runtime:${actorKey}:${f.artifact.id}`, limit: 180, windowMs: 60_000 }]) assert.ok(hits.some((seen) => JSON.stringify(seen) === JSON.stringify(hit)), hit.key);
  hits.length = 0;
  const owner = await f.direct(f.artifact.id);
  const own = startedId(await startUpload(f, owner, "docs", "doc", "a.pdf", 5));
  assert.equal((await putPart(f, owner, own, 1, new Uint8Array(5))).status, 200);
  assert.equal(hits.some((hit) => hit.key.startsWith("runtime-ip:files-")), false);
  for (let i = 0; i < 20; i++) await f.run(limiter.hit(`files-start:${actorKey}:${f.folder.id}`, { limit: 20, windowMs: hour }));
  const limited = await startUpload(f, visitor, "cvs", "cv", "b.pdf", 5);
  assert.deepEqual([limited.status, limited.body.error], [429, "rate-limited"]);
});
