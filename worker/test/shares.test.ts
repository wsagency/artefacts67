// Visitor shares: the security boundary, not the plumbing. Every test here asserts something
// a wrong implementation would happily break — what leaves the server before a password is
// checked, what a dead or mis-pointed token may reach, and whether the subtree a share serves
// is the subtree as it is NOW.

import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";

import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { openFolders } from "../src/folders.js";
import { openShares, type ShareGatePayload } from "../src/shares.js";
import { scalarSeal, type SealRecord } from "../src/crypto.js";
import { handleShare, handleShareGate } from "../src/share-viewer.js";
import { route } from "../src/router.js";
import { html } from "../src/http.js";
import { openArtifactRuntime, type RuntimeAccess, type RuntimeActiveSession, type RuntimeObservation, type RuntimeSource } from "../src/artifact-runtime.js";
import { openAnalytics, type Analytics } from "../src/analytics.js";
import { openRuntimeState } from "../src/runtime-state.js";
import { openReports } from "../src/reports.js";
import { openProjectData } from "../src/project-data.js";
import { openProjectFiles } from "../src/project-files.js";
import { openRateLimiter, type RateLimiter } from "../src/ratelimit.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
// The sentinels are what a document says and a gate page never may: asserting on the title
// would pass even when the gate page leaks, because the gate page prints the title by design.
const BODY = "revenue-is-up-eleven-percent";
const OTHER_BODY = "notes-from-the-second-round";
const HTML = `<!doctype html><html lang="en"><head><title>Deck</title></head><body><h1>Quarterly deck</h1><p>${BODY}</p></body></html>`;
const OTHER_HTML = `<!doctype html><html lang="en"><head><title>Notes</title></head><body><h1>Notes</h1><p>${OTHER_BODY}</p></body></html>`;
const NEUTRAL = "<!doctype html><html><body>front door</body></html>";
// A share's name is the sender's own label for the link. It is a sentinel too: the visitor
// pages, the audit trail and the observation rows must never carry it.
const LABEL = "acme-round-two-private-label";

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const join = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/**
 * Decrypt a share payload the way the BROWSER does: password -> KEK -> share key -> document
 * key -> document. Written straight against WebCrypto so it is an independent check of what
 * the gate released, never a second call into the code that released it.
 */
async function openAsRecipient({ wrap, key, content }: ShareGatePayload, password: string) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64(wrap.ksalt), iterations: wrap.iter, hash: "SHA-256" }, km, 256);
  const kek = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
  const open = async (k: CryptoKey, box: SealRecord) => new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(box.iv) }, k, join(b64(box.ct), b64(box.tag))));
  const hexKey = async (h: string) => crypto.subtle.importKey(
    "raw", Uint8Array.from(Buffer.from(h, "hex")), "AES-GCM", false, ["decrypt"]);

  const shareEnvelope: unknown = JSON.parse(await open(kek, wrap));
  assert.ok(shareEnvelope && typeof shareEnvelope === "object" && "k" in shareEnvelope && typeof shareEnvelope.k === "string");
  const contentEnvelope: unknown = JSON.parse(await open(await hexKey(shareEnvelope.k), key));
  assert.ok(contentEnvelope && typeof contentEnvelope === "object" && "k" in contentEnvelope && typeof contentEnvelope.k === "string");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(content.iv) }, await hexKey(contentEnvelope.k), b64(content.ct));
  return new TextDecoder().decode(pt);
}

/** The access adapter the collaboration lane owns, reduced to what shares ask of it: an owner
 *  may everything on their own rows, a manager may manage the folders they were granted.
 *  `foldersFor` counts its calls so the index path can prove the estate walk happens once. */
function accessDouble(): RuntimeAccess & { calls: { foldersFor: number }; grantManage(userId: string, folderId: string): void } {
  const managers = new Map<string, Set<string>>();
  const calls = { foldersFor: 0 };
  return {
    calls,
    grantManage(userId, folderId) {
      if (!managers.has(userId)) managers.set(userId, new Set());
      managers.get(userId)!.add(folderId);
    },
    foldersFor: () => Effect.sync(() => {
      calls.foldersFor += 1;
      return [];
    }),
    may: (userId, { ownerId, folderId } = {}, need = "read") => Effect.sync(() => {
      if (userId && userId === ownerId) return true;
      if (need !== "manage") return false;
      return Boolean(folderId && managers.get(String(userId))?.has(folderId));
    }),
  };
}

interface InvitationMessage { to: string; from: string; subject: string; text: string }
function mailerDouble() {
  const sent: InvitationMessage[] = [];
  return { sent, send: (message: InvitationMessage) => Effect.sync(() => {
    sent.push(message);
    return { ok: true, id: "test" };
  }) };
}

interface ShareLoadResponse { html: string; runtime: { grant: string }; observation: RuntimeObservation | null }
interface ShareIndexResponse {
  index: Array<{ viewer: { gated: boolean; publicUrl: string; runtime: Extract<RuntimeSource, { kind: "share" }> } }>;
}
interface ShareOpenResponse extends ShareGatePayload { observation: RuntimeObservation | null; runtime: { grant: string } }

async function environment({ analytics = null }: { analytics?: Pick<Analytics, "proof"> | null } = {}) {
  const DB = openD1Shim();
  const store = openStore(DB);
  const bucket = memoryBucket();
  const binding = rateLimitBinding();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const colleague = await Effect.runPromise(store.users.create({
    id: "member000000000b2", email: "member@example.test", name: "Member", role: "member", passwordHash: "{}",
  }));
  const artifacts = openArtifacts({ db: DB, bucket, masterKeyHex: MASTER, settings: store.settings });
  const folders = openFolders({ db: DB, masterKeyHex: MASTER });
  const access = accessDouble();
  const mailer = mailerDouble();
  const shares = openShares({
    db: DB, masterKeyHex: MASTER, artifacts, folders, access, audit: store.audit,
    publicOrigin: "https://artefacts.example", mailer, settings: store.settings,
  });
  // The wiring the composition root performs: an artefact change re-syncs its share wraps.
  artifacts.setOnChange((artifactId) => shares.syncArtifact(artifactId));

  // The session the stubbed auth resolves for the current request; tests flip `value` to
  // exercise a signed-in holder without wiring the whole auth model.
  const sessionRef: { value: RuntimeActiveSession | null } = { value: null };
  const ctx = {
    store, artifacts, folders, shares, access,
    analytics: analytics ?? openAnalytics({ db: DB, shares, access, masterKeyHex: MASTER }),
    auth: { sessionCookie: "session", currentSession: () => Effect.sync(() => sessionRef.value) },
    artifactRuntime: openArtifactRuntime({ db: DB, masterKeyHex: MASTER }),
    runtimeState: openRuntimeState({ db: DB, masterKeyHex: MASTER }),
    reports: openReports({ db: DB, masterKeyHex: MASTER }),
    projectData: openProjectData({ db: DB, masterKeyHex: MASTER }),
    projectFiles: openProjectFiles({ db: DB, bucket: memoryBucket(), masterKeyHex: MASTER }),
    limiter: openRateLimiter({ RATELIMIT: binding }),
    gate: { threshold: 4, lockMs: 3_600_000 },
    neutral: () => html(NEUTRAL),
  };

  const get = (path: string) => Effect.runPromise(handleShare(new Request(`https://artefacts.example${path}`), ctx, params(path)));
  const unlock = (path: string, password: string, ip = "203.0.113.9") => Effect.runPromise(handleShareGate(
    new Request(`https://artefacts.example/_gate${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://artefacts.example", "CF-Connecting-IP": ip,
        ...(sessionRef.value ? { Cookie: "session=fixture-session" } : {}) },
      body: JSON.stringify({ password }),
    }),
    ctx, params(path),
  ));
  const load = async (path: string): Promise<ShareLoadResponse> => {
    const { path: target, token, artefact } = params(path);
    const request = new Request("https://artefacts.example/_runtime/load", {
      method: "POST", headers: { "content-type": "application/json", Origin: "https://artefacts.example" },
      body: JSON.stringify({ source: { kind: "share", path: target, token, artifactId: artefact } }),
    });
    const response = await Effect.runPromise(ctx.artifactRuntime.handle(request, ctx, { action: "load" }));
    assert.equal(response.status, 200);
    return response.json() as Promise<ShareLoadResponse>;
  };

  return { DB, store, bucket, artifacts, folders, shares, access, mailer, ctx, owner, colleague, sessionRef, get, unlock, load };
}

/** Route the path exactly as the Worker would, so the tests exercise the real params. */
function params(path: string) {
  const match = route("GET", path) ?? route("POST", path);
  assert.ok(match, `no route for ${path}`);
  return match.params;
}

const urlPath = (url: string) => new URL(url).pathname;

test("a gated share releases wrapped keys only after the password, and the recipient decrypts", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Quarterly deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: LABEL,
    recipient: "client@example.test", password: "letmein",
  }));
  assert.equal(share.gated, true);
  assert.match(share.url, /^https:\/\/artefacts\.example\/deck\/s\/[0-9a-f]{40}\/$/);
  assert.equal(share.name, LABEL);
  assert.equal(share.recipient, "client@example.test");

  // The page a visitor gets carries the gate, never the document and never key material.
  const page = await env.get(urlPath(share.url));
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.equal(body.includes(BODY), false);
  assert.equal(body.includes(LABEL), false, "the sender's label for a link is not the visitor's business");

  const wrong = await env.unlock(urlPath(share.url), "nope");
  assert.equal(wrong.status, 401);

  const opened = await env.unlock(urlPath(share.url), "letmein");
  assert.equal(opened.status, 200);
  const payload = await opened.json() as ShareGatePayload;
  assert.ok(payload.wrap && payload.key && payload.content, "wrap, share-key box and ciphertext");
  assert.equal(JSON.stringify(payload).includes(BODY), false);
  // The gate page held none of the material the gate released once the password checked out.
  for (const box of [payload.wrap, payload.key, payload.content]) assert.equal(body.includes(box.ct), false);
  assert.equal(await openAsRecipient(payload, "letmein"), HTML);
});

test("a gated folder index projects every child through the safe viewer DTO, with the actor context computed once", async (t) => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const first = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "First", html: HTML, slug: "first", authorId: env.owner.id,
  }));
  const second = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Second", html: OTHER_HTML, slug: "second", authorId: env.owner.id,
  }));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client",
    recipient: "c@example.test", password: "pw",
  }));
  const base = urlPath(share.url);

  const scan = async (signedIn: boolean) => {
    env.sessionRef.value = signedIn ? { user: env.colleague, session: { id: "s1", userId: env.colleague.id, pending2fa: false, csrf: "x" } } : null;
    env.access.calls.foldersFor = 0;
    const response = await env.unlock(base, "pw");
    assert.equal(response.status, 200);
    const payload = await response.json() as ShareIndexResponse;
    env.sessionRef.value = null;
    return payload;
  };

  for (const signedIn of [false, true]) {
    const payload = await scan(signedIn);
    assert.ok(Array.isArray(payload.index) && payload.index.length === 2, "both children listed");
    const serialized = JSON.stringify(payload);
    // The raw descriptor carries these; the shared projection (views.viewerView) must not.
    for (const field of ["r2Key", "r2_key", "sha256", "authorId", "author_id", "titleSealed", "wrapMaster", "wrapPassword"]) {
      assert.equal(serialized.includes(field), false, `${field} must not reach the visitor index`);
    }
    for (const child of payload.index) {
      assert.equal(child.viewer.gated, true);
      assert.ok(child.viewer.publicUrl.startsWith(base), "each child keeps its own visitor path");
      assert.equal(child.viewer.runtime.kind, "share");
      assert.match(child.viewer.runtime.token, /^[0-9a-f]{40}$/);
    }
    assert.deepEqual(payload.index.map((c) => c.viewer.runtime.artifactId).sort(), [first.id, second.id].sort(),
      "each child still names its own document (per-child checks retained)");
    // One request-level actor context: the estate walk happens once per unlock, not per child.
    assert.equal(env.access.calls.foldersFor, signedIn ? 1 : 0);
  }
});

test("a share password is the share's own: the artefact password never opens it, and vice versa", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Deck", html: HTML, slug: "deck", password: "artefact-pass", authorId: env.owner.id,
  }));
  const openShare = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: "Link-only access",
  }));
  assert.match((await env.load(urlPath(openShare.url))).html, new RegExp(BODY));
  assert.equal(await Effect.runPromise(env.artifacts.verifyPassword(await Effect.runPromise(env.artifacts.byId(artifact.id)), "artefact-pass")), true);

  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: "Client",
    recipient: "c@example.test", password: "share-pass",
  }));
  const path = urlPath(share.url);
  assert.equal((await env.unlock(path, "artefact-pass")).status, 401);
  assert.equal((await env.unlock(path, "share-pass")).status, 200);
  // And the artefact's own gate is untouched by the share's password.
  assert.equal(await Effect.runPromise(env.artifacts.verifyPassword(artifact, "share-pass")), false);
});

test("a legacy passwordless share still excludes documents that become protected", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const open = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Open", html: HTML, slug: "open", authorId: env.owner.id,
  }));
  const locked = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Locked", html: OTHER_HTML, slug: "locked",
    password: "secret", authorId: env.owner.id,
  }));

  // Model an existing passwordless link before a document gains its ordinary gate.
  await Effect.runPromise(env.artifacts.setPassword(locked.id, null));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client", recipient: "c@example.test",
  }));
  await env.DB.prepare("UPDATE shares SET allow_protected = 0 WHERE id = ?").bind(share.id).run();
  const base = urlPath(share.url);
  assert.match(await (await env.get(base)).text(), /Locked/);

  await Effect.runPromise(env.artifacts.setPassword(locked.id, "secret-again"));
  const index = await (await env.get(base)).text();
  assert.equal(index.includes("Locked"), false);
  assert.match(index, /Open/);
  assert.equal(await (await env.get(`${base}a/${locked.id}/`)).text(), NEUTRAL);
  assert.match((await env.load(`${base}a/${open.id}/`)).html, new RegExp(BODY));
});

test("a new passwordless folder share includes protected descendants until moved or revoked", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const elsewhere = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Other", slug: "other" }));
  const first = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Protected", html: HTML,
    slug: "protected", password: "original-gate", authorId: env.owner.id,
  }));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Group without a password",
  }));
  const base = urlPath(share.url);
  assert.match((await env.load(`${base}a/${first.id}/`)).html, new RegExp(BODY));
  const nested = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Later", parentId: folder.id }));
  const later = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: nested.id, title: "Later protected", html: OTHER_HTML,
    slug: "later-protected", password: "another-gate", authorId: env.owner.id,
  }));
  assert.match(await (await env.get(base)).text(), /Later protected/);
  assert.match((await env.load(`${base}a/${later.id}/`)).html, new RegExp(OTHER_BODY));
  await Effect.runPromise(env.artifacts.setPassword(first.id, "rotated-gate"));
  assert.match((await env.load(`${base}a/${first.id}/`)).html, new RegExp(BODY));
  await Effect.runPromise(env.artifacts.moveTo(first.id, elsewhere.id));
  assert.equal(await (await env.get(`${base}a/${first.id}/`)).text(), NEUTRAL);
  await Effect.runPromise(env.shares.revoke({ actorId: env.owner.id, id: share.id }));
  assert.equal(await (await env.get(`${base}a/${later.id}/`)).text(), NEUTRAL);
});

test("a folder share follows the subtree as it stands: later children in, moved-out documents out", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const nested = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Round two", slug: "round-two", parentId: folder.id }));
  const elsewhere = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Other", slug: "other" }));
  const first = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "First", html: HTML, slug: "first", authorId: env.owner.id,
  }));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client",
    recipient: "c@example.test", password: "pw",
  }));
  const base = urlPath(share.url);

  // Published into a subfolder AFTER the share was handed out: in scope, and openable.
  const later = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: nested.id, title: "Later", html: OTHER_HTML, slug: "later", authorId: env.owner.id,
  }));
  const opened = await env.unlock(`${base}a/${later.id}/`, "pw");
  assert.equal(opened.status, 200);
  assert.equal(await openAsRecipient(await opened.json(), "pw"), OTHER_HTML);

  // Moved out of the shared tree: gone immediately, and its wrap goes with it.
  await Effect.runPromise(env.artifacts.moveTo(first.id, elsewhere.id));
  assert.equal(await (await env.get(`${base}a/${first.id}/`)).text(), NEUTRAL);
  assert.equal((await env.unlock(`${base}a/${first.id}/`, "pw")).status, 404);
  const wraps = await env.DB.prepare("SELECT share_id FROM share_keys WHERE artifact_id = ?").bind(first.id).all();
  assert.equal(wraps.results.length, 0);
});

test("a token is good for its own path and its own scope, and nothing else", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const other = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Other", slug: "other" }));
  const inside = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Inside", html: HTML, slug: "inside", authorId: env.owner.id,
  }));
  const outside = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: other.id, title: "Outside", html: OTHER_HTML, slug: "outside", authorId: env.owner.id,
  }));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client", recipient: "c@example.test",
  }));
  const token = share.url.match(/\/s\/([0-9a-f]{40})\//)![1];

  // Right token, wrong target path.
  assert.equal(await (await env.get(`/other/s/${token}/`)).text(), NEUTRAL);
  // Right token and path, a document from another folder.
  assert.equal(await (await env.get(`/client/s/${token}/a/${outside.id}/`)).text(), NEUTRAL);
  // A token that was never minted.
  assert.equal(await (await env.get(`/client/s/${"f".repeat(40)}/`)).text(), NEUTRAL);
  // And the real thing still works, through the folder's alias as well as its slug.
  assert.match((await env.load(`/client/s/${token}/a/${inside.id}/`)).html, new RegExp(BODY));
  await Effect.runPromise(env.folders.rename(folder.id, "client-renamed"));
  assert.match((await env.load(`/client/s/${token}/a/${inside.id}/`)).html, new RegExp(BODY));
});

test("revocation, expiry and a missing wrap all close the door", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));
  const make = () => env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: "Client",
    recipient: "c@example.test", password: "pw",
  });

  const revoked = await Effect.runPromise(make());
  assert.equal(await Effect.runPromise(env.shares.revoke({ actorId: env.owner.id, id: revoked.id })), true);
  assert.equal(await Effect.runPromise(env.shares.revoke({ actorId: env.owner.id, id: revoked.id })), false);
  assert.equal(await (await env.get(urlPath(revoked.url))).text(), NEUTRAL);
  assert.equal((await env.unlock(urlPath(revoked.url), "pw")).status, 404);
  const left = await env.DB.prepare("SELECT share_id FROM share_keys WHERE share_id = ?").bind(revoked.id).all();
  assert.equal(left.results.length, 0, "a revoked share keeps no wrapped content key");

  const expired = await Effect.runPromise(make());
  await env.DB.prepare("UPDATE shares SET expires_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1000).toISOString(), expired.id).run();
  assert.equal(await (await env.get(urlPath(expired.url))).text(), NEUTRAL);
  assert.equal((await env.unlock(urlPath(expired.url), "pw")).status, 404);

  // Fail closed: a wrap that never synced is a closed door, not a document the master key opens.
  const unsynced = await Effect.runPromise(make());
  await env.DB.prepare("DELETE FROM share_keys WHERE share_id = ?").bind(unsynced.id).run();
  assert.equal(await (await env.get(urlPath(unsynced.url))).text(), NEUTRAL);
  assert.equal((await env.unlock(urlPath(unsynced.url), "pw")).status, 404);
});

test("managing a share needs manage on the target, checked live", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));
  const create = (actorId: string) => env.shares.create({
    actorId, kind: "folder", targetId: folder.id, name: "Client", recipient: "c@example.test",
  });

  await assert.rejects(Effect.runPromise(create(env.colleague.id)), ({ code: "forbidden" }));
  await assert.rejects(Effect.runPromise(env.shares.listFor({ actorId: env.colleague.id, kind: "folder", targetId: folder.id })), ({ code: "forbidden" }),);

  env.access.grantManage(env.colleague.id, folder.id);
  const share = await Effect.runPromise(create(env.colleague.id));
  assert.equal((await Effect.runPromise(env.shares.listFor({ actorId: env.colleague.id, kind: "folder", targetId: folder.id }))).length, 1);

  // The grant is read on every call, so losing it closes management again — the link the
  // colleague already created keeps working; only managing it stops.
  env.access.grantManage("nobody", folder.id);
  const stripped = accessDouble();
  const before = await Effect.runPromise(env.shares.byId(share.id));
  assert.ok(before);
  assert.equal(before.ownerId, env.owner.id, "a share belongs to the target's owner, not its creator");
  assert.equal(stripped === env.access, false);
  await assert.rejects(Effect.runPromise(env.shares.revoke({ actorId: "stranger00000000", id: share.id })), ({ code: "forbidden" }),);
});

test("only a top-level folder can be shared, and every share expires inside a year", async () => {
  const env = await environment();
  const parent = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Parent", slug: "parent" }));
  const child = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Child", slug: "child", parentId: parent.id }));

  await assert.rejects(Effect.runPromise(env.shares.create({ actorId: env.owner.id, kind: "folder", targetId: child.id, name: "Child", recipient: "c@example.test" })), ({ code: "folder-not-top-level" }),);
  await assert.rejects(Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: parent.id, name: "Parent", recipient: "c@example.test",
    expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
  })), ({ code: "invalid-expiry" }),);
  await assert.rejects(Effect.runPromise(env.shares.create({ actorId: env.owner.id, kind: "folder", targetId: parent.id, name: "Parent", recipient: "not-an-address" })), ({ code: "invalid-recipient" }),);
  // A link has to be called something, and that something stays a label.
  await assert.rejects(Effect.runPromise(env.shares.create({ actorId: env.owner.id, kind: "folder", targetId: parent.id, name: "   ", recipient: "c@example.test" })), ({ code: "invalid-name" }),);
  await assert.rejects(Effect.runPromise(env.shares.create({ actorId: env.owner.id, kind: "folder", targetId: parent.id, name: "x".repeat(161) })), ({ code: "invalid-name" }),);

  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: parent.id, name: "  Parent  ", recipient: "c@example.test",
  }));
  assert.equal(share.name, "Parent", "a name is stored as it will be read");
  const days = (Date.parse(share.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30.1, `default expiry is 30 days, got ${days}`);
});

test("wrong passwords lock one share, and the lockout is audited", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));
  const mine = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: "First",
    recipient: "a@example.test", password: "pw-a",
  }));
  const theirs = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: "Second",
    recipient: "b@example.test", password: "pw-b",
  }));

  for (let i = 0; i < 4; i++) await env.unlock(urlPath(mine.url), "wrong");
  const lockedOut = await env.unlock(urlPath(mine.url), "pw-a");
  assert.equal(lockedOut.status, 429);
  assert.ok(Number(lockedOut.headers.get("Retry-After")) > 0);

  // The other recipient's link is untouched by this one's failures.
  assert.equal((await env.unlock(urlPath(theirs.url), "pw-b")).status, 200);

  const audit = await Effect.runPromise(env.store.audit.recent(20));
  const row = audit.find((entry) => entry.action === "share.lockout");
  assert.ok(row, "the lockout is on the trail");
  assert.ok(row.detail);
  const detail: unknown = JSON.parse(row.detail);
  assert.ok(detail && typeof detail === "object" && "shareId" in detail);
  assert.equal(detail.shareId, mine.id);
  assert.equal(audit.some((entry) => JSON.stringify(entry).includes(urlPath(mine.url).split("/s/")[1])), false,
    "a bearer token never reaches the audit trail");
});

test("the invitation goes out only when it was asked for, and never carries the password", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));

  const quiet = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: LABEL,
    recipient: "quiet@example.test", password: "pw",
  }));
  assert.equal(env.mailer.sent.length, 0);
  assert.equal(quiet.lastSentAt, null);

  const mailed = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: LABEL,
    recipient: "loud@example.test", password: "hunter2", sendMail: true,
  }));
  assert.equal(env.mailer.sent.length, 1);
  const message = env.mailer.sent[0];
  assert.equal(message.to, "loud@example.test");
  assert.ok(message.text.includes(mailed.url));
  assert.equal(message.text.includes("hunter2"), false, "a link and its password never travel together");
  assert.equal(JSON.stringify(message).includes(LABEL), false, "the sender's own label is not sent to the recipient");
  assert.ok(mailed.lastSentAt, "a sent invitation is recorded");
});

test("a named link may have nobody to send it to, and a send that was asked for must have one", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));

  // The case a name exists for: one link for a whole group, handed over by the sender.
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: LABEL,
  }));
  assert.equal(share.name, LABEL);
  assert.equal(share.recipient, "", "no address asked for, none invented");
  assert.equal(share.mailStatus, "not-requested");
  assert.equal(env.mailer.sent.length, 0);
  assert.match((await env.load(`${urlPath(share.url)}a/${artifact.id}/`)).html, new RegExp(BODY));

  // Asking to send with nobody to send to fails before the token exists, so no live link is
  // left behind while its sender believes the invitation went out.
  await assert.rejects(Effect.runPromise(env.shares.create({ actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Nobody", sendMail: true })), ({ code: "recipient-required" }),);
  assert.equal((await env.DB.prepare("SELECT id FROM shares").all()).results.length, 1, "a refused send mints nothing");
  assert.equal(env.mailer.sent.length, 0);

  const trail = await Effect.runPromise(env.store.audit.recent(20));
  assert.equal(JSON.stringify(trail).includes(LABEL), false, "a share name never reaches the audit trail");
});

test("a share minted before names is read under the address it went to", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));
  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: LABEL, recipient: "old@example.test",
  }));

  // The envelope shape that shipped before a share had a name: the address, and nothing else.
  await env.DB.prepare("UPDATE shares SET recipient_sealed = ? WHERE id = ?")
    .bind(await Effect.runPromise(scalarSeal(MASTER, { e: "old@example.test" })), share.id).run();

  const [listed] = await Effect.runPromise(env.shares.listFor({ actorId: env.owner.id, kind: "folder", targetId: folder.id }));
  assert.equal(listed.name, "old@example.test", "an older row is labelled by the address it was sent to");
  assert.equal(listed.recipient, "old@example.test");
  assert.equal(listed.url, share.url, "deriving the name on read moves no link");
  assert.equal((await Effect.runPromise(env.shares.byId(share.id)))?.name, "old@example.test");
  assert.match((await env.load(`${urlPath(share.url)}a/${artifact.id}/`)).html, new RegExp(BODY));
});

test("a measurement proof reaches the browser only with the document it measures", async () => {
  const proofs: Array<{ shareId: string; artifactId: string }> = [];
  const env = await environment();
  const proof = env.ctx.analytics.proof;
  env.ctx.analytics.proof = (input) => Effect.gen(function* () {
    const sealed = yield* proof(input);
    proofs.push(input);
    return sealed;
  });
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id,
  }));

  // Ungated: only the authorized load carries an observation proof, never the wrapper.
  const openShare = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client", recipient: "c@example.test",
  }));
  const openToken = openShare.url.match(/\/s\/([0-9a-f]{40})\//)![1];
  const wrapper = await (await env.get(`/client/s/${openToken}/a/${artifact.id}/`)).text();
  assert.equal(wrapper.includes(BODY), false);
  assert.equal(proofs.length, 0);
  const served = await env.load(`/client/s/${openToken}/a/${artifact.id}/`);
  assert.ok(served.observation);
  assert.equal(proofs.length, 1);
  assert.equal(wrapper.includes(served.observation.proof), false);
  assert.equal(served.observation.path, "client");

  // Gated: nothing measurable leaves before the password checks out.
  const gatedShare = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client",
    recipient: "c@example.test", password: "pw",
  }));
  const gatedPath = urlPath(gatedShare.url);
  const gatePageBody = await (await env.get(`${gatedPath}a/${artifact.id}/`)).text();
  assert.equal(proofs.length, 1);
  const wrong = await env.unlock(gatedPath, "wrong");
  assert.equal(wrong.status, 401);
  assert.equal(proofs.length, 1);
  const payload = await (await env.unlock(`${gatedPath}a/${artifact.id}/`, "pw")).json() as ShareOpenResponse;
  assert.equal(proofs.length, 2);
  assert.ok(payload.observation);
  assert.ok(payload.observation.proof);
  assert.equal(gatePageBody.includes(payload.observation.proof), false);
  assert.equal(payload.observation.token, gatedShare.url.match(/\/s\/([0-9a-f]{40})\//)![1]);

  // The folder index is not a document, so it is not measured.
  const index = await (await env.unlock(gatedPath, "pw")).json() as ShareIndexResponse;
  assert.ok(Array.isArray(index.index));
  assert.equal(proofs.length, 2);
  assert.ok(proofs.every((entry) => entry.artifactId === artifact.id));
});

test("the router hands share paths to the share handlers, and leaves everything else alone", async () => {
  const token = "a".repeat(40);
  assert.deepEqual({ ...route("GET", `/deck/s/${token}/`)!.params }, { path: "deck", token, artefact: undefined });
  assert.equal(route("GET", `/deck/s/${token}/`)!.handler, "share");
  assert.deepEqual({ ...route("GET", `/client/s/${token}/a/1a2b3c4d5e6f70819200/`)!.params },
    { path: "client", token, artefact: "1a2b3c4d5e6f70819200" });
  // The 1.x two-segment link may carry a share too — an alias that stopped working would
  // break the very promise a share is built on.
  assert.equal(route("GET", `/folder-token/art-token/s/${token}/`)!.handler, "share");
  assert.equal(route("POST", `/_gate/deck/s/${token}/`)!.handler, "shareGate");
  assert.equal(route("POST", `/_gate/deck/s/${token}/a/abc/`)!.handler, "shareGate");
  // Unchanged neighbours: the plain gate, the plain viewer, the console.
  assert.equal(route("POST", "/_gate/deck")!.handler, "gate");
  assert.equal(route("GET", "/deck/")!.handler, "viewer");
  assert.equal(route("GET", "/app/artefacts")!.handler, "console");
});

test("share creation is lazy and a failed wrap removes the unservable invitation", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, title: "Deck", html: HTML, authorId: env.owner.id }));
  const failure = Object.assign(new Error("Content key unavailable."), { code: "secrets-auth" });
  const shares = openShares({ db: env.DB, masterKeyHex: MASTER, folders: env.folders, access: env.access,
    artifacts: { ...env.artifacts, contentKey: () => Effect.fail(failure) } });
  const invitation = shares.create({ actorId: env.owner.id, kind: "artifact", targetId: artifact.id, name: "Recipient", password: "pw" });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM shares").first<{ n: number }>())!.n, 0);
  await assert.rejects(Effect.runPromise(invitation), (error) => error === failure);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM shares").first<{ n: number }>())!.n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM share_keys").first<{ n: number }>())!.n, 0);
});

test("an invitation mail failure preserves its live link and does not expose recipient data in the audit", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, title: "Deck", html: HTML, authorId: env.owner.id }));
  const shares = openShares({ db: env.DB, masterKeyHex: MASTER, artifacts: env.artifacts, folders: env.folders,
    access: env.access, audit: env.store.audit, publicOrigin: "https://artefacts.example",
    mailer: { send: () => Effect.fail(Object.assign(new Error("SMTP unavailable."), { code: "smtp-unavailable" })) } });
  const share = await Effect.runPromise(shares.create({ actorId: env.owner.id, kind: "artifact", targetId: artifact.id,
    name: LABEL, recipient: "private-recipient@example.test", sendMail: true }));
  assert.equal(share.mailStatus, "failed");
  assert.equal(share.lastSentAt, null);
  assert.match((await env.load(urlPath(share.url))).html, new RegExp(BODY));
  const trail = await Effect.runPromise(env.store.audit.recent());
  assert.ok(trail.some((row) => row.action === "share.mail-failed"));
  assert.equal(JSON.stringify(trail).includes("private-recipient@example.test"), false);
  assert.equal(JSON.stringify(trail).includes(LABEL), false);
});

test("share gates reject unreadable bodies and failed limiter checks without releasing keys", async (t) => {
  const env = await environment();
  t.after(() => env.DB.close());
  const artifact = await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, title: "Deck", html: HTML, slug: "deck", authorId: env.owner.id }));
  const share = await Effect.runPromise(env.shares.create({ actorId: env.owner.id, kind: "artifact", targetId: artifact.id,
    name: LABEL, password: "pw" }));
  const path = urlPath(share.url);
  const gateBody = (body: string) => Effect.runPromise(handleShareGate(new Request(`https://artefacts.example/_gate${path}`, {
    method: "POST", headers: { "content-type": "application/json", Origin: "https://artefacts.example" }, body,
  }), env.ctx, params(path)));
  for (const [body, status] of [["{", 400], [JSON.stringify({ password: { toString: null } }), 400], [JSON.stringify({ password: "x".repeat(8193) }), 413]] as const) {
    const response = await gateBody(body);
    assert.equal(response.status, status);
    const rejected: unknown = await response.json();
    assert.ok(rejected && typeof rejected === "object" && !("wrap" in rejected) && !("content" in rejected) && !("runtime" in rejected));
  }

  const limiter: RateLimiter = env.ctx.limiter;
  const failure = Object.assign(new Error("Rate storage unavailable."), { code: "storage-unavailable" });
  env.ctx.limiter = { ...limiter, check: () => Effect.fail(failure) };
  const failedCheck = await env.unlock(path, "pw");
  assert.equal(failedCheck.status, 503);
  assert.deepEqual(await failedCheck.json(), { error: "unavailable" });
  env.ctx.limiter = { ...limiter, hit: () => Effect.fail(failure) };
  const failedHit = await env.unlock(path, "wrong");
  assert.equal(failedHit.status, 503);
  assert.deepEqual(await failedHit.json(), { error: "unavailable" });

  // Only reset is best-effort, and only after the password is verified.
  env.ctx.limiter = { ...limiter, reset: () => Effect.fail(failure) };
  const opened = await env.unlock(path, "pw");
  assert.equal(opened.status, 200);
  const payload = await opened.json() as ShareGatePayload;
  assert.equal(await openAsRecipient(payload, "pw"), HTML);
});

test("creating a password-protected folder share succeeds when its subtree contains a deleted artefact", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const live = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Live", html: HTML, authorId: env.owner.id,
  }));
  const deleted = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Withdrawn", html: OTHER_HTML, authorId: env.owner.id,
  }));
  await Effect.runPromise(env.artifacts.remove(deleted.id, { authorId: env.owner.id }));

  const share = await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client visitors", password: "visitor-password",
  }));
  assert.equal(share.gated, true);
  assert.deepEqual((await Effect.runPromise(env.shares.contents(share.id))).map((artifact) => artifact.id), [live.id]);
});

test("moving a shared folder succeeds when its subtree contains a deleted artefact", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Client", slug: "client" }));
  const destination = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Other", slug: "other" }));
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Live", html: HTML, authorId: env.owner.id,
  }));
  const deleted = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Withdrawn", html: OTHER_HTML, authorId: env.owner.id,
  }));
  await Effect.runPromise(env.shares.create({
    actorId: env.owner.id, kind: "folder", targetId: folder.id, name: "Client visitors", password: "visitor-password",
  }));
  await Effect.runPromise(env.artifacts.remove(deleted.id, { authorId: env.owner.id }));
  env.folders.onChange = (folderId) => env.shares.syncFolder(folderId);

  const moved = await Effect.runPromise(env.folders.setParent(folder.id, destination.id));
  assert.equal(moved.parentId, destination.id);
});
