// The console's estate surface (ADR 0024): the /app home with the sidebar tree, the folder and
// artefact panes, and their actions (create, publish, meta, rename, password, retired paths).
// Screen-level cases run through handleConsole with a synthetic ctx (the keys-screen harness
// shape) and assert the HTTP surface only — routing, CSRF, session-user scoping, audit — never
// the models, which carry their own suites. The end-to-end cases run through worker.fetch over
// the real D1 shim and the real models, because only there does "published via the console"
// have to equal "served at the public path".

import test from "node:test";
import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import { handleConsole } from "../src/console.js";
import worker from "../src/index.js";
import { openD1Shim, type TestDatabase } from "./db.js";
import { memoryBucket, rateLimitBinding, openAsVisitor, authoredDocument, openConsoleContext, type MemoryBucket, type TestConsoleContext } from "./doubles.js";
import { openStore, type AuditEntry, type User, type Store, type Session } from "../src/store.js";
import { openArtifacts, type Artifact, type Artifacts, type CreateArtifact, type PublishArtifact, type GatePayload } from "../src/artifacts.js";
import { openFolders, type Folder, type Folders, type CreateFolder } from "../src/folders.js";
import type { CurrentSession } from "../src/auth.js";
import type { CodeError } from "../src/types.js";
import type { ViewProps } from "../src/views.js";

const HTML = `<!doctype html><html lang="hr"><head><title>Probni artefakt</title></head><body><h1>Bok</h1></body></html>`;
const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });

// ---- screen level: synthetic ctx -----------------------------------------------

const OWN_FOLDER: Folder = { id: "f1", slug: "zelena-suma", nameSealed: "s", ownerId: "u-member", parentId: null, createdAt: "", updatedAt: "" };
const OWN_CHILD: Folder = { ...OWN_FOLDER, id: "f3", slug: "podmapa", parentId: "f1" };
const FOREIGN_FOLDER: Folder = { ...OWN_FOLDER, id: "f2", slug: "drugi", ownerId: "u-other" };
const OWN_ARTEFACT: Artifact = {
  id: "a1", ownerId: "u-member", folderId: "f1", slug: "izvjesce", lang: "hr", currentVersion: 1,
  titleSealed: "s", headerUi: true, verifier: null, wrapMaster: null, maxVersions: null,
  wrapPassword: { v: 1, ksalt: "", iter: 1, iv: "", ct: "", tag: "" },
  createdAt: "", updatedAt: "", deletedAt: null, purgedAt: null,
};
const FOREIGN_ARTEFACT: Artifact = { ...OWN_ARTEFACT, id: "a2", ownerId: "u-other", folderId: "f2", slug: "tudi", wrapPassword: null };
const MEMBER: User = {
  id: "u-member", email: "member@example.test", name: "Member", role: "member", status: "active",
  passwordHash: "{}", totpSecretSealed: null, totpSecretPendingSealed: null, passkeys: [],
  invitedBy: null, createdAt: "", lastLoginAt: null,
};
interface ModelOptions { empty?: boolean; createError?: CodeError }
interface AuditCall {
  actorType: string; actorId: unknown; action: string; options?: Pick<AuditEntry, "artifactId" | "detail">;
}

/** Recording overrides keep the real model contracts and describe lazy effects. */
function models(base: TestConsoleContext, { empty = false, createError }: ModelOptions = {}) {
  const calls = {
    foldersCreate: [] as CreateFolder[],
    foldersAlias: [] as Array<Parameters<Folders["alias"]>>,
    foldersRename: [] as Array<Parameters<Folders["rename"]>>,
    foldersSetName: [] as Array<Parameters<Folders["setName"]>>,
    foldersSetParent: [] as Array<Parameters<Folders["setParent"]>>,
    artifactsCreate: [] as CreateArtifact[],
    artifactsAlias: [] as Array<Parameters<Artifacts["alias"]>>,
    artifactsRename: [] as Array<Parameters<Artifacts["rename"]>>,
    setMeta: [] as Array<Parameters<Artifacts["setMeta"]>>,
    publish: [] as PublishArtifact[],
    setPassword: [] as Array<Parameters<Artifacts["setPassword"]>>,
    artifactsMoveTo: [] as Array<Parameters<Artifacts["moveTo"]>>,
  };
  const byFolderId: Record<string, Folder> = { f1: OWN_FOLDER, f3: OWN_CHILD, f2: FOREIGN_FOLDER };
  const byFolderSlug: Record<string, Folder> = { "zelena-suma": OWN_FOLDER, podmapa: OWN_CHILD, drugi: FOREIGN_FOLDER };
  const folders: Folders = {
    ...base.folders,
    all: () => Effect.succeed(empty ? [FOREIGN_FOLDER] : [OWN_FOLDER, OWN_CHILD, FOREIGN_FOLDER]),
    bySlug: slug => Effect.succeed(byFolderSlug[String(slug)] ?? null),
    byId: id => Effect.succeed(byFolderId[String(id)] ?? null),
    aliasesFor: () => Effect.succeed(["stara-mapa"]),
    name: folder => Effect.succeed(folder === OWN_FOLDER ? "Zelena šuma" : folder === OWN_CHILD ? "Podmapa" : "Drugi folder"),
    create: args => Effect.sync(() => {
      calls.foldersCreate.push(args);
      return { ...OWN_FOLDER, id: "f-new", slug: args.slug ?? null, ownerId: args.ownerId, parentId: args.parentId ?? null };
    }),
    alias: (path, folderId) => Effect.sync(() => { calls.foldersAlias.push([path, folderId]); return String(path); }),
    rename: (id, slug) => Effect.sync(() => { calls.foldersRename.push([id, slug]); return { ...OWN_FOLDER, id, slug: String(slug) }; }),
    setName: (id, name) => Effect.sync(() => { calls.foldersSetName.push([id, name]); return { ...OWN_FOLDER, id }; }),
    setParent: (id, parentId) => Effect.sync(() => { calls.foldersSetParent.push([id, parentId]); return { ...OWN_FOLDER, id, parentId }; }),
  };
  const byArtifactId: Record<string, Artifact> = { a1: OWN_ARTEFACT, a2: FOREIGN_ARTEFACT };
  const byArtifactSlug: Record<string, Artifact> = { izvjesce: OWN_ARTEFACT, tudi: FOREIGN_ARTEFACT };
  const artifacts: Artifacts = {
    ...base.artifacts,
    prepare: () => Effect.succeed({}),
    listByOwner: ownerId => Effect.succeed((empty ? [FOREIGN_ARTEFACT] : [OWN_ARTEFACT, FOREIGN_ARTEFACT]).filter(artifact => artifact.ownerId === ownerId)),
    listForEstate: (ownerId, folderIds) => Effect.succeed((empty ? [FOREIGN_ARTEFACT] : [OWN_ARTEFACT, FOREIGN_ARTEFACT])
      .filter(artifact => artifact.folderId ? folderIds.includes(artifact.folderId) : artifact.ownerId === ownerId)),
    listByFolder: folderId => Effect.succeed(folderId === "f1" && !empty ? [OWN_ARTEFACT] : []),
    title: artifact => Effect.succeed(artifact === OWN_ARTEFACT ? "Izvješće za 2025" : "Tuđi izvještaj"),
    bySlug: slug => Effect.succeed(byArtifactSlug[String(slug)] ?? null),
    byId: id => Effect.succeed(byArtifactId[String(id)] ?? null),
    aliasesFor: () => Effect.succeed(["stari/izvjesec", "jos-stariji"]),
    versions: () => Effect.succeed([{
      artifactId: "a1", version: 1, size: HTML.length, authorType: "user", authorId: MEMBER.id,
      r2Key: "art/a1/1.enc", sha256: "", note: null, createdAt: "2026-09-10T10:00:00.000Z",
      type: "site", themeScope: null, themeId: null, themeSlug: null, themeOverridesSealed: null, brandLock: false,
    }]),
    create: args => Effect.gen(function* () {
      calls.artifactsCreate.push(args);
      if (createError) return yield* Effect.fail(createError);
      return { ...OWN_ARTEFACT, id: "a-new", slug: args.slug ?? null, ownerId: args.ownerId, folderId: args.folderId ?? null };
    }),
    alias: (path, artifactId) => Effect.sync(() => { calls.artifactsAlias.push([path, artifactId]); return String(path); }),
    rename: (id, slug) => Effect.sync(() => { calls.artifactsRename.push([id, slug]); return { ...OWN_ARTEFACT, id, slug: String(slug) }; }),
    setMeta: (id, meta) => Effect.sync(() => { calls.setMeta.push([id, meta]); return { ...OWN_ARTEFACT, id }; }),
    publish: args => Effect.sync(() => { calls.publish.push(args); return { version: 2, size: HTML.length, createdAt: "", warnings: [] }; }),
    setPassword: (id, password) => Effect.sync(() => { calls.setPassword.push([id, password]); return { ...OWN_ARTEFACT, id }; }),
    moveTo: (id, folderId) => Effect.sync(() => { calls.artifactsMoveTo.push([id, folderId]); return { ...OWN_ARTEFACT, id, folderId }; }),
  };
  return { calls, folders, artifacts };
}

function harness(options: ModelOptions = {}) {
  const base = openConsoleContext();
  const model = models(base, options);
  const audits: AuditCall[] = [];
  const active: CurrentSession = {
    session: { id: "session", userId: MEMBER.id, csrf: "csrf", pending2fa: false, createdAt: "", expiresAt: "" },
    user: MEMBER,
  };
  const ctx: TestConsoleContext = {
    ...base,
    auth: {
      ...base.auth,
      currentSession: () => Effect.succeed(active),
      audit: (actorType, actorId, action, auditOptions) => Effect.sync(() => { audits.push({ actorType, actorId, action, options: auditOptions }); }),
    },
    store: { ...base.store, users: { ...base.store.users, byId: () => Effect.succeed(active.user) } },
    folders: model.folders,
    artifacts: model.artifacts,
    access: {
      ...base.access,
      foldersFor: userId => Effect.map(model.folders.all(), folders => folders.filter(folder => folder.ownerId === userId)),
      role: (userId, folderId) => Effect.map(model.folders.byId(folderId), folder => folder?.ownerId === userId ? "owner" as const : null),
      may: (userId, subject) => Effect.succeed(subject?.ownerId === userId),
      grants: () => Effect.succeed([]),
    },
    shares: { ...base.shares, listFor: () => Effect.succeed([]) },
    analytics: { ...base.analytics, summary: () => Effect.succeed({
      totals: { opens: 0, activeSeconds: 0, scroll25: 0, scroll50: 0, scroll75: 0, scroll100: 0 }, shares: [], days: [],
    }) },
  };
  const request = (path: string, init: RequestInit = {}) =>
    Effect.runPromise(handleConsole(new Request(`https://example.test${path}`, { headers: { cookie: "wsa_session=session" }, ...init }), ctx,
      { area: "app", rest: path.replace(/^\/app\/?/, "") }));
  const post = (path: string, fields: Record<string, string>) => request(path, {
    method: "POST",
    headers: { cookie: "wsa_session=session", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { ctx, audits, calls: model.calls, request, post };
}

test("the /app home is the estate: the tree lists the user's own, and no one else's", async () => {
  const { request } = harness();
  const response = await request("/app");
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.doesNotMatch(page, /Drugi/);                            // another user's folder, absent
  assert.doesNotMatch(page, /Tuđi/);                             // another user's artefact, absent
});


test("a pane for someone else's estate is a flat 404 — no oracle", async () => {
  const { request } = harness();
  assert.equal((await request("/app/f/drugi")).status, 404);
  assert.equal((await request("/app/a/tudi")).status, 404);
  assert.equal((await request("/app/a/nema-me")).status, 404);
});

test("create publishes into an owned folder with a two-character password, as the session user", async () => {
  const { calls, audits, post } = harness();
  const response = await post("/app/new", {
    csrf: "csrf", folder: "zelena-suma",
    title: "Izvješće za 2025", slug: "izvjesce-2025", lang: "hr",
    html: HTML, password: "ws",
    retiredPaths: "a1b2c3d4e5f60718/9f8e7d6c5b4a3928\n\n  single  ",
  });
  assert.equal(response.status, 303);                            // PRG to the new artefact's pane
  assert.equal(response.headers.get("location"), "/app/a/izvjesce-2025");
  assert.equal(calls.artifactsCreate[0].ownerId, "u-member");
  assert.equal(calls.artifactsCreate[0].authorId, "u-member");
  assert.deepEqual(calls.artifactsAlias, [                       // blank lines dropped, whitespace trimmed
    ["a1b2c3d4e5f60718/9f8e7d6c5b4a3928", "a-new"],
    ["single", "a-new"],
  ]);
  assert.deepEqual(audits.map((a) => a.action), ["artifact.create", "artifact.alias", "artifact.alias"]);
  assert.ok(audits.every((a) => a.actorType === "user" && a.actorId === "u-member"));
});

test("create can found a new folder on the fly, audited as folder.create", async () => {
  const { calls, audits, post } = harness();
  const response = await post("/app/new", {
    csrf: "csrf", newFolder: "Zelena šuma", newFolderSlug: "zelena-suma",
    title: "Izvješće", slug: "izvjesce", lang: "hr", html: HTML,
  });
  assert.equal(response.status, 303);
  assert.deepEqual(calls.foldersCreate, [{ ownerId: "u-member", name: "Zelena šuma", slug: "zelena-suma" }]);
  assert.equal(calls.artifactsCreate[0].folderId, "f-new");      // published into the folder just founded
  assert.equal(calls.artifactsCreate[0].password, "");           // blank password = secret-link only
  assert.deepEqual(audits.map((a) => a.action), ["folder.create", "artifact.create"]);
});

test("an unknown or missing folder cannot create an artefact", async () => {
  const { calls, post } = harness();
  const response = await post("/app/new", {
    csrf: "csrf", folder: "nema-me", title: "T", slug: "s", lang: "en", html: HTML,
  });
  assert.equal(response.status, 404);
  assert.deepEqual(calls.artifactsCreate, []);
  assert.deepEqual(calls.foldersCreate, []);

  const neither = await post("/app/new", { csrf: "csrf", title: "T", slug: "s", html: HTML });
  assert.equal(neither.status, 400);                             // neither a folder nor a new-folder name
  assert.deepEqual(calls.artifactsCreate, []);
});

test("another user's folder is a flat 404 — never created into, never named", async () => {
  const { calls, post } = harness();
  const response = await post("/app/new", {
    csrf: "csrf", folder: "drugi", title: "T", slug: "s", lang: "en", html: HTML,
  });
  assert.equal(response.status, 404);
  assert.deepEqual(calls.artifactsCreate, []);
});

test("a taken slug refuses publication", async () => {
  const { calls, post } = harness({ createError: coded("slug-taken", "that slug is already in use") });
  const response = await post("/app/new", {
    csrf: "csrf", folder: "zelena-suma",
    title: "Izvješće", slug: "zauzeto", lang: "hr", html: HTML,
  });
  assert.equal(response.status, 409);
  assert.equal(calls.artifactsCreate.length, 1);                 // asked once, refused — nothing landed
});

test("a malformed retired path is refused before anything is written", async () => {
  const { calls, post } = harness();
  const response = await post("/app/new", {
    csrf: "csrf", newFolder: "F", title: "T", slug: "s", html: HTML, retiredPaths: "a/b/c",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(calls.foldersCreate, []);
  assert.deepEqual(calls.artifactsCreate, []);
  assert.deepEqual(calls.artifactsAlias, []);
});

test("the artefact pane's alias action records each path and audits it", async () => {
  const { calls, audits, post } = harness();
  const response = await post("/app/a/izvjesce/alias", { csrf: "csrf", paths: "old/tok1\nold/tok2" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.artifactsAlias, [["old/tok1", "a1"], ["old/tok2", "a1"]]);
  assert.deepEqual(audits.map((a) => a.action), ["artifact.alias", "artifact.alias"]);
});

test("the folder pane's actions: name, rename (PRG to the new path) and alias", async () => {
  const { calls, audits, post } = harness();
  const named = await post("/app/f/zelena-suma/name", { csrf: "csrf", name: "ZS" });
  assert.equal(named.status, 200);
  assert.deepEqual(calls.foldersSetName, [["f1", "ZS"]]);

  const renamed = await post("/app/f/zelena-suma/rename", { csrf: "csrf", slug: "zs" });
  assert.equal(renamed.status, 303);
  assert.equal(renamed.headers.get("location"), "/app/f/zs");
  assert.deepEqual(calls.foldersRename, [["f1", "zs"]]);

  const aliased = await post("/app/f/zelena-suma/alias", { csrf: "csrf", paths: "9f8e7d6c5b4a39281706" });
  assert.equal(aliased.status, 200);
  assert.deepEqual(calls.foldersAlias, [["9f8e7d6c5b4a39281706", "f1"]]);
  assert.equal(audits.at(-1)?.action, "folder.alias");
});

test("a pane action on a foreign artefact or folder is a 404, recording nothing", async () => {
  const { calls, post } = harness();
  assert.equal((await post("/app/a/tudi/alias", { csrf: "csrf", paths: "old/tok" })).status, 404);
  assert.equal((await post("/app/f/drugi/alias", { csrf: "csrf", paths: "old/tok" })).status, 404);
  assert.equal((await post("/app/a/nema-me/alias", { csrf: "csrf", paths: "old/tok" })).status, 404);
  assert.deepEqual(calls.artifactsAlias, []);
  assert.deepEqual(calls.foldersAlias, []);
});

test("the password action sets a short password and clears the gate through the model", async () => {
  const { calls, audits, post } = harness();
  const set = await post("/app/a/izvjesce/password", { csrf: "csrf", password: "ab" });
  assert.equal(set.status, 200);
  assert.deepEqual(calls.setPassword, [["a1", "ab"]]);           // two characters, accepted as-is

  const cleared = await post("/app/a/izvjesce/password", { csrf: "csrf", clear: "1" });
  assert.equal(cleared.status, 200);
  assert.deepEqual(calls.setPassword, [["a1", "ab"], ["a1", null]]);
  assert.equal(audits.at(-1)?.action, "artifact.password");

  const empty = await post("/app/a/izvjesce/password", { csrf: "csrf" });
  assert.equal(empty.status, 400);                               // neither a password nor the clear box
  assert.equal(calls.setPassword.length, 2);
});

test("the publish action ships a new version through the model, with its note", async () => {
  const { calls, audits, post } = harness();
  const response = await post("/app/a/izvjesce/publish", { csrf: "csrf", html: HTML, note: "prosinac" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.publish, [{ artifactId: "a1", html: HTML, authorType: "user", authorId: "u-member", note: "prosinac" }]);
  assert.equal(audits.at(-1)?.action, "artifact.publish");
});

test("a wrong CSRF token is refused with 403 and nothing reaches the models", async () => {
  const { calls, post } = harness();
  const attempts: Array<[string, Record<string, string>]> = [
    ["/app/new", { folder: "zelena-suma", title: "T", slug: "s", lang: "en", html: HTML }],
    ["/app/a/izvjesce/alias", { paths: "old/tok" }],
    ["/app/a/izvjesce/password", { password: "ws" }],
    ["/app/a/izvjesce/publish", { html: HTML }],
    ["/app/f/zelena-suma/alias", { paths: "old/tok" }],
  ];
  for (const [path, fields] of attempts) {
    const response = await post(path, { csrf: "wrong", ...fields });
    assert.equal(response.status, 403, path);
  }
  assert.deepEqual(calls, {
    foldersCreate: [], foldersAlias: [], foldersRename: [], foldersSetName: [], foldersSetParent: [],
    artifactsCreate: [], artifactsAlias: [], artifactsRename: [], setMeta: [], publish: [], setPassword: [], artifactsMoveTo: [],
  });
});


test("the folder + menu's subfolder action creates a nested folder, audited", async () => {
  const { calls, audits, post } = harness();
  const response = await post("/app/f/zelena-suma/subfolder", { csrf: "csrf", name: "Podmapa" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/app/f/f-new");    // id until named
  assert.deepEqual(calls.foldersCreate, [{ ownerId: "u-member", name: "Podmapa", parentId: "f1" }]);
  assert.deepEqual(audits.map((a) => a.action), ["folder.create"]);
});

test("the folder move action re-parents through the model, by form or by JSON", async () => {
  const { calls, post, request } = harness();
  const form = await post("/app/f/podmapa/move", { csrf: "csrf", parent: "root" });
  assert.equal(form.status, 200);
  assert.deepEqual(calls.foldersSetParent, [["f3", null]]);          // root = null parent

  const json = await request("/app/f/podmapa/move", {
    method: "POST",
    headers: { cookie: "wsa_session=session", "content-type": "application/json" },
    body: JSON.stringify({ csrf: "csrf", parent: "zelena-suma" }),
  });
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), { ok: true });
  assert.deepEqual(calls.foldersSetParent, [["f3", null], ["f3", "f1"]]);

  const foreign = await post("/app/f/podmapa/move", { csrf: "csrf", parent: "drugi" });
  assert.equal(foreign.status, 404);                                 // another user's folder is a miss
  assert.equal(calls.foldersSetParent.length, 2);
});

test("JSON mutation bodies must be objects before any write is attempted", async () => {
  const { request, calls } = harness();
  for (const body of ["null", "[]", "5", "{"]) {
    const response = await request("/app/a/izvjesce/move", {
      method: "POST",
      headers: { cookie: "wsa_session=session", "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    const payload: unknown = await response.json();
    assert.ok(payload !== null && typeof payload === "object" && "error" in payload);
    assert.ok(payload.error !== null && typeof payload.error === "object" && "code" in payload.error);
    assert.equal(payload.error.code, "bad-json");
  }
  assert.deepEqual(calls.artifactsMoveTo, []);
});

test("the artefact move action re-files through the model, form or JSON", async () => {
  const { calls, audits, post, request } = harness();
  const form = await post("/app/a/izvjesce/move", { csrf: "csrf", folder: "podmapa" });
  assert.equal(form.status, 200);
  assert.deepEqual(calls.artifactsMoveTo, [["a1", "f3"]]);
  assert.equal(audits.at(-1)?.action, "artifact.move");

  const json = await request("/app/a/izvjesce/move", {
    method: "POST",
    headers: { cookie: "wsa_session=session", "content-type": "application/json" },
    body: JSON.stringify({ csrf: "csrf", folder: "f1" }),
  });
  assert.deepEqual(await json.json(), { ok: true });
  assert.deepEqual(calls.artifactsMoveTo, [["a1", "f3"], ["a1", "f1"]]);

  const foreign = await post("/app/a/izvjesce/move", { csrf: "csrf", folder: "drugi" });
  assert.equal(foreign.status, 404);
  assert.equal(calls.artifactsMoveTo.length, 2);
});

// ---- end to end: the real D1 shim, the real models, worker.fetch ----------------

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
interface ScreenEnvironment {
  db: TestDatabase; store: Store; bucket: MemoryBucket; owner: User; other: User; session: Session;
  artifacts: Artifacts; folders: Folders;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, fields: Record<string, string>): Promise<Response>;
  signed: { headers: { cookie: string } };
}

/** One Worker environment over a fresh migrated D1, R2 double and RateLimit DO, plus a
 *  signed-in owner session so the console routes can be driven through worker.fetch. */
async function environment(): Promise<ScreenEnvironment> {
  const DB = openD1Shim();
  const store = openStore(DB);
  const bucket = memoryBucket();
  const limiter = rateLimitBinding();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const other = await Effect.runPromise(store.users.create({
    id: "other0000000b2", email: "other@example.test", name: "Other", role: "member", passwordHash: "{}",
  }));
  const session = await Effect.runPromise(store.sessions.create(owner.id, { csrf: "csrf" }));
  const env = {
    DB, ARTIFACTS: bucket, ARTEFACTS_MASTER_KEY: MASTER, RATELIMIT: limiter,
  };
  return {
    db: DB, store, bucket, owner, other, session,
    artifacts: openArtifacts({ db: DB, bucket, masterKeyHex: MASTER, settings: store.settings }),
    folders: openFolders({ db: DB, masterKeyHex: MASTER }),
    fetch: (path, init) => worker.fetch(new Request(`https://example.test${path}`, init), env),
    post: (path, fields) => worker.fetch(new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { cookie: `wsa_session=${session.id}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }), env),
    signed: { headers: { cookie: `wsa_session=${session.id}` } },
  };
}

async function bootstrapResponse(response: Response) {
  const html = await response.text();
  const data = html.match(/<script id="ws-bootstrap" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(data);
  return JSON.parse(data) as { screen: string; props: ViewProps };
}

test("settings can omit an existing same-user estate, but direct, different-user and mutation responses are fresh", async t => {
  const env = await environment();
  t.after(() => env.db.close());
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Settings sidebar" }));
  const prepare = env.db.prepare.bind(env.db);
  let artifactReads = 0;
  env.db.prepare = sql => {
    if (/SELECT[\s\S]*FROM artifacts\b/i.test(sql)) artifactReads++;
    return prepare(sql);
  };
  const partial = await bootstrapResponse(await env.fetch("/settings", {
    headers: { ...env.signed.headers, "X-WS-Console-Estate": env.owner.id },
  }));
  assert.equal(partial.screen, "settings");
  assert.equal(partial.props.me?.id, env.owner.id);
  assert.equal(partial.props.estateOmitted, true);
  assert.equal(partial.props.estate, undefined);
  assert.equal(artifactReads, 0);
  for (const headers of [env.signed.headers, { ...env.signed.headers, "X-WS-Console-Estate": env.other.id }]) {
    const fresh = await bootstrapResponse(await env.fetch("/settings", { headers }));
    assert.equal(fresh.props.estateOmitted, undefined);
    assert.equal(fresh.props.estate?.mine[0]?.id, folder.id);
  }
  const failedMutation = await bootstrapResponse(await env.fetch("/settings/profile", {
    method: "POST",
    headers: { ...env.signed.headers, "X-WS-Console-Estate": env.owner.id, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "csrf", name: "" }),
  }));
  assert.ok(failedMutation.props.error);
  assert.equal(failedMutation.props.estateOmitted, undefined);
  assert.equal(failedMutation.props.estate?.mine[0]?.id, folder.id);
  const minted = await bootstrapResponse(await env.fetch("/settings/keys/mint", {
    method: "POST",
    headers: { ...env.signed.headers, "X-WS-Console-Estate": env.owner.id, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "csrf", kind: "master" }),
  }));
  assert.ok(minted.props.secret);
  assert.equal(minted.props.estateOmitted, undefined);
  assert.equal(minted.props.estate?.mine[0]?.id, folder.id);
  const keys = await bootstrapResponse(await env.fetch("/settings/keys", {
    headers: { ...env.signed.headers, "X-WS-Console-Estate": env.owner.id },
  }));
  assert.equal(keys.props.secret, undefined);
  assert.equal(keys.props.estateOmitted, true);
  assert.equal(keys.props.estate, undefined);
  assert.equal(keys.props.keys?.length, 1);
  const signedOut = await env.fetch("/settings", { headers: { "X-WS-Console-Estate": env.owner.id } });
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.headers.get("location"), "/login");
});

test("bulk estate stays live and private across nested grants, unfiled, tombstones and more than 100 folders", async t => {
  const ctx = openConsoleContext();
  t.after(() => ctx.db.close());
  const own = await Effect.runPromise(ctx.store.users.create({ id: "bulk-owner", email: "bulk@example.test", role: "owner", passwordHash: "{}" }));
  const other = await Effect.runPromise(ctx.store.users.create({ id: "bulk-other", email: "other@example.test", role: "member", passwordHash: "{}" }));
  const session = await Effect.runPromise(ctx.store.sessions.create(own.id, { csrf: "csrf" }));
  const owned = await Effect.runPromise(ctx.folders.create({ ownerId: own.id, name: "Owned" }));
  for (let i = 0; i < 101; i++) {
    await Effect.runPromise(ctx.folders.create({ ownerId: own.id, name: `Empty ${i}` }));
  }
  const shared = await Effect.runPromise(ctx.folders.create({ ownerId: other.id, name: "Shared" }));
  const child = await Effect.runPromise(ctx.folders.create({ ownerId: other.id, name: "Child", parentId: shared.id }));
  const hidden = await Effect.runPromise(ctx.folders.create({ ownerId: other.id, name: "Hidden" }));
  await Effect.runPromise(ctx.access.grant({ actorId: other.id, folderId: shared.id, userId: own.id, role: "viewer" }));
  await Effect.runPromise(ctx.access.grant({ actorId: other.id, folderId: child.id, userId: own.id, role: "editor" }));
  const publish = (ownerId: string, title: string, folderId?: string) =>
    Effect.runPromise(ctx.artifacts.create({ ownerId, title, folderId, html: HTML, authorId: ownerId }));
  const ownArtifact = await publish(own.id, "Owned document", owned.id);
  const sharedArtifact = await publish(other.id, "Shared document", shared.id);
  const childArtifact = await publish(other.id, "Child document", child.id);
  const unfiled = await publish(own.id, "Unfiled document");
  const hiddenArtifact = await publish(other.id, "Hidden document", hidden.id);
  const foreignUnfiled = await publish(other.id, "Foreign unfiled");
  const removed = await publish(own.id, "Deleted document", owned.id);
  await Effect.runPromise(ctx.artifacts.remove(removed.id, { authorId: own.id }));
  const draft = await publish(own.id, "Draft document", owned.id);
  await ctx.db.prepare("UPDATE artifacts SET current_version = 0 WHERE id = ?").bind(draft.id).run();
  const prepare = ctx.db.prepare.bind(ctx.db);
  let artifactReads = 0;
  ctx.db.prepare = sql => {
    if (/SELECT[\s\S]*FROM artifacts\b/i.test(sql)) artifactReads++;
    return prepare(sql);
  };
  const load = async () => bootstrapResponse(await Effect.runPromise(handleConsole(
    new Request("https://example.test/app", { headers: { cookie: `wsa_session=${session.id}` } }), ctx, { area: "app", rest: "" },
  )));
  const initial = (await load()).props.estate;
  assert.ok(initial);
  assert.equal(artifactReads, 1);
  assert.equal(initial.mine.length, 102);
  assert.deepEqual(initial.mine.find(folder => folder.id === owned.id)?.artefacts.map(artifact => artifact.id), [ownArtifact.id]);
  assert.deepEqual(initial.unfiled.map(artifact => artifact.id), [unfiled.id]);
  assert.equal(initial.shared[0]?.role, "viewer");
  assert.deepEqual(initial.shared[0]?.artefacts.map(artifact => artifact.id), [sharedArtifact.id]);
  assert.equal(initial.shared[0]?.children[0]?.role, "editor");
  assert.deepEqual(initial.shared[0]?.children[0]?.artefacts.map(artifact => artifact.id), [childArtifact.id]);
  for (const id of [hiddenArtifact.id, foreignUnfiled.id, removed.id, draft.id]) assert.equal(JSON.stringify(initial).includes(id), false);
  await Effect.runPromise(ctx.access.revoke({ actorId: other.id, folderId: shared.id, userId: own.id }));
  const floated = (await load()).props.estate;
  assert.equal(floated?.shared[0]?.id, child.id);
  assert.equal(floated?.shared[0]?.role, "editor");
  assert.equal(JSON.stringify(floated).includes(sharedArtifact.id), false);
  await Effect.runPromise(ctx.access.revoke({ actorId: other.id, folderId: child.id, userId: own.id }));
  assert.deepEqual((await load()).props.estate?.shared, []);
});

const gate = (password: string, ip = "203.0.113.7"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", Origin: "https://example.test", "CF-Connecting-IP": ip },
  body: JSON.stringify({ password }),
});

async function loadPublicDocument(env: Pick<ScreenEnvironment, "fetch" | "signed">, path: string) {
  const response = await env.fetch("/_runtime/load", {
    method: "POST",
    headers: { ...env.signed.headers, Origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ source: { kind: "public", path } }),
  });
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  assert.ok(payload !== null && typeof payload === "object" && "html" in payload && typeof payload.html === "string");
  return authoredDocument(payload.html);
}

test("end to end: empty folders are owned by the signed-in creator and reject invalid creation", async () => {
  const env = await environment();
  const blank = await env.post("/app/folders/new", { csrf: "csrf", name: "  " });
  assert.equal(blank.status, 400);
  const forged = await env.post("/app/folders/new", { csrf: "wrong", name: "Clients" });
  assert.equal(forged.status, 403);
  assert.deepEqual(await Effect.runPromise(env.folders.all()), []);

  const created = await env.post("/app/folders/new", { csrf: "csrf", name: "  Clients  ", ownerId: env.other.id });
  assert.equal(created.status, 303);
  const location = created.headers.get("location");
  assert.ok(location);
  const ref = location.split("/").pop();
  const folder = await Effect.runPromise(env.folders.byId(ref));
  assert.ok(folder);
  assert.equal(folder.ownerId, env.owner.id);
  assert.equal(folder.parentId, null);
  assert.equal(await Effect.runPromise(env.folders.name(folder)), "Clients");
  assert.equal(env.db.prepare("SELECT COUNT(*) AS total FROM artifacts").first<{ total: number }>()?.total, 0);
  assert.equal((await env.fetch(`/app/f/${ref}`, env.signed)).status, 200);

  const otherSession = await Effect.runPromise(env.store.sessions.create(env.other.id));
  const forbidden = await env.fetch(`/app/f/${ref}`, { headers: { cookie: `wsa_session=${otherSession.id}` } });
  assert.equal(forbidden.status, 404);
  const audit = env.db.prepare("SELECT actor_type, actor_id FROM audit_log WHERE action = 'folder.create'").all<{ actor_type: string; actor_id: string }>();
  assert.deepEqual(audit.results.map(row => ({ ...row })), [{ actor_type: "user", actor_id: env.owner.id }]);
});

test("end to end: a two-character password, a live private path, and a retired 1.x link", async () => {
  const env = await environment();
  const legacy = "e04c7f2f37b107607dbc/a55317c6d4a5a33d514e";
  const created = await env.post("/app/new", {
    csrf: "csrf",
    newFolder: "Zelena šuma", newFolderSlug: "zelena-suma",
    title: "Izvješće za 2025", slug: "izvjesce-2025", lang: "hr",
    html: HTML, password: "ws",
    retiredPaths: `\n  ${legacy}  \n\n`,                         // blank lines and padding are ignored
  });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/app/a/izvjesce-2025");

  // The signed-in estate remains available after publication.
  const home = await env.fetch("/app", env.signed);
  assert.equal(home.status, 200);

  // The signed-in owner reaches the private path and its additional password gate.
  const gatePage = await env.fetch("/izvjesce-2025/", env.signed);
  assert.equal(gatePage.status, 200);
  const body = await gatePage.text();
  assert.equal(body.includes("<h1>Bok</h1>"), false);            // the document is not in the page
  const opened = await env.fetch("/_gate/izvjesce-2025", {
    ...gate("ws"), headers: { ...env.signed.headers, "content-type": "application/json", Origin: "https://example.test" },
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json() as GatePayload, "ws")), HTML);

  // The retired 1.x link resolves to the artefact — not the front door.
  const legacyPage = await env.fetch(`/${legacy}/`, env.signed);
  assert.equal(legacyPage.status, 200);

  // Another user's estate never appears on the owner's screen.
  const foreignFolder = await Effect.runPromise(env.folders.create({ ownerId: env.other.id, name: "Drugi folder" }));
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.other.id, folderId: foreignFolder.id, title: "Tuđi izvještaj",
    html: HTML, slug: "tudi-izvjestaj", authorId: env.other.id,
  }));
  const after = await (await env.fetch("/app", env.signed)).text();
  assert.equal(after.includes("Tuđi izvještaj"), false);
  assert.equal(after.includes("Drugi folder"), false);

  // Every mutation left its audit row, as the session user.
  const rows = env.db.prepare("SELECT actor_type, actor_id, action FROM audit_log").all<{ actor_type: string; actor_id: string; action: string }>();
  const actions = rows.results.map((r) => r.action);
  for (const action of ["folder.create", "artifact.create", "artifact.alias"]) {
    assert.ok(actions.includes(action), `expected an ${action} audit row`);
  }
  assert.ok(rows.results.filter((r) => r.action === "artifact.create")
    .every((r) => r.actor_type === "user" && r.actor_id === env.owner.id));
});

test("end to end: the password action re-keys the gate, and clearing it keeps the document private", async () => {
  const env = await environment();
  await env.post("/app/new", {
    csrf: "csrf", newFolder: "F", title: "T", slug: "doc", lang: "en", html: HTML, password: "ws",
  });

  const set = await env.post("/app/a/doc/password", { csrf: "csrf", password: "ab" });
  assert.equal(set.status, 200);
  const gated = await Effect.runPromise(env.artifacts.byPath("doc"));
  assert.equal(await Effect.runPromise(env.artifacts.verifyPassword(gated, "ab")), true);   // verified through the model
  assert.equal(await Effect.runPromise(env.artifacts.verifyPassword(gated, "ws")), false);  // the old password is gone

  const clear = await env.post("/app/a/doc/password", { csrf: "csrf", clear: "1" });
  assert.equal(clear.status, 200);
  const ungated = await Effect.runPromise(env.artifacts.byPath("doc"));
  assert.equal(env.artifacts.gated(ungated), false);
  assert.equal(await loadPublicDocument(env, "doc"), HTML);
  const anonymous = await env.fetch("/_runtime/load", {
    method: "POST", headers: { Origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ source: { kind: "public", path: "doc" } }),
  });
  assert.equal(anonymous.status, 403);
});

test("end to end: the create route accepts a real artefact body and refuses past 2 MiB", async () => {
  const env = await environment();
  // ~120 KiB — past the console's 64 KiB default, well under the contract's 1.5 MiB.
  const big = `<!doctype html><html lang="en"><head><title>Big</title></head><body>${"<p>pad</p>".repeat(12000)}</body></html>`;
  const ok = await env.post("/app/new", {
    csrf: "csrf", newFolder: "F", title: "Big", slug: "big", lang: "en", html: big,
  });
  assert.equal(ok.status, 303);
  assert.equal(await loadPublicDocument(env, "big"), big);

  const refused = await env.post("/app/new", {
    csrf: "csrf", newFolder: "F", title: "Huge", slug: "huge", lang: "en", html: "x".repeat(2 * 1024 * 1024 + 64),
  });
  assert.equal(refused.status, 413);
});

test("end to end: a reserved console name is refused on every creation path (ADR 0024)", async () => {
  const env = await environment();
  // A folder slug (the folder is refused before it exists).
  const folder = await env.post("/app/new", {
    csrf: "csrf", newFolder: "G", newFolderSlug: "settings", title: "T", slug: "dok", lang: "en", html: HTML,
  });
  assert.equal(folder.status, 409);
  assert.equal(await Effect.runPromise(env.folders.bySlug("settings")), null);
  // A real folder and artefact to work against.
  const made = await env.post("/app/new", {
    csrf: "csrf", newFolder: "F", newFolderSlug: "mapa", title: "T", slug: "dok", lang: "en", html: HTML,
  });
  assert.equal(made.status, 303);
  // An artefact slug.
  const artefact = await env.post("/app/new", {
    csrf: "csrf", folder: "mapa", title: "T2", slug: "login", lang: "en", html: HTML,
  });
  assert.equal(artefact.status, 409);
  // And a retired path — one shared rule in pathTaken, three doors that all stay shut.
  const aliased = await env.post("/app/a/dok/alias", { csrf: "csrf", paths: "admin" });
  assert.equal(aliased.status, 409);
  // ...while an ordinary name keeps working.
  const fine = await env.post("/app/new", { csrf: "csrf", folder: "mapa", title: "T3", slug: "obican", lang: "en", html: HTML });
  assert.equal(fine.status, 303);
});

test("end to end: the legacy console URLs redirect permanently, invite links included", async () => {
  const env = await environment();
  const cases: Array<[string, string]> = [
    ["/_auth/login", "/login"],
    ["/_auth/register", "/register"],
    [`/_auth/accept/${"a".repeat(48)}`, `/invite/${"a".repeat(48)}`],
    ["/_admin", "/app"],
    ["/_admin/artefacts", "/app"],
    ["/_admin/users", "/admin/users"],
    ["/_admin/settings", "/admin/settings"],
    ["/_admin/keys", "/settings/keys"],
    ["/_admin/account", "/settings"],
  ];
  for (const [from, to] of cases) {
    const response = await env.fetch(from, { redirect: "manual" });
    assert.equal(response.status, 301, from);
    assert.equal(response.headers.get("location"), to, from);
  }
});

test("end to end: the public root redirects visitors and signed-in owners to /login", async () => {
  const env = await environment();
  for (const options of [undefined, env.signed]) {
    const home = await env.fetch("/", options);
    assert.equal(home.status, 302);
    assert.equal(home.headers.get("location"), "/login");
  }

  const login = await env.fetch("/login");
  assert.equal(login.status, 200);
});

test("end to end: a member never reaches the platform area", async () => {
  const env = await environment();
  const memberSession = await Effect.runPromise(env.store.sessions.create(env.other.id, { csrf: "csrf" }));
  const signed = { headers: { cookie: `wsa_session=${memberSession.id}` } };
  for (const path of ["/admin", "/admin/users", "/admin/settings"]) {
    const response = await env.fetch(path, signed);
    assert.equal(response.status, 403, path);
  }
  const mutate = await env.fetch("/admin/users/role", {
    method: "POST",
    headers: { cookie: `wsa_session=${memberSession.id}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "csrf", userId: env.other.id, role: "admin" }),
  });
  assert.equal(mutate.status, 403);
});

test("end to end: subfolders, moves and the cycle guard — public paths never change", async () => {
  const env = await environment();
  const made = await env.post("/app/new", {
    csrf: "csrf", newFolder: "A", newFolderSlug: "mapa-a", title: "Dok", slug: "dok", lang: "en", html: HTML,
  });
  assert.equal(made.status, 303);
  const folderA = await Effect.runPromise(env.folders.bySlug("mapa-a"));
  assert.ok(folderA);

  // The tree's + menu founds a subfolder; it answers on its id until named.
  const sub = await env.post("/app/f/mapa-a/subfolder", { csrf: "csrf", name: "Podmapa B" });
  assert.equal(sub.status, 303);
  const folderB = (await Effect.runPromise(env.folders.all())).find((f) => f.parentId === folderA.id);
  assert.ok(folderB, "the subfolder exists under A");
  assert.equal(sub.headers.get("location"), `/app/f/${folderB.id}`);

  // The artefact moves into the subfolder by form, and back by JSON (the drag-and-drop path).
  const move = await env.post("/app/a/dok/move", { csrf: "csrf", folder: folderB.id });
  assert.equal(move.status, 200);
  const moved = await Effect.runPromise(env.artifacts.bySlug("dok"));
  assert.ok(moved);
  assert.equal(moved.folderId, folderB.id);
  const back = await env.fetch(`/app/a/dok/move`, {
    method: "POST",
    headers: { cookie: `wsa_session=${env.session.id}`, "content-type": "application/json" },
    body: JSON.stringify({ csrf: "csrf", folder: "mapa-a" }),
  });
  assert.deepEqual(await back.json(), { ok: true });
  const returned = await Effect.runPromise(env.artifacts.bySlug("dok"));
  assert.ok(returned);
  assert.equal(returned.folderId, folderA.id);

  // The folder nests by drag-and-drop JSON, and the cycle guard refuses A under its own child.
  const nest = await env.fetch(`/app/f/mapa-a/move`, {
    method: "POST",
    headers: { cookie: `wsa_session=${env.session.id}`, "content-type": "application/json" },
    body: JSON.stringify({ csrf: "csrf", parent: folderB.id }),
  });
  assert.equal(nest.status, 400);                                  // folder-cycle
  const unchangedA = await Effect.runPromise(env.folders.byId(folderA.id));
  const unchangedB = await Effect.runPromise(env.folders.byId(folderB.id));
  assert.ok(unchangedA);
  assert.ok(unchangedB);
  assert.equal(unchangedA.parentId, null);
  assert.equal(unchangedB.parentId, folderA.id);

  // Every door shut, and the artefact still serves at the same public path.
  assert.equal(await loadPublicDocument(env, "dok"), HTML);
  assert.equal((await Effect.runPromise(env.folders.bySlug("mapa-a")))?.slug, "mapa-a");
  const audit = env.db.prepare("SELECT action FROM audit_log").all<{ action: string }>();
  const actions = audit.results.map((r) => r.action);
  assert.ok(actions.includes("artifact.move"));
});

test("a rejected document leaves no newly requested folder behind", async () => {
  const env = await environment();
  const response = await env.post("/app/new", {
    csrf: "csrf", newFolder: "Must not exist", newFolderSlug: "no-orphan",
    title: "Invalid document", slug: "invalid", html: "<p>Not a complete document</p>",
  });
  assert.equal(response.status, 422);
  assert.equal(await Effect.runPromise(env.folders.bySlug("no-orphan")), null);
  assert.equal(await Effect.runPromise(env.artifacts.bySlug("invalid")), null);
});

test("deletion requires explicit confirmation and records its outcome", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, html: HTML, slug: "delete-me", authorId: env.owner.id }));
  const refused = await env.post("/app/a/delete-me/delete", { csrf: "csrf" });
  assert.equal(refused.status, 400);
  assert.equal(env.artifacts.live(await Effect.runPromise(env.artifacts.byId(artifact.id))), true);
  const removed = await env.post("/app/a/delete-me/delete", { csrf: "csrf", confirm: "delete" });
  assert.equal(removed.status, 303);
  assert.equal(env.artifacts.live(await Effect.runPromise(env.artifacts.byId(artifact.id))), false);
  const audit = env.db.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'artifact.delete' AND artifact_id = ?").bind(artifact.id).first<{ actor_id: string; detail: string }>();
  assert.ok(audit);
  assert.equal(audit.actor_id, env.owner.id);
  assert.equal(JSON.parse(audit.detail).outcome, "purged");
});

test("a failed physical purge stays withdrawn and is audited", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, html: HTML, slug: "purge-failure", authorId: env.owner.id }));
  env.bucket.delete = async () => { throw new Error("R2 unavailable"); };
  const response = await env.post("/app/a/purge-failure/delete", { csrf: "csrf", confirm: "delete" });
  assert.equal(response.status, 503);
  const tombstone = await Effect.runPromise(env.artifacts.byId(artifact.id));
  assert.ok(tombstone);
  assert.equal(env.artifacts.live(tombstone), false);
  assert.equal(tombstone.purgedAt, null);
  const audit = env.db.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.delete' AND artifact_id = ?").bind(artifact.id).first<{ detail: string }>();
  assert.ok(audit);
  assert.equal(JSON.parse(audit.detail).outcome, "withdrawn");
});
