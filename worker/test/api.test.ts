import * as Effect from "effect/Effect";
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding, openAsVisitor, authoredDocument } from "./doubles.js";
import { openStore, type Store } from "../src/store.js";
import { openKeys, type Key } from "../src/keys.js";
import { openAccess } from "../src/access.js";
import { API_BODY_LIMIT } from "../src/api.js";
import type { GatePayload } from "../src/artifacts.js";
import type { ValidationIssue } from "../src/validate.js";

interface ApiOptions { key?: string; method?: string; body?: unknown; headers?: Record<string, string> }
interface ArtifactDto {
  id: string; slug: string | null; title: string; lang: string; path: string; url: string;
  gated: boolean; version: number;
  folder: { id: string; slug: string | null; path: string; indexUrl: string };
}
interface PublishedResponse { artifact: ArtifactDto; artifacts?: never; warnings: ValidationIssue[] }
interface ArtifactListResponse { artifacts: ArtifactDto[] }
interface KeyResponse { key: Key; token: string }
interface KeyListResponse { keys: Key[] }
interface FolderDto { slug: string | null; path: string; artifacts: number }
interface FolderListResponse { folders: FolderDto[] }
interface ArtifactAliasResponse { artifact: Pick<ArtifactDto, "slug" | "path">; aliases: string[] }
interface FolderAliasResponse { folder: Pick<FolderDto, "slug" | "path">; aliases: string[] }
interface ErrorResponse { error: { code: string; message: string; details?: ValidationIssue[] } }

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><meta charset="utf-8"><title>Upute</title></head><body><h1>Bok</h1></body></html>`;
const HTML2 = HTML.replace("<h1>Bok</h1>", "<h1>Drugo izdanje</h1>");

/** One Worker environment plus a minted master key for the owner. */
async function environment() {
  const DB = openD1Shim();
  const store = openStore(DB);
  const bucket = memoryBucket();
  const limiter = rateLimitBinding();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner",
    passwordHash: "{}",
  }));
  const keys = openKeys({ db: DB, audit: store.audit, access: openAccess({ db: DB, audit: store.audit }) });
  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master", label: "Agent" }));
  const env = { DB, ARTIFACTS: bucket, ARTEFACTS_MASTER_KEY: MASTER, RATELIMIT: limiter };
  const session = await Effect.runPromise(store.sessions.create(owner.id, { pending2fa: false }));
  const fetch = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Cookie")) headers.set("Cookie", `wsa_session=${session.id}`);
    if (init.method === "POST" && !headers.has("Origin")) headers.set("Origin", "https://example.test");
    return worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), env);
  };
  const api = (path: string, { key = master.key, method = "GET", body, headers = {} }: ApiOptions = {}) =>
    fetch(path, {
      method,
      headers: body
        ? { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }
        : { authorization: `Bearer ${key}`, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const publish = (body: unknown, options: ApiOptions = {}) => api("/_api/artifacts", { method: "POST", body, ...options });
  const load = async (path: string) => {
    const response = await fetch("/_runtime/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "public", path } }),
    });
    assert.equal(response.status, 200);
    return authoredDocument((await response.json<{ html: string }>()).html);
  };
  return { DB, store, bucket, limiter, owner, keys, master, api, fetch, publish, load };
}

const addUser = (store: Store, id: string, email: string) =>
  store.users.create({ id, email, name: id, role: "member", passwordHash: "{}" });

test("publishing is synchronous: the artefact is live in the same request", async () => {
  const env = await environment();
  const created = await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, lang: "hr" });

  assert.equal(created.status, 201);
  const body = await created.json<PublishedResponse>();
  assert.equal(body.artifacts, undefined);
  assert.equal(body.artifact.slug, "upute");
  assert.equal(body.artifact.lang, "hr");
  assert.equal(body.artifact.version, 1);
  assert.equal(body.artifact.gated, false);
  assert.equal(body.artifact.url, "https://example.test/upute/");
  assert.equal(body.artifact.path, "/upute/");
  assert.equal(body.artifact.folder.slug, "acme");
  assert.equal(body.artifact.folder.indexUrl, "https://example.test/acme/");
  assert.deepEqual(body.warnings, []);

  // The owner can read the new private address immediately — no poll, no deploy.
  const served = await env.fetch("/upute/");
  assert.equal(served.status, 200);
  assert.equal((await served.text()).includes("<h1>Bok</h1>"), false);
  assert.equal(await env.load("upute"), HTML);
  // ...and the folder it auto-created is the index that lists it.
  const index = await env.fetch("/acme/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Upute/);
});

test("re-publishing the same (folder, slug) updates in place and never moves the link", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });

  const updated = await env.publish({ folder: "acme", slug: "upute", title: "Upute, drugo izdanje", html: HTML2 });
  assert.equal(updated.status, 200);                       // 201 creates, 200 updates
  const body = await updated.json<PublishedResponse>();
  assert.equal(body.artifact.version, 2);
  assert.equal(body.artifact.url, "https://example.test/upute/");
  assert.equal(body.artifact.title, "Upute, drugo izdanje");
  assert.equal(await env.load("upute"), HTML2);

  const listed = await (await env.api("/_api/artifacts")).json<ArtifactListResponse>();
  assert.equal(listed.artifacts.length, 1);                // one artefact, two versions
});

test("a gated artefact publishes straight into a gate a visitor can open", async () => {
  const env = await environment();
  const created = await env.publish({ folder: "acme", slug: "tajno", title: "Tajno", html: HTML, password: "tajna-lozinka" });
  assert.equal(created.status, 201);
  assert.equal((await created.json<PublishedResponse>()).artifact.gated, true);

  const page = await env.fetch("/tajno/");
  assert.equal(page.status, 200);
  assert.equal((await page.text()).includes("<h1>Bok</h1>"), false);        // no ciphertext in the page

  const opened = await env.fetch("/_gate/tajno/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "tajna-lozinka" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json<GatePayload>(), "tajna-lozinka")), HTML);
});

test("the validator rejects what the platform cannot serve", async () => {
  const env = await environment();
  const cases = [
    [{ folder: "acme", slug: "bez-doctype", title: "X", html: "<p>nije dokument</p>" }, "incomplete-document"],
    [{ folder: "acme", slug: "vanjski", title: "X", html: `${HTML}<img src="https://cdn.example.test/a.png">` }, "external-reference"],
    [{ folder: "acme", slug: "slaba", title: "X", html: HTML, password: "kratko" }, "weak-password"],
  ];
  for (const [body, code] of cases) {
    const response = await env.publish(body);
    assert.equal(response.status, 422, `${code} should be rejected`);
    const payload = await response.json<ErrorResponse>();
    assert.equal(payload.error.code, "validation");
    assert.equal(payload.error.details?.some((issue) => issue.code === code), true, `expected ${code}`);
  }

  const missing = await env.publish({ folder: "acme", title: "X", html: HTML });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json<ErrorResponse>()).error.details?.some((issue) => issue.code === "invalid-slug"), true);

  const notJson = await env.api("/_api/artifacts", { method: "POST", body: HTML });
  assert.equal(notJson.status, 422);                       // a bare string is not a JSON object
});

test("an artifact key reaches its one artefact and nothing else", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  await env.publish({ folder: "acme", slug: "drugo", title: "Drugo", html: HTML });

  const minted = await env.api("/_api/keys", {
    method: "POST",
    body: { artifact: "upute", scopes: "read", label: "Acme integracija" },
  });
  assert.equal(minted.status, 201);
  const { key, token } = await minted.json<KeyResponse>();
  assert.match(token, /^waa_[a-f0-9]{40}$/);
  assert.equal(key.kind, "artifact");
  assert.equal(key.label, "Acme integracija");
  assert.equal(key.prefix, token.slice(0, 8));
  assert.equal(JSON.stringify(key).includes("token"), false);
  assert.equal(JSON.stringify(key).includes(token.slice(10)), false);      // only the prefix, never the secret

  const listed = await env.api("/_api/artifacts", { key: token });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json<ArtifactListResponse>()).artifacts.map((a) => a.slug), ["upute"]);

  // Scoped to read: no publish, no rotate, no folder listing, and no minting on its own behalf.
  assert.equal((await env.publish({ folder: "acme", slug: "upute", title: "X", html: HTML }, { key: token })).status, 403);
  assert.equal((await env.api("/_api/folders", { key: token })).status, 403);
  assert.equal((await env.api("/_api/keys", { key: token })).status, 403);
  assert.equal((await env.api("/_api/artifacts/rotate", { key: token, method: "POST", body: { artifact: "upute", password: "novalozinka" } })).status, 403);

  // A write-scoped artifact key still cannot touch the sibling artefact.
  const writer = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read_write" } })).json<KeyResponse>();
  assert.equal((await env.api("/_api/artifacts/rotate", { key: writer.token, method: "POST", body: { artifact: "drugo", password: null } })).status, 403);
});

test("keys list without their secret, and revocation bites immediately", async () => {
  const env = await environment();
  const nameless = await env.api("/_api/keys", { method: "POST", body: { artifact: null } });
  assert.equal(nameless.status, 404);                              // an artifact key is always bound
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  const real = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read" } })).json<KeyResponse>();

  const list = await (await env.api("/_api/keys")).json<KeyListResponse>();
  assert.equal(list.keys.some((k) => k.kind === "master"), true);
  assert.equal(list.keys.some((k) => k.id === real.key.id), true);
  for (const k of list.keys) {
    assert.equal(Object.hasOwn(k, "tokenHash"), false);
    assert.equal(Object.hasOwn(k, "token_hash"), false);
  }

  const revoked = await env.api(`/_api/keys/${real.key.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true, id: real.key.id });
  assert.equal((await env.api("/_api/artifacts", { key: real.token })).status, 401);   // dead at once
  assert.equal((await env.api(`/_api/keys/${real.key.id}`, { method: "DELETE" })).status, 404);
});

test("rotation replaces the document and the gate, keeping the link", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, password: "stara-lozinka" });

  const rotated = await env.api("/_api/artifacts/rotate", {
    method: "POST",
    body: { artifact: "upute", html: HTML2, password: "nova-lozinka" },
  });
  assert.equal(rotated.status, 200);
  const body = await rotated.json<PublishedResponse>();
  assert.equal(body.artifact.path, "/upute/");
  assert.equal(body.artifact.gated, true);
  assert.equal(authoredDocument(await openAsVisitor(await (await env.fetch("/_gate/upute/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nova-lozinka" }),
  })).json<GatePayload>(), "nova-lozinka")), HTML2);

  // Omitted password leaves the gate alone; `null` clears it.
  const kept = await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", html: HTML } });
  assert.equal((await kept.json<PublishedResponse>()).artifact.gated, true);
  const cleared = await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", password: null } });
  assert.equal((await cleared.json<PublishedResponse>()).artifact.gated, false);
  assert.equal(await env.load("upute"), HTML);

  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", password: "kratko" } })).status, 422);
  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { password: "dovoljno-duga" } })).status, 422);
  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "nema-me", password: null } })).status, 404);
});

test("a master key may opt into a weak password; a scoped key never may", async () => {
  const env = await environment();

  // Without the flag, the floor is exactly what it always was.
  const refused = await env.publish({ folder: "acme", slug: "zastita", title: "Zaštita", html: HTML, password: "ws" });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json<ErrorResponse>()).error.details?.some((issue) => issue.code === "weak-password"), true);

  // With the flag, the master key publishes below the floor — and only that issue drops.
  const created = await env.publish({ folder: "acme", slug: "zastita", title: "Zaštita", html: HTML, password: "ws", allow_weak_password: true });
  assert.equal(created.status, 201);
  assert.equal((await created.json<PublishedResponse>()).artifact.gated, true);

  // The weak password really holds the gate: it opens through the released payload the way
  // a browser decrypts it, and the path serves the gate page — not the document, and not
  // the neutral page an unknown path answers with.
  const opened = await env.fetch("/_gate/zastita/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "ws" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json<GatePayload>(), "ws")), HTML);
  const pageBody = await (await env.fetch("/zastita/")).text();
  assert.equal(pageBody.includes("<h1>Bok</h1>"), false);

  // A write-scoped artifact key on its own artefact would sail through without the check —
  // the opt-in is what it may never widen.
  const minted = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "zastita", scopes: "write" } })).json<KeyResponse>();
  const widened = await env.publish(
    { folder: "acme", slug: "zastita", title: "Zaštita", html: HTML2, password: "no", allow_weak_password: true },
    { key: minted.token },
  );
  assert.equal(widened.status, 403);
  assert.equal((await (await env.api("/_api/artifacts")).json<ArtifactListResponse>()).artifacts[0].version, 1);   // nothing published
  assert.equal(authoredDocument(await openAsVisitor(await (await env.fetch("/_gate/zastita/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "ws" }),
  })).json<GatePayload>(), "ws")), HTML);

  // The audit row shows the platform accepted the weak password on purpose.
  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.create'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "weakPassword" in detail && detail.weakPassword === true;
  }), true);
});

test("rotate honours the same opt-in, and audits it the same way", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, password: "duga-lozinka" });

  const refused = await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", password: "ws" } });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json<ErrorResponse>()).error.details?.some((issue) => issue.code === "invalid-password"), true);

  const rotated = await env.api("/_api/artifacts/rotate", {
    method: "POST", body: { artifact: "upute", password: "ws", allow_weak_password: true },
  });
  assert.equal(rotated.status, 200);

  const opened = await env.fetch("/_gate/upute/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "ws" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json<GatePayload>(), "ws")), HTML);

  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.rotate'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "weakPassword" in detail && detail.weakPassword === true;
  }), true);
});

test("another user's artefacts and folders are untouchable", async () => {
  const env = await environment();
  const other = await Effect.runPromise(addUser(env.store, "member00000000a2", "member@example.test"));
  const theirKey = await Effect.runPromise(env.keys.mint({ userId: other.id, kind: "master", scopes: "master" }));

  await env.publish({ folder: "acme", slug: "moj", title: "Moj", html: HTML });
  await env.publish({ folder: "tudji-folder", slug: "tudji", title: "Tuđi", html: HTML }, { key: theirKey.key });

  // Slug collision across owners is a conflict, and their folder is not even visible.
  assert.equal((await env.publish({ folder: "tudji-folder", slug: "tudji", title: "X", html: HTML })).status, 403);
  assert.equal((await env.publish({ folder: "acme", slug: "tudji", title: "X", html: HTML })).status, 409);
  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "tudji", password: null } })).status, 403);

  const folders = await (await env.api("/_api/folders")).json<FolderListResponse>();
  assert.deepEqual(folders.folders.map((f) => f.slug), ["acme"]);
  assert.equal(folders.folders[0].artifacts, 1);
  const listed = await (await env.api("/_api/artifacts")).json<ArtifactListResponse>();
  assert.deepEqual(listed.artifacts.map((a) => a.slug), ["moj"]);
});

test("a retired artefact path keeps resolving to the artefact that recorded it", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });

  const aliased = await env.api("/_api/artifacts/alias", {
    method: "POST", body: { artifact: "upute", paths: ["klijent2023/upute-za-pristup"] },
  });
  assert.equal(aliased.status, 200);
  const body = await aliased.json<ArtifactAliasResponse>();
  assert.deepEqual(body.aliases, ["klijent2023/upute-za-pristup"]);
  assert.equal(body.artifact.slug, "upute");
  assert.equal(body.artifact.path, "/upute/");

  // The 1.x link serves the artefact itself — not the neutral page an unknown path gets.
  const served = await env.fetch("/klijent2023/upute-za-pristup/");
  assert.equal(served.status, 200);
  assert.equal(await env.load("klijent2023/upute-za-pristup"), HTML);

  // Recording the same path on the same artefact is the idempotent no-op it always was.
  assert.equal((await env.api("/_api/artifacts/alias", {
    method: "POST", body: { artifact: "upute", paths: ["klijent2023/upute-za-pristup"] },
  })).status, 200);

  // The audit row carries the recorded paths.
  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.alias'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "paths" in detail &&
      Array.isArray(detail.paths) && detail.paths.includes("klijent2023/upute-za-pristup");
  }), true);

  // Another user's artefact is untouchable, even by their master key.
  const other = await Effect.runPromise(addUser(env.store, "member00000000a3", "member2@example.test"));
  const theirKey = await Effect.runPromise(env.keys.mint({ userId: other.id, kind: "master", scopes: "master" }));
  assert.equal((await env.api("/_api/artifacts/alias", {
    key: theirKey.key, method: "POST", body: { artifact: "upute", paths: ["njihova-stara"] },
  })).status, 403);

  // Malformed paths are refused on the `paths` field before anything is recorded.
  for (const bad of ["a/b/c", "", "UPPER"]) {
    const response = await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "upute", paths: [bad] } });
    assert.equal(response.status, 422, `${JSON.stringify(bad)} should be invalid`);
    assert.equal((await response.json<ErrorResponse>()).error.details?.[0]?.field, "paths");
  }
  assert.equal((await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "upute", paths: [] } })).status, 422);

  // An unknown target is a 404; a path another artefact answers to is a 409.
  assert.equal((await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "nema-me", paths: ["neka-stara"] } })).status, 404);
  await env.publish({ folder: "acme", slug: "drugo", title: "Drugo", html: HTML2 });
  assert.equal((await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "upute", paths: ["drugo"] } })).status, 409);
});

test("a folder's retired path serves the folder index, master keys only", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });

  const aliased = await env.api("/_api/folders/alias", { method: "POST", body: { folder: "acme", paths: ["stari-klijent"] } });
  assert.equal(aliased.status, 200);
  const body = await aliased.json<FolderAliasResponse>();
  assert.deepEqual(body.aliases, ["stari-klijent"]);
  assert.equal(body.folder.slug, "acme");
  assert.equal(body.folder.path, "/acme/");

  const index = await env.fetch("/stari-klijent/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Upute/);

  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'folder.alias'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "paths" in detail &&
      Array.isArray(detail.paths) && detail.paths.includes("stari-klijent");
  }), true);

  // A scoped key sees no folders, so it records none — mirroring GET /_api/folders.
  const minted = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read_write" } })).json<KeyResponse>();
  assert.equal((await env.api("/_api/folders/alias", {
    key: minted.token, method: "POST", body: { folder: "acme", paths: ["bilo-sta"] },
  })).status, 403);

  // The same error spine as the artefact route.
  assert.equal((await env.api("/_api/folders/alias", { method: "POST", body: { folder: "nema-me", paths: ["neki-path"] } })).status, 404);
  const malformed = await env.api("/_api/folders/alias", { method: "POST", body: { folder: "acme", paths: ["UPPER"] } });
  assert.equal(malformed.status, 422);
  assert.equal((await malformed.json<ErrorResponse>()).error.details?.[0]?.field, "paths");
  await env.publish({ folder: "drugi", slug: "clanak", title: "Članak", html: HTML });
  assert.equal((await env.api("/_api/folders/alias", { method: "POST", body: { folder: "acme", paths: ["drugi"] } })).status, 409);
});

test("no key, no entry — but the contract is public", async () => {
  const env = await environment();
  assert.equal((await env.fetch("/_api/artifacts")).status, 401);
  assert.equal((await env.fetch("/_api/artifacts", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await env.fetch("/_api/nema-ovoga")).status, 401);

  const contract = await env.fetch("/_api/contract");
  assert.equal(contract.status, 200);
  const contentType = contract.headers.get("content-type");
  assert.ok(contentType);
  assert.match(contentType, /text\/markdown/);
  assert.equal((await contract.text()).includes("/_api/artifacts"), true);
  assert.equal((await env.fetch("/instructions")).status, 200);
});

test("an internal failure still answers the documented envelope", async () => {
  // A database that throws: the API must not hand an agent a shape it was never told about.
  const broken = {
    DB: {
      prepare: () => { throw new Error("boom"); },
      batch: () => { throw new Error("boom"); },
    },
    ARTIFACTS: memoryBucket(),
    ARTEFACTS_MASTER_KEY: MASTER,
    RATELIMIT: rateLimitBinding(),
  };
  const response = await worker.fetch(new Request("https://example.test/_api/artifacts", {
    headers: { authorization: "Bearer wak_0000000000000000000000000000000000000000" },
  }), broken);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json<ErrorResponse>(), {
    error: { code: "internal", message: "The platform could not complete the request." },
  });
});

test("the publish rate limit is enforced per key, and its outage fails closed", async () => {
  const env = await environment();
  const body = { folder: "acme", slug: "upute", title: "Upute", html: HTML };
  assert.equal((await env.publish(body)).status, 201);

  let last: Response | null = null;
  for (let i = 0; i < 30; i++) last = await env.publish({ ...body, title: `Upute ${i + 2}` });
  assert.ok(last);
  assert.equal(last.status, 429);
  assert.equal((await last.json<ErrorResponse>()).error.code, "rate-limited");
  assert.ok(Number(last.headers.get("retry-after")) > 0);

  // A limiter that cannot be reached is a 503, never an open door. A fresh environment is
  // required: the runtime is cached per D1 binding, so reusing this one's DB would keep the
  // healthy limiter alive.
  const brokenDB = openD1Shim();
  const brokenStore = openStore(brokenDB);
  const brokenOwner = await Effect.runPromise(brokenStore.users.create({
    id: "owner0000000000a2", email: "broken@example.test", name: "Broken", role: "owner", passwordHash: "{}",
  }));
  const brokenMaster = await Effect.runPromise(openKeys({
    db: brokenDB, audit: brokenStore.audit, access: openAccess({ db: brokenDB, audit: brokenStore.audit }),
  }).mint({ userId: brokenOwner.id, kind: "master", scopes: "master" }));
  const broken = {
    DB: brokenDB, ARTIFACTS: memoryBucket(), ARTEFACTS_MASTER_KEY: MASTER,
    RATELIMIT: { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("down"); } }) },
  };
  const response = await worker.fetch(new Request("https://example.test/_api/artifacts", {
    method: "POST",
    headers: { authorization: `Bearer ${brokenMaster.key}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "acme", slug: "novi", title: "Novi", html: HTML }),
  }), broken);
  assert.equal((await response.json<ErrorResponse>()).error.code, "unavailable");
});

test("JSON and body-cap refusals keep the API envelope and write nothing", async () => {
  const env = await environment();
  const headers = { authorization: `Bearer ${env.master.key}`, "content-type": "application/json" };
  const malformed = await env.fetch("/_api/artifacts", { method: "POST", headers, body: "{" });
  assert.equal(malformed.status, 422);
  assert.deepEqual(await malformed.json(), {
    error: { code: "validation", message: "Request body is not valid JSON." },
  });
  const oversized = await env.fetch("/_api/artifacts", {
    method: "POST", headers: { ...headers, "content-length": String(API_BODY_LIMIT + 1) }, body: "{}",
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: { code: "too-large", message: `Request body exceeds ${API_BODY_LIMIT} bytes.` },
  });
  const primitive = await env.fetch("/_api/artifacts", { method: "POST", headers, body: "null" });
  assert.equal(primitive.status, 422);
  assert.deepEqual((await primitive.json<ErrorResponse>()).error.details, [
    { code: "invalid-payload", message: "request body must be a JSON object" },
  ]);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first<{ count: number }>()?.count, 0);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first<{ count: number }>()?.count, 0);
});

test("key model refusals are validation responses and rotation revokes the old secret", async () => {
  const env = await environment();
  assert.equal((await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML })).status, 201);
  for (const body of [
    { artifact: "upute", scopes: "master" },
    { artifact: "upute", scopes: "read", label: "" },
  ]) {
    const refused = await env.api("/_api/keys", { method: "POST", body });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json<ErrorResponse>()).error.code, "validation");
  }
  const minted = await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read" } });
  const original = await minted.json<KeyResponse>();
  const response = await env.api("/_api/keys/rotate", { method: "POST", body: { id: original.key.id } });
  assert.equal(response.status, 200);
  const rotated = await response.json<KeyResponse>();
  assert.equal(rotated.key.id, original.key.id);
  assert.notEqual(rotated.token, original.token);
  assert.equal(rotated.key.artifactId, original.key.artifactId);
  assert.equal(rotated.key.scopes, "read");
  assert.equal(Object.hasOwn(rotated.key, "tokenHash"), false);
  assert.equal((await env.api("/_api/artifacts", { key: original.token })).status, 401);
  assert.equal((await env.api("/_api/artifacts", { key: rotated.token })).status, 200);
  assert.equal((await env.api("/_api/keys/rotate", { method: "POST", body: { id: "missing" } })).status, 404);
});