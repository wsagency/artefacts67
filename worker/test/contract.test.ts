// The public reference endpoint must retain the platform's response hygiene.

import test from "node:test";
import assert from "node:assert/strict";

import { agentInstructions } from "../src/instructions.js";
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

test("contract() documents M1 content-read capability and conditional writes", async () => {
  const body = (await contract().text()).replace(/\s+/g, " ");
  for (const statement of [
    "`can_read_content` is an explicit opt-in on key creation; absent and unchecked values are false, including for existing keys.",
    "Content reads require this capability and the key's current authority; password and visitor shares never authorize the API or MCP read.",
    "Every content read is audited with its outcome and without source content.",
    "`get_artifact({artifact,version?})` returns content only through an explicitly authorized read.",
    "`ifVersion` is optional and must be a positive integer.",
    "the API returns `409 conflict` with `currentVersion`",
    "Omitting `ifVersion` preserves the existing unconditional publish behavior.",
    "ordinary `site` publishes remain complete-document writes and are unchanged.",
  ]) {
    assert.ok(body.includes(statement), `contract is missing: ${statement}`);
  }
});
test("AI instructions describe the scoped MCP content-read capability", async () => {
  const instructions = agentInstructions("https://example.test", {});
  assert.match(instructions, /Only wak_ master keys may use project data and full MCP tools; an opted-in waa_ key with read scope and current read authority may call only get_artifact\./);
  assert.match(instructions, /get_artifact/);
  assert.match(instructions, /master key with content-read enabled using the console checkbox under Settings → API keys/);
  assert.match(instructions, /scoped artifact key with content-read capability created by POST `\/_api\/keys` with `\{artifact, scopes: "read", can_read_content: true\}`/);
  assert.doesNotMatch(instructions, /artifact key with content-read capability created under Settings → API keys/);
});

