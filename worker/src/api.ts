// The 2.0 write API (ADR 0015): Bearer API keys, synchronous publish, one error envelope.
// Listings return metadata and secret URLs, never a document or password. Live authorization
// comes from keys.may; a publish into a colleague's folder belongs to the folder's owner.
// R2 and D1 writes finish inside the request, so 201 means the artefact is already live.

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { fileResponse, json, readJson } from "./http.js";
import { normalizePath } from "./paths.js";
import { validateArtefactHtml, validatePublishBody, validateRotateBody, type ValidationIssue } from "./validate.js";
import type { Access } from "./access.js";
import type { Artifact, Artifacts, AuthorType, ThemeReference } from "./artifacts.js";
import type { Folder, Folders } from "./folders.js";
import type { Key, KeyAuthentication, KeyResource, Keys } from "./keys.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Audit } from "./store.js";
import type { ProjectData } from "./project-data.js";
import type { ProjectFiles, UploadState, UploadView } from "./project-files.js";
import { asCodeError, type CodeError } from "./types.js";
import { validatePageFragment, type PageDocument } from "./page-validation.js";
import { PLATFORM_THEMES, getPlatformTheme } from "../../frontend/src/platform-themes.js";
import { compileThemeOverrides } from "../../frontend/src/theme-overrides.js";
import { PAGE_DOCUMENT_MAX_LENGTH, worstPageDocumentLength } from "./page-size.js";
import type { CompiledTheme } from "../../frontend/src/theme-compiler.js";

export interface ApiContext {
  keys: Pick<Keys, "authenticate" | "hasScope" | "may" | "mint" | "list" | "rotate" | "revoke">;
  artifacts: Pick<Artifacts, "byId" | "bySlug" | "byPath" | "title" | "path" | "url" | "gated" | "live" |
    "prepare" | "create" | "publish" | "setPassword" | "listByOwner" | "listByFolder" | "alias" | "readContent">;
  folders: Pick<Folders, "byId" | "byPath" | "path" | "name" | "create" | "alias">;
  access: Pick<Access, "foldersFor" | "role">;
  limiter: Pick<RateLimiter, "hit">;
  store: { audit: Pick<Audit, "write" | "writeRequired"> };
  projectData: ProjectData;
  projectFiles: ProjectFiles;
  publicOrigin: string;
  contract(): Response;
}

/** Fields remain unknown until the existing validator or the consuming model narrows them. */
interface ApiBody {
  folder?: unknown; folderName?: unknown; slug?: unknown; title?: unknown; lang?: unknown;
  html?: unknown; password?: unknown; note?: unknown; allow_weak_password?: unknown; ifVersion?: unknown;
  artifact?: unknown; paths?: unknown; scopes?: unknown; label?: unknown; id?: unknown;
  can_read_content?: unknown; type?: unknown; theme?: unknown; themeOverrides?: unknown;
}
const isApiBody = (value: unknown): value is ApiBody => value !== null && typeof value === "object";
const objectBody = (value: unknown): ApiBody => isApiBody(value) ? value : {};

type JsonResult = { body: unknown } | { error: Response };
type FolderPlan = { value: Folder | null } | { error: Response };
type AliasResult = { value: string[] } | { error: Response };
type Limited = { retryAfter: number } | { unavailable: true } | null;

/** 1.x API_BODY_LIMIT: a document plus its metadata, never a stream. */
export const API_BODY_LIMIT = 2 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_GENERAL = 120;
const RATE_PUBLISH = 30;
const STATUS = {
  unauthorized: 401, forbidden: 403, validation: 422, "too-large": 413, "not-found": 404,
  conflict: 409, "rate-limited": 429, unavailable: 503, internal: 500,
};
type ApiErrorCode = keyof typeof STATUS;

/** The one error envelope every API failure answers with (ADR 0005, kept by ADR 0015). */
const envelope = (code: ApiErrorCode, message: string, details?: unknown): Response =>
  json(details === undefined ? { error: { code, message } } : { error: { code, message, details } }, STATUS[code]);
const rateLimited = (state: { retryAfter: number }): Response =>
  json({ error: { code: "rate-limited", message: "Too many requests for this key; retry shortly." } },
    429, { "Retry-After": String(Math.max(1, Number(state.retryAfter) || 60)) });

/** A limiter we cannot reach is a 503, never an open door. Interruption remains interruption. */
function limited(ctx: ApiContext, key: Key, bucket: string, limit: number): Effect.Effect<Limited, CodeError> {
  return ctx.limiter.hit(`api:${key.id}|${bucket}`, { limit, windowMs: RATE_WINDOW_MS }).pipe(
    Effect.map((state): Limited => state.allowed ? null : { retryAfter: state.retryAfter }),
    Effect.catchCause((cause) => Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.succeed<Limited>({ unavailable: true })),
  );
}
const may = (ctx: ApiContext, who: KeyAuthentication, target: KeyResource, need = "read") =>
  ctx.keys.may(who.key, target, need);
const audit = (ctx: ApiContext, who: KeyAuthentication, action: string, artifactId: string | null, detail: unknown) =>
  ctx.store.audit.write({ actorType: "api_key", actorId: who.key.id, action, artifactId, detail });
const auditContentRead = (ctx: ApiContext, who: KeyAuthentication, artifactId: string | null, detail: unknown) =>
  ctx.store.audit.writeRequired({ actorType: "api_key", actorId: who.key.id, action: "artifact.content.read", artifactId, detail });
/** The accepted weak-password exception must be visible afterwards (ADR 0023). */
const writeDetail = (detail: Record<string, unknown>, weakUsed: boolean) =>
  weakUsed ? { ...detail, weakPassword: true } : detail;
const absolute = (ctx: ApiContext, path: string) => `${ctx.publicOrigin.replace(/\/+$/, "")}${path}`;

/** Metadata and links only, never content, verifiers or key wraps. */
function view(ctx: ApiContext, artifact: Artifact, folder: Folder | null) {
  return Effect.gen(function* () {
    const indexPath = folder ? ctx.folders.path(folder) : null;
    return {
      id: artifact.id, slug: artifact.slug, title: yield* ctx.artifacts.title(artifact),
      lang: artifact.lang ?? "en", path: ctx.artifacts.path(artifact),
      url: ctx.artifacts.url(artifact, ctx.publicOrigin), gated: ctx.artifacts.gated(artifact),
      version: artifact.currentVersion,
      folder: folder && indexPath !== null
        ? { id: folder.id, slug: folder.slug, path: indexPath, indexUrl: absolute(ctx, indexPath) }
        : null,
    };
  });
}

/** Route one `/_api` request, retaining the existing authentication/limiter/handler order. */
export function handleApi(request: Request, ctx: ApiContext, { rest = "" }: { rest?: string } = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const path = String(rest ?? "").replace(/^\/+|\/+$/g, "");
    const method = request.method.toUpperCase();
    // Public even without a key, and a Response rather than a nested Effect.
    if (path === "contract" && method === "GET") return ctx.contract();

    const who = yield* ctx.keys.authenticate(request);
    if (!who) return envelope("unauthorized", "A valid API key is required (Authorization: Bearer <key>).");
    const general = yield* limited(ctx, who.key, "general", RATE_GENERAL);
    if (general && "unavailable" in general) return envelope("unavailable", "Rate limiting is unavailable; retry shortly.");
    if (general) return rateLimited(general);

    switch (`${method} ${path}`) {
      case "POST artifacts": return yield* publish(request, ctx, who);
      case "GET artifacts": return yield* listArtifacts(ctx, who);
      case "GET folders": return yield* listFolders(ctx, who);
      case "POST artifacts/rotate": return yield* rotate(request, ctx, who);
      case "POST artifacts/alias": return yield* aliasArtifacts(request, ctx, who);
      case "POST folders/alias": return yield* aliasFolders(request, ctx, who);
      case "POST keys": return yield* mintKey(request, ctx, who);
      case "GET keys": return yield* listKeys(ctx, who);
      case "POST keys/rotate": return yield* rotateKey(request, ctx, who);
      default: break;
    }
    const content = /^artifacts\/([^/]+)\/content$/.exec(path);
    if (content && method === "GET") {
      let reference: string;
      try { reference = decodeURIComponent(content[1]); } catch { return envelope("not-found", "No such artefact."); }
      return yield* readArtifactContent(request, ctx, who, reference);
    }

    const revoke = /^keys\/([A-Za-z0-9_-]+)$/.exec(path);
    if (revoke && method === "DELETE") return yield* revokeKey(ctx, who, revoke[1]);
    const file = FILE_ROUTE.exec(path);
    if (file) return yield* fileRoute(request, ctx, who, file.slice(1));
    const project = PROJECT_ROUTE.exec(path);
    if (project) return yield* projectRoute(request, ctx, who, project.slice(1));
    return envelope("not-found", "Unknown API endpoint.");
  }).pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
    const error = asCodeError(Cause.squash(cause));
    if (error.code === "validation" || (typeof error.code === "string" && error.code.startsWith("font-")) || error.code === "external-reference") {
      return Effect.succeed(envelope("validation", error.message,
        (error.issues ?? [{ code: error.code, message: error.message }]).map(issue => ({ ...issue, field: "html" }))));
    }
    if (error.code === "not-found") return Effect.succeed(envelope("not-found", error.message));
    if (error.code === "version-conflict" && "currentVersion" in error && typeof error.currentVersion === "number") {
      return Effect.succeed(envelope("conflict", error.message, { currentVersion: error.currentVersion }));
    }
    if (error.code === "slug-taken" || error.code === "publish-conflict") return Effect.succeed(envelope("conflict", error.message));
    // Unexpected failures also keep the documented machine-readable shape.
    console.error("artefacts67 api error", error);
    return Effect.succeed(envelope("internal", "The platform could not complete the request."));
  }));
}

// ---- artefacts -----------------------------------------------------------

/** Resolve and authorize without creating anything. Capture must succeed before creation. */
function findFolder(ctx: ApiContext, who: KeyAuthentication, reference: unknown): Effect.Effect<FolderPlan, CodeError> {
  return Effect.gen(function* () {
    const found = yield* ctx.folders.byPath(reference);
    if (found) {
      if (!(yield* may(ctx, who, { ownerId: found.ownerId, folderId: found.id }, "write"))) {
        return { error: envelope("forbidden", "You cannot publish into that folder.") };
      }
      return { value: found };
    }
    if (who.key.kind !== "master") return { error: envelope("forbidden", "An artifact key cannot create a folder.") };
    return { value: null };
  });
}
function createFolder(ctx: ApiContext, who: KeyAuthentication, slug: string, name: unknown) {
  return Effect.gen(function* () {
    const created = yield* ctx.folders.create({ ownerId: who.key.userId, name: name ?? slug, slug });
    yield* audit(ctx, who, "folder.create", null, { folderId: created.id, slug: created.slug });
    return created;
  });
}
function readApiJson(request: Request): Effect.Effect<JsonResult, CodeError> {
  return readJson(request, API_BODY_LIMIT).pipe(
    Effect.map((body): JsonResult => ({ body })),
    Effect.catch(error => Effect.succeed<JsonResult>({
      error: error.code === "too-large"
        ? envelope("too-large", `Request body exceeds ${API_BODY_LIMIT} bytes.`)
        : envelope("validation", "Request body is not valid JSON."),
    })),
  );
}
/** Master keys write as their user; scoped keys as their delegated integration (ADR 0013). */
const authorOf = (who: KeyAuthentication): { authorType: AuthorType; authorId: string } => who.key.kind === "master"
  ? { authorType: "user", authorId: who.key.userId }
  : { authorType: "api_key", authorId: who.key.id };

function publish(request: Request, ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!ctx.keys.hasScope(who.key, "write")) return envelope("forbidden", "This key cannot publish.");
    const limitedOut = yield* limited(ctx, who.key, "publish", RATE_PUBLISH);
    if (limitedOut && "unavailable" in limitedOut) return envelope("unavailable", "Rate limiting is unavailable; retry shortly.");
    if (limitedOut) return rateLimited(limitedOut);
    const read = yield* readApiJson(request);
    if ("error" in read) return read.error;
    const body = objectBody(read.body);
    if (body.ifVersion !== undefined &&
        (typeof body.ifVersion !== "number" || !Number.isSafeInteger(body.ifVersion) || body.ifVersion < 1)) {
      return envelope("validation", "ifVersion must be a positive integer.", [
        { code: "invalid-version", message: "ifVersion must be a positive integer.", field: "ifVersion" },
      ]);
    }
    const ifVersion = typeof body.ifVersion === "number" ? body.ifVersion : undefined;

    if (body.allow_weak_password === true && who.key.kind !== "master") {
      return envelope("forbidden", "Only a master key may publish a password below the floor.");
    }
    const flagged = validatePublishBody(read.body).issues;
    const weakUsed = body.allow_weak_password === true && flagged.some(issue => issue.code === "weak-password");
    const issues = weakUsed ? flagged.filter(issue => issue.code !== "weak-password") : flagged;
    if (issues.length) return envelope("validation", "Request rejected by validation.", issues);
    // The required shape has passed the validator; narrow without trusting parsed JSON.
    if (typeof body.folder !== "string" || typeof body.slug !== "string") {
      return envelope("validation", "Request rejected by validation.", flagged);
    }
    const note = typeof body.note === "string" ? body.note : null;

    const type: "site" | "page" = body.type === "page" ? "page" : "site";
    let validatedPage: PageDocument | undefined;
    let warnings: ValidationIssue[] = [];
    if (type !== "page") {
      const doc = validateArtefactHtml(body.html, { checkReferences: false });
      if (doc.errors.length) return envelope("validation", "Request rejected by validation.", doc.errors.map(issue => ({ ...issue, field: "html" })));
      warnings = doc.warnings.map(issue => ({ ...issue, field: "html" }));
    }
    let theme: ThemeReference | null = null;
    if (typeof body.theme === "object" && body.theme !== null && "scope" in body.theme && "slug" in body.theme &&
        body.theme.scope === "platform" && typeof body.theme.slug === "string")
      theme = { scope: body.theme.scope, slug: body.theme.slug };
    const folder = yield* findFolder(ctx, who, body.folder);
    if ("error" in folder) return folder.error;
    const existing = yield* ctx.artifacts.bySlug(body.slug);
    if (existing?.deletedAt) return envelope("conflict", "That path is permanently retired.");
    if (existing && existing.folderId !== folder.value?.id) return envelope("conflict", `The path "${body.slug}" already belongs to another artefact.`);
    if (existing && !(yield* may(ctx, who, { ownerId: existing.ownerId, folderId: existing.folderId, artifactId: existing.id }, "write"))) {
      return envelope("forbidden", "That artefact belongs to another user.");
    }
    const lang = typeof body.lang === "string" ? body.lang : existing?.lang ?? "en";
    if (type === "page") {
      try { validatedPage = validatePageFragment(String(body.html), { lang }); }
      catch (cause) {
        const error = asCodeError(cause);
        return envelope("validation", "Request rejected by validation.",
          (error.issues ?? [{ code: error.code, message: error.message }]).map(issue => ({ ...issue, field: "html" })));
      }
    }
    // A conditional update cannot create a fresh artefact: there is no current version to match.
    if (ifVersion !== undefined && !existing) {
      return envelope("conflict", `Artefact has changed since version ${ifVersion}.`, { currentVersion: 0 });
    }
    if (type === "page") {
      const baseTheme = getPlatformTheme(theme?.scope === "platform" ? theme.slug : "report") ?? getPlatformTheme("report");
      let compiledOverride: CompiledTheme | undefined;
      if (body.themeOverrides != null) {
        try { compiledOverride = compileThemeOverrides(baseTheme!, body.themeOverrides); }
        catch (cause) {
          return envelope("validation", "Request rejected by validation.", [{
            code: "invalid-theme-overrides",
            field: "themeOverrides",
            message: cause instanceof Error ? cause.message : "Page theme overrides are invalid.",
          }]);
        }
      }
      if (worstPageDocumentLength(body.html as string, PLATFORM_THEMES, ctx.publicOrigin, lang, compiledOverride) > PAGE_DOCUMENT_MAX_LENGTH) {
        return envelope("validation", "Request rejected by validation.", [{
          code: "composed-too-large",
          field: "html",
          message: "The composed page document exceeds the 1,500,000-character limit.",
        }]);
      }
    }
    const gated = body.password != null && body.password !== "" ? true : Boolean(existing && ctx.artifacts.gated(existing));
    let prepared: object | null = null;
    if (type === "site") prepared = yield* ctx.artifacts.prepare(body.html, { gated });
    const destination = folder.value ?? (yield* createFolder(ctx, who, body.folder, body.folderName));
    if (existing) {
      yield* ctx.artifacts.publish({ artifactId: existing.id, html: body.html, note, ...authorOf(who),
        title: body.title, lang: body.lang, password: body.password ?? undefined, prepared, ifVersion,
        type, theme, themeOverrides: body.themeOverrides, validatedPage });
      const updated = yield* ctx.artifacts.byId(existing.id);
      if (!updated) return yield* Effect.fail(new Error("The published artefact could not be read."));
      yield* audit(ctx, who, "artifact.publish", updated.id, writeDetail({ version: updated.currentVersion }, weakUsed));
      return json({ artifact: yield* view(ctx, updated, destination), warnings }, 200);
    }
    const created = yield* ctx.artifacts.create({ ownerId: destination.ownerId, folderId: destination.id,
      slug: body.slug, title: body.title, lang: body.lang ?? "en", html: body.html, password: body.password ?? null,
      note, prepared, type, theme, themeOverrides: body.themeOverrides, validatedPage, ...authorOf(who) });
    yield* audit(ctx, who, "artifact.create", created.id, writeDetail({ version: created.currentVersion }, weakUsed));
    return json({ artifact: yield* view(ctx, created, destination), warnings }, 201);
  });
}

function listArtifacts(ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!ctx.keys.hasScope(who.key, "read")) return envelope("forbidden", "This key cannot read artefacts.");
    const artifacts = who.key.kind === "master" ? yield* readableArtifacts(ctx, who) : yield* boundArtifact(ctx, who);
    const views = yield* Effect.forEach(artifacts, artifact => Effect.gen(function* () {
      const folder = artifact.folderId ? yield* ctx.folders.byId(artifact.folderId) : null;
      return yield* view(ctx, artifact, folder);
    }));
    return json({ artifacts: views });
  });
}
/** Content leaves only through this explicitly authorized, audited read. */
function readArtifactContent(request: Request, ctx: ApiContext, who: KeyAuthentication, reference: string) {
  return Effect.gen(function* () {
    const rawVersion = new URL(request.url).searchParams.get("version");
    const version = rawVersion === null ? undefined
      : /^\d+$/.test(rawVersion) && Number.isSafeInteger(Number(rawVersion)) && Number(rawVersion) > 0
        ? Number(rawVersion) : null;
    const artifact = yield* ctx.artifacts.byPath(reference);
    if (!artifact || !ctx.artifacts.live(artifact)) {
      yield* auditContentRead(ctx, who, artifact?.id ?? null, { version: version ?? null, allowed: false });
      return envelope("not-found", "No such artefact.");
    }
    if (version === null) {
      yield* auditContentRead(ctx, who, artifact.id, { allowed: false });
      return envelope("validation", "version must be a positive integer.");
    }
    const resource = { ownerId: artifact.ownerId, folderId: artifact.folderId, artifactId: artifact.id };
    const allowed = who.key.can_read_content && ctx.keys.hasScope(who.key, "read") &&
      (yield* may(ctx, who, resource, "read"));
    if (!allowed) {
      yield* auditContentRead(ctx, who, artifact.id, { version: version ?? null, allowed: false });
      return envelope("forbidden", "This key cannot read artefact content.");
    }
    const content = yield* Effect.gen(function* () {
      const selected = yield* ctx.artifacts.readContent(artifact, version);
      const title = yield* ctx.artifacts.title(artifact);
      return { selected, title };
    }).pipe(Effect.catch((error) => Effect.gen(function* () {
      yield* auditContentRead(ctx, who, artifact.id, {
        version: version ?? null, allowed: true, success: false,
        reason: typeof error.code === "string" ? error.code : "read-failed",
      });
      return yield* Effect.fail(error);
    })));
    const { selected, title } = content;
    yield* auditContentRead(ctx, who, artifact.id, {
      version: selected.version.version, allowed: true, success: true,
    });
    return json({
      artifact: { id: artifact.id, slug: artifact.slug, version: selected.version.version },
      version: selected.version.version, type: "text/html", title, language: artifact.lang, html: selected.html,
    });
  });
}

/** Own and explicitly shared estate, deduplicated and sorted newest first. */
function readableArtifacts(ctx: ApiContext, who: KeyAuthentication): Effect.Effect<Artifact[], CodeError> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    const all: Artifact[] = [];
    for (const artifact of yield* ctx.artifacts.listByOwner(who.key.userId)) {
      seen.add(artifact.id);
      all.push(artifact);
    }
    for (const folder of yield* ctx.access.foldersFor(who.key.userId)) {
      if (folder.ownerId === who.key.userId) continue;
      for (const artifact of yield* ctx.artifacts.listByFolder(folder.id)) {
        if (seen.has(artifact.id)) continue;
        seen.add(artifact.id);
        all.push(artifact);
      }
    }
    return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  });
}
/** Scoped-key access is re-asked live: revoking a colleague closes their delegated keys. */
function boundArtifact(ctx: ApiContext, who: KeyAuthentication): Effect.Effect<Artifact[], CodeError> {
  return Effect.gen(function* () {
    const artifact = yield* ctx.artifacts.byId(who.key.artifactId);
    if (!artifact || !ctx.artifacts.live(artifact)) return [];
    const allowed = yield* may(ctx, who, { ownerId: artifact.ownerId, folderId: artifact.folderId, artifactId: artifact.id }, "read");
    return allowed ? [artifact] : [];
  });
}
function listFolders(ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!ctx.keys.hasScope(who.key, "read")) return envelope("forbidden", "This key cannot read folders.");
    if (who.key.kind !== "master") return envelope("forbidden", "An artifact key lists no folders.");
    const reachable = yield* ctx.access.foldersFor(who.key.userId);
    const folders = yield* Effect.forEach(reachable, folder => Effect.gen(function* () {
      const path = ctx.folders.path(folder);
      return { id: folder.id, slug: folder.slug, name: yield* ctx.folders.name(folder), path,
        indexUrl: absolute(ctx, path), role: yield* ctx.access.role(who.key.userId, folder.id),
        artifacts: (yield* ctx.artifacts.listByFolder(folder.id)).length };
    }));
    return json({ folders });
  });
}

function rotate(request: Request, ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!ctx.keys.hasScope(who.key, "write")) return envelope("forbidden", "This key cannot change artefacts.");
    const read = yield* readApiJson(request);
    if ("error" in read) return read.error;
    const body = objectBody(read.body);
    if (body.ifVersion !== undefined &&
        (typeof body.ifVersion !== "number" || !Number.isSafeInteger(body.ifVersion) || body.ifVersion < 1)) {
      return envelope("validation", "ifVersion must be a positive integer.", [
        { code: "invalid-version", message: "ifVersion must be a positive integer.", field: "ifVersion" },
      ]);
    }
    const ifVersion = typeof body.ifVersion === "number" ? body.ifVersion : undefined;
    if (body.allow_weak_password === true && who.key.kind !== "master") {
      return envelope("forbidden", "Only a master key may publish a password below the floor.");
    }
    const flagged = validateRotateBody(read.body).issues;
    const weakUsed = body.allow_weak_password === true && flagged.some(issue => issue.code === "invalid-password");
    const issues = weakUsed ? flagged.filter(issue => issue.code !== "invalid-password") : flagged;
    if (issues.length) return envelope("validation", "Request rejected by validation.", issues);
    if (typeof body.artifact !== "string" || !body.artifact) return envelope("validation", "`artifact` is required.", [
      { code: "invalid-slug", message: "artifact must be the artefact slug or id", field: "artifact" },
    ]);
    const artifact = yield* ctx.artifacts.byPath(body.artifact);
    if (!artifact || !ctx.artifacts.live(artifact)) return envelope("not-found", "No such artefact.");
    if (!(yield* may(ctx, who, { ownerId: artifact.ownerId, folderId: artifact.folderId, artifactId: artifact.id }, "write"))) {
      return envelope("forbidden", "That artefact belongs to another user.");
    }
    const warnings: ValidationIssue[] = [];
    if (body.html !== undefined) {
      const doc = validateArtefactHtml(body.html, { checkReferences: false });
      if (doc.errors.length) return envelope("validation", "Request rejected by validation.", doc.errors.map(issue => ({ ...issue, field: "html" })));
      warnings.push(...doc.warnings.map(issue => ({ ...issue, field: "html" })));
      const gated = body.password === undefined ? ctx.artifacts.gated(artifact) : body.password != null && body.password !== "";
      const prepared = yield* ctx.artifacts.prepare(body.html, { gated });
      yield* ctx.artifacts.publish({ artifactId: artifact.id, html: body.html, password: body.password, prepared, ifVersion,
        ...authorOf(who) });
    }
    // Omitted leaves the gate alone; null clears it; a string sets/rotates it.
    if (body.html === undefined && body.password !== undefined) yield* ctx.artifacts.setPassword(artifact.id, body.password);
    const updated = yield* ctx.artifacts.byId(artifact.id);
    if (!updated) return yield* Effect.fail(new Error("The rotated artefact could not be read."));
    yield* audit(ctx, who, "artifact.rotate", updated.id, writeDetail({ gated: ctx.artifacts.gated(updated) }, weakUsed));
    const folder = updated.folderId ? yield* ctx.folders.byId(updated.folderId) : null;
    return json({ artifact: yield* view(ctx, updated, folder), warnings });
  });
}

// ---- retired paths ---------------------------------------------------------

/** Normalize every path before touching a model; uniqueness belongs to paths/model code. */
function normalizeAliasPaths(body: ApiBody): AliasResult {
  const invalid = (message: string) => envelope("validation", "Request rejected by validation.",
    [{ code: "invalid-slug", field: "paths", message }]);
  if (!Array.isArray(body.paths) || body.paths.length === 0) return { error: invalid("paths must be a non-empty array of public paths") };
  const clean: string[] = [];
  for (const path of body.paths) {
    const normalized = normalizePath(path);
    if (!normalized) return { error: invalid(`paths must be one or two lowercase path segments (got ${JSON.stringify(String(path ?? ""))})`) };
    clean.push(normalized);
  }
  return { value: [...new Set(clean)] };
}
/** Only documented alias refusals are converted here; other typed failures propagate. */
function aliasIssue(error: CodeError): Effect.Effect<Response, CodeError> {
  if (error.code === "slug-taken") return Effect.succeed(envelope("conflict", error.message));
  if (error.code === "invalid-path") return Effect.succeed(envelope("validation", "Request rejected by validation.",
    [{ code: "invalid-slug", field: "paths", message: error.message }]));
  return Effect.fail(error);
}
function aliasArtifacts(request: Request, ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!ctx.keys.hasScope(who.key, "write")) return envelope("forbidden", "This key cannot change artefacts.");
    const read = yield* readApiJson(request);
    if ("error" in read) return read.error;
    const body = objectBody(read.body);
    if (typeof body.artifact !== "string" || !body.artifact) return envelope("validation", "`artifact` is required.", [
      { code: "invalid-slug", message: "artifact must be the artefact slug or id", field: "artifact" },
    ]);
    const paths = normalizeAliasPaths(body);
    if ("error" in paths) return paths.error;
    const artifact = yield* ctx.artifacts.byPath(body.artifact);
    if (!artifact || !ctx.artifacts.live(artifact)) return envelope("not-found", "No such artefact.");
    if (!(yield* may(ctx, who, { ownerId: artifact.ownerId, folderId: artifact.folderId, artifactId: artifact.id }, "write"))) {
      return envelope("forbidden", "That artefact belongs to another user.");
    }
    const recorded = yield* Effect.forEach(paths.value, path => ctx.artifacts.alias(path, artifact.id)).pipe(
      Effect.map((value): AliasResult => ({ value })),
      Effect.catch(error => aliasIssue(error).pipe(Effect.map((response): AliasResult => ({ error: response })))),
    );
    if ("error" in recorded) return recorded.error;
    yield* audit(ctx, who, "artifact.alias", artifact.id, { paths: recorded.value });
    return json({ artifact: { slug: artifact.slug, path: ctx.artifacts.path(artifact) }, aliases: recorded.value });
  });
}
function aliasFolders(request: Request, ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (who.key.kind !== "master") return envelope("forbidden", "Only a master key records folder paths.");
    const read = yield* readApiJson(request);
    if ("error" in read) return read.error;
    const body = objectBody(read.body);
    if (typeof body.folder !== "string" || !body.folder) return envelope("validation", "`folder` is required.", [
      { code: "invalid-slug", message: "folder must be the folder slug or id", field: "folder" },
    ]);
    const paths = normalizeAliasPaths(body);
    if ("error" in paths) return paths.error;
    const folder = yield* ctx.folders.byPath(body.folder);
    if (!folder) return envelope("not-found", "No such folder.");
    if (!(yield* may(ctx, who, { ownerId: folder.ownerId, folderId: folder.id }, "write"))) return envelope("forbidden", "That folder belongs to another user.");
    const recorded = yield* Effect.forEach(paths.value, path => ctx.folders.alias(path, folder.id)).pipe(
      Effect.map((value): AliasResult => ({ value })),
      Effect.catch(error => aliasIssue(error).pipe(Effect.map((response): AliasResult => ({ error: response })))),
    );
    if ("error" in recorded) return recorded.error;
    yield* audit(ctx, who, "folder.alias", null, { folder: folder.id, paths: recorded.value });
    return json({ folder: { slug: folder.slug, path: ctx.folders.path(folder) }, aliases: recorded.value });
  });
}

// ---- keys ----------------------------------------------------------------

const masterOnly = (who: KeyAuthentication) => who.key.kind === "master";
/** The model rechecks live grants itself, including races between the controller and write. */
const keyIssue = (error: CodeError, fallback: string): Response => error.code === "forbidden"
  ? envelope("forbidden", "That artefact belongs to another user.")
  : envelope("validation", error.message || fallback);

function mintKey(request: Request, ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!masterOnly(who)) return envelope("forbidden", "Only a master key mints artifact keys.");
    const read = yield* readApiJson(request);
    if ("error" in read) return read.error;
    const body = objectBody(read.body);
    const artifact = yield* ctx.artifacts.byPath(body.artifact);
    if (!artifact || !ctx.artifacts.live(artifact)) return envelope("not-found", "No such artefact.");
    const scopes = body.scopes ?? "read";
    if (!(yield* may(ctx, who, { ownerId: artifact.ownerId, folderId: artifact.folderId, artifactId: artifact.id }, scopes === "read" ? "read" : "write"))) {
      return envelope("forbidden", "That artefact belongs to another user.");
    }
    return yield* ctx.keys.mint({ userId: who.key.userId, kind: "artifact", artifactId: artifact.id,
      scopes, label: body.label ?? null, can_read_content: body.can_read_content === true }).pipe(
      Effect.map(minted => json({ key: minted.record, token: minted.key }, 201)),
      Effect.catch(error => Effect.succeed(keyIssue(error, "The key could not be minted."))),
    );
  });
}
function listKeys(ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!masterOnly(who)) return envelope("forbidden", "Only a master key lists keys.");
    return json({ keys: yield* ctx.keys.list(who.key.userId) });
  });
}
function rotateKey(request: Request, ctx: ApiContext, who: KeyAuthentication) {
  return Effect.gen(function* () {
    if (!masterOnly(who)) return envelope("forbidden", "Only a master key rotates keys.");
    const read = yield* readApiJson(request);
    if ("error" in read) return read.error;
    return yield* ctx.keys.rotate(objectBody(read.body).id, who.key.userId).pipe(
      Effect.map(rotated => rotated ? json({ key: rotated.record, token: rotated.key }) : envelope("not-found", "No such key.")),
      Effect.catch(error => Effect.succeed(keyIssue(error, "The key could not be rotated."))),
    );
  });
}
function revokeKey(ctx: ApiContext, who: KeyAuthentication, id: string) {
  return Effect.gen(function* () {
    if (!masterOnly(who)) return envelope("forbidden", "Only a master key revokes keys.");
    const revoked = yield* ctx.keys.revoke(id, who.key.userId);
    if (!revoked) return envelope("not-found", "No such key, or it is already revoked.");
    return json({ ok: true, id });
  });
}

// ---- project data (ADR 0032) --------------------------------------------------

/** Groups: folder, collection, the `/records` marker, record id. */
const PROJECT_ROUTE = /^projects\/([^/]+)\/collections(?:\/([^/]+)(\/records(?:\/([^/]+))?)?)?$/;
/** Groups: folder, collection, the file tail (ADR 0035 §External API). */
const FILE_ROUTE = /^projects\/([^/]+)\/collections\/([^/]+)\/(uploads(?:\/[^/]+(?:\/complete|\/parts\/[1-9]\d{0,4})?)?|files\/[^/]+|records\/[^/]+\/files\/[^/]+)$/;
const unknownEndpoint = () => envelope("not-found", "Unknown API endpoint.");
const projectForbidden = () => envelope("forbidden", "This key cannot do that in this project.");
const decoded = (raw: string): string | null => {
  try { return decodeURIComponent(raw); } catch { return null; }
};

/** Model refusals answer here, so the catch-all never rewrites issue fields to `html`. */
function projectIssue(error: CodeError): Effect.Effect<Response, CodeError> {
  switch (error.code) {
    case "validation": return Effect.succeed(envelope("validation", error.message, error.issues ?? []));
    case "conflict":
    case "quota-exceeded": return Effect.succeed(envelope("conflict", error.message));
    case "too-large": return Effect.succeed(envelope("too-large", error.message));
    case "not-found": return Effect.succeed(envelope("not-found", error.message));
    case "wrong-kind": return Effect.succeed(envelope("forbidden", error.message));
    case "not-top-level": return Effect.succeed(envelope("validation", error.message, [{ field: "folder", message: error.message }]));
    case "rate-limited": return Effect.succeed(rateLimited({ retryAfter: error.retryAfter ?? 1 }));
    default: return Effect.fail(error);
  }
}

/** Master key, a folder the key can read, and a top-level one (ADR 0032). */
function projectFolder(ctx: ApiContext, who: KeyAuthentication, rawFolder: string | undefined): Effect.Effect<{ folder: Folder; target: KeyResource } | Response, CodeError> {
  return Effect.gen(function* () {
    if (who.key.kind !== "master") return envelope("forbidden", "Project data needs a master key.");
    const reference = decoded(rawFolder ?? "");
    if (reference === null) return unknownEndpoint();
    const folder = yield* ctx.folders.byPath(reference);
    if (!folder) return envelope("not-found", "No such folder.");
    const target = { ownerId: folder.ownerId, folderId: folder.id };
    if (!(yield* may(ctx, who, target, "read"))) return envelope("forbidden", "You cannot reach that project.");
    if (folder.parentId !== null) {
      const message = "Project data lives on a top-level folder.";
      return envelope("validation", message, [{ field: "folder", message }]);
    }
    return { folder, target };
  });
}

function projectRoute(request: Request, ctx: ApiContext, who: KeyAuthentication, [rawFolder, rawName, recordsMarker, rawId]: Array<string | undefined>) {
  return Effect.gen(function* () {
    const method = request.method.toUpperCase();
    const place = yield* projectFolder(ctx, who, rawFolder);
    if (place instanceof Response) return place;
    const { folder, target } = place;
    const name = rawName === undefined ? undefined : decoded(rawName);
    const id = rawId === undefined ? undefined : decoded(rawId);
    if (name === null || id === null) return unknownEndpoint();
    const can = (need: string) => may(ctx, who, target, need);
    const record = (action: string, collection: string, recordId?: string) =>
      audit(ctx, who, action, null, recordId ? { folderId: folder.id, collection, recordId } : { folderId: folder.id, collection });
    const query = new URL(request.url).searchParams;

    if (name === undefined) {
      if (method !== "GET") return unknownEndpoint();
      return json({ collections: yield* ctx.projectData.collections(folder.id) });
    }
    return yield* Effect.gen(function* () {
      if (recordsMarker === undefined) {
        if (method === "PUT") {
          if (!(yield* can("write"))) return projectForbidden();
          const parsed = yield* readApiJson(request);
          if ("error" in parsed) return parsed.error;
          const { collection, created } = yield* ctx.projectData.define(folder.id, name, parsed.body);
          yield* record("project.collection.define", collection.name);
          return json({ collection }, created ? 201 : 200);
        }
        if (method === "DELETE") {
          const found = yield* ctx.projectData.collection(folder.id, name);
          if (!found) return envelope("not-found", "No such collection in this project.");
          if (!(yield* can(found.kind === "responses" ? "manage" : "write"))) return projectForbidden();
          if (!(yield* ctx.projectData.removeCollection(folder.id, name, found.kind))) return envelope("not-found", "No such collection in this project.");
          yield* record("project.collection.delete", name);
          return json({ ok: true, name });
        }
        return unknownEndpoint();
      }
      const found = yield* ctx.projectData.collection(folder.id, name);
      if (!found) return envelope("not-found", "No such collection in this project.");
      const responses = found.kind === "responses";
      const readNeed = responses ? "manage" : "read";
      if (id === undefined) {
        if (method === "GET") {
          if (!(yield* can(readNeed))) return projectForbidden();
          return json(yield* ctx.projectData.list(folder.id, name, { limit: query.get("limit") ?? undefined, cursor: query.get("cursor") ?? undefined }));
        }
        if (method === "POST") {
          if (responses) return envelope("forbidden", "Responses are submitted by readers, not written by agents.");
          if (!(yield* can("write"))) return projectForbidden();
          const parsed = yield* readApiJson(request);
          if ("error" in parsed) return parsed.error;
          const created = yield* ctx.projectData.create(folder.id, name, objectOf(parsed.body).data, undefined, `api:${who.key.userId}`);
          yield* record("project.record.create", name, created.id);
          return json({ record: created }, 201);
        }
        return unknownEndpoint();
      }
      if (method === "GET") {
        if (!(yield* can(readNeed))) return projectForbidden();
        const found = yield* ctx.projectData.get(folder.id, name, id);
        return found ? json({ record: found }) : envelope("not-found", "No such record.");
      }
      if (method === "PUT") {
        if (responses) return envelope("forbidden", "Responses cannot be edited.");
        if (!(yield* can("write"))) return projectForbidden();
        const parsed = yield* readApiJson(request);
        if ("error" in parsed) return parsed.error;
        const body = objectOf(parsed.body);
        const updated = yield* ctx.projectData.update(folder.id, name, id, body.data, body.ifVersion, `api:${who.key.userId}`);
        yield* record("project.record.update", name, id);
        return json({ record: updated });
      }
      if (method === "DELETE") {
        if (!(yield* can(responses ? "manage" : "write"))) return projectForbidden();
        if (!(yield* ctx.projectData.remove(folder.id, name, id, query.get("ifVersion") ?? undefined))) {
          return envelope("not-found", "No such record.");
        }
        yield* record("project.record.delete", name, id);
        return json({ ok: true, id });
      }
      return unknownEndpoint();
    }).pipe(Effect.catch(projectIssue));
  });
}

/** Uploads, attached-file metadata and downloads; bytes never pass through JSON (ADR 0035). */
function fileRoute(request: Request, ctx: ApiContext, who: KeyAuthentication, [rawFolder, rawName, rawTail]: Array<string | undefined>) {
  return Effect.gen(function* () {
    const method = request.method.toUpperCase();
    const place = yield* projectFolder(ctx, who, rawFolder);
    if (place instanceof Response) return place;
    const { folder, target } = place;
    const segments = [rawName ?? "", ...(rawTail ?? "").split("/")].map(decoded);
    if (segments.includes(null)) return unknownEndpoint();
    // FILE_ROUTE fixes the shape: uploads[/id[/complete|/parts/n]] | files/fileId | records/id/files/fileId.
    const [name = "", head, id = "", step, last = ""] = segments as string[];
    const collection = yield* ctx.projectData.collection(folder.id, name);
    if (!collection) return envelope("not-found", "No such collection in this project.");
    const responses = collection.kind === "responses";
    const can = (need: string) => may(ctx, who, target, need);
    const actor = `api:${who.key.userId}`;
    const logged = (action: string, fileId: string, size: number) =>
      audit(ctx, who, action, null, { folderId: folder.id, collection: name, fileId, size });
    const uploadView = (upload: UploadState): UploadView =>
      ({ ...upload, partPath: `/_api/projects/${folder.id}/collections/${name}/uploads/${upload.id}/parts/` });

    return yield* Effect.gen(function* () {
      if (head !== "uploads") {
        if (method !== "GET") return unknownEndpoint();
        if (!(yield* can(responses ? "manage" : "read"))) return projectForbidden();
        if (head === "files") {
          const file = yield* ctx.projectFiles.describe(folder.id, name, id);
          if (!file) return envelope("not-found", "No such file.");
          return json({ file: { ...file, downloadPath: `/_api/projects/${folder.id}/collections/${name}/records/${file.recordId}/files/${file.id}` } });
        }
        const found = yield* ctx.projectFiles.download(folder.id, name, id, last, request.signal);
        return found ? fileResponse(found.file, found.body) : envelope("not-found", "No such file.");
      }
      if (responses) return envelope("forbidden", "Responses are submitted by readers, not uploaded by agents.");
      if (!(yield* can("write"))) return projectForbidden();
      if (rawTail === "uploads") {
        if (method !== "POST") return unknownEndpoint();
        const parsed = yield* readApiJson(request);
        if ("error" in parsed) return parsed.error;
        const body = objectOf(parsed.body);
        const { upload, resumed } = yield* ctx.projectFiles.start({ folderId: folder.id, collection, actorKey: actor,
          field: body.field, name: body.name, type: body.type, size: body.size, lastModified: body.lastModified });
        if (!resumed) yield* logged("project.file.upload", upload.id, upload.size);
        return json({ upload: uploadView(upload) }, resumed ? 200 : 201);
      }
      if (step === undefined && method === "GET") return json({ upload: uploadView(yield* ctx.projectFiles.status(folder.id, name, id, actor)) });
      if (step === undefined && method === "DELETE") {
        const upload = yield* ctx.projectFiles.status(folder.id, name, id, actor);
        if (!(yield* ctx.projectFiles.cancel(folder.id, name, id, actor))) return envelope("not-found", "No such upload.");
        yield* logged("project.file.cancel", id, upload.size);
        return json({ ok: true, id });
      }
      if (step === "complete" && method === "POST") {
        const { file, completed } = yield* ctx.projectFiles.complete(folder.id, name, id, actor);
        if (completed) yield* logged("project.file.complete", file.id, file.size);
        return json({ file });
      }
      if (step === "parts" && method === "PUT") {
        if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/octet-stream")) {
          const message = "Parts are sent as application/octet-stream.";
          return envelope("validation", message, [{ field: "part", message }]);
        }
        return json({ part: yield* ctx.projectFiles.putPart(folder.id, name, id, actor, Number(last), request) });
      }
      return unknownEndpoint();
    }).pipe(Effect.catch(projectIssue));
  });
}
const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
