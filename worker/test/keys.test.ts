import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { asCodeError } from "../src/types.js";

import { openD1Shim, type TestDatabase } from "./db.js";
import { memoryBucket } from "./doubles.js";
import { openStore, type AuditRow } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { openKeys, type KeyRow } from "../src/keys.js";
import { openAccess } from "../src/access.js";
import { sha256hex } from "../src/crypto.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><title>Probni</title></head><body><h1>Bok</h1></body></html>`;

const req = (authorization?: string) =>
  new Request("https://api.example.test/_api/artifacts", {
    headers: authorization === undefined ? {} : { authorization },
  });

async function services() {
  const db = openD1Shim();
  const store = openStore(db);
  const bucket = memoryBucket();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner",
    passwordHash: "{}",
  }));
  const other = await Effect.runPromise(store.users.create({
    id: "other0000000000b2", email: "other@example.test", name: "Other", role: "member",
    passwordHash: "{}",
  }));
  return {
    db, store, owner, other,
    artifacts: openArtifacts({ db, bucket, masterKeyHex: MASTER, settings: store.settings }),
    keys: openKeys({ db, audit: store.audit, access: openAccess({ db, audit: store.audit }) }),
  };
}

const rawKey = (db: TestDatabase, id: string): KeyRow => {
  const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first<KeyRow>();
  assert.ok(row);
  return row;
};

test("mint shows the plaintext once and stores only its hash", async () => {
  const { owner, keys, db } = await services();

  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  assert.match(master.key, /^wak_[0-9a-f]{40}$/);
  assert.equal(master.record.prefix, master.key.slice(0, 8));
  assert.equal(master.record.kind, "master");
  assert.equal(master.record.userId, owner.id);
  assert.equal(master.record.artifactId, null);
  assert.equal(master.record.scopes, "master");
  assert.equal(master.record.revokedAt, null);
  assert.equal(master.record.lastUsedAt, null);

  const row = await rawKey(db, master.record.id);
  assert.equal(row.token_hash, await Effect.runPromise(sha256hex(master.key)));   // the hash IS of the plaintext
  assert.notEqual(row.token_hash, master.key);
  assert.ok(!JSON.stringify(row).includes(master.key));        // the plaintext is nowhere in D1
  assert.ok(!JSON.stringify(master.record).includes(master.key));
  assert.equal("token_hash" in master.record, false);
});

test("content-read capability defaults off, is stored when opted in, and survives rotation", async () => {
  const { owner, keys, db } = await services();
  const ordinary = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  assert.equal(ordinary.record.can_read_content, false);
  assert.equal(rawKey(db, ordinary.record.id).can_read_content, 0);
  const explicitlyOff = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "master", scopes: "master", can_read_content: false,
  }));
  assert.equal(explicitlyOff.record.can_read_content, false);
  assert.equal(rawKey(db, explicitlyOff.record.id).can_read_content, 0);
  db.prepare("INSERT INTO api_keys (id, user_id, kind, artifact_id, token_hash, prefix, scopes, label, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind("legacy-key", owner.id, "master", null, "legacy-hash", "wak_legacy", "master", "", "2026-01-01T00:00:00.000Z").run();
  assert.equal((await Effect.runPromise(keys.byId("legacy-key")))?.can_read_content, false);

  const optedIn = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "master", scopes: "master", can_read_content: true,
  }));
  assert.equal(optedIn.record.can_read_content, true);
  assert.equal(rawKey(db, optedIn.record.id).can_read_content, 1);
  const rotated = await Effect.runPromise(keys.rotate(optedIn.record.id, owner.id));
  assert.ok(rotated);
  assert.equal(rotated.record.can_read_content, true);
  assert.equal(rawKey(db, optedIn.record.id).can_read_content, 1);
});

test("an artifact key is waa_-shaped and bound to its artefact", async () => {
  const { owner, artifacts, keys } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));

  const scoped = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read_write",
    label: "Acme integration",
  }));
  assert.match(scoped.key, /^waa_[0-9a-f]{40}$/);
  assert.equal(scoped.record.artifactId, artifact.id);
  assert.equal(scoped.record.label, "Acme integration");
});

test("mint validates kind, binding, scopes and label", async () => {
  const { owner, artifacts, keys } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));

  await assert.rejects(
    () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "org", scopes: "master" })),
    (e: unknown) => asCodeError(e).code === "invalid-kind");
  await assert.rejects(
    () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", scopes: "read" })),
    (e: unknown) => asCodeError(e).code === "invalid-artifact");                     // an artifact key REQUIRES its artefact
  await assert.rejects(
    () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", artifactId: artifact.id, scopes: "master" })),
    (e: unknown) => asCodeError(e).code === "invalid-artifact");                     // a master key is never bound
  await assert.rejects(
    () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "read" })),
    (e: unknown) => asCodeError(e).code === "invalid-scopes");                       // 'master' scopes, master only
  await assert.rejects(
    () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "master" })),
    (e: unknown) => asCodeError(e).code === "invalid-scopes");                       // read/write/read_write, artifact only
  await assert.rejects(
    () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "admin" })),
    (e: unknown) => asCodeError(e).code === "invalid-scopes");
  for (const label of ["", "   ", "y".repeat(121), 42]) {       // the 1.x label rules ride along
    await assert.rejects(
      () => Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master", label })),
      (e: unknown) => asCodeError(e).code === "invalid-label");
  }
  const bare = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  assert.equal(bare.record.label, "");                         // no label given -> stored empty
});

test("authenticate resolves a fresh key and bumps last_used_at", async () => {
  const { owner, artifacts, keys, db } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const scoped = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read",
  }));

  const asMaster = await Effect.runPromise(keys.authenticate(req(`Bearer ${master.key}`)));
  assert.ok(asMaster);
  assert.equal(asMaster.key.id, master.record.id);
  assert.equal(asMaster.user.id, owner.id);                    // the raw users row
  assert.equal(asMaster.artifact, null);

  const asScoped = await Effect.runPromise(keys.authenticate(req(`Bearer ${scoped.key}`)));
  assert.ok(asScoped);
  assert.ok(asScoped.artifact);
  assert.equal(asScoped.key.kind, "artifact");
  assert.equal(asScoped.artifact.id, artifact.id);             // the raw artifacts row

  const row = await rawKey(db, scoped.record.id);
  assert.notEqual(row.last_used_at, null);                     // best-effort telemetry landed
});

test("authenticate rejects anything that is not a live, well-formed key", async () => {
  const { owner, other, artifacts, keys } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const scoped = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read",
  }));
  const ofOther = await Effect.runPromise(keys.mint({ userId: other.id, kind: "master", scopes: "master" }));

  assert.equal(await Effect.runPromise(keys.authenticate(req())), null);                          // no header at all
  assert.equal(await Effect.runPromise(keys.authenticate(req("Bearer "))), null);                 // Bearer with no key
  assert.equal(await Effect.runPromise(keys.authenticate(req("bearer " + master.key))), null);    // wrong scheme case
  assert.equal(await Effect.runPromise(keys.authenticate(req("Basic dXNlcjpwYXNz"))), null);     // not Bearer
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${master.key}x`))), null);   // overlong
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${master.key.toUpperCase()}`))), null);
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer wak_${"z".repeat(40)}`))), null); // not hex
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${await Effect.runPromise(sha256hex(master.key))}`))), null); // a hash, not a key
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${scoped.key.replace("waa_", "wak_")}`))), null); // re-prefixed
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer wak_${"0".repeat(40)}`))), null); // unknown key
  assert.equal(
    await Effect.runPromise(keys.authenticate(req(`Bearer ${ofOther.key}`))).then((r) => r?.user.id),
    other.id);                                                                // another user's key is still theirs

  // revoked: the flag is checked before anything resolves
  await Effect.runPromise(keys.revoke(master.record.id, owner.id));
  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${master.key}`))), null);

});

test("an artifact key whose artefact is gone no longer authenticates", async () => {
  const { db, owner, artifacts, keys } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const scoped = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read",
  }));
  assert.ok(await Effect.runPromise(keys.authenticate(req(`Bearer ${scoped.key}`))));

  db.exec("PRAGMA foreign_keys = OFF");   // the row references this artefact; we are simulating loss
  await db.prepare("DELETE FROM artifacts WHERE id = ?").bind(artifact.id).run();
  db.exec("PRAGMA foreign_keys = ON");

  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${scoped.key}`))), null);
});

test("scope semantics: read is read, write is write, a master key carries both", async () => {
  const { owner, artifacts, keys } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const master = (await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }))).record;
  const read = (await Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read" }))).record;
  const write = (await Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "write" }))).record;
  const both = (await Effect.runPromise(keys.mint({ userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read_write" }))).record;

  assert.equal(keys.hasScope(master, "read"), true);
  assert.equal(keys.hasScope(master, "write"), true);
  assert.equal(keys.hasScope(read, "read"), true);
  assert.equal(keys.hasScope(read, "write"), false);
  assert.equal(keys.hasScope(write, "write"), true);
  assert.equal(keys.hasScope(write, "read"), false);
  assert.equal(keys.hasScope(both, "read"), true);
  assert.equal(keys.hasScope(both, "write"), true);
});

test("the authorization spine never widens", async () => {
  const { owner, other, artifacts, keys } = await services();
  const mine = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const sibling = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const theirs = await Effect.runPromise(artifacts.create({ ownerId: other.id, html: HTML, authorId: other.id }));

  // No collaboration grants exist here, so only ownership opens a door. Live grants
  // and revocation are exercised in test/collaboration.test.ts.
  const master = (await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }))).record;
  assert.equal(await Effect.runPromise(keys.may(master, { ownerId: owner.id, artifactId: mine.id }, "write")), true);
  assert.equal(await Effect.runPromise(keys.may(master, { ownerId: other.id, artifactId: theirs.id }, "read")), false); // a foreign artefact arrives with its owner's id
  assert.equal(await Effect.runPromise(keys.may(master, { ownerId: owner.id, artifactId: mine.id }, "own")), true);

  const scoped = (await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: mine.id, scopes: "read_write",
  }))).record;
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: owner.id, artifactId: mine.id }, "write")), true);
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: owner.id, artifactId: sibling.id }, "read")), false); // not its artefact
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: other.id, artifactId: mine.id }, "read")), false);    // not its user
  assert.equal(await Effect.runPromise(keys.may(scoped, { ownerId: owner.id, artifactId: undefined }, "read")), false);  // no target, no reach

  // An unknown permission is a programming error, not a quiet `false` that would read as a
  // clean refusal in a log.
  await assert.rejects(
    () => Effect.runPromise(keys.may(master, { ownerId: owner.id, artifactId: mine.id }, "publish")),
    (e: unknown) => asCodeError(e).code === "invalid-need");
});

test("rotation replaces the secret: the old plaintext dies immediately", async () => {
  const { owner, other, artifacts, keys, db } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));
  const minted = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "write", label: "CI pipeline",
  }));

  const rotated = await Effect.runPromise(keys.rotate(minted.record.id, owner.id));
  assert.ok(rotated);
  assert.match(rotated.key, /^waa_[0-9a-f]{40}$/);
  assert.notEqual(rotated.key, minted.key);
  assert.equal(rotated.record.id, minted.record.id);           // the same key identity
  assert.equal(rotated.record.scopes, "write");
  assert.equal(rotated.record.artifactId, artifact.id);
  assert.equal(rotated.record.label, "CI pipeline");
  assert.equal(rotated.record.prefix, rotated.key.slice(0, 8));

  assert.equal(await Effect.runPromise(keys.authenticate(req(`Bearer ${minted.key}`))), null);   // old plaintext: dead
  const fresh = await Effect.runPromise(keys.authenticate(req(`Bearer ${rotated.key}`)));
  assert.ok(fresh);
  assert.equal(fresh.key.id, minted.record.id);                               // new plaintext: live
  const row = await rawKey(db, minted.record.id);
  assert.equal(row.token_hash, await Effect.runPromise(sha256hex(rotated.key)));  // the stored hash tracks the new secret
  assert.equal(row.prefix, rotated.record.prefix);

  assert.equal(await Effect.runPromise(keys.rotate(minted.record.id, other.id)), null);   // not theirs
  assert.equal(await Effect.runPromise(keys.rotate("missing0000000d4", owner.id)), null); // not there
});

test("revocation is a flag, is idempotent, and outlives in lists", async () => {
  const { owner, other, keys, db } = await services();
  const minted = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));

  assert.equal(await Effect.runPromise(keys.revoke(minted.record.id, owner.id)), true);
  assert.equal(await Effect.runPromise(keys.revoke(minted.record.id, owner.id)), false);          // already flipped
  assert.equal(await Effect.runPromise(keys.revoke(minted.record.id, other.id)), false);          // never widen via revoke

  const row = await rawKey(db, minted.record.id);
  assert.notEqual(row.revoked_at, null);                       // flagged, never deleted
  const listed = await Effect.runPromise(keys.list(owner.id));
  assert.equal(listed.find((k) => k.id === minted.record.id)?.revokedAt, row.revoked_at);

  assert.equal(await Effect.runPromise(keys.rotate(minted.record.id, owner.id)), null);           // revocation is terminal
});

test("list is per-user, newest first, and leaks no hash", async () => {
  const { db, owner, other, keys } = await services();
  const first = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const second = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const theirs = await Effect.runPromise(keys.mint({ userId: other.id, kind: "master", scopes: "master" }));

  // mint timestamps share a millisecond; forge distinct ones so DESC ordering is observable
  await db.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").bind("2026-01-01T00:00:00Z", first.record.id).run();
  await db.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").bind("2026-01-02T00:00:00Z", second.record.id).run();
  await db.prepare("UPDATE api_keys SET created_at = ? WHERE id = ?").bind("2026-01-03T00:00:00Z", theirs.record.id).run();

  const listed = await Effect.runPromise(keys.list(owner.id));
  assert.deepEqual(listed.map((k) => k.id), [second.record.id, first.record.id]); // newest first, own only
  for (const k of listed) assert.equal("token_hash" in k, false);
  const dump = JSON.stringify(listed);
  assert.ok(!dump.includes("token_hash"));
  assert.ok(!dump.includes(first.key) && !dump.includes(second.key) && !dump.includes(theirs.key));
});

test("every lifecycle action lands in the audit trail", async () => {
  const { db, owner, artifacts, keys } = await services();
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: owner.id, html: HTML, authorId: owner.id }));

  const scoped = await Effect.runPromise(keys.mint({
    userId: owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read",
  }));
  const rotated = await Effect.runPromise(keys.rotate(scoped.record.id, owner.id));
  assert.ok(rotated);
  await Effect.runPromise(keys.revoke(scoped.record.id, owner.id));

  const byAction = async (action: string) =>
    (await db.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY seq").bind(action).all<AuditRow>()).results;

  const mints = await byAction("key.mint");
  assert.equal(mints.length, 1);
  assert.equal(mints[0].actor_type, "user");
  assert.equal(mints[0].actor_id, owner.id);
  assert.equal(mints[0].artifact_id, artifact.id);
  assert.deepEqual(JSON.parse(mints[0].detail ?? "null"), {
    kind: "artifact", artifactId: artifact.id, prefix: scoped.record.prefix,
  });

  const rotations = await byAction("key.rotate");
  assert.equal(rotations.length, 1);
  assert.deepEqual(JSON.parse(rotations[0].detail ?? "null"), {
    kind: "artifact", artifactId: artifact.id, prefix: rotated.record.prefix,
  });

  const revokes = await byAction("key.revoke");
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0].artifact_id, artifact.id);
});

test("key work is lazy and injected audit Effects preserve failures after each mutation", async () => {
  const { keys, store, owner, db } = await services();
  const original = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const originalHash = rawKey(db, original.record.id).token_hash;
  const failure = Object.assign(new Error("audit unavailable"), { code: "audit-unavailable" });
  const brokenAudit = { ...store.audit, write: () => Effect.fail(failure) };
  const brokenKeys = openKeys({ db, audit: brokenAudit, access: openAccess({ db, audit: store.audit }) });
  const mint = brokenKeys.mint({ userId: owner.id, kind: "master", scopes: "master" });
  assert.equal((await Effect.runPromise(keys.list(owner.id))).length, 1);
  await assert.rejects(Effect.runPromise(mint), (error: unknown) => error === failure);
  assert.equal((await Effect.runPromise(keys.list(owner.id))).length, 2);
  await assert.rejects(Effect.runPromise(brokenKeys.rotate(original.record.id, owner.id)), (error: unknown) => error === failure);
  assert.notEqual(rawKey(db, original.record.id).token_hash, originalHash);
  await assert.rejects(Effect.runPromise(brokenKeys.revoke(original.record.id, owner.id)), (error: unknown) => error === failure);
  assert.ok(rawKey(db, original.record.id).revoked_at);
});
