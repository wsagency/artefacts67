import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { openD1Shim } from "./db.js";
import { openConsoleContext } from "./doubles.js";
import { viewerDescriptor, type RuntimeSource } from "../src/artifact-runtime.js";
import { viewerView } from "../src/views.js";

const run = Effect.runPromise;
const HTML = '<!doctype html><html lang="en"><head><title>App</title></head><body>Private application</body></html>';

async function fixture() {
  const db = openD1Shim();
  const ctx = openConsoleContext(db);
  await run(ctx.store.users.create({ id: "owner", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}" }));
  const project = await run(ctx.folders.create({ ownerId: "owner", name: "Offers 2026", slug: "offers" }));
  const inner = await run(ctx.folders.create({ ownerId: "owner", name: "Inner", slug: "inner", parentId: project.id }));
  const artifact = await run(ctx.artifacts.create({ ownerId: "owner", folderId: inner.id, title: "App", html: HTML, slug: "data-app", authorId: "owner" }));
  const unfiled = await run(ctx.artifacts.create({ ownerId: "owner", title: "Loose", html: HTML, slug: "loose", authorId: "owner" }));
  const session = await run(ctx.store.sessions.create("owner", { pending2fa: false }));
  const signedIn = new Request("https://example.test/app", { headers: { Cookie: `wsa_session=${session.id}` } });
  const share = await run(ctx.shares.create({ actorId: "owner", kind: "artifact", targetId: artifact.id, name: "V" }));
  const token = new URL(share.url).pathname.split("/s/")[1].split("/")[0];
  const define = (name: string, kind: "records" | "responses", visitors: boolean) =>
    run(ctx.projectData.define(project.id, name, { kind, visitors, fields: { title: { type: "text" } } }));
  const describe = (request: Request, source: RuntimeSource, target = artifact, gated = false) =>
    run(viewerDescriptor(request, ctx, { artifact: target, source, publicUrl: "/x", gated }));
  const consoleSource = { kind: "console", artifactId: artifact.id } satisfies RuntimeSource;
  const shareSource = { kind: "share", path: "data-app", token, artifactId: artifact.id } satisfies RuntimeSource;
  return { db, ctx, artifact, unfiled, signedIn, define, describe, consoleSource, shareSource };
}

test("a signed-in reader sees every collection of the project", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.define("offers", "records", false);
  await f.define("rsvp", "responses", true);
  const viewer = await f.describe(f.signedIn, f.consoleSource);
  assert.deepEqual(viewer.data, { collections: [{ name: "offers", kind: "records" }, { name: "rsvp", kind: "responses" }] });
  assert.deepEqual(viewerView(viewer)?.data, viewer.data);
});

test("a share visitor sees only visitor collections, even when signed in", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.define("offers", "records", false);
  await f.define("rsvp", "responses", true);
  const anonymous = await f.describe(new Request("https://example.test/s"), f.shareSource);
  assert.deepEqual(anonymous.data, { collections: [{ name: "rsvp", kind: "responses" }] });
  const signedIn = await f.describe(f.signedIn, f.shareSource);
  assert.deepEqual(signedIn.data?.collections, [{ name: "rsvp", kind: "responses" }]);
  const serialized = JSON.stringify(viewerView(anonymous));
  assert.equal(serialized.includes("offers\""), false);
  assert.equal(serialized.includes("Offers 2026"), false);
});

test("a share visitor with no visitor collections gets no indicator", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.define("offers", "records", false);
  assert.equal((await f.describe(new Request("https://example.test/s"), f.shareSource)).data, null);
});

test("unfiled artefacts, empty projects and gated viewers get no indicator", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  assert.equal((await f.describe(f.signedIn, f.consoleSource)).data, null);
  await f.define("offers", "records", true);
  assert.equal((await f.describe(f.signedIn, { kind: "console", artifactId: f.unfiled.id } as const, f.unfiled)).data, null);
  assert.equal((await f.describe(f.signedIn, f.consoleSource, f.artifact, true)).data, null);
});
test("viewer composition uses the deployment origin, not the request host", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const viewer = await f.describe(new Request("https://alias.test/app"), f.consoleSource);
  assert.equal(viewer.documentOrigin, f.ctx.publicOrigin);
  assert.equal(viewer.publicUrl, "/x");
});
