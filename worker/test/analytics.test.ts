import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { openD1Shim } from "./db.js";
import { memoryBucket } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openFolders } from "../src/folders.js";
import { openArtifacts } from "../src/artifacts.js";
import { openAccess } from "../src/access.js";
import { openShares } from "../src/shares.js";
import { openAnalytics, handleAnalytics } from "../src/analytics.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = "<!doctype html><html lang=\"en\"><head><title>Observation boundary</title></head><body>Private contents</body></html>";

async function fixture(t: TestContext) {
  const db = openD1Shim(); t.after(() => db.close());
  const store = openStore(db);
  for (const id of ["owner", "manager", "editor", "outsider"]) {
    await Effect.runPromise(store.users.create({ id, email: `${id}@example.test`, name: id, role: id === "outsider" ? "admin" : "member", passwordHash: "{}" }));
  }
  const access = openAccess({ db, audit: store.audit });
  const folders = openFolders({ db, masterKeyHex: MASTER });
  const folder = await Effect.runPromise(folders.create({ ownerId: "owner", name: "Private folder", slug: "observations" }));
  const artifacts = openArtifacts({ db, bucket: memoryBucket(), masterKeyHex: MASTER, settings: store.settings });
  const artifact = await Effect.runPromise(artifacts.create({ ownerId: "owner", folderId: folder.id, html: HTML, authorId: "owner", slug: "observed" }));
  const shares = openShares({ db, masterKeyHex: MASTER, artifacts, folders, access, audit: store.audit, publicOrigin: "https://example.test", settings: store.settings });
  const share = await Effect.runPromise(shares.create({ actorId: "owner", kind: "artifact", targetId: artifact.id, name: "Observed link", recipient: "visitor@example.test" }));
  let clock = Date.now();
  const analytics = openAnalytics({ db, shares, access, masterKeyHex: MASTER, now: () => clock });
  const body = { path: "observed", token: new URL(share.url).pathname.split("/s/")[1].split("/")[0], artifactId: artifact.id,
    proof: await Effect.runPromise(analytics.proof({ shareId: share.id, artifactId: artifact.id })), activeSeconds: 0, scroll: 0 };
  const summary = (actorId = "owner") => Effect.runPromise(analytics.summary({ actorId, kind: "folder", targetId: folder.id }));
  return { db, store, access, folders, folder, artifacts, artifact, shares, share, analytics, body, summary, advance: (ms: number) => { clock += ms; } };
}

test("one authorized opening deduplicates retries and bounds cumulative dwell", async (t) => {
  const f = await fixture(t);
  assert.equal(await Effect.runPromise(f.analytics.record(f.body)), true);
  f.advance(20000);
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, activeSeconds: 10000, scroll: 75 })), true);
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, activeSeconds: 2, scroll: 25 })), true);
  const observed = await f.summary();
  assert.deepEqual({ ...observed.totals }, { opens: 1, activeSeconds: 20, scroll25: 1, scroll50: 1, scroll75: 1, scroll100: 0 });
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, proof: f.body.proof.slice(0, -10) + "tampered" })), false);
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, artifactId: "another-artifact" })), false);
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, activeSeconds: -1 })), false);
  // A reopened document has a separate authorized proof, never a persistent visitor id.
  const proof = await Effect.runPromise(f.analytics.proof({ shareId: f.share.id, artifactId: f.artifact.id }));
  await Effect.runPromise(f.analytics.record({ ...f.body, proof }));
  assert.equal((await f.summary()).totals.opens, 2);
});

test("revoked shares and expired measurement proofs stop accepting observations", async (t) => {
  const f = await fixture(t);
  await Effect.runPromise(f.analytics.record(f.body));
  f.advance(4 * 60 * 60 * 1000);
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, scroll: 100 })), false);
  const proof = await Effect.runPromise(f.analytics.proof({ shareId: f.share.id, artifactId: f.artifact.id }));
  await Effect.runPromise(f.shares.revoke({ actorId: "owner", id: f.share.id }));
  assert.equal(await Effect.runPromise(f.analytics.record({ ...f.body, proof })), false);
  assert.equal((await f.summary()).totals.opens, 1);
});

test("detail follows management grants, never platform role; retention removes old observations", async (t) => {
  const f = await fixture(t);
  await Effect.runPromise(f.analytics.record(f.body));
  await Effect.runPromise(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "manager", role: "manager" }));
  await Effect.runPromise(f.access.grant({ actorId: "owner", folderId: f.folder.id, userId: "editor", role: "editor" }));
  assert.equal((await f.summary("manager")).totals.opens, 1);
  for (const actor of ["editor", "outsider"]) await assert.rejects(f.summary(actor), { code: "forbidden" });
  await Effect.runPromise(f.access.revoke({ actorId: "owner", folderId: f.folder.id, userId: "manager" }));
  await assert.rejects(f.summary("manager"), { code: "forbidden" });
  const platform = await Effect.runPromise(f.analytics.platformSummary());
  assert.equal(platform.totals.opens, 1);
  assert.deepEqual(Object.keys(platform).sort(), ["days", "totals"]);
  assert.equal(JSON.stringify(platform).includes("visitor@example.test"), false);
  f.advance(2 * 86400000);
  await Effect.runPromise(f.analytics.setRetention(1));
  assert.equal((await f.summary()).totals.opens, 0);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM share_visits").first<{ n: number }>())!.n, 0);
  await assert.rejects(Effect.runPromise(f.analytics.setRetention(0)), { code: "invalid-retention" });
});

test("observation HTTP rejects cross-origin requests and accepts same-origin authorized usage", async (t) => {
  const f = await fixture(t);
  const request = (origin: string) => new Request("https://example.test/_ev", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(f.body) });
  assert.equal((await Effect.runPromise(handleAnalytics(request("https://attacker.test"), f))).status, 403);
  assert.equal((await f.summary()).totals.opens, 0);
  assert.equal((await Effect.runPromise(handleAnalytics(request("https://example.test"), f))).status, 204);
  assert.equal((await f.summary()).totals.opens, 1);
});

test("observation HTTP distinguishes body rejection, rate limits and unexpected model failures", async (t) => {
  const f = await fixture(t);
  const request = (body: string) => new Request("https://example.test/_ev", { method: "POST",
    headers: { Origin: "https://example.test", "Content-Type": "application/json" }, body });
  const limited = openAnalytics({ db: f.db, shares: f.shares, access: f.access, masterKeyHex: MASTER,
    limiter: { hit: () => Effect.succeed({ allowed: false }) } });
  const rateLimited = await Effect.runPromise(handleAnalytics(request(JSON.stringify(f.body)), { analytics: limited }));
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("Retry-After"), "60");
  assert.equal((await f.summary()).totals.opens, 0);

  const failure = Object.assign(new Error("Observation storage unavailable."), { code: "storage-unavailable" });
  f.analytics.record = () => Effect.fail(failure);
  for (const body of ["{", JSON.stringify({ ...f.body, extra: "x".repeat(4097) })]) {
    assert.equal((await Effect.runPromise(handleAnalytics(request(body), f))).status, 400);
  }
  await assert.rejects(Effect.runPromise(handleAnalytics(request(JSON.stringify(f.body)), f)), (error) => error === failure);
});
