// Internal collaboration: folder grants (access.js), the key spine that reads them live
// (keys.js) and the API surface they open (api.js).
//
// These are boundary tests. Every one of them asks the same question from a different
// side — "does this reach stop the moment the grant does?" — because a grant model that is
// merely correct at the moment of granting is a model that leaks. The API cases build the
// handler context directly rather than going through the Worker entrypoint: this suite is
// about who may do what, not about how the runtime is assembled.

import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";
import { contract } from "../src/contract.js";
import { openRateLimiter } from "../src/ratelimit.js";

import { openD1Shim, type TestDatabase } from "./db.js";
import { memoryBucket, rateLimitBinding } from "./doubles.js";
import { openStore, type AuditRow, type User } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { openFolders } from "../src/folders.js";
import { openProjectData } from "../src/project-data.js";
import { openProjectFiles } from "../src/project-files.js";
import { openKeys } from "../src/keys.js";
import { openAccess, type EstateRole, type GrantInput } from "../src/access.js";
import { handleApi } from "../src/api.js";

interface ArtifactListResponse { artifacts: Array<{ slug: string | null }> }
interface FolderListResponse { folders: Array<{ slug: string | null; role: EstateRole | null; artifacts: number }> }
interface ApiFailureResponse { error: { code: string } }

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><meta charset="utf-8"><title>Probni</title></head><body><h1>Bok</h1></body></html>`;

/**
 * One platform with three members: the estate's owner, a colleague nothing has been shared
 * with yet, and a platform admin — who is here to prove that the admin role opens no door
 * into somebody else's estate on its own.
 */
async function platform() {
  const db = openD1Shim();
  const store = openStore(db);
  const bucket = memoryBucket();
  const access = openAccess({ db, audit: store.audit });
  const folders = openFolders({ db, masterKeyHex: MASTER });
  const artifacts = openArtifacts({ db, bucket, masterKeyHex: MASTER, settings: store.settings });
  const keys = openKeys({ db, audit: store.audit, access });

  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const mate = await Effect.runPromise(store.users.create({
    id: "mate00000000000b2", email: "mate@example.test", name: "Mate", role: "member", passwordHash: "{}",
  }));
  const admin = await Effect.runPromise(store.users.create({
    id: "admin0000000000c3", email: "admin@example.test", name: "Admin", role: "admin", passwordHash: "{}",
  }));

  const ctx = {
    store, artifacts, folders, keys, access, projectData: openProjectData({ db, masterKeyHex: MASTER }),
    projectFiles: openProjectFiles({ db, bucket: memoryBucket(), masterKeyHex: MASTER }),
    publicOrigin: "https://example.test",
    limiter: openRateLimiter({ RATELIMIT: rateLimitBinding() }), contract,
  };
  const api = (path: string, { key, method = "GET", body }: { key?: string; method?: string; body?: object } = {}) => Effect.runPromise(handleApi(new Request(`https://example.test/_api/${path}`, {
    method,
    headers: body
      ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
      : { authorization: `Bearer ${key}` },
    body: body ? JSON.stringify(body) : undefined,
  }),
  ctx,
  { rest: path },));
  const masterKeyFor = async (user: Pick<User, "id">) =>
    (await Effect.runPromise(keys.mint({ userId: user.id, kind: "master", scopes: "master" }))).key;

  return { db, store, bucket, access, folders, artifacts, keys, owner, mate, admin, ctx, api, masterKeyFor };
}

const auditRows = async (db: TestDatabase, action: string) =>
  (await db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY at").bind(action).all<AuditRow>()).results;

// ---- access.js: the grant model ------------------------------------------

test("a grant is inherited down the nesting, and the strongest one on the chain wins", async () => {
  const { access, folders, owner, mate } = await platform();
  const root = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const child = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Child", parentId: root.id }));
  const grandchild = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Grandchild", parentId: child.id }));

  assert.equal(await Effect.runPromise(access.role(owner.id, grandchild.id)), "owner");
  assert.equal(await Effect.runPromise(access.role(mate.id, grandchild.id)), null);

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: root.id, userId: mate.id, role: "viewer" }));
  assert.equal(await Effect.runPromise(access.role(mate.id, root.id)), "viewer");
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), "viewer");
  assert.equal(await Effect.runPromise(access.role(mate.id, grandchild.id)), "viewer");

  // A stronger grant deeper in wins where it applies, and only there.
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: child.id, userId: mate.id, role: "manager" }));
  assert.equal(await Effect.runPromise(access.role(mate.id, root.id)), "viewer");
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), "manager");
  assert.equal(await Effect.runPromise(access.role(mate.id, grandchild.id)), "manager");

  // ...and a WEAKER grant deeper in never narrows what an ancestor already gave: strongest
  // wins is about the role, not about the distance.
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: grandchild.id, userId: mate.id, role: "viewer" }));
  assert.equal(await Effect.runPromise(access.role(mate.id, grandchild.id)), "manager");
});

test("the permission ladder: read/write/manage/own against each role", async () => {
  const { access, folders, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const resource = { ownerId: owner.id, folderId: folder.id };

  const ladder = async () => ({
    read: await Effect.runPromise(access.may(mate.id, resource, "read")),
    write: await Effect.runPromise(access.may(mate.id, resource, "write")),
    manage: await Effect.runPromise(access.may(mate.id, resource, "manage")),
    own: await Effect.runPromise(access.may(mate.id, resource, "own")),
  });

  assert.deepEqual(await ladder(), { read: false, write: false, manage: false, own: false });

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "viewer" }));
  assert.deepEqual(await ladder(), { read: true, write: false, manage: false, own: false });

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));
  assert.deepEqual(await ladder(), { read: true, write: true, manage: false, own: false });

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "manager" }));
  assert.deepEqual(await ladder(), { read: true, write: true, manage: true, own: false });

  // Ownership is never granted — a manager is not an owner, and the owner is everything.
  for (const need of ["read", "write", "manage", "own"]) {
    assert.equal(await Effect.runPromise(access.may(owner.id, resource, need)), true);
  }
});

test("the platform admin role opens no estate on its own", async () => {
  const { access, folders, artifacts, owner, admin } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const artifact = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Izvještaj", html: HTML, slug: "izvjestaj", authorId: owner.id,
  }));

  assert.equal(await Effect.runPromise(access.role(admin.id, folder.id)), null);
  assert.equal(await Effect.runPromise(access.may(admin.id, { ownerId: owner.id, folderId: folder.id }, "read")), false);
  assert.equal(await Effect.runPromise(access.may(admin.id, { ownerId: artifact.ownerId, folderId: artifact.folderId }, "read")), false);
  assert.deepEqual(await Effect.runPromise(access.foldersFor(admin.id)), []);
});

test("an unfiled resource is reachable by its owner alone: a grant has nothing to hang on", async () => {
  const { access, folders, artifacts, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "manager" }));
  const loose = await Effect.runPromise(artifacts.create({ ownerId: owner.id, title: "Bez mape", html: HTML, authorId: owner.id }));

  assert.equal(loose.folderId, null);
  assert.equal(await Effect.runPromise(access.may(owner.id, { ownerId: loose.ownerId, folderId: loose.folderId }, "read")), true);
  assert.equal(await Effect.runPromise(access.may(mate.id, { ownerId: loose.ownerId, folderId: loose.folderId }, "read")), false);
});

test("suspending a colleague takes every granted reach away, live", async () => {
  const { access, store, folders, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const child = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Child", parentId: folder.id }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));
  assert.equal((await Effect.runPromise(access.foldersFor(mate.id))).length, 2);

  await Effect.runPromise(store.users.setStatus(mate.id, "suspended"));

  assert.equal(await Effect.runPromise(access.role(mate.id, folder.id)), null);
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), null);
  assert.equal(await Effect.runPromise(access.may(mate.id, { ownerId: owner.id, folderId: folder.id }, "read")), false);
  assert.deepEqual(await Effect.runPromise(access.foldersFor(mate.id)), []);

  // The grant itself survives, so the owner can still see and remove it — flagged inactive,
  // because a list that showed it as live access would be a lie.
  const listed = await Effect.runPromise(access.grants({ actorId: owner.id, folderId: folder.id }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].userId, mate.id);
  assert.equal(listed[0].active, false);

  // ...and reinstating restores exactly what was there, with no re-grant.
  await Effect.runPromise(store.users.setStatus(mate.id, "active"));
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), "editor");
});

test("foldersFor returns the caller's own estate plus what is shared, and nothing else", async () => {
  const { access, folders, owner, mate } = await platform();
  const shared = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Shared" }));
  const nested = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Nested", parentId: shared.id }));
  const deeper = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Deeper", parentId: nested.id }));
  const private_ = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Private" }));
  const own = await Effect.runPromise(folders.create({ ownerId: mate.id, name: "Mate's own" }));

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: shared.id, userId: mate.id, role: "viewer" }));

  const ids = (await Effect.runPromise(access.foldersFor(mate.id))).map((f) => f.id).sort();
  assert.deepEqual(ids, [own.id, shared.id, nested.id, deeper.id].sort());
  assert.equal(ids.includes(private_.id), false);

  // The shape is the folders.js projection, so a caller cannot tell the two apart.
  const row = (await Effect.runPromise(access.foldersFor(mate.id))).find((f) => f.id === shared.id);
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(),
    ["createdAt", "id", "nameSealed", "ownerId", "parentId", "slug", "updatedAt"]);
  assert.equal(row.ownerId, owner.id);                         // a grant never moves ownership
});

test("only the owner hands out or takes back access — a manager cannot re-share", async () => {
  const { access, folders, owner, mate, admin } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "manager" }));

  await assert.rejects(
    () => Effect.runPromise(access.grant({ actorId: mate.id, folderId: folder.id, userId: admin.id, role: "viewer" })),
    (e: unknown) => asCodeError(e).code === "forbidden");
  await assert.rejects(
    () => Effect.runPromise(access.revoke({ actorId: mate.id, folderId: folder.id, userId: mate.id })),
    (e: unknown) => asCodeError(e).code === "forbidden");
  await assert.rejects(
    () => Effect.runPromise(access.grants({ actorId: mate.id, folderId: folder.id })),
    (e: unknown) => asCodeError(e).code === "forbidden");

  // A platform admin is no more privileged here than anybody else.
  await assert.rejects(
    () => Effect.runPromise(access.grant({ actorId: admin.id, folderId: folder.id, userId: admin.id, role: "manager" })),
    (e: unknown) => asCodeError(e).code === "forbidden");
});

test("grant refuses what it cannot mean: bad roles, the owner, a suspended or unknown user", async () => {
  const { access, store, folders, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const grant = (over: Partial<GrantInput>) => Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "viewer", ...over }));

  await assert.rejects(() => grant({ role: "owner" }), (e: unknown) => asCodeError(e).code === "invalid-role");
  await assert.rejects(() => grant({ role: "admin" }), (e: unknown) => asCodeError(e).code === "invalid-role");
  await assert.rejects(() => grant({ role: "" }), (e: unknown) => asCodeError(e).code === "invalid-role");
  await assert.rejects(() => grant({ userId: owner.id }), (e: unknown) => asCodeError(e).code === "invalid-user");
  await assert.rejects(() => grant({ userId: "" }), (e: unknown) => asCodeError(e).code === "invalid-user");
  await assert.rejects(() => grant({ userId: "nobody" }), (e: unknown) => asCodeError(e).code === "not-found");
  await assert.rejects(() => grant({ folderId: "nosuchfolder" }), (e: unknown) => asCodeError(e).code === "not-found");

  await Effect.runPromise(store.users.setStatus(mate.id, "suspended"));
  await assert.rejects(() => grant({}), (e: unknown) => asCodeError(e).code === "invalid-user");
});

test("revoking is where the grant lives: at the child it does not touch the ancestor", async () => {
  const { access, folders, owner, mate } = await platform();
  const root = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const child = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Child", parentId: root.id }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: root.id, userId: mate.id, role: "viewer" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: child.id, userId: mate.id, role: "editor" }));

  assert.equal(await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: child.id, userId: mate.id })), true);
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), "viewer");    // the inherited grant remains

  assert.equal(await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: child.id, userId: mate.id })), false);
  assert.equal(await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: root.id, userId: mate.id })), true);
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), null);
  assert.deepEqual(await Effect.runPromise(access.foldersFor(mate.id)), []);
});

test("the colleague list keeps direct grants revocable even when inherited access is stronger", async () => {
  const { access, folders, owner, mate, admin } = await platform();
  const root = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const child = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Child", parentId: root.id }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: root.id, userId: mate.id, role: "viewer" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: child.id, userId: admin.id, role: "editor" }));

  const atChild = await Effect.runPromise(access.grants({ actorId: owner.id, folderId: child.id }));
  assert.deepEqual(atChild.map((g) => [g.email, g.role, g.folderId, g.inherited, g.active]), [
    ["admin@example.test", "editor", child.id, false, true],
    ["mate@example.test", "viewer", root.id, true, true],
  ]);

  // At the root, only the grant recorded there exists — a descendant's grant never climbs.
  const atRoot = await Effect.runPromise(access.grants({ actorId: owner.id, folderId: root.id }));
  assert.deepEqual(atRoot.map((g) => g.email), ["mate@example.test"]);

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: root.id, userId: mate.id, role: "manager" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: child.id, userId: mate.id, role: "viewer" }));
  const grants = (await Effect.runPromise(access.grants({ actorId: owner.id, folderId: child.id }))).filter((g) => g.userId === mate.id);
  assert.deepEqual(grants.map((g) => [g.role, g.inherited]).sort(), [["manager", true], ["viewer", false]]);
  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: child.id, userId: mate.id }));
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), "manager");
  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: root.id, userId: mate.id }));
  assert.equal(await Effect.runPromise(access.role(mate.id, child.id)), null);
});

test("granting and revoking are audited", async () => {
  const { db, access, folders, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));
  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: folder.id, userId: mate.id }));

  const granted = await auditRows(db, "access.grant");
  assert.equal(granted.length, 1);
  assert.equal(granted[0].actor_id, owner.id);
  assert.deepEqual(JSON.parse(granted[0].detail ?? "null"), { folder: folder.id, user: mate.id, role: "editor" });

  const revoked = await auditRows(db, "access.revoke");
  assert.equal(revoked.length, 1);
  assert.deepEqual(JSON.parse(revoked[0].detail ?? "null"), { folder: folder.id, user: mate.id, role: "editor" });
});

// ---- folders.js: the shape collaboration and visitor shares both walk -----

test("a folder's subtree and ancestry are answered live, and a move changes both", async () => {
  const { folders, owner } = await platform();
  const a = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "A" }));
  const b = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "B", parentId: a.id }));
  const c = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "C", parentId: b.id }));
  const other = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Other" }));

  assert.deepEqual((await Effect.runPromise(folders.subtreeIds(a.id))).sort(), [a.id, b.id, c.id].sort());
  assert.deepEqual(await Effect.runPromise(folders.ancestorIds(c.id)), [b.id, a.id]);
  assert.deepEqual(await Effect.runPromise(folders.ancestorIds(a.id)), []);
  assert.deepEqual(await Effect.runPromise(folders.subtreeIds("nosuchfolder")), []);

  // Moving B out takes C with it: a folder-wide visitor share recomputed after this covers
  // neither, with nothing cached to go stale.
  await Effect.runPromise(folders.setParent(b.id, other.id));
  assert.deepEqual(await Effect.runPromise(folders.subtreeIds(a.id)), [a.id]);
  assert.deepEqual((await Effect.runPromise(folders.subtreeIds(other.id))).sort(), [other.id, b.id, c.id].sort());
  assert.deepEqual(await Effect.runPromise(folders.ancestorIds(c.id)), [b.id, other.id]);
});

test("concurrent opposite folder moves cannot create a cycle", async () => {
  const { folders, owner } = await platform();
  const a = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "A" }));
  const b = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "B" }));
  const moves = await Promise.allSettled([Effect.runPromise(folders.setParent(a.id, b.id)), Effect.runPromise(folders.setParent(b.id, a.id))]);
  assert.equal(moves.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = moves.find((result) => result.status === "rejected");
  assert.ok(rejected);
  assert.equal(asCodeError(rejected.reason).code, "folder-cycle");
  const parentA = (await Effect.runPromise(folders.byId(a.id)))?.parentId;
  const parentB = (await Effect.runPromise(folders.byId(b.id)))?.parentId;
  assert.equal(parentA === null || parentB === null, true);
});

test("suspension blocks an owner's own estate and previously issued API credentials", async () => {
  const { store, access, folders, owner, api, masterKeyFor } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const key = await masterKeyFor(owner);
  assert.equal((await api("folders", { key })).status, 200);
  await Effect.runPromise(store.users.setStatus(owner.id, "suspended"));
  assert.equal((await api("folders", { key })).status, 401);
  assert.equal(await Effect.runPromise(access.role(owner.id, folder.id)), null);
  assert.equal(await Effect.runPromise(access.may(owner.id, { ownerId: owner.id, folderId: folder.id }, "write")), false);
  assert.deepEqual(await Effect.runPromise(access.foldersFor(owner.id)), []);
});

// ---- keys.js: the spine reads the grant on every request -----------------

test("a colleague's key reaches the shared estate, and stops the instant the grant does", async () => {
  const { access, keys, folders, artifacts, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const artifact = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Izvještaj", html: HTML, slug: "izvjestaj", authorId: owner.id,
  }));
  const mateKey = (await Effect.runPromise(keys.mint({ userId: mate.id, kind: "master", scopes: "master" }))).record;
  const target = { ownerId: artifact.ownerId, folderId: artifact.folderId, artifactId: artifact.id };

  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "read")), false);

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "viewer" }));
  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "read")), true);
  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "write")), false);
  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "own")), false);

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));
  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "write")), true);

  // No cache, no session: the next question after the revoke is already the new answer.
  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: folder.id, userId: mate.id }));
  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "read")), false);
  assert.equal(await Effect.runPromise(keys.may(mateKey, target, "write")), false);
});

test("a scoped key stays bound to its one artefact, grant or no grant", async () => {
  const { access, keys, folders, artifacts, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const one = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Prvi", html: HTML, slug: "prvi", authorId: owner.id,
  }));
  const two = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Drugi", html: HTML, slug: "drugi", authorId: owner.id,
  }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));

  const scoped = (await Effect.runPromise(keys.mint({
    userId: mate.id, kind: "artifact", artifactId: one.id, scopes: "read_write",
  }))).record;

  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: one.ownerId, folderId: one.folderId, artifactId: one.id }, "write")), true);
  // The grant covers the whole folder; the KEY does not. A binding is never widened.
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: two.ownerId, folderId: two.folderId, artifactId: two.id }, "read")), false);
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: one.ownerId, folderId: one.folderId }, "read")), false);

  // And when the grant behind it goes, so does the key that was minted from it.
  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: folder.id, userId: mate.id }));
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: one.ownerId, folderId: one.folderId, artifactId: one.id }, "read")), false);
});

test("minting and rotating re-ask the grant question: no key outlives the access behind it", async () => {
  const { access, keys, folders, artifacts, owner, mate } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const artifact = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Izvještaj", html: HTML, slug: "izvjestaj", authorId: owner.id,
  }));
  const mint = (scopes: string) => Effect.runPromise(keys.mint({ userId: mate.id, kind: "artifact", artifactId: artifact.id, scopes }));

  await assert.rejects(() => mint("read"), (e: unknown) => asCodeError(e).code === "forbidden");     // no grant at all

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "viewer" }));
  const readKey = await mint("read");
  assert.match(readKey.key, /^waa_[0-9a-f]{40}$/);
  // A viewer may not leave a write key behind against somebody else's estate.
  await assert.rejects(() => mint("write"), (e: unknown) => asCodeError(e).code === "forbidden");
  await assert.rejects(() => mint("read_write"), (e: unknown) => asCodeError(e).code === "forbidden");

  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));
  const writeKey = await mint("read_write");

  // Rotation is a fresh secret, so it asks again — and refuses once the grant is gone.
  assert.ok(await Effect.runPromise(keys.rotate(writeKey.record.id, mate.id)));
  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: folder.id, userId: mate.id }));
  await assert.rejects(() => Effect.runPromise(keys.rotate(writeKey.record.id, mate.id)), (e: unknown) => asCodeError(e).code === "forbidden");
  await assert.rejects(() => Effect.runPromise(keys.rotate(readKey.record.id, mate.id)), (e: unknown) => asCodeError(e).code === "forbidden");
  await assert.rejects(() => mint("read"), (e: unknown) => asCodeError(e).code === "forbidden");

  // Revocation of the KEY is always the user's own to do — a lost grant must never trap a
  // live secret in place.
  assert.equal(await Effect.runPromise(keys.revoke(writeKey.record.id, mate.id)), true);
});


// ---- api.js: the surface the grants open ---------------------------------

test("an editor publishes into a shared folder, and the artefact joins the owner's estate", async () => {
  const { db, access, artifacts, folders, owner, mate, api, masterKeyFor } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Acme", slug: "acme" }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));
  const key = await masterKeyFor(mate);

  const created = await api("artifacts", {
    key, method: "POST",
    body: { folder: "acme", slug: "izvjestaj", title: "Izvještaj", html: HTML, lang: "hr" },
  });
  assert.equal(created.status, 201);

  const artifact = await Effect.runPromise(artifacts.bySlug("izvjestaj"));
  assert.ok(artifact);
  assert.equal(artifact.folderId, folder.id);
  // Working in somebody's folder adds to THEIR estate — it never starts one of your own.
  assert.equal(artifact.ownerId, owner.id);
  // ...but the version is authored by whoever actually published it.
  const versions = (await db.prepare(
    "SELECT author_type, author_id FROM artifact_versions WHERE artifact_id = ?").bind(artifact.id).all<{ author_type: string; author_id: string }>()).results;
  assert.deepEqual(versions.map((v) => [v.author_type, v.author_id]), [["user", mate.id]]);

  // The editor can keep publishing over it, which is the point of the role.
  const again = await api("artifacts", {
    key, method: "POST",
    body: { folder: "acme", slug: "izvjestaj", title: "Izvještaj 2", html: HTML, lang: "hr" },
  });
  assert.equal(again.status, 200);
  assert.equal((await Effect.runPromise(artifacts.bySlug("izvjestaj")))?.currentVersion, 2);
});

test("a viewer reads the shared estate and cannot write a byte of it", async () => {
  const { access, folders, artifacts, owner, mate, api, masterKeyFor } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Acme", slug: "acme" }));
  await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Izvještaj", html: HTML, slug: "izvjestaj", authorId: owner.id,
  }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "viewer" }));
  const key = await masterKeyFor(mate);

  const listed = await api("artifacts", { key });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as ArtifactListResponse).artifacts.map((a) => a.slug), ["izvjestaj"]);

  for (const [path, body] of [
    ["artifacts", { folder: "acme", slug: "drugi", title: "Drugi", html: HTML }],
    ["artifacts/rotate", { artifact: "izvjestaj", password: "tajna123" }],
    ["artifacts/alias", { artifact: "izvjestaj", paths: ["staro"] }],
    ["folders/alias", { folder: "acme", paths: ["staro"] }],
    ["keys", { artifact: "izvjestaj", scopes: "read_write" }],
  ] satisfies Array<[string, object]>) {
    const refused = await api(path, { key, method: "POST", body });
    assert.equal(refused.status, 403, `${path} must refuse a viewer`);
    assert.equal((await refused.json() as ApiFailureResponse).error.code, "forbidden");
  }

  // A read key over a readable artefact is legitimate, and it is all a viewer may mint.
  const minted = await api("keys", { key, method: "POST", body: { artifact: "izvjestaj", scopes: "read" } });
  assert.equal(minted.status, 201);
});

test("a stranger sees and touches nothing, and the listings stay inside the grant", async () => {
  const { access, folders, artifacts, owner, mate, admin, api, masterKeyFor } = await platform();
  const shared = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Acme", slug: "acme" }));
  const private_ = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Private", slug: "private" }));
  await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: shared.id, title: "Dijeljeni", html: HTML, slug: "dijeljeni", authorId: owner.id,
  }));
  await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: private_.id, title: "Tajni", html: HTML, slug: "tajni", authorId: owner.id,
  }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: shared.id, userId: mate.id, role: "manager" }));

  const mateFolders = await (await api("folders", { key: await masterKeyFor(mate) })).json() as FolderListResponse;
  assert.deepEqual(mateFolders.folders.map((f) => [f.slug, f.role, f.artifacts]), [["acme", "manager", 1]]);

  const mateArtifacts = await (await api("artifacts", { key: await masterKeyFor(mate) })).json() as ArtifactListResponse;
  assert.deepEqual(mateArtifacts.artifacts.map((a) => a.slug), ["dijeljeni"]);

  // The platform admin, with no grant, sees an empty platform through the API.
  const adminKey = await masterKeyFor(admin);
  assert.deepEqual((await (await api("folders", { key: adminKey })).json() as FolderListResponse).folders, []);
  assert.deepEqual((await (await api("artifacts", { key: adminKey })).json() as ArtifactListResponse).artifacts, []);
  const refused = await api("artifacts", {
    key: adminKey, method: "POST", body: { folder: "acme", slug: "upad", title: "Upad", html: HTML },
  });
  assert.equal(refused.status, 403);

  // The owner still sees their whole estate, shared or not.
  const ownerFolders = await (await api("folders", { key: await masterKeyFor(owner) })).json() as FolderListResponse;
  assert.deepEqual(ownerFolders.folders.map((f) => [f.slug, f.role]), [["acme", "owner"], ["private", "owner"]]);
});

test("a revoked grant closes the API on the very next request, scoped keys included", async () => {
  const { access, keys, folders, artifacts, owner, mate, api, masterKeyFor } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Acme", slug: "acme" }));
  const artifact = await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: folder.id, title: "Izvještaj", html: HTML, slug: "izvjestaj", authorId: owner.id,
  }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "editor" }));

  const masterKey = await masterKeyFor(mate);
  const scoped = (await Effect.runPromise(keys.mint({
    userId: mate.id, kind: "artifact", artifactId: artifact.id, scopes: "read_write",
  }))).key;

  assert.equal((await api("artifacts", { key: scoped })).status, 200);
  assert.equal((await (await api("artifacts", { key: scoped })).json() as ArtifactListResponse).artifacts.length, 1);

  await Effect.runPromise(access.revoke({ actorId: owner.id, folderId: folder.id, userId: mate.id }));

  // The scoped key still authenticates — it is not revoked — but it authorizes nothing.
  assert.deepEqual((await (await api("artifacts", { key: scoped })).json() as ArtifactListResponse).artifacts, []);
  const write = await api("artifacts/rotate", {
    key: scoped, method: "POST", body: { artifact: "izvjestaj", password: "tajna123" },
  });
  assert.equal(write.status, 403);

  assert.deepEqual((await (await api("folders", { key: masterKey })).json() as FolderListResponse).folders, []);
  assert.deepEqual((await (await api("artifacts", { key: masterKey })).json() as ArtifactListResponse).artifacts, []);
  const publish = await api("artifacts", {
    key: masterKey, method: "POST", body: { folder: "acme", slug: "novi", title: "Novi", html: HTML },
  });
  assert.equal(publish.status, 403);
});

test("a shared subfolder is reachable through the parent's grant, over the API too", async () => {
  const { access, folders, artifacts, owner, mate, api, masterKeyFor } = await platform();
  const root = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Acme", slug: "acme" }));
  const child = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Reports", slug: "reports", parentId: root.id }));
  await Effect.runPromise(artifacts.create({
    ownerId: owner.id, folderId: child.id, title: "Ugniježđeni", html: HTML, slug: "ugnijezdeni", authorId: owner.id,
  }));
  await Effect.runPromise(access.grant({ actorId: owner.id, folderId: root.id, userId: mate.id, role: "editor" }));
  const key = await masterKeyFor(mate);

  const folderList = await (await api("folders", { key })).json() as FolderListResponse;
  assert.deepEqual(folderList.folders.map((f) => [f.slug, f.role]), [["acme", "editor"], ["reports", "editor"]]);
  assert.deepEqual((await (await api("artifacts", { key })).json() as ArtifactListResponse).artifacts.map((a) => a.slug), ["ugnijezdeni"]);

  const published = await api("artifacts", {
    key, method: "POST", body: { folder: "reports", slug: "novi", title: "Novi", html: HTML },
  });
  assert.equal(published.status, 201);
  assert.equal((await Effect.runPromise(artifacts.bySlug("novi")))?.ownerId, owner.id);
});

test("grant work is lazy and injected audit Effects propagate original failures after grant and revoke", async () => {
  const { db, store, folders, owner, mate, access } = await platform();
  const folder = await Effect.runPromise(folders.create({ ownerId: owner.id, name: "Estate" }));
  const failure = Object.assign(new Error("grant audit unavailable"), { code: "audit-unavailable" });
  const brokenAccess = openAccess({ db, audit: { ...store.audit, write: () => Effect.fail(failure) } });
  const grant = brokenAccess.grant({ actorId: owner.id, folderId: folder.id, userId: mate.id, role: "viewer" });
  assert.equal(await Effect.runPromise(access.role(mate.id, folder.id)), null);
  await assert.rejects(Effect.runPromise(grant), (error: unknown) => error === failure);
  assert.equal(await Effect.runPromise(access.role(mate.id, folder.id)), "viewer");
  await assert.rejects(Effect.runPromise(brokenAccess.revoke({ actorId: owner.id, folderId: folder.id, userId: mate.id })), (error: unknown) => error === failure);
  assert.equal(await Effect.runPromise(access.role(mate.id, folder.id)), null);
});
