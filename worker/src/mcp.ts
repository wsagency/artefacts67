// Stateless MCP over Streamable HTTP (ADR 0032): JSON-RPC 2.0, JSON responses only, no
// sessions or SSE. Every tool is a synthetic `/_api` request through handleApi carrying the
// caller's Authorization, so authority, rate limits and audit keep one path.

import * as Effect from "effect/Effect";
import { json, readJson, text } from "./http.js";
import { API_BODY_LIMIT, handleApi, type ApiContext } from "./api.js";
import type { CodeError } from "./types.js";

export const MCP_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

type Args = Record<string, unknown>;
interface ApiCall { method: string; rest: string; query?: Record<string, unknown>; body?: unknown }
interface Tool { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, object>; required?: string[] }; call(args: Args): ApiCall }

const string = (description: string) => ({ type: "string", description });
const FOLDER = string("Top-level folder slug or id (the project).");
const FIELDS = {
  type: "object",
  description: "Field name → { type: text|email|number|boolean|date|choice|file, required?, maxLength?, min?, max?, integer?, options?, multiple?, maxBytes?, accept? }.",
  additionalProperties: { type: "object" },
};
const segment = (value: unknown) => encodeURIComponent(String(value));
const collectionPath = (args: Args) => `projects/${segment(args.folder)}/collections/${segment(args.name ?? args.collection)}`;
// File tools carry a file `name`, so their collection always comes from `collection`.
const inCollection = (args: Args) => `projects/${segment(args.folder)}/collections/${segment(args.collection)}`;
const recordsPath = (args: Args) => `${inCollection(args)}/records`;
const uploadPath = (args: Args) => `${inCollection(args)}/uploads/${segment(args.uploadId)}`;
const recordArgs = { folder: FOLDER, collection: string("Collection name."), id: string("Record id.") };
const uploadArgs = { folder: FOLDER, collection: recordArgs.collection, uploadId: string("Upload id from start_upload.") };
const HTTP_ONLY = "Bytes never travel through MCP; use HTTP with the same Authorization: Bearer key.";

const TOOLS: Tool[] = [
  { name: "list_folders", description: "List folders this key can reach.",
    inputSchema: { type: "object", properties: {} }, call: () => ({ method: "GET", rest: "folders" }) },
  { name: "list_artifacts", description: "List artefacts this key can reach (metadata only).",
    inputSchema: { type: "object", properties: {} }, call: () => ({ method: "GET", rest: "artifacts" }) },
  { name: "get_artifact", description: "Read an explicitly authorized artefact version.",
    inputSchema: { type: "object", properties: {
      artifact: string("Artefact slug or id."), version: { type: "integer", minimum: 1, description: "Retained version (defaults to current)." },
    }, required: ["artifact"] },
    call: (args) => ({ method: "GET", rest: `artifacts/${segment(args.artifact)}/content`, query: { version: args.version } }) },
  { name: "publish_artifact", description: "Publish a complete HTML site or semantic page fragment in a folder.",
    inputSchema: { type: "object", properties: {
      folder: string("Folder slug; created when missing."), slug: string("Artefact slug."), title: string("Title."),
      html: string("Complete HTML document for site, or a body fragment for page."), type: { type: "string", enum: ["site", "page"] },
      theme: { type: "object", properties: { scope: { type: "string", enum: ["platform"] }, slug: string("Theme slug.") },
        required: ["scope", "slug"], additionalProperties: false },
      themeOverrides: { type: "object", properties: { tokens: { type: "object" }, recipes: { type: "object" } },
        additionalProperties: false },
      folderName: string("Display name for a new folder."),
      lang: string("Document language."), password: string("Optional artefact password."), note: string("Version note."),
      ifVersion: { type: "integer", minimum: 1, description: "Only publish when the current version matches." },
    }, required: ["folder", "slug", "title", "html"] },
    call: (args) => ({ method: "POST", rest: "artifacts", body: args }) },
  { name: "list_collections", description: "List a project's data collections.",
    inputSchema: { type: "object", properties: { folder: FOLDER }, required: ["folder"] },
    call: (args) => ({ method: "GET", rest: `projects/${segment(args.folder)}/collections` }) },
  { name: "define_collection", description: "Create or replace a collection definition. kind is records (shared data) or responses (reader submissions); it cannot change later.",
    inputSchema: { type: "object", properties: {
      folder: FOLDER, name: string("Collection name: a-z, 0-9, - or _."), kind: { type: "string", enum: ["records", "responses"] },
      fields: FIELDS, visitors: { type: "boolean", description: "Allow share visitors (default false)." },
    }, required: ["folder", "name", "kind", "fields"] },
    call: (args) => ({ method: "PUT", rest: collectionPath(args), body: { kind: args.kind, fields: args.fields, visitors: args.visitors } }) },
  { name: "delete_collection", description: "Delete a collection and all its records.",
    inputSchema: { type: "object", properties: { folder: FOLDER, name: string("Collection name.") }, required: ["folder", "name"] },
    call: (args) => ({ method: "DELETE", rest: collectionPath(args) }) },
  { name: "list_records", description: "List records oldest first; pass the returned cursor for the next page.",
    inputSchema: { type: "object", properties: {
      folder: FOLDER, collection: recordArgs.collection, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: string("Opaque page cursor."),
    }, required: ["folder", "collection"] },
    call: (args) => ({ method: "GET", rest: recordsPath(args), query: { limit: args.limit, cursor: args.cursor } }) },
  { name: "get_record", description: "Read one record.",
    inputSchema: { type: "object", properties: recordArgs, required: ["folder", "collection", "id"] },
    call: (args) => ({ method: "GET", rest: `${recordsPath(args)}/${segment(args.id)}` }) },
  { name: "create_record", description: "Create a record in a records collection.",
    inputSchema: { type: "object", properties: { folder: FOLDER, collection: recordArgs.collection, data: { type: "object" } }, required: ["folder", "collection", "data"] },
    call: (args) => ({ method: "POST", rest: recordsPath(args), body: { data: args.data } }) },
  { name: "update_record", description: "Replace a record's data; ifVersion makes it conditional.",
    inputSchema: { type: "object", properties: { ...recordArgs, data: { type: "object" }, ifVersion: { type: "integer", minimum: 1 } }, required: ["folder", "collection", "id", "data"] },
    call: (args) => ({ method: "PUT", rest: `${recordsPath(args)}/${segment(args.id)}`, body: { data: args.data, ifVersion: args.ifVersion } }) },
  { name: "delete_record", description: "Delete a record; ifVersion makes it conditional.",
    inputSchema: { type: "object", properties: { ...recordArgs, ifVersion: { type: "integer", minimum: 1 } }, required: ["folder", "collection", "id"] },
    call: (args) => ({ method: "DELETE", rest: `${recordsPath(args)}/${segment(args.id)}`, query: { ifVersion: args.ifVersion } }) },
  { name: "start_upload", description: "Start or resume a file upload for a file field of a records collection. Bytes never travel through MCP: " +
      "PUT each part n (1…upload.parts, upload.partBytes each except the last) as raw bytes with Content-Type: application/octet-stream " +
      "to <this origin><upload.partPath><n> with the same Authorization: Bearer key, then call complete_upload.",
    inputSchema: { type: "object", properties: {
      folder: FOLDER, collection: recordArgs.collection, field: string("File field name."), name: string("File name."),
      type: string("MIME type."), size: { type: "integer", minimum: 1 }, lastModified: { type: "integer" },
    }, required: ["folder", "collection", "field", "name", "size"] },
    call: (args) => ({ method: "POST", rest: `${inCollection(args)}/uploads`,
      body: { field: args.field, name: args.name, type: args.type, size: args.size, lastModified: args.lastModified } }) },
  { name: "get_upload", description: `Show an upload's received parts and its partPath. ${HTTP_ONLY}`,
    inputSchema: { type: "object", properties: uploadArgs, required: ["folder", "collection", "uploadId"] },
    call: (args) => ({ method: "GET", rest: uploadPath(args) }) },
  { name: "complete_upload", description: `Seal an upload once every part was PUT to its partPath; returns the file to put in a record's file field. ${HTTP_ONLY}`,
    inputSchema: { type: "object", properties: uploadArgs, required: ["folder", "collection", "uploadId"] },
    call: (args) => ({ method: "POST", rest: `${uploadPath(args)}/complete` }) },
  { name: "cancel_upload", description: `Cancel an upload and discard the parts already PUT to its partPath. ${HTTP_ONLY}`,
    inputSchema: { type: "object", properties: uploadArgs, required: ["folder", "collection", "uploadId"] },
    call: (args) => ({ method: "DELETE", rest: uploadPath(args) }) },
  { name: "get_file", description: "Describe an attached file; download its bytes with GET <this origin><file.downloadPath> and the same Authorization: Bearer key.",
    inputSchema: { type: "object", properties: { folder: FOLDER, collection: recordArgs.collection, fileId: string("File id.") }, required: ["folder", "collection", "fileId"] },
    call: (args) => ({ method: "GET", rest: `${inCollection(args)}/files/${segment(args.fileId)}` }) },
];

export const MCP_TOOLS: ReadonlyArray<{ name: string; description: string; inputSchema: object }> =
  TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

type RpcId = string | number | null;
const reply = (id: RpcId, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function handleMcp(request: Request, ctx: ApiContext): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return text("Method Not Allowed", 405, { Allow: "POST" });
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin && origin !== ctx.publicOrigin.replace(/\/+$/, "")) {
      return json({ error: { code: "forbidden", message: "Cross-origin MCP requests are refused." } }, 403);
    }
    const version = request.headers.get("mcp-protocol-version");
    if (version && !(MCP_VERSIONS as readonly string[]).includes(version)) {
      return rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}.`, 400);
    }
    const authorization = request.headers.get("authorization") ?? "";
    const who = yield* ctx.keys.authenticate(request);
    if (!who) {
      return json({ error: { code: "unauthorized", message: "A valid API key is required (Authorization: Bearer <key>)." } }, 401);
    }
    const parsed = yield* readJson(request, API_BODY_LIMIT + 64 * 1024).pipe(
      Effect.map((body) => ({ body })),
      Effect.catch((error) => Effect.succeed({ error })),
    );
    if ("error" in parsed) {
      return parsed.error.code === "too-large"
        ? json({ error: { code: "too-large", message: "Request body is too large." } }, 413)
        : rpcError(null, -32700, "Parse error.");
    }
    const message = parsed.body;
    // A response to a server request (we send none) is acknowledged like a notification.
    if (isObject(message) && message.jsonrpc === "2.0" && "id" in message && !("method" in message) && ("result" in message || "error" in message)) {
      return new Response(null, { status: 202 });
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(null, -32600, "Invalid request: send one JSON-RPC 2.0 message (no batches).");
    }
    if (!("id" in message)) return new Response(null, { status: 202 });
    if (typeof message.id !== "string" && typeof message.id !== "number") return rpcError(null, -32600, "Invalid request: id is a string or a number.");
    const id: RpcId = message.id;
    const params = isObject(message.params) ? message.params : {};
    let canDiscoverContent = false;
    if (who.key.kind === "artifact" && who.key.can_read_content && ctx.keys.hasScope(who.key, "read") && who.artifact) {
      canDiscoverContent = yield* ctx.keys.may(who.key, {
        ownerId: who.artifact.owner_id, folderId: who.artifact.folder_id, artifactId: who.artifact.id,
      }, "read");
    }
    const lifecycle = message.method === "initialize" || message.method === "ping" || message.method === "tools/list";
    const contentCall = message.method === "tools/call" && params.name === "get_artifact";
    if (who.key.kind !== "master" && !lifecycle && !contentCall) {
      return json({ error: { code: "forbidden", message: "This MCP operation needs a master key; artifact keys are limited to authorized get_artifact reads." } }, 403);
    }

    switch (message.method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = (MCP_VERSIONS as readonly unknown[]).includes(requested) ? requested : MCP_VERSIONS[0];
        return reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "artefacts67", version: "2.0.0" } });
      }
      case "ping": return reply(id, {});
      case "tools/list": return reply(id, { tools: who.key.kind === "master" ? MCP_TOOLS
        : canDiscoverContent ? MCP_TOOLS.filter(({ name }) => name === "get_artifact") : [] });
      case "tools/call": {
        const tool = TOOLS.find((candidate) => candidate.name === params.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool ${String(params.name)}.`);
        const args = isObject(params.arguments) ? params.arguments : {};
        const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined || args[key] === null);
        if (missing.length) return rpcError(id, -32602, `Missing arguments: ${missing.join(", ")}.`);
        const call = tool.call(args);
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(call.query ?? {})) if (value !== undefined && value !== null) query.set(key, String(value));
        const search = query.size ? `?${query}` : "";
        const synthetic = new Request(new URL(`/_api/${call.rest}${search}`, request.url), {
          method: call.method,
          headers: { authorization, "content-type": "application/json" },
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
        });
        const response = yield* handleApi(synthetic, ctx, { rest: call.rest });
        const body = yield* Effect.promise(() => response.text());
        let structuredContent: unknown;
        try { structuredContent = JSON.parse(body); } catch { structuredContent = { text: body }; }
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
          isError: response.status >= 400,
        });
      }
      default: return rpcError(id, -32601, `Method not found: ${message.method}.`);
    }
  });
}
