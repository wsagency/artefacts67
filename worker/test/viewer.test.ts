import * as Effect from "effect/Effect";
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding, openAsVisitor } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openArtifacts } from "../src/artifacts.js";
import { openFolders } from "../src/folders.js";
import { folderIndexPage, handleGate, type GateContext } from "../src/viewer.js";
import { openAccess } from "../src/access.js";
import { openArtifactRuntime } from "../src/artifact-runtime.js";
import type { GatePayload } from "../src/artifacts.js";
import { openRateLimiter } from "../src/ratelimit.js";
import { openAuth } from "../src/auth.js";
import { openMailer } from "../src/mail.js";

interface WrongPasswordResponse { error: "wrong"; remaining: number }
interface LockoutResponse { error: "locked"; retryAfter: number }

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><title>Probni artefakt</title></head><body><h1>Bok</h1></body></html>`;

/** One Worker environment over a fresh migrated D1, R2 double and RateLimit DO. */
async function environment() {
  const DB = openD1Shim();
  const store = openStore(DB);
  const bucket = memoryBucket();
  const limiter = rateLimitBinding();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner",
    passwordHash: "{}",
  }));
  const artifacts = openArtifacts({ db: DB, bucket, masterKeyHex: MASTER, settings: store.settings });
  const folders = openFolders({ db: DB, masterKeyHex: MASTER });
  const session = await Effect.runPromise(store.sessions.create(owner.id, { pending2fa: false }));
  const cookie = `wsa_session=${session.id}`;
  const access = openAccess({ db: DB, audit: store.audit });
  return {
    store, bucket, artifacts, folders, owner, access, session, cookie,
    fetch: (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("Cookie")) headers.set("Cookie", cookie);
      return worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), {
        DB, ARTIFACTS: bucket, ARTEFACTS_MASTER_KEY: MASTER, RATELIMIT: limiter,
      });
    },
  };
}

const post = (password: string, ip = "203.0.113.7"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", Origin: "https://example.test", "CF-Connecting-IP": ip },
  body: JSON.stringify({ password }),
});


test("ordinary artefact URLs require a current authorized session", async () => {
  const env = await environment();
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Private-by-default publication", html: HTML, slug: "private-default", authorId: env.owner.id,
  }));
  const anonymous = await env.fetch("/private-default/", { headers: { Cookie: "" } });
  assert.equal((await anonymous.text()).includes("Private-by-default publication"), false);
  const load = (cookie = "") => env.fetch("/_runtime/load", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://example.test", Cookie: cookie },
    body: JSON.stringify({ source: { kind: "public", path: "private-default" } }),
  });
  assert.equal((await load()).status, 403);
  const session = await Effect.runPromise(env.store.sessions.create(env.owner.id, { pending2fa: false }));
  const cookie = `wsa_session=${session.id}`;
  const owned = await load(cookie);
  assert.equal(owned.status, 200);
  assert.equal((await owned.json<{ html: string }>()).html, HTML);
  await Effect.runPromise(env.store.sessions.destroy(session.id));
  assert.equal((await load(cookie)).status, 403);
});

test("ordinary folders, aliases and password gates hide all metadata from unauthorized readers", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Private folder", slug: "private-folder" }));
  await Effect.runPromise(env.folders.alias("old-folder", folder.id));
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, folderId: folder.id, title: "Private document", html: HTML, password: "correct",
    slug: "private-doc", authorId: env.owner.id,
  }));
  await Effect.runPromise(env.artifacts.alias("old-folder/old-doc", artifact.id));
  const cookies = [""];
  for (const [id, role, pending2fa] of [["staff", "admin", false], ["stranger", "member", false], ["unfinished", "member", true]] as const) {
    await Effect.runPromise(env.store.users.create({ id, email: `${id}@example.test`, name: id, role, passwordHash: "{}" }));
    const session = await Effect.runPromise(env.store.sessions.create(id, { pending2fa }));
    cookies.push(`wsa_session=${session.id}`);
    if (pending2fa) await Effect.runPromise(env.access.grant({ actorId: env.owner.id, folderId: folder.id, userId: id, role: "viewer" }));
  }
  for (const cookie of cookies) {
    const neutral = await (await env.fetch("/unknown-document/", { headers: { Cookie: cookie } })).text();
    for (const path of ["private-folder", "old-folder", "private-doc", "old-folder/old-doc"]) {
      const page = await env.fetch(`/${path}/`, { headers: { Cookie: cookie } });
      assert.equal(page.status, 200);
      assert.equal(await page.text(), neutral);
    }
    for (const path of ["private-doc", "old-folder/old-doc"]) {
      const response = await env.fetch(`/_gate/${path}/`, {
        ...post("correct"), headers: { "content-type": "application/json", Origin: "https://example.test", Cookie: cookie },
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not found" });
      assert.equal((await env.fetch("/_runtime/load", {
        method: "POST", headers: { "content-type": "application/json", Origin: "https://example.test", Cookie: cookie },
        body: JSON.stringify({ source: { kind: "public", path } }),
      })).status, 403);
    }
    for (const suffix of ["", "/view", "/preview", "/download"]) {
      const response = await env.fetch(`/app/a/private-doc${suffix}`, { headers: { Cookie: cookie } });
      const body = await response.text();
      assert.equal(body.includes("Private document"), false);
      assert.equal(body.includes("<h1>Bok</h1>"), false);
    }
  }
  await Effect.runPromise(env.access.grant({ actorId: env.owner.id, folderId: folder.id, userId: "stranger", role: "viewer" }));
  for (const cookie of [env.cookie, cookies[2]]) {
    assert.match(await (await env.fetch("/old-folder/", { headers: { Cookie: cookie } })).text(), /Private folder/);
    assert.match(await (await env.fetch("/old-folder/old-doc/", { headers: { Cookie: cookie } })).text(), /Private document/);
    const response = await env.fetch("/_gate/old-folder/old-doc/", {
      ...post("correct"), headers: { "content-type": "application/json", Origin: "https://example.test", Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(await openAsVisitor(await response.json<GatePayload>(), "correct"), HTML);
    const download = await env.fetch("/app/a/private-doc/download", { headers: { Cookie: cookie } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), HTML);
  }
  await Effect.runPromise(env.artifacts.setPassword(artifact.id, null));
  assert.equal(await (await env.fetch("/private-doc/", { headers: { Cookie: "" } })).text(),
    await (await env.fetch("/unknown-document/", { headers: { Cookie: "" } })).text());
});

test("an artefact is served at its slug, and unknown paths answer the landing page", async () => {
  const env = await environment();
  await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, title: "Izvješće", html: HTML, slug: "izvjesce", authorId: env.owner.id }));

  for (const path of ["/izvjesce", "/izvjesce/"]) {
    const response = await env.fetch(path);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.equal(page.includes("<h1>Bok</h1>"), false);
    const bootstrap = /<script id="ws-bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
    assert.ok(bootstrap);
    const data: unknown = JSON.parse(bootstrap[1]);
    assert.ok(data !== null && typeof data === "object" && "props" in data);
    const props = data.props;
    assert.ok(props !== null && typeof props === "object" && "viewer" in props);
    const viewer = props.viewer;
    assert.ok(viewer !== null && typeof viewer === "object" && "runtime" in viewer && "loadUrl" in viewer && "permissions" in viewer);
    assert.deepEqual(viewer.runtime, { kind: "public", path: "izvjesce" });
    assert.equal(viewer.loadUrl, "/_runtime/load");
    assert.deepEqual(viewer.permissions, { read: true, write: true, manage: true, own: true });
    assert.equal(Object.hasOwn(viewer, "wrapMaster"), false);
    assert.equal(Object.hasOwn(viewer, "verifier"), false);
    const loaded = await env.fetch("/_runtime/load", {
      method: "POST", headers: { "content-type": "application/json", Origin: "https://example.test" },
      body: JSON.stringify({ source: { kind: "public", path: "izvjesce" } }),
    });
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json<{ html: string }>()).html, HTML);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }

  // A 404 for an unknown secret link would turn the URL space into an oracle.
  for (const path of ["/nema-me", "/a1b2c3d4e5f60718/9f8e7d6c5b4a3928/"]) {
    const response = await env.fetch(path);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("<h1>Bok</h1>"), false);
  }

  assert.equal((await env.fetch("/a/b/c")).status, 404);
});

test("a gated artefact serves a page with no ciphertext, and the gate opens the document", async () => {
  const env = await environment();
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Tajni izvještaj", html: HTML, password: "ws", slug: "tajno", authorId: env.owner.id,
  }));

  const page = await env.fetch("/tajno");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");   // secret-link discipline
  const body = await page.text();
  assert.match(body, /Tajni izvještaj/);
  assert.equal(body.includes("<h1>Bok</h1>"), false);         // the document is not in the page
  assert.ok(artifact.wrapPassword);
  assert.equal(body.includes(artifact.wrapPassword.ct.slice(0, 32)), false);

  const wrong = await env.fetch("/_gate/tajno", post("pogresna"));
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json<WrongPasswordResponse>(), { error: "wrong", remaining: 3 });
  assert.equal((await env.fetch("/_gate/tajno", post(""))).status, 401);

  const opened = await env.fetch("/_gate/tajno", post("ws"));
  assert.equal(opened.status, 200);
  const payload = await opened.json<GatePayload>();
  assert.equal(await openAsVisitor(payload, "ws"), HTML);
  assert.equal(JSON.stringify(payload).includes("<h1>Bok</h1>"), false);

  // A successful unlock clears the counter.
  assert.equal((await env.fetch("/_gate/tajno", post("pogresna"))).status, 401);
});

test("the gate locks the (IP, artefact) pair and audits the lockout", async () => {
  const env = await environment();
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Tajni", html: HTML, password: "ws", slug: "tajno", authorId: env.owner.id,
  }));

  for (const remaining of [3, 2, 1]) {
    const response = await env.fetch("/_gate/tajno", post("pogresna"));
    assert.equal(response.status, 401);
    assert.equal((await response.json<WrongPasswordResponse>()).remaining, remaining);
  }

  const locked = await env.fetch("/_gate/tajno", post("pogresna"));
  assert.equal(locked.status, 429);
  const body = await locked.json<LockoutResponse>();
  assert.equal(body.error, "locked");
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 3600);
  assert.equal(locked.headers.get("retry-after"), String(body.retryAfter));

  // Even the right password waits for the lock to expire.
  assert.equal((await env.fetch("/_gate/tajno", post("ws"))).status, 429);

  const rows = await env.store.db.prepare("SELECT * FROM audit_log WHERE action = ?").bind("gate.lockout").all<{ actor_id: string }>();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].actor_id, "203.0.113.7");

  // The lockout is per pair: another visitor is unaffected.
  const other = await env.fetch("/_gate/tajno", post("ws", "198.51.100.9"));
  assert.equal(other.status, 200);
  assert.equal(await openAsVisitor(await other.json<GatePayload>(), "ws"), HTML);
});

test("the gate refuses requests it cannot verify", async () => {
  const env = await environment();
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Tajni", html: HTML, password: "ws", slug: "tajno", authorId: env.owner.id,
  }));
  await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, title: "Javni", html: HTML, slug: "javni", authorId: env.owner.id }));

  assert.equal((await env.fetch("/_gate/tajno")).status, 405);                 // GET is not an unlock
  assert.equal((await env.fetch("/_gate/nema-me", post("ws"))).status, 404);   // unknown path
  assert.equal((await env.fetch("/_gate/javni", post("ws"))).status, 404);     // no gate to open
  const malformed = await env.fetch("/_gate/tajno", {
    ...post("ws"), body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "bad request" });
  const invalidPassword = await env.fetch("/_gate/tajno", {
    ...post("ws"), body: JSON.stringify({ password: { toString: null } }),
  });
  assert.equal(invalidPassword.status, 400);
  assert.deepEqual(await invalidPassword.json(), { error: "bad request" });
  assert.equal((await env.fetch("/_gate/tajno", { ...post("ws"), headers: { "content-type": "application/json" } })).status, 403);
  assert.equal((await env.fetch("/_gate/tajno", {
    ...post("ws"), headers: { "content-type": "application/json", Origin: "https://other.test" },
  })).status, 403);
  assert.equal((await env.fetch("/_gate/tajno", {
    ...post("ws"), headers: { "content-type": "text/plain", Origin: "https://example.test" },
  })).status, 403);

  const huge = await env.fetch("/_gate/tajno", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://example.test" },
    body: JSON.stringify({ password: "x".repeat(9000) }),
  });
  assert.equal(huge.status, 413);
});

test("a legacy two-segment link serves the artefact and its gate", async () => {
  const env = await environment();
  const legacy = "a1b2c3d4e5f60718/9f8e7d6c5b4a3928";
  const artifact = await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Naslijeđeni", html: HTML, password: "ws", authorId: env.owner.id,
  }));
  await Effect.runPromise(env.artifacts.alias(legacy, artifact.id));

  const page = await env.fetch(`/${legacy}/`);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Naslijeđeni/);
  assert.equal(body.includes("<h1>Bok</h1>"), false);

  const opened = await env.fetch(`/_gate/${legacy}/`, post("ws"));
  assert.equal(opened.status, 200);
  assert.equal(await openAsVisitor(await opened.json<GatePayload>(), "ws"), HTML);
});

test("a folder index lists that folder's artefacts, and a 1.x index link still lands on it", async () => {
  const env = await environment();
  const folder = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Zelena šuma" }));
  const other = await Effect.runPromise(env.folders.create({ ownerId: env.owner.id, name: "Drugi folder", slug: "drugi" }));
  await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, folderId: folder.id, title: "Javni izvještaj", html: HTML, slug: "javni-izvjestaj", authorId: env.owner.id }));
  await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, folderId: folder.id, title: "Tajni izvještaj", html: HTML, slug: "tajni-izvjestaj", password: "ws", authorId: env.owner.id }));
  await Effect.runPromise(env.artifacts.create({ ownerId: env.owner.id, folderId: other.id, title: "Tuđi izvještaj", html: HTML, slug: "tudi-izvjestaj", authorId: env.owner.id }));

  const named = await Effect.runPromise(env.folders.rename(folder.id, "zelena-suma"));
  const page = await env.fetch("/zelena-suma/");
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(body, /Zelena šuma/);
  assert.match(body, /Javni izvještaj/);
  assert.match(body, /Tajni izvještaj/);
  assert.match(body, /href="\/javni-izvjestaj\/"/);
  assert.equal(body.includes("Tuđi izvještaj"), false);       // never another folder's artefact
  assert.equal(env.folders.path(named), "/zelena-suma/");

  // The link the visitor was handed in 1.x keeps landing on the index.
  await Effect.runPromise(env.folders.alias("9f8e7d6c5b4a39281706", folder.id));
  const legacy = await env.fetch("/9f8e7d6c5b4a39281706/");
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /Zelena šuma/);

  // ...and the artefacts on it are still served at their own paths.
  assert.equal((await env.fetch("/tajni-izvjestaj/")).status, 200);
});

test("routes outside the table answer 404, and the agent surfaces are live", async () => {
  const env = await environment();
  assert.equal((await env.fetch("/_nope")).status, 404);            // no route, no asset, no surface
  assert.equal((await env.fetch("/instructions")).status, 200);     // M3 onboarding page
  assert.equal((await env.fetch("/_api/contract")).status, 200);    // public contract
  assert.equal((await env.fetch("/_api/artifacts")).status, 401);   // the API itself needs a key
});

test("gate failures stay closed while reset alone is best-effort", async () => {
  const env = await environment();
  await Effect.runPromise(env.artifacts.create({
    ownerId: env.owner.id, title: "Tajni", html: HTML, password: "ws", slug: "tajno", authorId: env.owner.id,
  }));
  const limiter = openRateLimiter({ RATELIMIT: rateLimitBinding() });
  const runtime = openArtifactRuntime({ db: env.store.db, masterKeyHex: MASTER });
  let verifications = 0;
  let grants = 0;
  const ctx: GateContext = {
    artifacts: {
      ...env.artifacts,
      verifyPassword: (subject, password) => Effect.gen(function* () {
        verifications += 1;
        return yield* env.artifacts.verifyPassword(subject, password);
      }),
    },
    auth: openAuth({ store: env.store, mailer: openMailer(), masterKeyHex: MASTER, origin: "https://example.test", rateLimiter: limiter }),
    access: openAccess({ db: env.store.db, audit: env.store.audit }),
    shares: { resolve: () => Effect.succeed(null) },
    analytics: { proof: () => Effect.fail(new Error("Ordinary access must not issue an observation proof.")) },
    artifactRuntime: {
      issue: (request, context, input) => Effect.gen(function* () {
        grants += 1;
        return yield* runtime.issue(request, context, input);
      }),
    },
    limiter, gate: { threshold: 4, lockMs: 3600000 }, store: env.store,
  };
  const unlock = (password: string) => Effect.runPromise(handleGate(
    new Request("https://example.test/_gate/tajno", {
      ...post(password), headers: { "content-type": "application/json", Origin: "https://example.test", Cookie: env.cookie },
    }), ctx, { rest: "tajno" },
  ));
  ctx.limiter = { ...limiter, check: () => Effect.fail(new Error("check unavailable")) };
  assert.equal((await unlock("ws")).status, 503);
  assert.equal(verifications, 0);
  assert.equal(grants, 0);
  ctx.limiter = { ...limiter, check: () => Effect.die(new Error("check defect")) };
  assert.equal((await unlock("ws")).status, 503);
  assert.equal(verifications, 0);
  ctx.limiter = { ...limiter, hit: () => Effect.fail(new Error("hit unavailable")) };
  assert.equal((await unlock("wrong")).status, 503);
  assert.equal(grants, 0);
  const originalPayload = ctx.artifacts.gatePayload;
  ctx.artifacts.gatePayload = () => Effect.fail(new Error("payload unavailable"));
  ctx.limiter = limiter;
  assert.equal((await unlock("ws")).status, 503);
  assert.equal(grants, 0);
  ctx.artifacts.gatePayload = originalPayload;
  ctx.limiter = { ...limiter, reset: () => Effect.fail(new Error("reset unavailable")) };
  const opened = await unlock("ws");
  assert.equal(opened.status, 200);
  const payload = await opened.json<GatePayload & { runtime: { grant: string } }>();
  assert.equal(await openAsVisitor(payload, "ws"), HTML);
  assert.ok(payload.runtime.grant);
  assert.equal(opened.headers.get("Set-Cookie"), null);
  assert.equal(grants, 1);
});
test("the folder index uses the kit, without the WS Agency credit", () => {
  const page = folderIndexPage({ name: "Zelena šuma" });
  assert.match(page, /<html class="wsa-brand" data-identity="original" data-appearance="auto" lang="en">/);
  for (const f of ["fonts.css", "tokens.css", "footer.css"]) assert.match(page, new RegExp(`/assets/ws-design-kit/${f}`));
  assert.match(page, /products\/artefacts67\/original\/logo-white\.svg/);
  assert.match(page, /rel="icon" type="image\/svg\+xml" href="\/assets\/ws-design-kit\/products\/artefacts67\/original\/favicon\.svg"/);
  assert.doesNotMatch(page, /Made with love|ws-logo\.svg/);
});
