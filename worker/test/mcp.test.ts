import * as Effect from "effect/Effect";
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openKeys } from "../src/keys.js";
import { openAccess } from "../src/access.js";
import { validThemeDefinition } from "./theme-fixtures.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Form</title></head><body><h1>Form</h1></body></html>`;

// Test-only wire shapes: absent members fail the assertions at runtime.
interface Structured {
  artifact: { id: string; version: number }; html: string; collection: { kind: string };
  error: { code: string; details?: { currentVersion: number } };
  theme: { scope: string; slug: string; revision?: number; definition?: unknown; brandLock?: boolean };
  themes: Array<{ slug: string }>;
  record: { id: string; version: number; data: unknown }; records: Array<{ id: string }>;
  collections: Array<{ name: string }>; folders: unknown[]; artifacts: unknown[];
  upload: { id: string; partPath: string; received: unknown[] }; file: { id: string; size: number; downloadPath: string };
}
interface ToolResult { content: Array<{ type: string; text: string }>; structuredContent: Structured; isError: boolean }
interface RpcResult {
  protocolVersion: string; capabilities: unknown; serverInfo: { name: string };
  tools: Array<{ name: string; description: string; inputSchema: { type: string; properties?: Record<string, object>; required?: string[] } }>;
}
interface RpcResponse { jsonrpc: "2.0"; id: unknown; result: RpcResult & ToolResult; error?: { code: number; message: string } }

async function environment() {
  const DB = openD1Shim();
  const store = openStore(DB);
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  const keys = openKeys({ db: DB, audit: store.audit, access: openAccess({ db: DB, audit: store.audit }) });
  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master" }));
  const bucket = memoryBucket();
  const RATELIMIT = rateLimitBinding();
  const env = { DB, ARTIFACTS: bucket, ARTEFACTS_MASTER_KEY: MASTER, RATELIMIT };
  const raw = (body: string | undefined, { key = master.key as string | null, method = "POST", headers = {} as Record<string, string> } = {}) => {
    const all: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
    if (key) all.authorization = `Bearer ${key}`;
    return worker.fetch(new Request("https://example.test/_mcp", { method, headers: all, body }), env);
  };
  const rpc = (body: unknown, options: Parameters<typeof raw>[1] = {}) => raw(JSON.stringify(body), options);
  const http = (path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
    worker.fetch(new Request(`https://example.test${path}`, { ...init, headers: { authorization: `Bearer ${master.key}`, ...init.headers } }), env);
  // A constructed Request carries no Content-Length of its own; readBytes requires it.
  const put = (path: string, bytes: number[]) => http(path, { method: "PUT", body: new Uint8Array(bytes),
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
  const get = (path: string) => http(path);
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}, options: Parameters<typeof raw>[1] = {}) => {
    const response = await rpc({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, options);
    assert.equal(response.status, 200);
    return (await response.json<RpcResponse>()).result as ToolResult;
  };
  return { DB, bucket, keys, owner, master, RATELIMIT, raw, rpc, call, put, get };
}

test("initialize negotiates the protocol version", async () => {
  const env = await environment();
  const response = await env.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = await response.json<RpcResponse>();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.equal(typeof body.result.serverInfo.name, "string");
  const fallback = await (await env.rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json<RpcResponse>();
  assert.equal(fallback.result.protocolVersion, "2025-06-18");
  const ping = await (await env.rpc({ jsonrpc: "2.0", id: 3, method: "ping" })).json<RpcResponse>();
  assert.deepEqual(ping.result, {});
});

test("notifications are accepted without a body", async () => {
  const env = await environment();
  const response = await env.rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("client responses are accepted without a body", async () => {
  const env = await environment();
  for (const message of [{ jsonrpc: "2.0", id: 7, result: {} }, { jsonrpc: "2.0", id: 8, error: { code: -32000, message: "declined" } }]) {
    const response = await env.rpc(message);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
});

test("tools/list publishes every tool with an input schema", async () => {
  const env = await environment();
  const body = await (await env.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json<RpcResponse>();
  const tools = body.result.tools as Array<{
    name: string; description: string;
    inputSchema: { type: string; properties?: Record<string, object>; required?: string[] };
  }>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "list_folders", "list_artifacts", "get_artifact", "publish_artifact",
    "list_themes", "get_theme", "define_theme", "delete_theme", "set_project_default_theme", "set_project_brand_lock",
    "list_collections", "define_collection", "delete_collection", "list_records", "get_record", "create_record",
    "update_record", "delete_record", "start_upload", "get_upload", "complete_upload", "cancel_upload", "get_file",
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 0, tool.name);
  }
  for (const tool of tools.slice(18)) {
    assert.match(tool.description, /partPath|downloadPath/, tool.name);
    assert.match(tool.description, /Authorization: Bearer/, tool.name);
  }
  const publish = tools.find(tool => tool.name === "publish_artifact");
  assert.ok(publish);
  assert.deepEqual(publish.inputSchema.properties?.ifVersion, {
    type: "integer", minimum: 1, description: "Only publish when the current version matches.",
  });
  assert.equal(publish.inputSchema.required?.includes("ifVersion"), false);
  assert.deepEqual(publish.inputSchema.properties?.html, { type: "string", description: "Complete HTML document or page fragment." });
  assert.deepEqual(publish.inputSchema.properties?.type, {
    type: "string", enum: ["site", "page"], description: "Omitted or site preserves legacy documents; page validates a semantic fragment.",
  });
});

test("tools/call uploads a file whose bytes travel over HTTP", async () => {
  const env = await environment();
  await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  await env.call("define_collection", { folder: "acme", name: "docs", kind: "records", fields: { title: { type: "text" }, doc: { type: "file" } } });
  const where = { folder: "acme", collection: "docs" };
  const started = await env.call("start_upload", { ...where, field: "doc", name: "a.pdf", size: 3 });
  assert.equal(started.isError, false);
  const { id: uploadId, partPath } = started.structuredContent.upload;
  assert.ok(partPath.startsWith("/_api/projects/"));
  assert.equal((await env.put(`${partPath}1`, [7, 8, 9])).status, 200);
  assert.equal((await env.call("get_upload", { ...where, uploadId })).structuredContent.upload.received.length, 1);
  const { file } = (await env.call("complete_upload", { ...where, uploadId })).structuredContent;
  assert.equal(file.size, 3);
  assert.equal((await env.call("create_record", { ...where, data: { title: "A", doc: file.id } })).isError, false);
  const described = (await env.call("get_file", { ...where, fileId: file.id })).structuredContent.file;
  assert.deepEqual(new Uint8Array(await (await env.get(described.downloadPath)).arrayBuffer()), new Uint8Array([7, 8, 9]));
  const second = (await env.call("start_upload", { ...where, field: "doc", name: "b.pdf", size: 3 })).structuredContent.upload;
  assert.equal((await env.call("cancel_upload", { ...where, uploadId: second.id })).isError, false);
  assert.equal((await env.call("get_upload", { ...where, uploadId: second.id })).isError, true);
});

test("tools/call publishes and manages records through the API", async () => {
  const env = await environment();
  const published = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  assert.equal(published.isError, false);
  assert.equal(published.structuredContent.artifact.version, 1);
  assert.equal(published.content[0]?.type, "text");
  assert.deepEqual(JSON.parse(published.content[0]!.text), published.structuredContent);

  const rsvp = await env.call("define_collection", { folder: "acme", name: "rsvp", kind: "responses", fields: {
    name: { type: "text", required: true }, confirm: { type: "boolean", required: true } } });
  assert.equal(rsvp.isError, false);
  assert.equal(rsvp.structuredContent.collection.kind, "responses");
  await env.call("define_collection", { folder: "acme", name: "offers", kind: "records", fields: { title: { type: "text" } } });
  const created = await env.call("create_record", { folder: "acme", collection: "offers", data: { title: "A" } });
  assert.equal(created.isError, false);
  const id = created.structuredContent.record.id as string;
  const listed = await env.call("list_records", { folder: "acme", collection: "offers", limit: 10 });
  assert.deepEqual(listed.structuredContent.records.map((record: { id: string }) => record.id), [id]);
  assert.deepEqual(JSON.parse(listed.content[0]!.text), listed.structuredContent);
  const updated = await env.call("update_record", { folder: "acme", collection: "offers", id, data: { title: "B" }, ifVersion: 1 });
  assert.equal(updated.structuredContent.record.version, 2);
  assert.deepEqual((await env.call("get_record", { folder: "acme", collection: "offers", id })).structuredContent.record.data, { title: "B" });
  assert.equal((await env.call("delete_record", { folder: "acme", collection: "offers", id, ifVersion: 2 })).isError, false);
  assert.deepEqual((await env.call("list_collections", { folder: "acme" })).structuredContent.collections.map((c: { name: string }) => c.name), ["offers", "rsvp"]);
  assert.equal((await env.call("delete_collection", { folder: "acme", name: "offers" })).isError, false);
  assert.equal((await env.call("list_folders")).structuredContent.folders.length, 1);
  assert.equal((await env.call("list_artifacts")).structuredContent.artifacts.length, 1);
});

test("get_artifact returns explicit content through shared authorization", async () => {
  const env = await environment();
  const published = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  const artifactId = published.structuredContent.artifact.id;
  const denied = await env.call("get_artifact", { artifact: "form" });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "forbidden");

  const capable = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "master", artifactId: null, scopes: "master", can_read_content: true,
  }));
  const success = await env.call("get_artifact", { artifact: "form", version: 1 }, { key: capable.key });
  assert.equal(success.isError, false);
  const content = success.structuredContent;
  assert.deepEqual({ ...content, html: undefined }, {
    artifact: { id: artifactId, slug: "form", version: 1 },
    version: 1, type: "text/html", title: "Form", language: "en", html: undefined,
  });
  assert.match(String(content.html), /<h1>Form<\/h1>/);
  const scoped = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "artifact", artifactId, scopes: "read", can_read_content: true,
  }));
  assert.equal((await env.call("get_artifact", { artifact: "form" }, { key: scoped.key })).isError, false);
  const writer = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "artifact", artifactId, scopes: "write", can_read_content: true,
  }));
  assert.equal((await env.call("get_artifact", { artifact: "form" }, { key: writer.key })).structuredContent.error.code, "forbidden");
  assert.equal((await env.call("get_artifact", { artifact: "form" }, { key: env.master.key })).structuredContent.error.code, "forbidden");
  assert.equal((await env.call("list_artifacts")).structuredContent.artifacts.length, 1);
  assert.equal(JSON.stringify((await env.call("list_artifacts")).structuredContent).includes(HTML), false);
});
test("scoped content readers can initialize and discover only get_artifact", async () => {
  const env = await environment();
  const published = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  const key = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "artifact", artifactId: published.structuredContent.artifact.id,
    scopes: "read", can_read_content: true,
  }));
  const initialized = await env.rpc({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
  }, { key: key.key });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json<RpcResponse>()).result.protocolVersion, "2025-06-18");
  const listed = await env.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { key: key.key });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json<RpcResponse>()).result.tools.map(({ name }) => name), ["get_artifact"]);
  const refused = await env.rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_artifacts", arguments: {} },
  }, { key: key.key });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json<{ error: { message: string } }>()).error.message,
    "This MCP operation needs a master key; artifact keys are limited to authorized get_artifact reads.");
});


test("API errors become tool errors", async () => {
  const env = await environment();
  await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  await env.call("define_collection", { folder: "acme", name: "rsvp", kind: "responses", fields: { name: { type: "text" } } });
  const refused = await env.call("create_record", { folder: "acme", collection: "rsvp", data: { name: "A" } });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, "forbidden");
});

test("authentication, origin and method guards", async () => {
  const env = await environment();
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  const anonymous = await env.rpc(initialize, { key: null });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json<{ error: { code: string } }>()).error.code, "unauthorized");

  const published = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  const scoped = await Effect.runPromise(env.keys.mint({ userId: env.owner.id, kind: "artifact", artifactId: published.structuredContent.artifact.id, scopes: "read_write" }));
  const hidden = await env.rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { key: scoped.key });
  assert.equal(hidden.status, 200);
  assert.deepEqual((await hidden.json<RpcResponse>()).result.tools.map(({ name }) => name), []);
  const denied = await env.rpc({
    jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_collections", arguments: { folder: "acme" } },
  }, { key: scoped.key });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json<{ error: { code: string } }>()).error.code, "forbidden");

  assert.equal((await env.rpc(initialize, { headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await env.rpc(initialize, { headers: { origin: "https://example.test" } })).status, 200);
  const get = await env.raw(undefined, { method: "GET" });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await env.raw(undefined, { method: "DELETE" })).status, 405);
  assert.equal((await env.rpc(initialize, { headers: { "mcp-protocol-version": "1999-01-01" } })).status, 400);
  assert.equal((await env.rpc(initialize, { headers: { "mcp-protocol-version": "2025-03-26" } })).status, 200);
});

test("JSON-RPC errors", async () => {
  const env = await environment();
  const unknown = await (await env.rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" })).json<RpcResponse>();
  assert.equal(unknown.error?.code, -32601);
  assert.equal(unknown.id, 1);
  const batch = await (await env.rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).json<RpcResponse>();
  assert.equal(batch.error?.code, -32600);
  const malformed = await (await env.raw("{not json")).json<RpcResponse>();
  assert.equal(malformed.error?.code, -32700);
  assert.equal(malformed.id, null);
  const tool = await (await env.rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "drop_tables", arguments: {} } })).json<RpcResponse>();
  assert.equal(tool.error?.code, -32602);
  for (const id of [null, true, { n: 1 }, [1]]) {
    const invalid = await (await env.rpc({ jsonrpc: "2.0", id, method: "ping" })).json<RpcResponse>();
    assert.equal(invalid.error?.code, -32600, JSON.stringify(id));
    assert.equal(invalid.id, null);
  }
});

test("tool calls share the API rate limit", async () => {
  const env = await environment();
  env.RATELIMIT.values.set(`w:api:${env.master.record.id}|general`, { count: 120, windowStart: Date.now() });
  const limited = await env.call("list_folders");
  assert.equal(limited.isError, true);
  assert.equal(limited.structuredContent.error.code, "rate-limited");
});
test("MCP publish_artifact forwards optional ifVersion and preserves omitted writes", async () => {
  const env = await environment();
  const first = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  assert.equal(first.isError, false);
  assert.equal(first.structuredContent.artifact.version, 1);

  const update = await env.call("publish_artifact", {
    folder: "acme", slug: "form", title: "Form", html: HTML.replace("<h1>Form</h1>", "<h1>New</h1>"), ifVersion: 1,
  });
  assert.equal(update.isError, false);
  assert.equal(update.structuredContent.artifact.version, 2);
  const objectCount = env.bucket.objects.size;

  const stale = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML, ifVersion: 1 });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "conflict");
  assert.equal(stale.structuredContent.error.details?.currentVersion, 2);

  const unconditional = await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });
  assert.equal(unconditional.isError, false);
  assert.equal(unconditional.structuredContent.artifact.version, 3);
  assert.equal(env.bucket.objects.size, objectCount + 1);
});
test("MCP conditional publish cannot create a missing artefact or folder", async () => {
  const env = await environment();
  const response = await env.call("publish_artifact", {
    folder: "new-folder", slug: "missing", title: "Missing", html: HTML, ifVersion: 1,
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, "conflict");
  assert.equal(response.structuredContent.error.details?.currentVersion, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first<{ count: number }>())?.count, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first<{ count: number }>())?.count, 0);
  assert.equal(env.bucket.objects.size, 0);
});
test("project theme MCP operations share HTTP references, null defaults, and errors", async () => {
  const env = await environment();
  await env.call("publish_artifact", { folder: "acme", slug: "form", title: "Form", html: HTML });

  const definition = validThemeDefinition("brand");
  const created = await env.call("define_theme", { project: "acme", slug: "brand", definition });
  assert.equal(created.isError, false);
  assert.equal(created.structuredContent.theme.revision, 1);
  const listed = await env.call("list_themes", { project: "acme" });
  assert.equal(listed.structuredContent.themes[0]?.slug, "brand");
  const read = await env.call("get_theme", { project: "acme", theme: { scope: "project", slug: "brand" } });
  assert.deepEqual(read.structuredContent.theme.definition, definition);

  assert.equal((await env.call("set_project_default_theme", {
    project: "acme", theme: { scope: "project", slug: "brand" },
  })).isError, false);
  assert.equal((await env.call("set_project_brand_lock", { project: "acme", brandLock: true })).isError, false);
  assert.equal((await env.call("set_project_default_theme", { project: "acme", theme: null })).isError, false);

  const invalid = await env.call("set_project_default_theme", { project: "acme", theme: "launch" });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "validation");
  const missingProject = await env.rpc({
    jsonrpc: "2.0", id: 77, method: "tools/call",
    params: { name: "get_theme", arguments: { theme: { scope: "project", slug: "brand" } } },
  });
  assert.equal((await missingProject.json<RpcResponse>()).error?.code, -32602);
  const invalidRefs = [
    { slug: "report" },
    { scope: "invalid", slug: "report" },
    { scope: "platform", slug: "report", extra: true },
  ];
  for (const theme of invalidRefs) {
    const invalid = await env.rpc({ jsonrpc: "2.0", id: 78, method: "tools/call",
      params: { name: "get_theme", arguments: { theme } } });
    assert.equal((await invalid.json<RpcResponse>()).error?.code, -32602);
  }
});
