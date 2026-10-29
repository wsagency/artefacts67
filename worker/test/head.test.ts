import * as Effect from "effect/Effect";
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding } from "./doubles.js";
import { openStore } from "../src/store.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d50524f442d55534521";

async function environment(assets?: { fetch(request: Request): Promise<Response> }) {
  const DB = openD1Shim();
  const store = openStore(DB);
  await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const env = {
    DB,
    ARTIFACTS: memoryBucket(),
    RATELIMIT: rateLimitBinding(),
    ARTEFACTS_MASTER_KEY: MASTER,
    ...(assets ? { ASSETS: assets } : {}),
  };
  const fetch = (path: string, method = "GET") => worker.fetch(new Request(`https://example.test${path}`, { method }), env);
  return { env, fetch };
}

test("HEAD returns GET status and headers without a body for GET routes", async () => {
  const { fetch } = await environment();
  for (const path of ["/", "/login", "/_health"]) {
    const get = await fetch(path);
    const head = await fetch(path, "HEAD");
    assert.equal(head.status, get.status, path);
    for (const [name, value] of get.headers) assert.equal(head.headers.get(name), value, `${path} ${name}`);
    assert.equal(await head.text(), "", path);
  }
  assert.equal((await fetch("/", "HEAD")).headers.get("location"), "/login");
  assert.equal((await fetch("/login", "HEAD")).status, 200);
  assert.equal((await fetch("/_health", "HEAD")).status, 200);
});

test("HEAD preserves POST-only response and unknown-path status", async () => {
  const { fetch } = await environment();
  const mcp = await fetch("/_mcp", "HEAD");
  assert.equal(mcp.status, 405);
  assert.equal(mcp.headers.get("allow"), "POST");
  assert.equal(await mcp.text(), "");
  const unknownGet = await fetch("/unknown-head-path");
  const unknownHead = await fetch("/unknown-head-path", "HEAD");
  assert.equal(unknownHead.status, unknownGet.status);
  assert.equal(await unknownHead.text(), "");
});

test("HEAD requests for static assets are fetched as GET and omit the body", async () => {
  const methods: string[] = [];
  const { fetch } = await environment({
    async fetch(request) {
      methods.push(request.method);
      return new Response("asset", { status: 200, headers: { "content-type": "text/plain", "x-asset": "ok" } });
    },
  });
  const response = await fetch("/assets/logo.svg", "HEAD");
  assert.deepEqual(methods, ["GET"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-asset"), "ok");
  assert.equal(await response.text(), "");
});
