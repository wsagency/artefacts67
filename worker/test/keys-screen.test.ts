// The key and platform-mail HTTP surfaces: routing, CSRF, user scoping and
// one-time-secret rendering. Unused seams use the real platform factories.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";

import { handleConsole } from "../src/console.js";
import { openConsoleContext, type TestConsoleContext } from "./doubles.js";
import type { CurrentSession } from "../src/auth.js";
import type { Artifact } from "../src/artifacts.js";
import type { Keys, Key, MintKey, MintedKey } from "../src/keys.js";
import type { AuditEntry, Role, Settings } from "../src/store.js";
const frontendRequire = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { createServer } = frontendRequire("vite") as { createServer(options: object): Promise<{
  ssrLoadModule(path: string): Promise<Record<string, (props: Record<string, unknown>) => unknown>>;
  close(): Promise<void>;
}> };
const { renderToString } = frontendRequire("@solidjs/web") as { renderToString(render: () => unknown): string };
const { default: solid } = frontendRequire("@solidjs/vite-plugin") as { default(options: object): unknown };
import { shouldShowContentReadCheck } from "../../frontend/src/key-capability.js";

const KEY_ROWS: Key[] = [
  { id: "k1", userId: "u-owner", kind: "master", artifactId: null, label: "", prefix: "wak_1a2b3c4d",
    scopes: "master", can_read_content: false, createdAt: "2026-01-05T10:00:00.000Z", revokedAt: null, lastUsedAt: null },
  { id: "k2", userId: "u-owner", kind: "artifact", artifactId: "a1", label: "CI objava", prefix: "waa_9e8f7a6b",
    scopes: "read_write", can_read_content: false, createdAt: "2026-02-06T11:30:00.000Z", revokedAt: null, lastUsedAt: "2026-03-01T09:12:00.000Z" },
];

interface KeyOptions { rotateResult?: MintedKey | null; revokeResult?: boolean; noMaster?: boolean }
interface AuditCall {
  actorType: string; actorId: unknown; action: string; options?: Pick<AuditEntry, "artifactId" | "detail">;
}

function keysModel(base: Keys, { rotateResult, revokeResult, noMaster = false }: KeyOptions = {}) {
  const calls = {
    mint: [] as MintKey[], rotate: [] as Array<Parameters<Keys["rotate"]>>,
    revoke: [] as Array<Parameters<Keys["revoke"]>>, list: [] as string[],
  };
  const model: Keys = {
    ...base,
    list: userId => Effect.sync(() => { calls.list.push(userId); return noMaster ? KEY_ROWS.filter(key => key.kind !== "master") : KEY_ROWS; }),
    mint: args => Effect.sync(() => {
      calls.mint.push(args);
      return { key: `waa_${"f".repeat(40)}`, record: { ...KEY_ROWS[1], userId: args.userId, artifactId: args.artifactId ?? null } };
    }),
    rotate: (id, userId) => Effect.sync(() => {
      calls.rotate.push([id, userId]);
      return rotateResult === undefined ? { key: `waa_${"0".repeat(40)}`, record: KEY_ROWS[1] } : rotateResult;
    }),
    revoke: (id, userId) => Effect.sync(() => {
      calls.revoke.push([id, userId]);
      return revokeResult === undefined ? true : revokeResult;
    }),
  };
  return { calls, model };
}

function settingsStore(base: Settings, initial: string) {
  const calls = { setMailFrom: [] as unknown[], setRetention: [] as unknown[] };
  let mailFrom = initial;
  const settings: Settings = {
    ...base,
    retention: () => Effect.succeed(100),
    setRetention: value => Effect.sync(() => { calls.setRetention.push(value); return Number(value); }),
    mailFrom: () => Effect.sync(() => mailFrom),
    setMailFrom: value => Effect.sync(() => { calls.setMailFrom.push(value); mailFrom = String(value); return mailFrom; }),
  };
  return { calls, settings };
}

function harness({ role = "member", mailFrom = "", rotateResult, revokeResult, noMaster = false }: KeyOptions & { role?: Role; mailFrom?: string } = {}) {
  const base = openConsoleContext();
  const id = role === "owner" ? "u-owner" : "u-member";
  const audits: AuditCall[] = [];
  const settings = settingsStore(base.store.settings, mailFrom);
  const keys = keysModel(base.keys, { rotateResult, revokeResult, noMaster });
  const active: CurrentSession = {
    session: { id: "session", userId: id, csrf: "csrf", pending2fa: false, createdAt: "", expiresAt: "" },
    user: {
      id, email: `${role}@example.test`, name: role, role, status: "active", passwordHash: "{}",
      totpSecretSealed: null, totpSecretPendingSealed: null, passkeys: [], invitedBy: null, createdAt: "", lastLoginAt: null,
    },
  };
  const artifact: Artifact = {
    id: "a1", slug: "acme-report", ownerId: id, folderId: null, lang: "en", currentVersion: 1,
    titleSealed: "", headerUi: true, verifier: null, wrapPassword: null, wrapMaster: null, maxVersions: null,
    createdAt: "", updatedAt: "", deletedAt: null, purgedAt: null,
  };
  const ctx: TestConsoleContext = {
    ...base,
    auth: {
      ...base.auth,
      currentSession: () => Effect.succeed(active),
      audit: (actorType, actorId, action, options) => Effect.sync(() => { audits.push({ actorType, actorId, action, options }); }),
    },
    store: {
      ...base.store, settings: settings.settings,
      users: { ...base.store.users, byId: () => Effect.succeed(active.user) },
    },
    keys: keys.model,
    artifacts: {
      ...base.artifacts,
      listByOwner: ownerId => Effect.succeed(ownerId === artifact.ownerId ? [artifact] : []),
      listForEstate: ownerId => Effect.succeed(ownerId === artifact.ownerId ? [artifact] : []),
      title: () => Effect.succeed(""),
    },
    analytics: { ...base.analytics,
      platformSummary: () => Effect.succeed({ totals: { opens: 0, activeSeconds: 0, shares: 0 }, days: [] }),
    },
  };
  const request = (path: string, init: RequestInit = {}) =>
    Effect.runPromise(handleConsole(new Request(`https://example.test${path}`, { headers: { cookie: "wsa_session=session" }, ...init }), ctx,
      { area: path.split("/")[1], rest: path.replace(/^\/[^/]+\/?/, "") }));
  const post = (path: string, fields: Record<string, string>) => request(path, {
    method: "POST",
    headers: { cookie: "wsa_session=session", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { ctx, keys, settings, audits, request, post };
}

test("the keys screen is lazy and lists only the signed-in member's keys", async () => {
  const { ctx, keys } = harness({ role: "member" });
  const effect = handleConsole(new Request("https://example.test/settings/keys", {
    headers: { cookie: "wsa_session=session" },
  }), ctx, { area: "settings", rest: "keys" });
  assert.deepEqual(keys.calls.list, []);
  const response = await Effect.runPromise(effect);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.doesNotMatch(page, /waa_[0-9a-f]{40}/);               // a full key never renders
  assert.deepEqual(keys.calls.list, ["u-member"]);             // scoped to the session user
});
test("content-read checkbox appears only for master-key selection when no master key exists", () => {
  assert.equal(shouldShowContentReadCheck("artifact", false), false);
  assert.equal(shouldShowContentReadCheck("master", false), true);
  assert.equal(shouldShowContentReadCheck("master", true), false);
});
test("the API-key creation form renders its unchecked content-read checkbox only for a master key", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../../frontend", import.meta.url)),
    configFile: false,
    plugins: [solid({ ssr: true, refresh: false })],
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const { KeyCreationForm } = await vite.ssrLoadModule("/src/key-creation-form.tsx");
    const base = { onKindChange: () => {}, hasMaster: false, csrf: "csrf", artifacts: [] };
    const master = renderToString(() => KeyCreationForm({ ...base, kind: "master" }));
    const artifact = renderToString(() => KeyCreationForm({ ...base, kind: "artifact" }));
    assert.match(master, /name="can_read_content"/);
    assert.doesNotMatch(master.match(/<input[^>]*name="can_read_content"[^>]*>/)?.[0] ?? "", /\bchecked\b/);
    assert.doesNotMatch(artifact, /name="can_read_content"/);
  } finally {
    await vite.close();
  }
});


test("the master-key screen exposes the no-master state and forwards the checked capability", async () => {
  const { keys, request, post } = harness({ noMaster: true });
  const page = await (await request("/settings/keys")).text();
  const bootstrap = JSON.parse(page.match(/<script id="ws-bootstrap" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "{}");
  assert.equal(bootstrap.props.keys.some((key: Key) => key.kind === "master"), false);
  const minted = await post("/settings/keys/mint", { csrf: "csrf", kind: "master", can_read_content: "1" });
  assert.equal(minted.status, 200);
  assert.deepEqual(keys.calls.mint, [{
    userId: "u-member", kind: "master", artifactId: null, scopes: "master", label: null, can_read_content: true,
  }]);
});


test("minting calls keys.mint as the session user and re-renders the one-time plaintext", async () => {
  const { keys, post } = harness({ role: "member" });
  const response = await post("/settings/keys/mint", {
    csrf: "csrf", kind: "artifact", artifactId: "a1", scopes: "read_write",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(keys.calls.mint, [{
    userId: "u-member", kind: "artifact", artifactId: "a1", scopes: "read_write", label: null, can_read_content: false,
  }]);
  const page = await response.text();
  assert.match(page, /waa_[0-9a-f]{40}/);
});

test("an artifact mint without an artifact is refused before the model", async () => {
  const { keys, post } = harness({ role: "member" });
  const response = await post("/settings/keys/mint", { csrf: "csrf", kind: "artifact", artifactId: "", scopes: "read" });
  assert.equal(response.status, 400);
  assert.deepEqual(keys.calls.mint, []);
});

test("rotating calls keys.rotate with the session user and re-renders the new plaintext", async () => {
  const { keys, post } = harness({ role: "member" });
  const response = await post("/settings/keys/rotate", { csrf: "csrf", keyId: "k2" });
  assert.equal(response.status, 200);
  assert.deepEqual(keys.calls.rotate, [["k2", "u-member"]]);
  assert.match(await response.text(), /waa_[0-9a-f]{40}/);
});

test("revoking calls keys.revoke as the session user and redirects back (PRG)", async () => {
  const { keys, post } = harness({ role: "member" });
  const response = await post("/settings/keys/revoke", { csrf: "csrf", keyId: "k2" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/settings/keys");
  assert.deepEqual(keys.calls.revoke, [["k2", "u-member"]]);
});

test("a wrong CSRF token is refused with 403 and nothing reaches the keys model", async () => {
  const { keys, post } = harness({ role: "member" });
  for (const path of ["/settings/keys/mint", "/settings/keys/rotate", "/settings/keys/revoke"]) {
    const response = await post(path, { csrf: "wrong", kind: "artifact", artifactId: "a1", scopes: "read", keyId: "k2" });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(keys.calls, { mint: [], rotate: [], revoke: [], list: [] });
});

test("a key row the model will not hand over renders 403 and leaks nothing", async () => {
  const { keys, post } = harness({ role: "member", rotateResult: null, revokeResult: false });
  const rotate = await post("/settings/keys/rotate", { csrf: "csrf", keyId: "someone-elses" });
  assert.equal(rotate.status, 403);
  const rotatePage = await rotate.text();
  assert.doesNotMatch(rotatePage, /waa_[0-9a-f]{40}/);            // no plaintext, ever

  const revoke = await post("/settings/keys/revoke", { csrf: "csrf", keyId: "someone-elses" });
  assert.equal(revoke.status, 403);
  assert.equal(revoke.headers.get("location"), null);              // refused, not redirected

  assert.deepEqual(keys.calls.rotate, [["someone-elses", "u-member"]]);  // still scoped by the session id
  assert.deepEqual(keys.calls.revoke, [["someone-elses", "u-member"]]);
});

test("the owner updates the platform mail sender and audits the change", async () => {
  const { settings, audits, request, post } = harness({ role: "owner", mailFrom: "artefacts@old.example.test" });
  const before = await request("/admin/settings");
  assert.equal(before.status, 200);

  const response = await post("/admin/settings/mail", { csrf: "csrf", mailFrom: "objave@acme.test" });
  assert.equal(response.status, 200);
  assert.deepEqual(settings.calls.setMailFrom, ["objave@acme.test"]);
  assert.deepEqual(audits, [{ actorType: "user", actorId: "u-owner", action: "platform.mail_from",
    options: { detail: { from: "objave@acme.test" } } }]);
});

test("settings — the screen and the mail route — are the owner's alone", async () => {
  const { settings, request, post } = harness({ role: "member" });
  assert.equal((await request("/admin/settings")).status, 403);
  assert.equal((await post("/admin/settings/mail", { csrf: "csrf", mailFrom: "x@example.test" })).status, 403);
  assert.deepEqual(settings.calls.setMailFrom, []);                            // the write never happened
});
