import * as Effect from "effect/Effect";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding, openAsVisitor, authoredDocument } from "./doubles.js";
import { openStore, type Store } from "../src/store.js";
import { openKeys, type Key } from "../src/keys.js";
import { openAccess } from "../src/access.js";
import { openFolders } from "../src/folders.js";
import { openArtifacts } from "../src/artifacts.js";
import { openProjectData } from "../src/project-data.js";
import { openProjectFiles } from "../src/project-files.js";
import { openRateLimiter } from "../src/ratelimit.js";
import { handleApi, API_BODY_LIMIT, type ApiContext } from "../src/api.js";
import type { GatePayload } from "../src/artifacts.js";
import type { ValidationIssue } from "../src/validate.js";
import { contract } from "../src/contract.js";
import { PLATFORM_THEMES } from "../../frontend/src/platform-themes.js";
import { composePageDocument } from "../../frontend/src/page-composition.js";
import { validThemeDefinition } from "./theme-fixtures.js";
import { openProjectThemes } from "../src/themes.js";
import { THEME_FONT_SOURCE, themeFontFetcher } from "./theme-fixtures.js";
import { PAGE_DOCUMENT_MAX_LENGTH, worstPageDocumentLength } from "../src/page-size.js";

const PAGE_PNG = Buffer.from(readFileSync(new URL("./fixtures/page-image.png", import.meta.url))).toString("base64");
const PAGE_JPEG = Buffer.from(readFileSync(new URL("./fixtures/page-photo.jpg", import.meta.url))).toString("base64");

interface ApiOptions { key?: string; method?: string; body?: unknown; headers?: Record<string, string> }
interface ArtifactDto {
  id: string; slug: string | null; title: string; lang: string; path: string; url: string;
  gated: boolean; version: number;
  folder: { id: string; slug: string | null; path: string; indexUrl: string };
}
interface PublishedResponse { artifact: ArtifactDto; artifacts?: never; warnings: ValidationIssue[] }
interface ArtifactListResponse { artifacts: ArtifactDto[] }
interface KeyResponse { key: Key; token: string }
interface KeyListResponse { keys: Key[] }
interface FolderDto { slug: string | null; path: string; artifacts: number }
interface FolderListResponse { folders: FolderDto[] }
interface ArtifactAliasResponse { artifact: Pick<ArtifactDto, "slug" | "path">; aliases: string[] }
interface FolderAliasResponse { folder: Pick<FolderDto, "slug" | "path">; aliases: string[] }
interface ErrorResponse { error: { code: string; message: string; details?: ValidationIssue[] } }

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const HTML = `<!doctype html><html lang="hr"><head><meta charset="utf-8"><title>Upute</title></head><body><h1>Bok</h1></body></html>`;
const HTML2 = HTML.replace("<h1>Bok</h1>", "<h1>Drugo izdanje</h1>");

/** One Worker environment plus a minted master key for the owner. */
async function environment() {
  const DB = openD1Shim();
  const store = openStore(DB);
  const bucket = memoryBucket();
  const limiter = rateLimitBinding();
  const owner = await Effect.runPromise(store.users.create({
    id: "owner0000000000a1", email: "owner@example.test", name: "Owner", role: "owner",
    passwordHash: "{}",
  }));
  const keys = openKeys({ db: DB, audit: store.audit, access: openAccess({ db: DB, audit: store.audit }) });
  const master = await Effect.runPromise(keys.mint({ userId: owner.id, kind: "master", scopes: "master", label: "Agent" }));
  const env = { DB, ARTIFACTS: bucket, ARTEFACTS_MASTER_KEY: MASTER, RATELIMIT: limiter };
  const session = await Effect.runPromise(store.sessions.create(owner.id, { pending2fa: false }));
  const fetch = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Cookie")) headers.set("Cookie", `wsa_session=${session.id}`);
    if (init.method === "POST" && !headers.has("Origin")) headers.set("Origin", "https://example.test");
    return worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), env);
  };
  const api = (path: string, { key = master.key, method = "GET", body, headers = {} }: ApiOptions = {}) =>
    fetch(path, {
      method,
      headers: body
        ? { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }
        : { authorization: `Bearer ${key}`, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const publish = (body: unknown, options: ApiOptions = {}) => api("/_api/artifacts", { method: "POST", body, ...options });
  const load = async (path: string) => {
    const response = await fetch("/_runtime/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "public", path } }),
    });
    assert.equal(response.status, 200);
    return authoredDocument((await response.json<{ html: string }>()).html);
  };
  return { DB, store, bucket, limiter, owner, keys, master, api, fetch, publish, load };
}

const addUser = (store: Store, id: string, email: string) =>
  store.users.create({ id, email, name: id, role: "member", passwordHash: "{}" });

test("publishing is synchronous: the artefact is live in the same request", async () => {
  const env = await environment();
  const created = await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, lang: "hr" });

  assert.equal(created.status, 201);
  const body = await created.json<PublishedResponse>();
  assert.equal(body.artifacts, undefined);
  assert.equal(body.artifact.slug, "upute");
  assert.equal(body.artifact.lang, "hr");
  assert.equal(body.artifact.version, 1);
  assert.equal(body.artifact.gated, false);
  assert.equal(body.artifact.url, "https://example.test/upute/");
  assert.equal(body.artifact.path, "/upute/");
  assert.equal(body.artifact.folder.slug, "acme");
  assert.equal(body.artifact.folder.indexUrl, "https://example.test/acme/");
  assert.deepEqual(body.warnings, []);

  // The owner can read the new private address immediately — no poll, no deploy.
  const served = await env.fetch("/upute/");
  assert.equal(served.status, 200);
  assert.equal((await served.text()).includes("<h1>Bok</h1>"), false);
  assert.equal(await env.load("upute"), HTML);
  // ...and the folder it auto-created is the index that lists it.
  const index = await env.fetch("/acme/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Upute/);
});

test("re-publishing the same (folder, slug) updates in place and never moves the link", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });

  const updated = await env.publish({ folder: "acme", slug: "upute", title: "Upute, drugo izdanje", html: HTML2 });
  assert.equal(updated.status, 200);                       // 201 creates, 200 updates
  const body = await updated.json<PublishedResponse>();
  assert.equal(body.artifact.version, 2);
  assert.equal(body.artifact.url, "https://example.test/upute/");
  assert.equal(body.artifact.title, "Upute, drugo izdanje");
  assert.equal(await env.load("upute"), HTML2);

  const listed = await (await env.api("/_api/artifacts")).json<ArtifactListResponse>();
  assert.equal(listed.artifacts.length, 1);                // one artefact, two versions
});

test("a gated artefact publishes straight into a gate a visitor can open", async () => {
  const env = await environment();
  const created = await env.publish({ folder: "acme", slug: "tajno", title: "Tajno", html: HTML, password: "tajna-lozinka" });
  assert.equal(created.status, 201);
  assert.equal((await created.json<PublishedResponse>()).artifact.gated, true);

  const page = await env.fetch("/tajno/");
  assert.equal(page.status, 200);
  assert.equal((await page.text()).includes("<h1>Bok</h1>"), false);        // no ciphertext in the page

  const opened = await env.fetch("/_gate/tajno/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "tajna-lozinka" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json<GatePayload>(), "tajna-lozinka")), HTML);
});

test("the validator rejects what the platform cannot serve", async () => {
  const env = await environment();
  const cases = [
    [{ folder: "acme", slug: "bez-doctype", title: "X", html: "<p>nije dokument</p>" }, "incomplete-document"],
    [{ folder: "acme", slug: "vanjski", title: "X", html: `${HTML}<img src="https://cdn.example.test/a.png">` }, "external-reference"],
    [{ folder: "acme", slug: "slaba", title: "X", html: HTML, password: "kratko" }, "weak-password"],
  ];
  for (const [body, code] of cases) {
    const response = await env.publish(body);
    assert.equal(response.status, 422, `${code} should be rejected`);
    const payload = await response.json<ErrorResponse>();
    assert.equal(payload.error.code, "validation");
    assert.equal(payload.error.details?.some((issue) => issue.code === code), true, `expected ${code}`);
  }

  const missing = await env.publish({ folder: "acme", title: "X", html: HTML });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json<ErrorResponse>()).error.details?.some((issue) => issue.code === "invalid-slug"), true);

  const notJson = await env.api("/_api/artifacts", { method: "POST", body: HTML });
  assert.equal(notJson.status, 422);                       // a bare string is not a JSON object
});
test("page publication rejects ThemeRef string shorthand", async () => {
  const env = await environment();
  const rejected = await env.publish({ folder: "acme", slug: "string-theme", title: "Invalid ref", type: "page",
    html: "<main><h1>Content</h1></main>", theme: "report" as never });
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json<ErrorResponse>()).error.code, "validation");
});
test("page publication accepts a project ThemeRef", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "project-theme-anchor", title: "Project", html: HTML });
  const defined = await env.api("/_api/projects/acme/themes/brand", {
    method: "PUT", body: validThemeDefinition("brand"),
  });
  assert.equal(defined.status, 201);
  const published = await env.publish({
    folder: "acme", slug: "project-themed-page", title: "Project theme", type: "page",
    html: "<main><h1>Project theme</h1></main>", theme: { scope: "project", slug: "brand" },
  });
  assert.equal(published.status, 201);
  const artifact = (await published.json<PublishedResponse>()).artifact;
  const row = await env.DB.prepare(
    "SELECT theme_scope, theme_slug, theme_id FROM artifact_versions WHERE artifact_id = ? AND version = 1",
  ).bind(artifact.id).first<{ theme_scope: string | null; theme_slug: string | null; theme_id: string | null }>();
  assert.deepEqual({ scope: row?.theme_scope, slug: row?.theme_slug }, { scope: "project", slug: "brand" });
  assert(row?.theme_id);
});
test("nested-folder page publication resolves its project theme from the top-level ancestor", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "nested-anchor", title: "Anchor", html: HTML });
  const parent = await env.DB.prepare("SELECT id,owner_id FROM folders WHERE slug='acme'").first<{ id: string; owner_id: string }>();
  assert.ok(parent);
  env.DB.prepare("INSERT INTO folders (id,slug,name_sealed,owner_id,created_at,updated_at,parent_id) VALUES (?,?,?,?,?,?,?)")
    .bind("nested-child", "nested-child", "sealed", parent.owner_id, new Date().toISOString(), new Date().toISOString(), parent.id).run();
  const defined = await env.api("/_api/projects/acme/themes/brand", { method: "PUT", body: validThemeDefinition("brand") });
  assert.equal(defined.status, 201);
  const published = await env.publish({
    folder: "nested-child", slug: "nested-themed-page", title: "Nested theme", type: "page",
    html: "<main><h1>Nested theme</h1></main>", theme: { scope: "project", slug: "brand" },
  });
  assert.equal(published.status, 201, await published.text());
});
test("page publication counts the current project default and captured font CSS toward the document limit", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "project-default-anchor", title: "Anchor", html: HTML });
  const definition = validThemeDefinition("expanded");
  definition.fonts.heading.stack = `"${"A".repeat(80)}", system-ui, sans-serif`;
  const defined = await env.api("/_api/projects/acme/themes/expanded", { method: "PUT", body: definition });
  assert.equal(defined.status, 201);
  const setDefault = await env.api("/_api/projects/acme/theme-default", {
    method: "PUT", body: { theme: { scope: "project", slug: "expanded" } },
  });
  assert.equal(setDefault.status, 200);
  const baseline = worstPageDocumentLength("", PLATFORM_THEMES, "https://example.test", "en");
  const projectTheme = PLATFORM_THEMES[0]!;
  const fontCss = `@font-face{font-family:Example;src:url(data:font/woff2;base64,${"A".repeat(2048)})}`;
  const withCapturedFonts = worstPageDocumentLength("", PLATFORM_THEMES, "https://example.test", "en", undefined, {
    compiledTheme: projectTheme, fontsCss: fontCss,
  });
  assert.equal(withCapturedFonts, baseline + fontCss.length + "<style id=\"a67-page-fonts\"></style>".length);
  const largestPlatformSize = worstPageDocumentLength("", PLATFORM_THEMES, "https://example.test", "en");
  const nearLimit = `<main>${"x".repeat(PAGE_DOCUMENT_MAX_LENGTH - largestPlatformSize - 13)}</main>`;
  const capturedFontsAtPlatformSelection = worstPageDocumentLength(nearLimit, PLATFORM_THEMES, "https://example.test", "en",
    undefined, { compiledTheme: PLATFORM_THEMES.find(theme => theme.slug === "report")!, fontsCss: "x" });
  assert.ok(capturedFontsAtPlatformSelection > PAGE_DOCUMENT_MAX_LENGTH,
    "switching to the largest platform theme must retain captured-font CSS in the size check");
  const fragment = `<main>${"x".repeat(1_500_000 - baseline - 13)}</main>`;
  const rejected = await env.publish({ folder: "acme", slug: "project-expanded-over-limit", title: "Too large",
    type: "page", html: fragment });
  assert.equal(rejected.status, 422);
  assert.ok((await rejected.json<ErrorResponse>()).error.details?.some(issue => issue.code === "composed-too-large"));
});
test("project theme with captured fonts publishes at the exact composition limit and rejects limit plus one", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "project-font-limit-anchor", title: "Anchor", html: HTML });
  const project = await env.DB.prepare("SELECT id FROM folders WHERE slug='acme'").first<{ id: string }>();
  assert.ok(project);
  const themes = openProjectThemes({ db: env.DB, masterKeyHex: MASTER, fetcher: themeFontFetcher });
  const access = openAccess({ db: env.DB, audit: env.store.audit });
  const context: ApiContext = {
    keys: env.keys,
    artifacts: openArtifacts({ db: env.DB, bucket: env.bucket, masterKeyHex: MASTER, settings: env.store.settings }),
    folders: openFolders({ db: env.DB, masterKeyHex: MASTER }),
    access,
    limiter: openRateLimiter({ RATELIMIT: env.limiter }),
    store: env.store,
    themes,
    projectData: openProjectData({ db: env.DB, masterKeyHex: MASTER }),
    projectFiles: openProjectFiles({ db: env.DB, bucket: env.bucket, masterKeyHex: MASTER }),
    publicOrigin: "https://example.test",
    contract,
  };
  const directApi = (path: string, body: unknown, method = "POST") => Effect.runPromise(handleApi(
    new Request(`https://example.test${path}`, {
      method, headers: { authorization: `Bearer ${env.master.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }), context, { rest: path.replace(/^\/_api\/?/, "") }));
  const definition = { ...validThemeDefinition("font-limited"), fontSources: [THEME_FONT_SOURCE] };
  definition.fonts.heading = { family: "Example", stack: '"Example", system-ui, sans-serif' };
  const defined = await directApi("/_api/projects/acme/themes/font-limited", definition, "PUT");
  assert.equal(defined.status, 201, await defined.clone().text());
  const selected = { scope: "project" as const, slug: "font-limited" };
  assert.equal((await directApi("/_api/projects/acme/theme-default", { theme: selected }, "PUT")).status, 200);
  const definitionRow = await Effect.runPromise(themes.get({ folderId: project.id, theme: selected }));
  assert.ok("definition" in definitionRow);
  const resolved = await Effect.runPromise(themes.resolveForRead({ folderId: project.id, theme: selected, themeId: definitionRow.id }));
  assert.match(resolved.fontsCss, /data:font\/woff2;base64,/);
  const baseline = worstPageDocumentLength("", PLATFORM_THEMES, "https://example.test", "en", undefined,
    { compiledTheme: resolved.compiledTheme, fontsCss: resolved.fontsCss });
  const fragmentLength = PAGE_DOCUMENT_MAX_LENGTH - baseline;
  const exact = `<main>${"x".repeat(fragmentLength - 13)}</main>`;
  assert.equal(worstPageDocumentLength(exact, PLATFORM_THEMES, "https://example.test", "en", undefined,
    { compiledTheme: resolved.compiledTheme, fontsCss: resolved.fontsCss }), PAGE_DOCUMENT_MAX_LENGTH);
  const accepted = await directApi("/_api/artifacts", {
    folder: "acme", slug: "project-font-limit-exact", title: "Exact limit", type: "page", html: exact,
  });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const over = `<main>${"x".repeat(fragmentLength - 12)}</main>`;
  const rejected = await directApi("/_api/artifacts", {
    folder: "acme", slug: "project-font-limit-over", title: "Over limit", type: "page", html: over,
  });
  assert.equal(rejected.status, 422);
  assert.ok((await rejected.json<ErrorResponse>()).error.details?.some(issue => issue.code === "composed-too-large"));
});
test("omitted publish theme validates overrides against the effective project default", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "default-theme-anchor", title: "Anchor", html: HTML });
  const setDefault = await env.api("/_api/projects/acme/theme-default", {
    method: "PUT", body: { theme: { scope: "platform", slug: "launch" } },
  });
  assert.equal(setDefault.status, 200);
  const published = await env.publish({ folder: "acme", slug: "default-blue-page", title: "Default blue", type: "page",
    html: "<main><h1>Default blue</h1></main>", themeOverrides: { tokens: { accent: "#0000ff" } } });
  assert.equal(published.status, 201, await published.text());
});
test("page publication rejects invalid inline images and accepts signature-matched fixtures", async () => {
  const env = await environment();
  const invalid = await env.publish({
    folder: "acme", slug: "invalid-page-image", title: "Invalid page", type: "page",
    html: `<main><h1>Report</h1><img src="data:image/png;base64,${PAGE_JPEG}" alt="Photo" width="96" height="72"></main>`,
  });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json<ErrorResponse>()).error.code, "validation");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first<{ count: number }>())?.count, 0);

  const html = `<main><h1>Report</h1><img src="data:image/jpeg;base64,${PAGE_JPEG}" alt="A mountain lake" width="96" height="72"><img src="data:image/png;base64,${PAGE_PNG}" alt="" width="8" height="8"></main>`;
  const accepted = await env.publish({
    folder: "acme", slug: "valid-page", title: "Valid page", type: "page", html,
    theme: { scope: "platform", slug: "report" }, themeOverrides: { tokens: {} },
  });
  assert.equal(accepted.status, 201);
  const artifact = (await accepted.json<PublishedResponse>()).artifact;
  const row = await env.DB.prepare(
    "SELECT type, theme_scope, theme_slug, theme_overrides_sealed FROM artifact_versions WHERE artifact_id = ? AND version = 1",
  ).bind(artifact.id).first<{ type: string; theme_scope: string | null; theme_slug: string | null; theme_overrides_sealed: string | null }>();
  assert.equal(row?.type, "page");
  assert.equal(row?.theme_scope, "platform");
  assert.equal(row?.theme_slug, "report");
  assert.ok(row?.theme_overrides_sealed);
  assert.equal(await env.load("valid-page"), html);
});

test("page publication accepts a removed platform slug with sealed overrides resolved on Report", async () => {
  const env = await environment();
  const html = "<main><h1>Fallback publication</h1></main>";
  const accepted = await env.publish({
    folder: "acme", slug: "removed-platform-theme", title: "Fallback page", type: "page", html,
    theme: { scope: "platform", slug: "removed-platform-theme" },
    themeOverrides: { tokens: { "--a67-accent": "#8f5e00" } },
  });
  assert.equal(accepted.status, 201);
  const artifact = (await accepted.json<PublishedResponse>()).artifact;
  const row = await env.DB.prepare(
    "SELECT theme_scope, theme_slug, theme_overrides_sealed FROM artifact_versions WHERE artifact_id = ? AND version = 1",
  ).bind(artifact.id).first<{ theme_scope: string | null; theme_slug: string | null; theme_overrides_sealed: string | null }>();
  assert.equal(row?.theme_scope, "platform");
  assert.equal(row?.theme_slug, "removed-platform-theme");
  assert.ok(row?.theme_overrides_sealed);
  assert.equal(await env.load("removed-platform-theme"), html);
});

test("an artifact key reaches its one artefact and nothing else", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  await env.publish({ folder: "acme", slug: "drugo", title: "Drugo", html: HTML });

  const minted = await env.api("/_api/keys", {
    method: "POST",
    body: { artifact: "upute", scopes: "read", label: "Acme integracija" },
  });
  assert.equal(minted.status, 201);
  const { key, token } = await minted.json<KeyResponse>();
  assert.match(token, /^waa_[a-f0-9]{40}$/);
  assert.equal(key.kind, "artifact");
  assert.equal(key.label, "Acme integracija");
  assert.equal(key.prefix, token.slice(0, 8));
  assert.equal(JSON.stringify(key).includes("token"), false);
  assert.equal(JSON.stringify(key).includes(token.slice(10)), false);      // only the prefix, never the secret

  const listed = await env.api("/_api/artifacts", { key: token });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json<ArtifactListResponse>()).artifacts.map((a) => a.slug), ["upute"]);

  // Scoped to read: no publish, no rotate, no folder listing, and no minting on its own behalf.
  assert.equal((await env.publish({ folder: "acme", slug: "upute", title: "X", html: HTML }, { key: token })).status, 403);
  assert.equal((await env.api("/_api/folders", { key: token })).status, 403);
  assert.equal((await env.api("/_api/keys", { key: token })).status, 403);
  assert.equal((await env.api("/_api/artifacts/rotate", { key: token, method: "POST", body: { artifact: "upute", password: "novalozinka" } })).status, 403);

  // A write-scoped artifact key still cannot touch the sibling artefact.
  const writer = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read_write" } })).json<KeyResponse>();
  assert.equal((await env.api("/_api/artifacts/rotate", { key: writer.token, method: "POST", body: { artifact: "drugo", password: null } })).status, 403);
});

test("invalid page theme overrides reject without replacing the readable current version", async () => {
  const env = await environment();
  const html = "<main><h1>Readable version</h1></main>";
  const created = await env.publish({
    folder: "acme", slug: "invalid-theme-update", title: "Themed", type: "page", html,
    theme: { scope: "platform", slug: "report" }, themeOverrides: { tokens: {} },
  });
  assert.equal(created.status, 201);

  const rejected = await env.publish({
    folder: "acme", slug: "invalid-theme-update", title: "Broken", type: "page",
    html: "<main><h1>Must not replace current</h1></main>",
    theme: { scope: "platform", slug: "report" }, themeOverrides: { tokens: { density: "2" } },
  });
  assert.equal(rejected.status, 422);
  const error = await rejected.json<ErrorResponse>();
  assert.equal(error.error.code, "validation");
  assert.ok(error.error.details?.some(issue => issue.field === "themeOverrides"));

  assert.equal(await env.load("invalid-theme-update"), html);
  const versions = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM artifact_versions WHERE artifact_id = (SELECT id FROM artifacts WHERE slug = 'invalid-theme-update')",
  ).first<{ count: number }>();
  assert.equal(versions?.count, 1);
});

test("artifact-key mint accepts an explicit content-read capability and defaults it off", async () => {
  const env = await environment();
  assert.equal((await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML })).status, 201);
  const omitted = await (await env.api("/_api/keys", {
    method: "POST", body: { artifact: "upute", scopes: "read" },
  })).json<KeyResponse>();
  assert.equal(omitted.key.can_read_content, false);
  const optedIn = await (await env.api("/_api/keys", {
    method: "POST", body: { artifact: "upute", scopes: "read", can_read_content: true },
  })).json<KeyResponse>();
  assert.equal(optedIn.key.can_read_content, true);
});
test("content reads require explicit capability, read scope and live bound authority", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, lang: "hr", password: "tajna-lozinka" });
  await env.publish({ folder: "acme", slug: "upute", title: "Novo", html: HTML2, lang: "en" });
  await env.publish({ folder: "acme", slug: "drugo", title: "Drugo", html: HTML });

  const plain = await Effect.runPromise(env.keys.mint({ userId: env.owner.id, kind: "master", scopes: "master" }));
  const capableMaster = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "master", scopes: "master", can_read_content: true,
  }));
  const list = await (await env.api("/_api/artifacts")).json<ArtifactListResponse>();
  const artifactId = list.artifacts.find(({ slug }) => slug === "upute")!.id;
  const masterRead = await env.api("/_api/artifacts/upute/content?version=1", { key: capableMaster.key });
  assert.equal(masterRead.status, 200);
  const masterContent = await masterRead.json<{ artifact: { id: string; slug: string; version: number }; version: number; type: string; title: string; language: string; html: string }>();
  assert.deepEqual({ ...masterContent, html: undefined }, {
    artifact: { id: artifactId, slug: "upute", version: 1 },
    version: 1, type: "text/html", title: "Novo", language: "en", html: undefined,
  });
  assert.match(masterContent.html, /<h1>Bok<\/h1>/);
  assert.equal(JSON.stringify(list).includes(HTML), false);
  assert.equal((await env.api("/_api/artifacts/upute/content", { key: plain.key })).status, 403);

  const artifact = list.artifacts.find(({ slug }) => slug === "upute")!;
  const defaultOff = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read",
  }));
  assert.equal((await env.api("/_api/artifacts/upute/content", { key: defaultOff.key })).status, 403);
  const readKey = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "artifact", artifactId: artifact.id, scopes: "read", can_read_content: true,
  }));
  const scopedContent = await env.api("/_api/artifacts/upute/content", { key: readKey.key });
  assert.equal(scopedContent.status, 200);
  assert.match((await scopedContent.json<{ html: string }>()).html, /<h1>Drugo izdanje<\/h1>/);
  const writer = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "artifact", artifactId: artifact.id, scopes: "write", can_read_content: true,
  }));
  assert.equal((await env.api("/_api/artifacts/upute/content", { key: writer.key })).status, 403);

  const other = list.artifacts.find(({ slug }) => slug === "drugo")!;
  assert.equal((await env.api(`/_api/artifacts/${other.id}/content`, { key: readKey.key })).status, 403);
  await Effect.runPromise(env.keys.revoke(readKey.record.id, env.owner.id));
  assert.equal((await env.api("/_api/artifacts/upute/content", { key: readKey.key })).status, 401);
  const attempts = await Effect.runPromise(env.store.audit.recent(30));
  const contentReads = attempts.filter(({ action }) => action === "artifact.content.read");
  assert.ok(contentReads.length >= 4);
  const details = contentReads.map(({ detail }) => JSON.parse(detail ?? "{}") as { allowed?: boolean });
  assert.equal(details.some(({ allowed }) => allowed === true), true);
  assert.equal(details.some(({ allowed }) => allowed === false), true);
  assert.equal(contentReads.some(({ detail }) => (detail ?? "").includes(HTML)), false);
});
test("content reads fail closed when the production audit insert fails over HTTP and MCP", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  const key = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "master", scopes: "master", can_read_content: true,
  }));
  env.DB.exec(`CREATE TRIGGER fail_content_read_audit BEFORE INSERT ON audit_log
    WHEN NEW.action = 'artifact.content.read'
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);

  const http = await env.api("/_api/artifacts/upute/content", { key: key.key });
  assert.equal(http.status, 500);
  assert.equal((await http.text()).includes(HTML), false);

  const mcp = await env.fetch("/_mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_artifact", arguments: { artifact: "upute" } },
    }),
  });
  assert.equal(mcp.status, 200);
  const mcpBody = await mcp.json<{
    jsonrpc: string; id: number;
    result: { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: ErrorResponse };
  }>();
  assert.equal(mcpBody.jsonrpc, "2.0");
  assert.equal(mcpBody.id, 1);
  assert.equal(mcpBody.result.isError, true);
  assert.equal(mcpBody.result.structuredContent.error.code, "internal");
  assert.equal(mcpBody.result.content[0]?.type, "text");
  const serializedMcp = JSON.stringify(mcpBody);
  assert.equal(serializedMcp.includes(HTML), false);
  assert.equal(serializedMcp.includes("audit unavailable"), false);
});

test("authorized content reads do not require the artefact password", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "tajno", title: "Tajno", html: HTML, password: "tajna-lozinka" });
  const key = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "master", scopes: "master", can_read_content: true,
  }));
  const response = await env.api("/_api/artifacts/tajno/content", { key: key.key });
  assert.equal(response.status, 200);
  assert.match((await response.json<{ html: string }>()).html, /<h1>Bok<\/h1>/);
});
test("content reads stop when the live folder grant is revoked", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  const artifact = (await (await env.api("/_api/artifacts")).json<ArtifactListResponse>())
    .artifacts.find(({ slug }) => slug === "upute")!;
  const collaborator = await Effect.runPromise(addUser(env.store, "collaborator0001", "collaborator@example.test"));
  const folder = env.DB.prepare("SELECT id FROM folders WHERE slug = ?").bind("acme").first<{ id: string }>();
  assert.ok(folder);
  const access = openAccess({ db: env.DB, audit: env.store.audit });
  await Effect.runPromise(access.grant({ actorId: env.owner.id, folderId: folder.id, userId: collaborator.id, role: "viewer" }));
  const key = await Effect.runPromise(env.keys.mint({
    userId: collaborator.id, kind: "artifact", artifactId: artifact.id, scopes: "read", can_read_content: true,
  }));
  assert.equal((await env.api("/_api/artifacts/upute/content", { key: key.key })).status, 200);
  await Effect.runPromise(access.revoke({ actorId: env.owner.id, folderId: folder.id, userId: collaborator.id }));
  assert.equal((await env.api("/_api/artifacts/upute/content", { key: key.key })).status, 403);
});
test("failed content reads are audited without recording content", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  const artifact = (await (await env.api("/_api/artifacts")).json<ArtifactListResponse>())
    .artifacts.find(({ slug }) => slug === "upute")!;
  const key = await Effect.runPromise(env.keys.mint({
    userId: env.owner.id, kind: "master", scopes: "master", can_read_content: true,
  }));
  const rows = async () => (await Effect.runPromise(env.store.audit.recent(30)))
    .filter(({ action }) => action === "artifact.content.read");
  const auditedFailure = async (reason: string) => {
    const event = (await rows()).map(({ detail: value }) => JSON.parse(value ?? "{}") as {
      allowed?: boolean; success?: boolean; reason?: string;
    }).find(({ reason: value }) => value === reason);
    assert.ok(event, `expected an audit event for ${reason}`);
    assert.equal(event.success, false);
  };

  assert.equal((await env.api("/_api/artifacts/upute/content?version=99", { key: key.key })).status, 404);
  await auditedFailure("not-found");

  const version = env.DB.prepare("SELECT r2_key FROM artifact_versions WHERE artifact_id = ? AND version = 1")
    .bind(artifact.id).first<{ r2_key: string }>();
  assert.ok(version);
  const ciphertext = env.bucket.objects.get(version.r2_key);
  assert.ok(ciphertext);
  env.bucket.objects.delete(version.r2_key);
  assert.equal((await env.api("/_api/artifacts/upute/content?version=1", { key: key.key })).status, 500);
  await auditedFailure("content-missing");

  const beforeDecryption = (await rows()).length;
  env.bucket.objects.set(version.r2_key, new Uint8Array([1, 2, 3]));
  assert.equal((await env.api("/_api/artifacts/upute/content?version=1", { key: key.key })).status, 500);
  const afterDecryption = await rows();
  assert.equal(afterDecryption.length, beforeDecryption + 1);
  assert.equal(afterDecryption.some(({ detail: event }) => (event ?? "").includes(HTML)), false);
});




test("keys list without their secret, and revocation bites immediately", async () => {
  const env = await environment();
  const nameless = await env.api("/_api/keys", { method: "POST", body: { artifact: null } });
  assert.equal(nameless.status, 404);                              // an artifact key is always bound
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  const real = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read" } })).json<KeyResponse>();

  const list = await (await env.api("/_api/keys")).json<KeyListResponse>();
  assert.equal(list.keys.some((k) => k.kind === "master"), true);
  assert.equal(list.keys.some((k) => k.id === real.key.id), true);
  for (const k of list.keys) {
    assert.equal(Object.hasOwn(k, "tokenHash"), false);
    assert.equal(Object.hasOwn(k, "token_hash"), false);
  }

  const revoked = await env.api(`/_api/keys/${real.key.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true, id: real.key.id });
  assert.equal((await env.api("/_api/artifacts", { key: real.token })).status, 401);   // dead at once
  assert.equal((await env.api(`/_api/keys/${real.key.id}`, { method: "DELETE" })).status, 404);
});

test("rotation replaces the document and the gate, keeping the link", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, password: "stara-lozinka" });

  const rotated = await env.api("/_api/artifacts/rotate", {
    method: "POST",
    body: { artifact: "upute", html: HTML2, password: "nova-lozinka" },
  });
  assert.equal(rotated.status, 200);
  const body = await rotated.json<PublishedResponse>();
  assert.equal(body.artifact.path, "/upute/");
  assert.equal(body.artifact.gated, true);
  assert.equal(authoredDocument(await openAsVisitor(await (await env.fetch("/_gate/upute/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nova-lozinka" }),
  })).json<GatePayload>(), "nova-lozinka")), HTML2);

  // Omitted password leaves the gate alone; `null` clears it.
  const kept = await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", html: HTML } });
  assert.equal((await kept.json<PublishedResponse>()).artifact.gated, true);
  const cleared = await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", password: null } });
  assert.equal((await cleared.json<PublishedResponse>()).artifact.gated, false);
  assert.equal(await env.load("upute"), HTML);

  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", password: "kratko" } })).status, 422);
  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { password: "dovoljno-duga" } })).status, 422);
  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "nema-me", password: null } })).status, 404);
});

test("a master key may opt into a weak password; a scoped key never may", async () => {
  const env = await environment();

  // Without the flag, the floor is exactly what it always was.
  const refused = await env.publish({ folder: "acme", slug: "zastita", title: "Zaštita", html: HTML, password: "ws" });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json<ErrorResponse>()).error.details?.some((issue) => issue.code === "weak-password"), true);

  // With the flag, the master key publishes below the floor — and only that issue drops.
  const created = await env.publish({ folder: "acme", slug: "zastita", title: "Zaštita", html: HTML, password: "ws", allow_weak_password: true });
  assert.equal(created.status, 201);
  assert.equal((await created.json<PublishedResponse>()).artifact.gated, true);

  // The weak password really holds the gate: it opens through the released payload the way
  // a browser decrypts it, and the path serves the gate page — not the document, and not
  // the neutral page an unknown path answers with.
  const opened = await env.fetch("/_gate/zastita/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "ws" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json<GatePayload>(), "ws")), HTML);
  const pageBody = await (await env.fetch("/zastita/")).text();
  assert.equal(pageBody.includes("<h1>Bok</h1>"), false);

  // A write-scoped artifact key on its own artefact would sail through without the check —
  // the opt-in is what it may never widen.
  const minted = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "zastita", scopes: "write" } })).json<KeyResponse>();
  const widened = await env.publish(
    { folder: "acme", slug: "zastita", title: "Zaštita", html: HTML2, password: "no", allow_weak_password: true },
    { key: minted.token },
  );
  assert.equal(widened.status, 403);
  assert.equal((await (await env.api("/_api/artifacts")).json<ArtifactListResponse>()).artifacts[0].version, 1);   // nothing published
  assert.equal(authoredDocument(await openAsVisitor(await (await env.fetch("/_gate/zastita/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "ws" }),
  })).json<GatePayload>(), "ws")), HTML);

  // The audit row shows the platform accepted the weak password on purpose.
  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.create'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "weakPassword" in detail && detail.weakPassword === true;
  }), true);
});

test("rotate honours the same opt-in, and audits it the same way", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, password: "duga-lozinka" });

  const refused = await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "upute", password: "ws" } });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json<ErrorResponse>()).error.details?.some((issue) => issue.code === "invalid-password"), true);

  const rotated = await env.api("/_api/artifacts/rotate", {
    method: "POST", body: { artifact: "upute", password: "ws", allow_weak_password: true },
  });
  assert.equal(rotated.status, 200);

  const opened = await env.fetch("/_gate/upute/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "ws" }),
  });
  assert.equal(opened.status, 200);
  assert.equal(authoredDocument(await openAsVisitor(await opened.json<GatePayload>(), "ws")), HTML);

  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.rotate'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "weakPassword" in detail && detail.weakPassword === true;
  }), true);
});

test("another user's artefacts and folders are untouchable", async () => {
  const env = await environment();
  const other = await Effect.runPromise(addUser(env.store, "member00000000a2", "member@example.test"));
  const theirKey = await Effect.runPromise(env.keys.mint({ userId: other.id, kind: "master", scopes: "master" }));

  await env.publish({ folder: "acme", slug: "moj", title: "Moj", html: HTML });
  await env.publish({ folder: "tudji-folder", slug: "tudji", title: "Tuđi", html: HTML }, { key: theirKey.key });

  // Slug collision across owners is a conflict, and their folder is not even visible.
  assert.equal((await env.publish({ folder: "tudji-folder", slug: "tudji", title: "X", html: HTML })).status, 403);
  assert.equal((await env.publish({ folder: "acme", slug: "tudji", title: "X", html: HTML })).status, 409);
  assert.equal((await env.api("/_api/artifacts/rotate", { method: "POST", body: { artifact: "tudji", password: null } })).status, 403);

  const folders = await (await env.api("/_api/folders")).json<FolderListResponse>();
  assert.deepEqual(folders.folders.map((f) => f.slug), ["acme"]);
  assert.equal(folders.folders[0].artifacts, 1);
  const listed = await (await env.api("/_api/artifacts")).json<ArtifactListResponse>();
  assert.deepEqual(listed.artifacts.map((a) => a.slug), ["moj"]);
});

test("a retired artefact path keeps resolving to the artefact that recorded it", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });

  const aliased = await env.api("/_api/artifacts/alias", {
    method: "POST", body: { artifact: "upute", paths: ["klijent2023/upute-za-pristup"] },
  });
  assert.equal(aliased.status, 200);
  const body = await aliased.json<ArtifactAliasResponse>();
  assert.deepEqual(body.aliases, ["klijent2023/upute-za-pristup"]);
  assert.equal(body.artifact.slug, "upute");
  assert.equal(body.artifact.path, "/upute/");

  // The 1.x link serves the artefact itself — not the neutral page an unknown path gets.
  const served = await env.fetch("/klijent2023/upute-za-pristup/");
  assert.equal(served.status, 200);
  assert.equal(await env.load("klijent2023/upute-za-pristup"), HTML);

  // Recording the same path on the same artefact is the idempotent no-op it always was.
  assert.equal((await env.api("/_api/artifacts/alias", {
    method: "POST", body: { artifact: "upute", paths: ["klijent2023/upute-za-pristup"] },
  })).status, 200);

  // The audit row carries the recorded paths.
  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'artifact.alias'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "paths" in detail &&
      Array.isArray(detail.paths) && detail.paths.includes("klijent2023/upute-za-pristup");
  }), true);

  // Another user's artefact is untouchable, even by their master key.
  const other = await Effect.runPromise(addUser(env.store, "member00000000a3", "member2@example.test"));
  const theirKey = await Effect.runPromise(env.keys.mint({ userId: other.id, kind: "master", scopes: "master" }));
  assert.equal((await env.api("/_api/artifacts/alias", {
    key: theirKey.key, method: "POST", body: { artifact: "upute", paths: ["njihova-stara"] },
  })).status, 403);

  // Malformed paths are refused on the `paths` field before anything is recorded.
  for (const bad of ["a/b/c", "", "UPPER"]) {
    const response = await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "upute", paths: [bad] } });
    assert.equal(response.status, 422, `${JSON.stringify(bad)} should be invalid`);
    assert.equal((await response.json<ErrorResponse>()).error.details?.[0]?.field, "paths");
  }
  assert.equal((await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "upute", paths: [] } })).status, 422);

  // An unknown target is a 404; a path another artefact answers to is a 409.
  assert.equal((await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "nema-me", paths: ["neka-stara"] } })).status, 404);
  await env.publish({ folder: "acme", slug: "drugo", title: "Drugo", html: HTML2 });
  assert.equal((await env.api("/_api/artifacts/alias", { method: "POST", body: { artifact: "upute", paths: ["drugo"] } })).status, 409);
});

test("a folder's retired path serves the folder index, master keys only", async () => {
  const env = await environment();
  await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });

  const aliased = await env.api("/_api/folders/alias", { method: "POST", body: { folder: "acme", paths: ["stari-klijent"] } });
  assert.equal(aliased.status, 200);
  const body = await aliased.json<FolderAliasResponse>();
  assert.deepEqual(body.aliases, ["stari-klijent"]);
  assert.equal(body.folder.slug, "acme");
  assert.equal(body.folder.path, "/acme/");

  const index = await env.fetch("/stari-klijent/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Upute/);

  const rows = (await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'folder.alias'").all<{ detail: string }>()).results;
  assert.equal(rows.some(row => {
    const detail: unknown = JSON.parse(row.detail);
    return detail !== null && typeof detail === "object" && "paths" in detail &&
      Array.isArray(detail.paths) && detail.paths.includes("stari-klijent");
  }), true);

  // A scoped key sees no folders, so it records none — mirroring GET /_api/folders.
  const minted = await (await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read_write" } })).json<KeyResponse>();
  assert.equal((await env.api("/_api/folders/alias", {
    key: minted.token, method: "POST", body: { folder: "acme", paths: ["bilo-sta"] },
  })).status, 403);

  // The same error spine as the artefact route.
  assert.equal((await env.api("/_api/folders/alias", { method: "POST", body: { folder: "nema-me", paths: ["neki-path"] } })).status, 404);
  const malformed = await env.api("/_api/folders/alias", { method: "POST", body: { folder: "acme", paths: ["UPPER"] } });
  assert.equal(malformed.status, 422);
  assert.equal((await malformed.json<ErrorResponse>()).error.details?.[0]?.field, "paths");
  await env.publish({ folder: "drugi", slug: "clanak", title: "Članak", html: HTML });
  assert.equal((await env.api("/_api/folders/alias", { method: "POST", body: { folder: "acme", paths: ["drugi"] } })).status, 409);
});

test("no key, no entry — but the contract is public", async () => {
  const env = await environment();
  assert.equal((await env.fetch("/_api/artifacts")).status, 401);
  assert.equal((await env.fetch("/_api/artifacts", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await env.fetch("/_api/nema-ovoga")).status, 401);

  const contract = await env.fetch("/_api/contract");
  assert.equal(contract.status, 200);
  const contentType = contract.headers.get("content-type");
  assert.ok(contentType);
  assert.match(contentType, /text\/markdown/);
  assert.equal((await contract.text()).includes("/_api/artifacts"), true);
  assert.equal((await env.fetch("/instructions")).status, 200);
});

test("an internal failure still answers the documented envelope", async () => {
  // A database that throws: the API must not hand an agent a shape it was never told about.
  const broken = {
    DB: {
      prepare: () => { throw new Error("boom"); },
      batch: () => { throw new Error("boom"); },
    },
    ARTIFACTS: memoryBucket(),
    ARTEFACTS_MASTER_KEY: MASTER,
    RATELIMIT: rateLimitBinding(),
  };
  const response = await worker.fetch(new Request("https://example.test/_api/artifacts", {
    headers: { authorization: "Bearer wak_0000000000000000000000000000000000000000" },
  }), broken);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json<ErrorResponse>(), {
    error: { code: "internal", message: "The platform could not complete the request." },
  });
});

test("the publish rate limit is enforced per key, and its outage fails closed", async () => {
  const env = await environment();
  const body = { folder: "acme", slug: "upute", title: "Upute", html: HTML };
  assert.equal((await env.publish(body)).status, 201);

  let last: Response | null = null;
  for (let i = 0; i < 30; i++) last = await env.publish({ ...body, title: `Upute ${i + 2}` });
  assert.ok(last);
  assert.equal(last.status, 429);
  assert.equal((await last.json<ErrorResponse>()).error.code, "rate-limited");
  assert.ok(Number(last.headers.get("retry-after")) > 0);

  // A limiter that cannot be reached is a 503, never an open door. A fresh environment is
  // required: the runtime is cached per D1 binding, so reusing this one's DB would keep the
  // healthy limiter alive.
  const brokenDB = openD1Shim();
  const brokenStore = openStore(brokenDB);
  const brokenOwner = await Effect.runPromise(brokenStore.users.create({
    id: "owner0000000000a2", email: "broken@example.test", name: "Broken", role: "owner", passwordHash: "{}",
  }));
  const brokenMaster = await Effect.runPromise(openKeys({
    db: brokenDB, audit: brokenStore.audit, access: openAccess({ db: brokenDB, audit: brokenStore.audit }),
  }).mint({ userId: brokenOwner.id, kind: "master", scopes: "master" }));
  const broken = {
    DB: brokenDB, ARTIFACTS: memoryBucket(), ARTEFACTS_MASTER_KEY: MASTER,
    RATELIMIT: { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("down"); } }) },
  };
  const response = await worker.fetch(new Request("https://example.test/_api/artifacts", {
    method: "POST",
    headers: { authorization: `Bearer ${brokenMaster.key}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "acme", slug: "novi", title: "Novi", html: HTML }),
  }), broken);
  assert.equal((await response.json<ErrorResponse>()).error.code, "unavailable");
});

test("JSON and body-cap refusals keep the API envelope and write nothing", async () => {
  const env = await environment();
  const headers = { authorization: `Bearer ${env.master.key}`, "content-type": "application/json" };
  const malformed = await env.fetch("/_api/artifacts", { method: "POST", headers, body: "{" });
  assert.equal(malformed.status, 422);
  assert.deepEqual(await malformed.json(), {
    error: { code: "validation", message: "Request body is not valid JSON." },
  });
  const oversized = await env.fetch("/_api/artifacts", {
    method: "POST", headers: { ...headers, "content-length": String(API_BODY_LIMIT + 1) }, body: "{}",
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    error: { code: "too-large", message: `Request body exceeds ${API_BODY_LIMIT} bytes.` },
  });
  const primitive = await env.fetch("/_api/artifacts", { method: "POST", headers, body: "null" });
  assert.equal(primitive.status, 422);
  assert.deepEqual((await primitive.json<ErrorResponse>()).error.details, [
    { code: "invalid-payload", message: "request body must be a JSON object" },
  ]);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first<{ count: number }>()?.count, 0);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first<{ count: number }>()?.count, 0);
});

test("key model refusals are validation responses and rotation revokes the old secret", async () => {
  const env = await environment();
  assert.equal((await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML })).status, 201);
  for (const body of [
    { artifact: "upute", scopes: "master" },
    { artifact: "upute", scopes: "read", label: "" },
  ]) {
    const refused = await env.api("/_api/keys", { method: "POST", body });
    assert.equal(refused.status, 422);
    assert.equal((await refused.json<ErrorResponse>()).error.code, "validation");
  }
  const minted = await env.api("/_api/keys", { method: "POST", body: { artifact: "upute", scopes: "read" } });
  const original = await minted.json<KeyResponse>();
  const response = await env.api("/_api/keys/rotate", { method: "POST", body: { id: original.key.id } });
  assert.equal(response.status, 200);
  const rotated = await response.json<KeyResponse>();
  assert.equal(rotated.key.id, original.key.id);
  assert.notEqual(rotated.token, original.token);
  assert.equal(rotated.key.artifactId, original.key.artifactId);
  assert.equal(rotated.key.scopes, "read");
  assert.equal(Object.hasOwn(rotated.key, "tokenHash"), false);
  assert.equal((await env.api("/_api/artifacts", { key: original.token })).status, 401);
  assert.equal((await env.api("/_api/artifacts", { key: rotated.token })).status, 200);
  assert.equal((await env.api("/_api/keys/rotate", { method: "POST", body: { id: "missing" } })).status, 404);
});
test("HTTP publish and rotate-with-HTML honor optional ifVersion without changing omitted writes", async () => {
  const env = await environment();
  const created = await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML });
  assert.equal(created.status, 201);
  const published = await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML2, ifVersion: 1 });
  assert.equal(published.status, 200);
  assert.equal((await published.json<PublishedResponse>()).artifact.version, 2);
  const objectCount = env.bucket.objects.size;

  const stalePublish = await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML, ifVersion: 1 });
  assert.equal(stalePublish.status, 409);
  assert.deepEqual(await stalePublish.json(), { error: { code: "conflict", message: "Artefact has changed since version 1.", details: { currentVersion: 2 } } });
  assert.equal(env.bucket.objects.size, objectCount);

  const rotated = await env.api("/_api/artifacts/rotate", {
    method: "POST", body: { artifact: "upute", html: HTML, ifVersion: 2 },
  });
  assert.equal(rotated.status, 200);
  const staleRotate = await env.api("/_api/artifacts/rotate", {
    method: "POST", body: { artifact: "upute", html: HTML2, ifVersion: 2 },
  });
  assert.equal(staleRotate.status, 409);
  assert.deepEqual(await staleRotate.json(), { error: { code: "conflict", message: "Artefact has changed since version 2.", details: { currentVersion: 3 } } });
  assert.equal(env.bucket.objects.size, objectCount + 1);

  const unconditional = await env.publish({ folder: "acme", slug: "upute", title: "Upute", html: HTML2 });
  assert.equal((await unconditional.json<PublishedResponse>()).artifact.version, 4);
});
test("HTTP publish with ifVersion does not create a missing artefact or folder", async () => {
  const env = await environment();
  const response = await env.publish({
    folder: "new-folder", slug: "missing", title: "Missing", html: HTML, ifVersion: 1,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { code: "conflict", message: "Artefact has changed since version 1.", details: { currentVersion: 0 } },
  });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first<{ count: number }>())?.count, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM artifacts").first<{ count: number }>())?.count, 0);
  assert.equal(env.bucket.objects.size, 0);
});
test("page publication includes expanded brand-locked override CSS in the composed-size cap", async () => {
  const env = await environment();
  const origin = "https://example.test";
  const shellLength = worstPageDocumentLength("", PLATFORM_THEMES, origin, "en");
  const fragment = `<main>${"x".repeat(1_500_000 - shellLength - 13)}</main>`;
  const accepted = await env.publish({
    folder: "acme", slug: "page-without-expanded-theme", title: "Page", type: "page", html: fragment,
    theme: { scope: "platform", slug: "report" },
  });
  assert.equal(accepted.status, 201);
  const overLimit = await env.publish({
    folder: "acme", slug: "page-one-over-limit", title: "Page", type: "page", html: fragment.replace("</main>", "x</main>"),
  });
  assert.equal(overLimit.status, 422);
  const overLimitResponse = await overLimit.json<ErrorResponse>();
  assert.equal(overLimitResponse.error.code, "validation");
  assert.ok(overLimitResponse.error.details?.some(issue =>
    issue.code === "composed-too-large" && issue.field === "html" && issue.message.length > 0));


  const expandedFont = `"${"A".repeat(158)}"`;
  const rejected = await env.publish({
    folder: "acme", slug: "page-with-expanded-theme", title: "Page", type: "page", html: fragment,
    theme: { scope: "platform", slug: "report" },
    themeOverrides: { tokens: {
      "font-heading": expandedFont,
      "font-body": expandedFont,
      "font-mono": expandedFont,
    } },
  });
  assert.equal(rejected.status, 422);
  const response = await rejected.json<ErrorResponse>();
  assert.equal(response.error.code, "validation");
  assert.ok(response.error.details?.some(issue =>
    issue.code === "composed-too-large" && issue.field === "html" && issue.message.length > 0));
});
test("publish rejects a page whose runtime bridge exceeds the composed-document cap", async () => {
  const env = await environment();
  const origin = "https://example.test";
  const shellLength = Math.max(...PLATFORM_THEMES.flatMap(theme =>
    (["light", "dark"] as const).flatMap(mode =>
      (["s", "m", "l"] as const).map(size =>
        composePageDocument("", theme, mode, origin, size, "en").length))));
  const html = `<main>${"x".repeat(1_500_000 - shellLength - 13)}</main>`;
  const response = await env.publish({
    folder: "acme", slug: "page-bridge-over-limit", title: "Page", type: "page", html,
  });
  assert.equal(response.status, 422);
  const body = await response.json<ErrorResponse>();
  assert.equal(body.error.code, "validation");
  assert.ok(body.error.details?.some(issue => issue.code === "composed-too-large" && issue.field === "html"));
});

test("page update sizes with the existing language when lang is omitted", async () => {
  const env = await environment();
  const existing = await env.publish({
    folder: "acme", slug: "page-long-language", title: "Page", type: "page", lang: "zh-Hant-TW", html: "<main>Old</main>",
  });
  assert.equal(existing.status, 201);
  const shellLength = worstPageDocumentLength("", PLATFORM_THEMES, "https://example.test", "en");
  const html = `<main>${"x".repeat(1_500_000 - shellLength - 13)}</main>`;
  const updated = await env.publish({
    folder: "acme", slug: "page-long-language", title: "Page", type: "page", html,
  });
  assert.equal(updated.status, 422);
  const body = await updated.json<ErrorResponse>();
  assert.equal(body.error.code, "validation");
  assert.ok(body.error.details?.some(issue => issue.code === "composed-too-large" && issue.field === "html"));
});