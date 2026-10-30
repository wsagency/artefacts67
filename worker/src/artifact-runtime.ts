import * as Effect from "effect/Effect";
import { randomHex, scalarSeal, scalarUnseal, sha256hex } from "./crypto.js";
import { json, readJson, parseCookies, setCookie, clientIp, fileResponse } from "./http.js";
import type { Artifact, Artifacts, ArtifactVersion } from "./artifacts.js";
import type { Folder, Folders } from "./folders.js";
import type { Session, User } from "./store.js";
import type { Analytics, ObservationLimiter } from "./analytics.js";
import type { ShareAccess, ShareAudit, Shares, VisitorShare } from "./shares.js";
import type { RuntimeState } from "./runtime-state.js";
import type { Collection, CollectionKind, ProjectData, ProjectRecord, Submission, SubmittedBy } from "./project-data.js";
import type { ProjectFiles } from "./project-files.js";
import type { RateLimiter } from "./ratelimit.js";
import { asCodeError, type CodeError, type DatabaseLike } from "./types.js";
import type { CompiledTheme } from "../../frontend/src/theme-compiler.js";
import { compileThemeOverrides } from "../../frontend/src/theme-overrides.js";
import { openProjectThemes } from "./themes.js";
import { getPlatformTheme } from "../../frontend/src/platform-themes.js";

const LIFETIME = 60 * 60 * 1000;
const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const statuses: Readonly<Record<string, number | undefined>> = {
  forbidden: 403, unauthorized: 401, "password-required": 401, "rate-limited": 429,
  "quota-exceeded": 409, "too-large": 413, "invalid-state": 400, "invalid-report": 400,
  "bad-json": 400, "password-choice": 400, "invalid-title": 400, "invalid-slug": 400,
  "slug-taken": 409, validation: 400, "external-reference": 400, "incomplete-document": 400,
  "not-utf8": 400, "invalid-content": 400, "invalid-version": 400, "invalid-owner": 400,
  "font-provider": 400, "font-fetch": 502, "font-format": 400, "font-css": 400,
  "font-limit": 413, "font-timeout": 504, "publish-conflict": 409, "not-found": 404,
  conflict: 409, "no-project": 409, "wrong-kind": 400, "theme-project-mismatch": 400,
};
const cookieName = (request: Request) => new URL(request.url).protocol === "https:" ? "__Host-artefacts-reader" : "artefacts-reader";
/** The runtime error envelope; a refusal that knows when to retry (transfer slot, limiter) says so. */
const runtimeError = (error: CodeError) => {
  const status = error.code ? statuses[error.code] : undefined;
  return status ? Effect.succeed(json({ error: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) }, status,
    error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {})) : Effect.fail(error);
};

export type RuntimeSource =
  | { kind: "console"; artifactId: string }
  | { kind: "public"; path: string }
  | { kind: "share"; path: string; token: string; artifactId?: string | null };
export interface RuntimeActiveSession { user: User; session: Session }
export interface RuntimeSessionContext {
  auth: {
    sessionCookie: string;
    currentSession(token: unknown): Effect.Effect<RuntimeActiveSession | null, CodeError>;
  };
}
export interface RuntimeAccess extends ShareAccess {
  foldersFor(userId: unknown): Effect.Effect<Folder[], CodeError>;
}
export interface ViewerContext extends RuntimeSessionContext {
  access: RuntimeAccess;
  folders: Pick<Folders, "name">;
  artifacts: Pick<Artifacts, "title" | "gated" | "versions">;
  projectData: Pick<ProjectData, "projectOf" | "collections">;
  publicOrigin: string;
}
export interface DuplicateContext {
  access: ShareAccess;
  folders: Pick<Folders, "byId">;
  artifacts: Pick<Artifacts, "gated" | "title" | "duplicate">;
  store: { audit: ShareAudit };
}
export interface RuntimeReadContext extends RuntimeSessionContext {
  artifacts: Pick<Artifacts, "byId" | "byPath" | "live" | "gated">;
  access: ShareAccess;
  shares: Pick<Shares, "resolve">;
  limiter: ObservationLimiter;
  analytics: Pick<Analytics, "proof">;
}
export interface RuntimeContext extends RuntimeReadContext {
  artifacts: Pick<Artifacts, "byId" | "byPath" | "live" | "gated" | "title" | "duplicate" | "readContent">;
  folders: Pick<Folders, "byId">;
  shares: Pick<Shares, "resolve" | "byId">;
  store: { audit: ShareAudit };
  runtimeState: Pick<RuntimeState, "execute">;
  projectData: Pick<ProjectData, "projectOf" | "collection" | "list" | "get" | "create" | "update" | "remove">;
  projectFiles: Pick<ProjectFiles, "session" | "start" | "putPart" | "complete" | "cancel" | "download">;
  /** The full limiter: file transfer refusals carry its retryAfter. */
  limiter: Pick<RateLimiter, "hit">;
  reports: {
    submit(input: { artifactId: string; actorKey: string; reason: unknown }): Effect.Effect<string, CodeError>;
  };
}
export interface ViewerPermissions { read: boolean; write: boolean; manage: boolean; own: boolean }
export interface WritableDestination { id: string; ref: string; name: string; permissions: ViewerPermissions }
export interface ViewerOptions {
  artifact?: Artifact | null; source: RuntimeSource; publicUrl: string; gated: boolean; mode?: string;
  session?: RuntimeActiveSession | null; folders?: WritableDestination[];
}
export interface ViewerDescriptor {
  title: string; lang?: string; currentVersion?: number; publicUrl: string; documentOrigin: string; gated: boolean; mode?: string;
  loadUrl: string; gateUrl?: string; runtime: RuntimeSource; signedIn: boolean; csrf?: string;
  permissions: ViewerPermissions; folders: WritableDestination[]; actionBase?: string;
  artifactRef?: string; versions?: ArtifactVersion[]; protected: boolean;
  /** Project data this reader may use (ADR 0032); null when none, unfiled or still gated. */
  data: { collections: Array<{ name: string; kind: CollectionKind }> } | null;
}
export interface DuplicateValues { folderId?: unknown; title?: unknown; slug?: unknown; password?: unknown }
export interface RuntimeObservation { path: string; token: string; artifactId: string; proof: string }
export interface IssuedRuntime {
  runtime: { grant: string }; observation: RuntimeObservation | null; cookie?: string;
}
interface RuntimeGrant {
  purpose: "artifact-runtime"; source: RuntimeSource; artifactId: string; revision: string | null;
  actorKey: string; binding: string; issuedAt: number; expiresAt: number;
}
interface ReaderIdentity {
  active: RuntimeActiveSession | null; actorKey: string; binding: string; cookie?: string;
}
export interface RuntimeResolved {
  artifact: Artifact; share: VisitorShare | undefined; active: RuntimeActiveSession | null;
}
export interface AuthorizedRuntime extends RuntimeResolved, ReaderIdentity {
  source: RuntimeSource; canWriteShared: boolean;
}
export interface IssueRuntimeInput { artifact: Artifact; share?: VisitorShare | null; source: RuntimeSource }
export interface ArtifactRuntime {
  issue(request: Request, ctx: RuntimeReadContext, input: IssueRuntimeInput): Effect.Effect<IssuedRuntime, CodeError>;
  authorize(request: Request, ctx: RuntimeReadContext, token: unknown): Effect.Effect<AuthorizedRuntime, CodeError>;
  presentation(version: ArtifactVersion, lang: string | undefined, folderId: string | null): Effect.Effect<PagePresentation | null, CodeError>;
  handle(request: Request, ctx: RuntimeContext, params: { action?: string }): Effect.Effect<Response, CodeError>;
  /** Binary project file transfers (ADR 0035): part uploads and downloads under `/_runtime/files/`. */
  files(request: Request, ctx: RuntimeContext, params: { rest?: string }): Effect.Effect<Response, CodeError>;
}
export interface PagePresentation {
  type: "page";
  theme: { scope: "platform" | "project"; slug: string } | null;
  themeResolution: "explicit" | "fallback";
  brandLock: boolean;
  lang: string;
  fontsCss?: string;
  compiledTheme?: CompiledTheme;
}
interface RuntimeRequestBody extends DuplicateValues {
  source?: RuntimeSource; grant?: unknown; csrf?: unknown; reason?: unknown;
  op: unknown; scope?: unknown; key?: unknown; prefix?: unknown; value?: unknown;
  collection?: unknown; id?: unknown; data?: unknown; ifVersion?: unknown; limit?: unknown; cursor?: unknown;
}
type RuntimeRecord = Omit<ProjectRecord, "submission"> & { submission?: Pick<Submission, "submittedAt" | "artifactVersion"> };

/** Clients see only when and against which version they submitted, never who or from where. */
const recordView = ({ submission, ...record }: ProjectRecord): RuntimeRecord =>
  submission ? { ...record, submission: { submittedAt: submission.submittedAt, artifactVersion: submission.artifactVersion } } : record;

export function runtimeSession(request: Request, ctx: RuntimeSessionContext): Effect.Effect<RuntimeActiveSession | null, CodeError> {
  return Effect.gen(function* () {
    const token = parseCookies(request)[ctx.auth.sessionCookie];
    const active = token ? yield* ctx.auth.currentSession(token) : null;
    return active && !active.session.pending2fa && active.user.status === "active" ? active : null;
  });
}
export function writableDestinations(ctx: ViewerContext, active: RuntimeActiveSession | null): Effect.Effect<WritableDestination[], CodeError> {
  return Effect.gen(function* () {
    const folders: WritableDestination[] = [];
    if (!active) return folders;
    for (const folder of yield* ctx.access.foldersFor(active.user.id)) {
      const subject = { ownerId: folder.ownerId, folderId: folder.id };
      if (yield* ctx.access.may(active.user.id, subject, "write")) folders.push({
        id: folder.id, ref: folder.slug ?? folder.id, name: yield* ctx.folders.name(folder),
        permissions: { read: true, write: true, manage: yield* ctx.access.may(active.user.id, subject, "manage"), own: folder.ownerId === active.user.id },
      });
    }
    return folders;
  });
}
/** A folder-share index may reuse one actor/estate walk; each child's authority stays live. */
export function viewerDescriptor(request: Request, ctx: ViewerContext, { artifact, source, publicUrl, gated, mode, session, folders }: ViewerOptions): Effect.Effect<ViewerDescriptor, CodeError> {
  return Effect.gen(function* () {
    const active = session === undefined ? yield* runtimeSession(request, ctx) : session;
    const permissions: ViewerPermissions = { read: true, write: false, manage: false, own: false };
    const colleague = Boolean(artifact && active && (yield* ctx.access.may(active.user.id, artifact, "read")));
    if (colleague && artifact && active) {
      for (const need of ["write", "manage", "own"] as const) permissions[need] = yield* ctx.access.may(active.user.id, artifact, need);
    }
    const destinations = folders ?? (yield* writableDestinations(ctx, active));
    // Same rule as the runtime: a share source is a visitor even when the browser is signed in.
    let data: ViewerDescriptor["data"] = null;
    const projectId = artifact && !gated ? yield* ctx.projectData.projectOf(artifact.folderId) : null;
    if (projectId) {
      const usable = (yield* ctx.projectData.collections(projectId)).filter(item => source.kind !== "share" || item.visitors);
      // The project folder's name is sealed metadata; share visitors and subfolder-only colleagues must not receive it.
      if (usable.length) data = { collections: usable.map(({ name, kind }) => ({ name, kind })) };
    }
    return {
      title: artifact ? yield* ctx.artifacts.title(artifact) : "Shared folder",
      ...(artifact ? { lang: artifact.lang, currentVersion: artifact.currentVersion } : {}),
      documentOrigin: ctx.publicOrigin,
      publicUrl, gated, mode, loadUrl: "/_runtime/load",
      ...(gated ? { gateUrl: `/_gate${publicUrl}` } : {}), runtime: source,
      signedIn: Boolean(active), csrf: active?.session.csrf, permissions, folders: destinations,
      ...(colleague && artifact ? { actionBase: `/app/a/${artifact.slug ?? artifact.id}`, artifactRef: artifact.slug ?? artifact.id,
        versions: yield* ctx.artifacts.versions(artifact.id) } : {}),
      protected: Boolean(gated || (artifact && ctx.artifacts.gated(artifact))), data,
    };
  });
}
export function duplicateReadable(ctx: DuplicateContext, active: { user: User } | null, artifact: Artifact, values: DuplicateValues, protectedSource = false): Effect.Effect<{ url: string }, CodeError> {
  return Effect.gen(function* () {
    if (!active) return yield* Effect.fail(fail("unauthorized", "Sign in to duplicate this artefact."));
    if ((protectedSource || ctx.artifacts.gated(artifact)) && typeof values.password !== "string") {
      return yield* Effect.fail(fail("password-choice", "Explicitly choose a password for the copy, or explicitly choose no password."));
    }
    let folder: Folder | null = null;
    if (values.folderId) {
      folder = yield* ctx.folders.byId(String(values.folderId));
      if (!folder || !(yield* ctx.access.may(active.user.id, { ownerId: folder.ownerId, folderId: folder.id }, "write"))) {
        return yield* Effect.fail(fail("forbidden", "You cannot publish into that folder."));
      }
    }
    const copy = yield* ctx.artifacts.duplicate({ artifactId: artifact.id, ownerId: folder?.ownerId ?? active.user.id,
      folderId: folder?.id ?? null, title: String(values.title || `${yield* ctx.artifacts.title(artifact)} (copy)`),
      slug: values.slug ? String(values.slug) : null, password: values.password || null, authorType: "user", authorId: active.user.id });
    yield* ctx.store.audit.write({ actorType: "user", actorId: active.user.id, action: "artifact.duplicate", artifactId: copy.id });
    return { url: `/app/a/${copy.slug ?? copy.id}/view` };
  });
}

export function openArtifactRuntime({ db, masterKeyHex, now = Date.now }: { db: DatabaseLike; masterKeyHex: string; now?: () => number }): ArtifactRuntime {
  const themes = openProjectThemes({ db, masterKeyHex });
  const ipKey = (request: Request) => sha256hex(`${masterKeyHex}:runtime-ip:${clientIp(request)}`);
  const limitAnonymous = (request: Request, ctx: RuntimeReadContext, purpose: string, limit: number) => Effect.gen(function* () {
    const result = yield* ctx.limiter.hit(`runtime-ip:${purpose}:${yield* ipKey(request)}`, { limit, windowMs: 60000 });
    if (!result.allowed) return yield* Effect.fail(fail("rate-limited", "Too many anonymous runtime requests. Try again in a minute."));
  });
  const identity = (request: Request, ctx: RuntimeSessionContext, create = false): Effect.Effect<ReaderIdentity, CodeError> => Effect.gen(function* () {
    const active = yield* runtimeSession(request, ctx);
    if (active) return { active, actorKey: yield* sha256hex(`user:${active.user.id}`), binding: yield* sha256hex(`session:${active.session.id}`) };
    let token = parseCookies(request)[cookieName(request)];
    let cookie: string | undefined;
    if (!/^[a-f0-9]{64}$/.test(token || "")) {
      if (!create) return yield* Effect.fail(fail("unauthorized", "Reopen the artefact to establish reader identity."));
      token = yield* randomHex(32);
      cookie = setCookie(cookieName(request), token, { maxAge: 365 * 86400, secure: new URL(request.url).protocol === "https:", sameSite: "Strict" });
    }
    const actorKey = yield* sha256hex(`reader:${token}`);
    return { active: null, actorKey, binding: actorKey, cookie };
  });
  const resolve = (request: Request, ctx: RuntimeReadContext, source: RuntimeSource | null | undefined): Effect.Effect<RuntimeResolved, CodeError> => Effect.gen(function* () {
    if (!source || typeof source !== "object") return yield* Effect.fail(fail("forbidden", "Invalid runtime source."));
    const active = yield* runtimeSession(request, ctx);
    let artifact: Artifact | null | undefined;
    let share: VisitorShare | undefined;
    if (source.kind === "console") {
      artifact = yield* ctx.artifacts.byId(String(source.artifactId || ""));
      if (!active || !artifact || !(yield* ctx.access.may(active.user.id, artifact, "read"))) return yield* Effect.fail(fail("forbidden", "Artefact access has ended."));
    } else if (source.kind === "public") {
      artifact = yield* ctx.artifacts.byPath(String(source.path || ""));
      if (!active || !artifact || !(yield* ctx.access.may(active.user.id, artifact, "read"))) return yield* Effect.fail(fail("forbidden", "Artefact access has ended."));
    } else if (source.kind === "share") {
      const resolved = yield* ctx.shares.resolve({ path: source.path, token: source.token, artifactId: source.artifactId });
      artifact = resolved?.artifact;
      share = resolved?.share;
    }
    if (!artifact || artifact.deletedAt || !ctx.artifacts.live(artifact)) return yield* Effect.fail(fail("forbidden", "Artefact access has ended."));
    // Owner suspension does not withdraw live visitor shares; reader suspension ends direct access.
    return { artifact, share, active };
  });
  const presentation = (version: ArtifactVersion, lang: string | undefined, folderId: string | null): Effect.Effect<PagePresentation | null, CodeError> => Effect.gen(function* () {
    if (version.type !== "page") return null;
    const effectiveLang = lang ?? "en";
    const theme = version.themeScope && version.themeSlug ? { scope: version.themeScope, slug: version.themeSlug } : null;
    let resolved: { theme: { scope: "platform" | "project"; slug: string }; themeResolution: "explicit" | "fallback";
      compiledTheme: CompiledTheme; fontsCss: string; brandLock: boolean };
    if (folderId) {
      resolved = yield* themes.resolveForRead({ folderId, theme, themeId: version.themeId });
    } else {
      const selected = theme?.scope === "platform" ? getPlatformTheme(theme.slug) : null;
      const compiledTheme = selected ?? getPlatformTheme("report")!;
      resolved = { theme: selected ? theme! : { scope: "platform", slug: "report" },
        themeResolution: selected || theme === null ? "explicit" : "fallback",
        compiledTheme, fontsCss: "", brandLock: false };
    }
    let compiledTheme: CompiledTheme | undefined;
    if (version.themeOverridesSealed) {
      const sealed = yield* scalarUnseal<{ v: unknown }>(masterKeyHex, version.themeOverridesSealed);
      compiledTheme = yield* Effect.try({ try: () => compileThemeOverrides(resolved.compiledTheme, sealed?.v), catch: error => fail("invalid-theme-overrides", error instanceof Error ? error.message : "Stored page theme overrides are invalid.") });
    }
    return { type: "page", theme: resolved.theme, themeResolution: resolved.themeResolution,
      brandLock: version.brandLock || resolved.brandLock, lang: effectiveLang, fontsCss: resolved.fontsCss,
      ...(compiledTheme ? { compiledTheme } : { compiledTheme: resolved.compiledTheme }) };
  });
  const revision = (artifact: Artifact, share: VisitorShare | null | undefined, source: RuntimeSource) => Effect.gen(function* () {
    if (source.kind === "public") return yield* sha256hex(JSON.stringify(artifact.wrapPassword ?? null));
    if (source.kind === "share") {
      if (!share) return yield* Effect.fail(fail("forbidden", "Share access has ended."));
      const row = yield* Effect.tryPromise({
        try: async () => db.prepare("SELECT key_wrap_password FROM shares WHERE id = ?").bind(share.id).first<{ key_wrap_password: string | null }>(),
        catch: asCodeError,
      });
      if (!row) return yield* Effect.fail(fail("forbidden", "Share access has ended."));
      return yield* sha256hex(row.key_wrap_password ?? "null");
    }
    return null;
  });
  const issue = (request: Request, ctx: RuntimeReadContext, { artifact, share = null, source }: IssueRuntimeInput): Effect.Effect<IssuedRuntime, CodeError> => Effect.gen(function* () {
    const resolved = yield* resolve(request, ctx, source);
    if (resolved.artifact.id !== artifact.id) return yield* Effect.fail(fail("forbidden", "Artefact access changed."));
    const reader = yield* identity(request, ctx, true);
    if (!reader.active) yield* limitAnonymous(request, ctx, "grant", 30);
    const issuedAt = now();
    const envelope: RuntimeGrant = { purpose: "artifact-runtime", source, artifactId: artifact.id,
      revision: yield* revision(artifact, share, source), actorKey: reader.actorKey, binding: reader.binding, issuedAt, expiresAt: issuedAt + LIFETIME };
    const grant = yield* scalarSeal(masterKeyHex, envelope);
    let observation: RuntimeObservation | null = null;
    if (share && source.kind === "share") {
      // Measurement outages must not close authorized content.
      observation = yield* Effect.catch(Effect.gen(function* () {
        return { path: source.path, token: source.token, artifactId: artifact.id,
          proof: yield* ctx.analytics.proof({ shareId: share.id, artifactId: artifact.id }) };
      }), () => Effect.succeed(null));
    }
    return { runtime: { grant }, observation, cookie: reader.cookie };
  });
  const authorize = (request: Request, ctx: RuntimeReadContext, token: unknown): Effect.Effect<AuthorizedRuntime, CodeError> => Effect.gen(function* () {
    if (typeof token !== "string" || token.length > 8192) return yield* Effect.fail(fail("forbidden", "Reopen the artefact."));
    const grant = yield* Effect.catch(scalarUnseal<RuntimeGrant>(masterKeyHex, token), () => Effect.fail(fail("forbidden", "Invalid runtime grant.")));
    if (grant?.purpose !== "artifact-runtime" || grant.expiresAt <= now() || grant.issuedAt > now() ||
      grant.expiresAt - grant.issuedAt !== LIFETIME) return yield* Effect.fail(fail("forbidden", "Runtime access expired. Reopen the artefact."));
    const reader = yield* identity(request, ctx);
    if (reader.actorKey !== grant.actorKey || reader.binding !== grant.binding) return yield* Effect.fail(fail("forbidden", "Reader session changed. Reopen the artefact."));
    const resolved = yield* resolve(request, ctx, grant.source);
    if (resolved.artifact.id !== grant.artifactId || (yield* revision(resolved.artifact, resolved.share, grant.source)) !== grant.revision) {
      return yield* Effect.fail(fail("forbidden", "Artefact access changed. Reopen the artefact."));
    }
    return { ...resolved, ...reader, source: grant.source,
      canWriteShared: grant.source.kind !== "share" && Boolean(reader.active && (yield* ctx.access.may(reader.active.user.id, resolved.artifact, "write"))) };
  });
  /** The project's collection as this reader may see it: a share source only reaches visitor collections. */
  const projectCollection = (ctx: RuntimeContext, folderId: string, name: string, source: RuntimeSource) => Effect.gen(function* () {
    const collection = yield* ctx.projectData.collection(folderId, name);
    if (!collection) return yield* Effect.fail(fail("not-found", "No such collection."));
    if (source.kind === "share" && !collection.visitors) return yield* Effect.fail(fail("forbidden", "This collection is not open to share visitors."));
    return collection;
  });
  /** ADR 0035 upload authority: records need live shared write; responses follow submit authority. */
  const mayUpload = ({ canWriteShared, active, source }: AuthorizedRuntime, collection: Collection) => {
    if (collection.kind === "records") return canWriteShared ? Effect.void : Effect.fail(fail("forbidden", "Your role cannot change this project's data."));
    return source.kind === "share" || active ? Effect.void : Effect.fail(fail("forbidden", "Artefact access has ended."));
  };
  /** Hourly file buckets per reader and project; a signed-out reader key resets with its cookie, the IP ceiling does not. */
  const limitFiles = (request: Request, ctx: RuntimeContext, { active, actorKey }: AuthorizedRuntime, purpose: string, folderId: string, limit: number, ipLimit: number) => Effect.gen(function* () {
    const refuse = (retryAfter: number) => Effect.fail(Object.assign(fail("rate-limited", "Too many file transfers. Try again later."), { retryAfter }));
    const own = yield* ctx.limiter.hit(`${purpose}:${actorKey}:${folderId}`, { limit, windowMs: 3_600_000 });
    if (!own.allowed) return yield* refuse(own.retryAfter);
    if (active) return;
    const shared = yield* ctx.limiter.hit(`runtime-ip:${purpose}:${yield* ipKey(request)}:${folderId}`, { limit: ipLimit, windowMs: 3_600_000 });
    if (!shared.allowed) return yield* refuse(shared.retryAfter);
  });
  /** ADR 0032 runtime authority: the folder is the binding, a share source is always a visitor. */
  const projectRequest = (request: Request, ctx: RuntimeContext, authorized: AuthorizedRuntime, body: RuntimeRequestBody) => Effect.gen(function* () {
    const { artifact, active, actorKey, canWriteShared, source } = authorized;
    const folderId = yield* ctx.projectData.projectOf(artifact.folderId);
    if (!folderId) return yield* Effect.fail(fail("no-project", "This artefact is not in a project folder."));
    const name = typeof body.collection === "string" ? body.collection : "";
    const collection = yield* projectCollection(ctx, folderId, name, source);
    const id = typeof body.id === "string" ? body.id : "";
    const op = body.op;
    if (op === "upload-start" || op === "upload-complete" || op === "upload-cancel") {
      yield* mayUpload(authorized, collection);
      if (op === "upload-complete") return { file: (yield* ctx.projectFiles.complete(folderId, name, id, actorKey)).file };
      if (op === "upload-cancel") {
        if (!(yield* ctx.projectFiles.cancel(folderId, name, id, actorKey))) return yield* Effect.fail(fail("not-found", "Upload expired or unknown."));
        return null;
      }
      yield* limitFiles(request, ctx, authorized, "files-start", folderId, 20, 60);
      const input = typeof body.data === "object" && body.data !== null && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
      const { upload, resumed } = yield* ctx.projectFiles.start({ folderId, collection, actorKey,
        field: input.field, name: input.name, type: input.type, size: input.size, lastModified: input.lastModified });
      return { upload: { ...upload, partPath: `/_runtime/files/uploads/${upload.id}/parts/` }, resumed };
    }
    if (op !== "schema" && op !== "list" && op !== "get" && op !== "create" && op !== "update" && op !== "delete" && op !== "submit" && op !== "mine") {
      return yield* Effect.fail(Object.assign(fail("validation", "Unknown data operation."), { issues: [{ field: "op", message: "Unknown data operation." }] }));
    }
    if (op === "schema") return { name: collection.name, kind: collection.kind, fields: collection.fields, visitors: collection.visitors };
    if ((collection.kind === "responses") !== (op === "submit" || op === "mine")) {
      return yield* Effect.fail(fail("wrong-kind", collection.kind === "responses"
        ? "Responses are submitted with submit and read back with mine."
        : "Only responses collections take submissions."));
    }
    if (op === "list") {
      const page = yield* ctx.projectData.list(folderId, name, { limit: body.limit, cursor: body.cursor });
      return { ...page, records: page.records.map(recordView) };
    }
    if (op === "mine") {
      const page = yield* ctx.projectData.list(folderId, name, { limit: body.limit, cursor: body.cursor, actorKey });
      return { ...page, records: page.records.map(recordView) };
    }
    if (op === "get") {
      const found = yield* ctx.projectData.get(folderId, name, id);
      return found ? recordView(found) : null;
    }
    if (op === "submit") {
      const limit = yield* ctx.limiter.hit(`runtime-submit:${actorKey}:${folderId}`, { limit: 30, windowMs: 3_600_000 });
      if (!limit.allowed) return yield* Effect.fail(fail("rate-limited", "Too many submissions. Try again later."));
      // A signed-out reader key is a cookie hash and resets with the cookie; the IP ceiling does not.
      if (!active) {
        const shared = yield* ctx.limiter.hit(`runtime-ip:submit:${yield* ipKey(request)}:${folderId}`, { limit: 120, windowMs: 3_600_000 });
        if (!shared.allowed) return yield* Effect.fail(fail("rate-limited", "Too many submissions from this network. Try again later."));
      }
      let submittedBy: SubmittedBy;
      if (source.kind === "share") {
        const share = authorized.share ? yield* ctx.shares.byId(authorized.share.id) : null;
        if (!share) return yield* Effect.fail(fail("forbidden", "Share access has ended."));
        submittedBy = { type: "share", shareId: share.id, shareName: share.name || share.recipient };
      } else if (active) {
        submittedBy = { type: "user", userId: active.user.id, email: active.user.email, name: active.user.name ?? "" };
      } else return yield* Effect.fail(fail("forbidden", "Artefact access has ended."));
      const meta: Submission = { submittedAt: new Date(now()).toISOString(), artifactId: artifact.id, artifactVersion: artifact.currentVersion, submittedBy };
      return recordView(yield* ctx.projectData.create(folderId, name, body.data, { actorKey, meta }));
    }
    if (!canWriteShared) return yield* Effect.fail(fail("forbidden", "Your role cannot change this project's data."));
    if (op === "create") return recordView(yield* ctx.projectData.create(folderId, name, body.data, undefined, actorKey));
    if (op === "update") return recordView(yield* ctx.projectData.update(folderId, name, id, body.data, body.ifVersion, actorKey));
    if (!(yield* ctx.projectData.remove(folderId, name, id, body.ifVersion))) return yield* Effect.fail(fail("not-found", "No such record."));
    return null;
  });
  const handle = (request: Request, ctx: RuntimeContext, { action }: { action?: string }): Effect.Effect<Response, CodeError> => Effect.gen(function* () {
    if (request.method !== "POST") return json({ error: "method-not-allowed" }, 405);
    if (request.headers.get("Origin") !== new URL(request.url).origin ||
      !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "forbidden" }, 403);
    return yield* Effect.catch(Effect.gen(function* () {
      if (!(yield* runtimeSession(request, ctx))) yield* limitAnonymous(request, ctx, "request", 180);
      const body = yield* readJson<RuntimeRequestBody>(request, 80 * 1024);
      if (action === "load") {
        const source = body.source;
        if (!source) return yield* Effect.fail(fail("forbidden", "Invalid runtime source."));
        const resolved = yield* resolve(request, ctx, source);
        if ((source.kind === "public" && ctx.artifacts.gated(resolved.artifact)) || resolved.share?.gated) return yield* Effect.fail(fail("password-required", "Enter the password to open this artefact."));
        const issued = yield* issue(request, ctx, { ...resolved, source });
        const content = yield* ctx.artifacts.readContent(resolved.artifact);
        const page = yield* presentation(content.version, resolved.artifact.lang, resolved.artifact.folderId);
        return json({ html: content.html, ...(page ? { page } : {}), runtime: issued.runtime, observation: issued.observation }, 200, issued.cookie ? { "Set-Cookie": issued.cookie } : {});
      }
      const authorized = yield* authorize(request, ctx, body.grant);
      const { artifact, active, actorKey, canWriteShared } = authorized;
      const limit = yield* ctx.limiter.hit(`runtime:${actorKey}:${artifact.id}`, { limit: 180, windowMs: 60000 });
      if (!limit.allowed) return yield* Effect.fail(fail("rate-limited", "Too many runtime requests. Try again in a minute."));
      if (action === "state") return json({ value: yield* ctx.runtimeState.execute({ artifactId: artifact.id, actorKey, canWriteShared, anonymous: !active }, body) });
      if (action === "check") return json({ ok: true });
      if (action === "data") return json({ value: yield* projectRequest(request, ctx, authorized, body) });
      if (action === "report") {
        const reportLimit = yield* ctx.limiter.hit(`report:${yield* ipKey(request)}`, { limit: 10, windowMs: 3600000 });
        if (!reportLimit.allowed) return yield* Effect.fail(fail("rate-limited", "Too many reports. Try again later."));
        yield* ctx.reports.submit({ artifactId: artifact.id, actorKey, reason: body.reason });
        return json({ ok: true });
      }
      if (action === "duplicate") {
        if (!active || body.csrf !== active.session.csrf) return yield* Effect.fail(fail("forbidden", "Refresh your signed-in session."));
        return json(yield* duplicateReadable(ctx, active, artifact, body, Boolean(authorized.share?.gated)));
      }
      return json({ error: "not-found" }, 404);
    }), runtimeError);
  });
  const UPLOAD_PART = /^uploads\/([0-9a-f]{32})\/parts\/([1-9]\d{0,4})$/;
  const DOWNLOAD = /^([^/]+)\/([^/]+)\/([^/]+)$/;
  const files = (request: Request, ctx: RuntimeContext, { rest = "" }: { rest?: string }): Effect.Effect<Response, CodeError> => Effect.gen(function* () {
    const part = UPLOAD_PART.exec(rest);
    const download = part ? null : DOWNLOAD.exec(rest);
    if (!part && !download) return json({ error: "not-found" }, 404);
    if (request.method !== (part ? "PUT" : "POST")) return json({ error: "method-not-allowed" }, 405);
    if (request.headers.get("Origin") !== new URL(request.url).origin ||
      (part && !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/octet-stream"))) return json({ error: "forbidden" }, 403);
    return yield* Effect.catch(Effect.gen(function* () {
      if (!(yield* runtimeSession(request, ctx))) yield* limitAnonymous(request, ctx, "request", 180);
      // Live authority on every part and download (ADR 0035): grant, project, collection, role.
      const authorized = yield* authorize(request, ctx, request.headers.get("X-Artefacts-Grant"));
      const { artifact, actorKey, source } = authorized;
      const limit = yield* ctx.limiter.hit(`runtime:${actorKey}:${artifact.id}`, { limit: 180, windowMs: 60000 });
      if (!limit.allowed) return yield* Effect.fail(fail("rate-limited", "Too many runtime requests. Try again in a minute."));
      const folderId = yield* ctx.projectData.projectOf(artifact.folderId);
      if (!folderId) return yield* Effect.fail(fail("no-project", "This artefact is not in a project folder."));
      if (part) {
        const [, id = "", number = ""] = part;
        const session = yield* ctx.projectFiles.session(id);
        if (!session || session.folderId !== folderId) return yield* Effect.fail(fail("not-found", "Upload expired or unknown."));
        const collection = yield* projectCollection(ctx, folderId, session.collection, source);
        yield* mayUpload(authorized, collection);
        // The hourly part buckets are charged inside a transfer slot: a busy isolate costs no hit.
        const admit = limitFiles(request, ctx, authorized, "files-part", folderId, 128, 256);
        return json({ value: { part: yield* ctx.projectFiles.putPart(folderId, collection.name, id, actorKey, Number(number), request, admit) } });
      }
      const [, name = "", recordId = "", fileId = ""] = download!;
      const collection = yield* projectCollection(ctx, folderId, name, source);
      // A response file is its submitter's alone: the attach predicate made its uploader the record's submitter.
      if (collection.kind === "responses" && (yield* ctx.projectFiles.session(fileId))?.actorKey !== actorKey) {
        return yield* Effect.fail(fail("not-found", "No such file."));
      }
      const found = yield* ctx.projectFiles.download(folderId, name, recordId, fileId, request.signal);
      if (!found) return yield* Effect.fail(fail("not-found", "No such file."));
      return fileResponse(found.file, found.body);   // Range is not supported: always the whole file
    }), runtimeError);
  });
  return { issue, authorize, presentation, handle, files };
}
