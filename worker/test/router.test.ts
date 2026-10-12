import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";

import { publicPath, route } from "../src/router.js";
import { artifactObject, parseArtifactObject } from "../src/r2keys.js";

test("system routes win over the slug catch-all", () => {
  assert.equal(route("GET", "/_health")?.handler, "health");
  assert.equal(route("GET", "/instructions")?.handler, "instructions");
  assert.equal(route("GET", "/robots.txt")?.handler, "robots");
});

test("api, auth pages, and the console areas capture their sub-paths", () => {
  const api = route("POST", "/_api/artifacts/quarterly-report");
  assert.ok(api);
  assert.equal(api.handler, "api");
  assert.equal(api.params.rest, "artifacts/quarterly-report");
  assert.equal(route("POST", "/_mcp")?.handler, "mcp");
  assert.equal(route("POST", "/_mcp/")?.handler, "mcp");
  assert.equal(route("GET", "/_mcp")?.handler, "mcp");
  assert.equal(route("POST", "/_runtime/data")?.params.action, "data");
  const part = route("PUT", `/_runtime/files/uploads/${"a".repeat(32)}/parts/1`);
  assert.deepEqual([part?.handler, part?.params.rest], ["runtimeFiles", `uploads/${"a".repeat(32)}/parts/1`]);
  assert.equal(route("POST", "/_runtime/files/docs/r1/f1")?.handler, "runtimeFiles");

  const login = route("POST", "/login");
  assert.ok(login);
  assert.equal(login.handler, "auth");
  assert.equal(login.params.action, "login");

  const invite = route("GET", "/invite/wsi_9f8e7d6c");
  assert.ok(invite);
  assert.equal(invite.handler, "auth");
  assert.equal(invite.params.token, "wsi_9f8e7d6c");

  const passkey = route("POST", "/passkey/begin");
  assert.ok(passkey);
  assert.equal(passkey.handler, "auth");
  assert.equal(passkey.params.op, "begin");

  const passkeyFirst = route("POST", "/passkey/login/complete");
  assert.ok(passkeyFirst);
  assert.equal(passkeyFirst.handler, "auth");
  assert.equal(passkeyFirst.params.op, "login/complete");

  const app = route("GET", "/app/a/quarterly-report");
  assert.ok(app);
  assert.equal(app.handler, "console");
  assert.equal(app.params.area, "app");
  assert.equal(app.params.rest, "a/quarterly-report");

  const admin = route("GET", "/admin/users");
  assert.ok(admin);
  assert.equal(admin.handler, "console");
  assert.equal(admin.params.area, "admin");
  assert.equal(admin.params.rest, "users");

  const settings = route("POST", "/settings/keys/mint");
  assert.ok(settings);
  assert.equal(settings.handler, "console");
  assert.equal(settings.params.area, "settings");
  assert.equal(settings.params.rest, "keys/mint");
});

test("the M1 console URLs route to the permanent redirects", () => {
  assert.equal(route("GET", "/_auth/login")?.handler, "legacyAuth");
  assert.equal(route("GET", "/_auth/accept/wsi_9f8e7d6c")?.handler, "legacyAuth");
  assert.equal(route("GET", "/_admin/users")?.handler, "legacyAdmin");
  assert.equal(route("GET", "/_admin")?.handler, "legacyAdmin");
  // Old POST endpoints are gone, not redirected: nothing in the wild posts there.
  assert.equal(route("POST", "/_auth/login"), null);
  assert.equal(route("POST", "/_admin/users"), null);
});
test("the console's reserved names can never be artefact paths", async () => {
  // The rule lives in paths.js (ADR 0024): pathTaken answers "taken" for every reserved
  // name, so creation, rename and alias all refuse them no matter which surface calls.
  const { RESERVED_SEGMENTS, pathTaken } = await import("../src/paths.js");
  const { openD1Shim } = await import("./db.js");
  const db = openD1Shim();
  for (const segment of RESERVED_SEGMENTS) {
    assert.equal(await Effect.runPromise(pathTaken(db, segment)), true, `${segment} must be reserved`);
  }
  assert.equal(await Effect.runPromise(pathTaken(db, "quarterly-report")), false);
  // The names that ARE routed must never fall through to the viewer.
  for (const path of ["/app", "/admin", "/settings", "/login", "/logout", "/register", "/enroll", "/2fa", "/instructions"]) {
    assert.notEqual(route("GET", path)?.handler, "viewer", `${path} must not reach the viewer`);
  }
});

test("viewer routes a friendly slug, with or without a trailing slash", () => {
  for (const path of ["/quarterly-report", "/quarterly-report/"]) {
    const viewer = route("GET", path);
    assert.ok(viewer);
    assert.equal(viewer.handler, "viewer");
    assert.equal(viewer.params.slug, "quarterly-report");
  }
  assert.equal(publicPath(route("GET", "/quarterly-report/")?.params), "quarterly-report");
});

test("viewer routes the 1.x two-segment link, trailing slash included", () => {
  const legacy = route("GET", "/a1b2c3d4e5f60718/9f8e7d6c5b4a3928/");
  assert.ok(legacy);
  assert.equal(legacy.handler, "viewer");
  assert.equal(legacy.params.folder, "a1b2c3d4e5f60718");
  assert.equal(legacy.params.artefact, "9f8e7d6c5b4a3928");
  assert.equal(publicPath(legacy.params), "a1b2c3d4e5f60718/9f8e7d6c5b4a3928");
  assert.equal(route("GET", "/a/b/c"), null);
});

test("the gate captures the public path it is unlocking", () => {
  assert.equal(route("POST", "/_gate/quarterly-report/")?.params.rest, "quarterly-report");
  assert.equal(route("GET", "/_gate/a1b2c3d4e5f60718/9f8e7d6c5b4a3928/")?.handler, "gate");
  assert.equal(route("POST", "/_gate/a/b")?.params.rest, "a/b");
});

test("slug rules: no leading/trailing hyphen, lowercase, 64 max, _ reserved", () => {
  assert.equal(route("GET", "/-leading"), null);
  assert.equal(route("GET", "/trailing-"), null);
  assert.equal(route("GET", "/Quarterly"), null);
  assert.equal(route("GET", "/_internal"), null);
  assert.equal(route("GET", `/${"a".repeat(64)}`)?.handler, "viewer");
  assert.equal(route("GET", `/${"a".repeat(65)}`), null);
});

test("method mismatches do not match", () => {
  assert.equal(route("POST", "/_health"), null);
  assert.equal(route("DELETE", "/quarterly-report"), null);
});

test("r2 object keys round-trip", () => {
  const key = artifactObject("a1b2c3d4", 7);
  assert.equal(key, "art/a1b2c3d4/7.enc");
  assert.deepEqual(parseArtifactObject(key), { artifactId: "a1b2c3d4", version: 7 });
  assert.equal(parseArtifactObject("art/a1b2c3d4/7.html"), null);
  assert.equal(parseArtifactObject("../../etc/passwd"), null);
});
