// The public reference endpoint must retain the platform's response hygiene.

import test from "node:test";
import assert from "node:assert/strict";

import { contract } from "../src/contract.js";

test("contract() serves the markdown under the platform hygiene headers", async () => {
  const res = contract();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

