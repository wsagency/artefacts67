import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
// HTTP surface of the 2.0 console (ADR 0024): the public auth pages (/login, /register,
// /invite/<token>, /2fa, /enroll, /logout, the passkey ceremonies), the legacy /_ redirects,
// and the three signed-in areas — /app (the estate, tree-first), /settings (the account's
// own), /admin (the platform, owner & admins). State transitions stay in auth.js,
// webauthn.js and the models; this module owns request parsing, CSRF and rendering.

import { html, json, redirect, readForm, readJson, parseCookies, setCookie, clearCookie, clientIp } from "./http.js";
import { normalizePath } from "./paths.js";
import {
  loginView, registerView, acceptView, twoFaView, enrollView, messageView,
  appHomeView, appNewView, appFolderNewView, folderPaneView, artefactPaneView, artefactReaderView,
  settingsView, keysView, adminHomeView, usersView, platformSettingsView,
  atLeast, artifactViewerView, reportsView,
} from "./views.js";
import { viewerDescriptor, duplicateReadable } from "./artifact-runtime.js";
import { asCodeError, type CodeError } from "./types.js";
import type { Auth, CurrentSession } from "./auth.js";
import type { Store, Session, User } from "./store.js";
import type { WebAuthn } from "./webauthn.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Access, AccessResource, EstateRole, Permission } from "./access.js";
import type { Artifact, Artifacts } from "./artifacts.js";
import type { Folder, Folders } from "./folders.js";
import type { Keys } from "./keys.js";
import type { Shares, CreatedShare, ShareKind } from "./shares.js";
import type { Analytics, AnalyticsSummary } from "./analytics.js";
import type { Reports } from "./reports.js";
import type { ProjectData } from "./project-data.js";
import type { ViewProps, Standing, EstateTreeNode, ArtifactViewInput, DestinationViewInput } from "./views.js";

export interface AuthContext {
  auth: Pick<Auth, "sessionCookie" | "currentSession" | "userCount" | "bootstrapAllowed" |
    "login" | "registerOwner" | "findInvite" | "acceptInvite" | "beginTotpEnroll" |
    "lockState" | "confirmTotpEnroll" | "loginFail" | "loginReset" | "elevate" | "signInVerified" | "verifyTotp">;
  store: { sessions: Pick<Store["sessions"], "destroy"> };
  webauthn: Pick<WebAuthn, "beginAuthentication" | "completeAuthentication" | "beginLogin" | "completeLogin">;
  limiter: Pick<RateLimiter, "hit">;
  secureCookies?: boolean;
  rpId: string;
  rpName: string;
  requestOrigin: string;
  /** OPERATOR_NAME, trimmed; the auth screens show "Hosted by …" when non-empty. */
  operator?: string;
}
export interface ConsoleContext extends AuthContext {
  auth: AuthContext["auth"] & Pick<Auth, "meView" | "invite" | "audit" | "counts" |
    "changePassword" | "canManage" | "canSetRole" | "wouldOrphanOwners">;
  store: {
    sessions: AuthContext["store"]["sessions"] & Pick<Store["sessions"], "destroyUser">;
    users: Pick<Store["users"], "byId" | "byEmail" | "all" | "setName" | "setRole" | "setStatus">;
    invites: Pick<Store["invites"], "pending" | "cancel">;
    audit: Pick<Store["audit"], "recent" | "write">;
    settings: Pick<Store["settings"], "retention" | "setRetention" | "mailFrom" | "setMailFrom">;
  };
  webauthn: AuthContext["webauthn"] & Pick<WebAuthn, "list" | "beginRegistration" | "completeRegistration" | "remove">;
  access: Access;
  folders: Pick<Folders, "byId" | "bySlug" | "aliasesFor" | "name" | "path" |
    "create" | "setName" | "rename" | "alias" | "setParent" | "contents" | "remove">;
  artifacts: Pick<Artifacts, "byId" | "bySlug" | "listForEstate" | "listByOwner" |
    "title" | "gated" | "live" | "path" | "aliasesFor" | "versions" | "document" |
    "prepare" | "create" | "restore" | "remove" | "publish" | "setMeta" | "rename" |
    "setPassword" | "alias" | "moveTo" | "duplicate">;
  keys: Pick<Keys, "list" | "mint" | "rotate" | "revoke">;
  shares: Pick<Shares, "listFor" | "create" | "revoke">;
  analytics: Pick<Analytics, "summary" | "platformSummary" | "retention" | "setRetention">;
  reports: Pick<Reports, "list" | "resolve">;
  projectData: Pick<ProjectData, "projectOf" | "collections">;
}
interface AuthParams { action?: string; token?: string; op?: string }
interface ConsoleParams { area?: string; rest?: string }
interface Estate { mine: EstateTreeNode[]; shared: EstateTreeNode[]; unfiled: ArtifactViewInput[] }
type FormValues = Record<string, string>;
type RequestFields = Record<string, unknown>;
type ScreenExtra = Pick<ViewProps, "error" | "notice" | "inviteLink" | "secret">;
type ScreenRender = (extra?: ScreenExtra, status?: number) => Effect.Effect<Response, CodeError>;

const SESSION_MAX_AGE = 12 * 60 * 60;
const formValues = (params: URLSearchParams): FormValues => Object.fromEntries(params.entries());
const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });

function readFields(request: Request): Effect.Effect<RequestFields, CodeError> {
  return Effect.gen(function* () {
    const body = yield* readJson(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return yield* Effect.fail(fail("bad-json", "request body is not valid JSON"));
    }
    return body as RequestFields;
  });
}

const LOCKED_MESSAGE = "Too many failed attempts. Try again in a few minutes.";
// Passkey-first begins per client address: enough for retries and shared offices, too few to fill D1.
const PASSKEY_LOGIN_LIMIT = 20;
const PASSKEY_LOGIN_WINDOW_MS = 5 * 60_000;
const isPasskeyProofFailure = (error: CodeError) => /^(?:webauthn-|sign-count$)/.test(error.code || "");

function errorInfo(error: unknown, fallback = "The request could not be processed.") {
  const value = error !== null && typeof error === "object" ? error : {};
  const code = "code" in value && typeof value.code === "string" && value.code ? value.code : "error";
  const issues = "issues" in value && Array.isArray(value.issues)
    ? value.issues.map((issue: unknown) => {
      const item = issue !== null && typeof issue === "object" ? issue : {};
      return `${"code" in item ? item.code : undefined}: ${"message" in item ? item.message : undefined}`;
    }).join(" ")
    : "";
  const message = code === "rate-limit-unavailable"
    ? "Something went wrong. Please try again."
    : issues || ("message" in value && typeof value.message === "string" && value.message ? value.message : fallback);
  const statuses: Record<string, number> = {
    "bad-json": 400,
    "too-large": 413,
    "bad-email": 400,
    "bad-role": 400,
    "bad-action": 400,
    "password-mismatch": 400,
    "password-policy": 400,
    "weak-password": 400,
    "invalid-title": 400,
    "invalid-content": 400,
    "invalid-slug": 400,
    "invalid-path": 400,
    "invalid-owner": 400,
    "validation": 422,
    "external-reference": 422,
    "font-provider": 422,
    "font-fetch": 422,
    "font-timeout": 422,
    "font-format": 422,
    "font-css": 422,
    "font-limit": 413,
    "publish-conflict": 409,
    "project-data": 409,
    "folder-changed": 409,
    "folder-too-large": 409,
    "purge-failed": 503,
    "slug-taken": 409,
    "already-bootstrapped": 409,
    "bad-invite": 410,
    "invalid-current-password": 400,
    "no-pending-totp": 400,
    "locked": 429,
    "rate-limited": 429,
    "rate-limit-unavailable": 500,
    "suspended": 403,
    "csrf": 403,
    "forbidden": 403,
    "unauthorized": 401,
    "invalid-credentials": 401,
    "invalid-2fa": 401,
    "already-authenticated": 409,
    "no-passkeys": 409,
    "not-found": 404,
    "method": 405,
    "internal": 500,
    "webauthn": 400,
  };
  const status = statuses[code] ?? 400;
  return { code, message, status };
}

function internalError(error: unknown) {
  return Effect.sync(() => {
    console.error("artefacts67 handler error", error);
    return errorInfo({ code: "internal", message: "Something went wrong. Please try again." });
  });
}

function cookieFor(ctx: AuthContext, session: Session) {
  return setCookie(ctx.auth.sessionCookie, session.id, {
    maxAge: SESSION_MAX_AGE,
    secure: ctx.secureCookies,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

function expiredCookie(ctx: AuthContext) {
  return clearCookie(ctx.auth.sessionCookie, { secure: ctx.secureCookies, path: "/", sameSite: "Lax" });
}

function current(request: Request, ctx: AuthContext): Effect.Effect<CurrentSession | null, CodeError> {
  return Effect.gen(function* () {
    const token = parseCookies(request)[ctx.auth.sessionCookie];
    return token ? (yield* ctx.auth.currentSession(token)) : null;
  });
}

function requireCsrf(session: Session | null | undefined, value: unknown): Effect.Effect<void, CodeError> {
  return Effect.gen(function* () {
    if (!session || !value || session.csrf !== String(value)) {
      return yield* Effect.fail(fail("csrf", "Your session has expired. Refresh the page."));
    }
  });
}

function readValues(request: Request, session?: Session, limit?: number): Effect.Effect<FormValues, CodeError> {
  return Effect.gen(function* () {
    const values = formValues(yield* readForm(request, limit));
    if (session) yield* requireCsrf(session, values.csrf);
    return values;
  });
}

function nextFactor(active: { user: Pick<User, "totpSecretSealed"> } | null) {
  return active?.user?.totpSecretSealed ? "/2fa" : "/enroll";
}

function page(view: string, status = 200) {
  return html(view, status);
}

function jsonError(error: unknown, fallback = "The request could not be processed.") {
  const info = errorInfo(error, fallback);
  return json({ ok: false, error: { code: info.code, message: info.message } }, info.status);
}

function requireFull(request: Request, ctx: AuthContext): Effect.Effect<
  { active: CurrentSession; response: null } | { active: CurrentSession | null; response: Response }, CodeError
> {
  return current(request, ctx).pipe(Effect.map(active => {
    if (!active) return { active: null, response: redirect("/login") };
    if (active.session.pending2fa) return { active, response: redirect(nextFactor(active)) };
    return { active, response: null };
  }));
}

function actorCanManage(user: Pick<User, "role"> | null) {
  return user?.role === "owner" || user?.role === "admin";
}

// ---- the estate, and who may do what to it ----------------------------------------
//
// A person's estate is no longer only their own: access.js answers which folders they may
// reach, own ones and granted ones alike, and with what standing. The console mirrors that
// ladder to decide what to DRAW; every mutation asks `access.may` again before it moves, so a
// control that should not have been drawn still cannot act, and a revocation lands on the very
// next request.

const GRANT_ROLES = ["viewer", "editor", "manager"];
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARE_DEFAULT_DAYS = 30;
const SHARE_MAX_DAYS = 365;
/** The share model's own ceiling, mirrored here so a long name comes back as a sentence on
 *  the form rather than as a model error. */
const SHARE_NAME_MAX = 160;

/** The subject `access.may` rules on: who owns the thing, and which folder carries the grants. */
const folderSubject = (folder: Folder): AccessResource => ({ ownerId: folder.ownerId, folderId: folder.id });
const artifactSubject = (artifact: Artifact): AccessResource => ({ ownerId: artifact.ownerId, folderId: artifact.folderId ?? null });

/** The live central ruling. Nothing in this module changes state without passing through it. */
function requireMay(ctx: ConsoleContext, user: User, subject: AccessResource, need: Permission): Effect.Effect<void, CodeError> {
  return Effect.gen(function* () {
    if (yield* ctx.access.may(user.id, subject, need)) return;
    return yield* Effect.fail(fail("forbidden", {
      read: "This is not yours to read.",
      write: "You may read this, but not change it.",
      manage: "Sharing this is the manager's, not yours.",
      own: "Only the owner can do this.",
    }[need]));
  });
}

/** What to DRAW: one role lookup, turned into the four capabilities the panes ask about. */
function standingOf(ctx: ConsoleContext, user: User, subject: AccessResource): Effect.Effect<Standing, CodeError> {
  const granted = subject.folderId ? ctx.access.role(user.id, subject.folderId) : Effect.succeed(null);
  return granted.pipe(Effect.map(granted => {
    const role = granted ?? (subject.ownerId === user.id ? "owner" : null);
    return {
      role,
      read: atLeast(role, "viewer"),
      write: atLeast(role, "editor"),
      manage: atLeast(role, "manager"),
      own: atLeast(role, "owner"),
    };
  }));
}

/** The signed-in user's estate as a nested tree (ADR 0025): the folders they may reach, the
 *  artefacts under each, and the subfolders under each — `parentId` nesting is display only,
 *  paths stay flat. Two groups come back: the folders they own, and the ones shared with them. */
function estateOf(ctx: ConsoleContext, userId: string): Effect.Effect<Estate, CodeError> {
  return Effect.gen(function* () {
    const folders = yield* ctx.access.foldersFor(userId);
    const byFolder = new Map<string, ArtifactViewInput[]>();
    const unfiled: ArtifactViewInput[] = [];
    for (const artifact of yield* ctx.artifacts.listForEstate(userId, folders.map(folder => folder.id))) {
      const summary: ArtifactViewInput = {
        id: artifact.id,
        ref: artifact.slug ?? artifact.id,
        title: (yield* ctx.artifacts.title(artifact)) || artifact.slug || artifact.id,
        lang: artifact.lang,
        gated: ctx.artifacts.gated(artifact),
        path: ctx.artifacts.path(artifact),
        ownerId: artifact.ownerId,
      };
      if (artifact.folderId) {
        let list = byFolder.get(artifact.folderId);
        if (!list) byFolder.set(artifact.folderId, list = []);
        list.push(summary);
      } else unfiled.push(summary);
    }
    const nodes = new Map<string, EstateTreeNode>();
    for (const folder of folders) {
      const mine = folder.ownerId === userId;
      // Shared standing is live per folder: a deeper grant may be stronger than its parent's.
      const role: EstateRole = mine ? "owner" : ((yield* ctx.access.role(userId, folder.id)) ?? "viewer");
      nodes.set(folder.id, {
        id: folder.id,
        ref: folder.slug ?? folder.id,
        slug: folder.slug,
        parentId: folder.parentId,
        ownerId: folder.ownerId,
        ownerName: "",
        role,
        name: (yield* ctx.folders.name(folder)) || folder.slug || folder.id,
        path: ctx.folders.path(folder),
        artefacts: byFolder.get(folder.id) ?? [],
        children: [],
      });
    }
    const mine: EstateTreeNode[] = [];
    const shared: EstateTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : null;
      // A dangling parent (deleted, or simply out of reach) floats the node back to a root.
      if (parent) parent.children.push(node);
      else if (node.ownerId === userId) mine.push(node);
      else shared.push(node);
    }
    for (const node of shared) node.ownerName = yield* displayName(ctx, node.ownerId);
    return { mine, shared, unfiled };
  });
}

/** Only an existing same-user settings shell may intentionally retain its display tree.
 * Authentication has already run, and all content/mutations still use the live models. */
function settingsEstate(request: Request, ctx: ConsoleContext, userId: string): Effect.Effect<Pick<ViewProps, "estate" | "estateOmitted">, CodeError> {
  if (request.method === "GET" && request.headers.get("X-WS-Console-Estate") === userId) {
    return Effect.succeed({ estateOmitted: true });
  }
  return estateOf(ctx, userId).pipe(Effect.map(estate => ({ estate })));
}

/** A colleague's name for the screens — their display name, or their address if they have none. */
function displayName(ctx: ConsoleContext, userId: string): Effect.Effect<string, CodeError> {
  return ctx.store.users.byId(userId).pipe(Effect.map(user => user ? (user.name || user.email) : ""));
}

const allRoots = (estate: Estate) => [...estate.mine, ...estate.shared];

/** The estate flattened depth-first, for <select> lists. `skip` drops a folder and its whole
 *  subtree (a folder may not move into itself or its descendant, ADR 0025); `need` keeps only
 *  the folders the person's standing earns — a viewer's folder is no place to publish into. */
function flattenEstate(nodes: EstateTreeNode[], { skip = null, need = null }: {
  skip?: string | null; need?: EstateRole | null;
} = {}): DestinationViewInput[] {
  const out: DestinationViewInput[] = [];
  const walk = (list: EstateTreeNode[], depth: number) => {
    for (const node of list) {
      if (skip && node.id === skip) continue;    // the whole subtree goes with it
      if (!need || atLeast(node.role, need)) {
        out.push({
          id: node.id, ref: node.ref, name: node.name, depth,
          path: node.path, ownerId: node.ownerId, ownerName: node.ownerName, role: node.role,
        });
      }
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** Resolve a console ref (slug or id) to an artefact the actor may at least read; a flat miss
 *  otherwise — the console never tells apart "no such artefact" from "not yours to see". */
function readableArtifact(ctx: ConsoleContext, user: User, ref: string, includeDeleted = false): Effect.Effect<Artifact | null, CodeError> {
  return Effect.gen(function* () {
    const artifact = (yield* ctx.artifacts.bySlug(ref)) ?? (yield* ctx.artifacts.byId(ref));
    if (!artifact || (artifact.deletedAt && !includeDeleted)) return null;
    return (yield* ctx.access.may(user.id, artifactSubject(artifact), "read")) ? artifact : null;
  });
}

function readableFolder(ctx: ConsoleContext, user: User, ref: string): Effect.Effect<Folder | null, CodeError> {
  return Effect.gen(function* () {
    const folder = (yield* ctx.folders.bySlug(ref)) ?? (yield* ctx.folders.byId(ref));
    if (!folder) return null;
    return (yield* ctx.access.may(user.id, folderSubject(folder), "read")) ? folder : null;
  });
}

/** A folder the actor may publish into (their own, or one a colleague let them edit). */
function writableFolder(ctx: ConsoleContext, user: User, ref: string): Effect.Effect<Folder | null, CodeError> {
  return Effect.gen(function* () {
    const folder = (yield* ctx.folders.bySlug(ref)) ?? (yield* ctx.folders.byId(ref));
    if (!folder) return null;
    return (yield* ctx.access.may(user.id, folderSubject(folder), "write")) ? folder : null;
  });
}

function ownFolder(ctx: ConsoleContext, user: User, ref: string): Effect.Effect<Folder | null, CodeError> {
  return Effect.gen(function* () {
    const folder = (yield* ctx.folders.bySlug(ref)) ?? (yield* ctx.folders.byId(ref));
    return folder && folder.ownerId === user.id ? folder : null;
  });
}

const dayStamp = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A `<input type=date>` value as the ISO instant that day ends. Blank hands the decision back
 *  to the share model's own default; the bounds are checked here too so a typo comes back as a
 *  sentence on the form rather than as a model error. */
function shareExpiry(value: unknown): Effect.Effect<string | undefined, CodeError> {
  return Effect.gen(function* () {
    const raw = String(value ?? "").trim();
    if (!raw) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return yield* Effect.fail(fail("bad-action", "The expiry must be a date."));
    const at = Date.parse(`${raw}T23:59:59.000Z`);
    if (Number.isNaN(at) || dayStamp(at) !== raw) return yield* Effect.fail(fail("bad-action", "The expiry must be a valid date."));
    if (at <= Date.now()) return yield* Effect.fail(fail("bad-action", "The expiry must be in the future."));
    const ceiling = Date.now() + SHARE_MAX_DAYS * DAY_MS;
    if (raw > dayStamp(ceiling)) return yield* Effect.fail(fail("bad-action", `A share can last at most ${SHARE_MAX_DAYS} days.`));
    return new Date(Math.min(at, ceiling)).toISOString();
  });
}

/** What a share form hands the model, validated before anything is minted. The name is the
 *  manager's own label for this link and is required — a list of links nobody can tell apart is
 *  not a list anybody can manage. The address is not required: a link is just as often copied
 *  and handed over in person, or given to a whole group. Ticking the mail box is what makes an
 *  address necessary, and that is settled here, before the model mints anything. */
function shareForm(values: RequestFields) {
  return Effect.gen(function* () {
    const name = String(values.name ?? "").trim();
    if (!name) return yield* Effect.fail(fail("bad-action", "Name this share, so you can tell your links apart later."));
    if (name.length > SHARE_NAME_MAX) return yield* Effect.fail(fail("bad-action", `A share name can be at most ${SHARE_NAME_MAX} characters.`));
    const recipient = String(values.recipient ?? "").trim().toLowerCase();
    if (recipient && !EMAIL_SHAPE.test(recipient)) {
      return yield* Effect.fail(fail("bad-email", "That is not an e-mail address. Leave it empty to pass the link on yourself."));
    }
    // Never on anything but a ticked box: a share must not mail itself by accident.
    const sendMail = values.sendMail === "1";
    if (sendMail && !recipient) {
      return yield* Effect.fail(fail("bad-email", "Add an e-mail address to send the link, or untick the box and pass it on yourself."));
    }
    return {
      name,
      recipient,
      password: String(values.password ?? "") || null,
      expiresAt: yield* shareExpiry(values.expiresAt),
      sendMail,
    };
  });
}

const shareNotice = (share: CreatedShare, sendMail: boolean) => {
  if (!sendMail) return "The share link is ready — copy it from the list below.";
  if (share.mailStatus === "sent") return "The share link was created and e-mailed.";
  if (share.mailStatus === "dry-run") return "The link is ready, but mail is in dry-run mode. Copy the link below; no email was sent.";
  return "The link is ready, but the email could not be sent. Copy the link below.";
};

/** Per-share numbers keyed by share id, so a share row can carry its own reading figures. */
const statsByShare = (summary: AnalyticsSummary | null) => new Map((summary?.shares ?? []).map((row) => [row.shareId, row]));

/** The measurement of one target, for the people who may read it. */
const summaryFor = (ctx: ConsoleContext, user: User, kind: ShareKind, targetId: string, allowed: boolean): Effect.Effect<AnalyticsSummary | null, CodeError> =>
  allowed ? ctx.analytics.summary({ actorId: user.id, kind, targetId }) : Effect.succeed(null);

/** Split a "one path per line" textarea into clean lines (blank lines and whitespace ignored). */
const pathLines = (value: unknown) =>
  String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** The retired paths a form listed, validated before anything is written so a typo can never
 *  leave a half-finished change behind. */
function validRetiredPaths(value: unknown): Effect.Effect<string[], CodeError> {
  return Effect.gen(function* () {
    const paths = pathLines(value);
    for (const path of paths) {
      if (!normalizePath(path)) return yield* Effect.fail(fail("invalid-path", `"${path}" is not a valid path.`));
    }
    return paths;
  });
}


/** The M1 auth URLs, permanently moved (ADR 0024). Invitation mails sent before the rename
 *  carry `/_auth/accept/<token>`; that link must not die. */
export function legacyAuthRedirect({ rest = "" }: Pick<ConsoleParams, "rest"> = {}) {
  const path = String(rest || "").replace(/^\/+|\/+$/g, "");
  if (path.startsWith("accept/")) return redirect(`/invite/${path.slice("accept/".length)}`, {}, 301);
  const table: Record<string, string> = {
    "": "/login", login: "/login", register: "/register",
    "2fa": "/2fa", enroll: "/enroll", logout: "/login",
    "passkey/begin": "/login", "passkey/complete": "/login",
  };
  return redirect(table[path] ?? "/login", {}, 301);
}

/** The M1 console URLs, permanently moved (ADR 0024). */
export function legacyAdminRedirect({ rest = "" }: Pick<ConsoleParams, "rest"> = {}) {
  const path = String(rest || "").replace(/^\/+|\/+$/g, "");
  if (path === "" || path === "dashboard" || path === "artefacts" || path.startsWith("artefacts/")) return redirect("/app", {}, 301);
  if (path === "invite" || path === "users" || path.startsWith("users/")) return redirect("/admin/users", {}, 301);
  if (path === "settings" || path.startsWith("settings/")) return redirect("/admin/settings", {}, 301);
  if (path === "keys" || path.startsWith("keys/")) return redirect("/settings/keys", {}, 301);
  if (path === "account" || path.startsWith("account/")) return redirect("/settings", {}, 301);
  return redirect("/app", {}, 301);
}

// ---- the public auth pages ----

/** Handle the auth pages: /login, /register, /invite/<token>, /2fa, /enroll, /logout and the
 *  /passkey JSON ceremonies. `params` carries the router's groups (action | token | op). */
export function handleAuth(request: Request, ctx: AuthContext, params: AuthParams = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const method = request.method.toUpperCase();
    const op = params.token ? `accept/${params.token}`
      : params.op ? `passkey/${params.op}`
      : String(params.action || "login");
    const active = yield* current(request, ctx);

    if (op === "logout") {
      if (!active) return redirect("/login", { "Set-Cookie": expiredCookie(ctx) });
      if (method !== "POST") return page(messageView({ title: "That method is not allowed.", operator: ctx.operator }), 405);
      return yield* Effect.gen(function* () {
        yield* readValues(request, active.session);
        yield* ctx.store.sessions.destroy(active.session.id);
        return redirect("/login", { "Set-Cookie": expiredCookie(ctx) });
      }).pipe(Effect.catch(error => {
        const info = errorInfo(error);
        return Effect.succeed(page(messageView({ title: info.message, operator: ctx.operator }), info.status));
      }));
    }

    if (op.startsWith("accept/")) {
      return yield* handleAccept(request, ctx, method, decodeURIComponent(op.slice("accept/".length)));
    }

    if (op === "login") {
      if (method === "GET") {
        if (active && !active.session.pending2fa) return redirect("/app");
        if ((yield* ctx.auth.userCount()) === 0) return redirect("/register");
        return page(loginView({ operator: ctx.operator }));
      }
      if (method !== "POST") return page(messageView({ title: "That method is not allowed.", operator: ctx.operator }), 405);
      const parsed = yield* Effect.result(readValues(request));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(loginView({ error: info.message, operator: ctx.operator }), info.status);
      }
      const values = parsed.success;
      return yield* ctx.auth.login(values).pipe(
        Effect.map(result => redirect(nextFactor(result), { "Set-Cookie": cookieFor(ctx, result.session) })),
        Effect.catch(error => {
          const info = errorInfo(error, "Incorrect email or password.");
          return Effect.succeed(page(loginView({ error: info.message, email: values.email, operator: ctx.operator }), info.status));
        }),
      );
    }

    if (op === "register") {
      if (method === "GET") {
        if (active && !active.session.pending2fa) return redirect("/app");
        if (!(yield* ctx.auth.bootstrapAllowed())) return redirect("/login");
        return page(registerView({ operator: ctx.operator }));
      }
      if (method !== "POST") return page(messageView({ title: "That method is not allowed.", operator: ctx.operator }), 405);
      const parsed = yield* Effect.result(readValues(request));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(registerView({ error: info.message, operator: ctx.operator }), info.status);
      }
      const values = parsed.success;
      return yield* ctx.auth.registerOwner(values).pipe(
        Effect.map(result => redirect("/enroll", { "Set-Cookie": cookieFor(ctx, result.session) })),
        Effect.catch(error => {
          const info = errorInfo(error);
          return Effect.succeed(page(registerView({ error: info.message, values, operator: ctx.operator }), info.status));
        }),
      );
    }

    if (op === "enroll") {
      if (!active) return redirect("/login");
      if (!active.session.pending2fa) return redirect("/app");
      if (method === "GET") {
        return yield* ctx.auth.beginTotpEnroll(active.user).pipe(
          Effect.map(setup => page(enrollView({ ...setup, csrf: active.session.csrf, operator: ctx.operator }))),
          Effect.catch(error => Effect.map(internalError(error), info =>
            page(messageView({ title: info.message, operator: ctx.operator }), info.status))),
        );
      }
      if (method !== "POST") return page(messageView({ title: "That method is not allowed.", operator: ctx.operator }), 405);
      const parsed = yield* Effect.result(readValues(request, active.session));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(messageView({ title: info.message, operator: ctx.operator }), info.status);
      }
      const values = parsed.success;
      return yield* Effect.gen(function* () {
        const lock = yield* ctx.auth.lockState(active.user.email);
        if (lock.locked) return page(messageView({ title: LOCKED_MESSAGE, operator: ctx.operator }), 429);
        const confirmed = yield* ctx.auth.confirmTotpEnroll(active.user, values.code);
        if (!confirmed) {
          const state = yield* ctx.auth.loginFail(active.user.email);
          const setup = yield* ctx.auth.beginTotpEnroll(active.user);
          const locked = state.locked;
          return page(enrollView({
            ...setup,
            csrf: active.session.csrf,
            operator: ctx.operator,
            error: locked ? LOCKED_MESSAGE : "The code is not correct. Check your device clock and try again.",
          }), locked ? 429 : 401);
        }
        yield* ctx.auth.loginReset(active.user.email);
        const session = yield* ctx.auth.elevate(active.session);
        return redirect("/app", { "Set-Cookie": cookieFor(ctx, session) });
      }).pipe(Effect.catch(error => {
        const info = errorInfo(error);
        return Effect.succeed(page(messageView({ title: info.message, operator: ctx.operator }), info.status));
      }));
    }

    if (op === "2fa") {
      if (!active) return redirect("/login");
      if (!active.session.pending2fa) return redirect("/app");
      if (!active.user.totpSecretSealed) return redirect("/enroll");
      if (method === "GET") {
        return page(twoFaView({ csrf: active.session.csrf, hasPasskey: active.user.passkeys.length > 0, operator: ctx.operator }));
      }
      if (method !== "POST") return page(messageView({ title: "That method is not allowed.", operator: ctx.operator }), 405);
      const parsed = yield* Effect.result(readValues(request, active.session));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(messageView({ title: info.message, operator: ctx.operator }), info.status);
      }
      const values = parsed.success;
      return yield* Effect.gen(function* () {
        const lock = yield* ctx.auth.lockState(active.user.email);
        if (lock.locked) {
          return page(twoFaView({ csrf: active.session.csrf, hasPasskey: active.user.passkeys.length > 0, error: LOCKED_MESSAGE, operator: ctx.operator }), 429);
        }
        const valid = yield* ctx.auth.verifyTotp(active.user, values.code);
        if (!valid) {
          const state = yield* ctx.auth.loginFail(active.user.email);
          const info = state.locked
            ? errorInfo({ code: "locked", message: LOCKED_MESSAGE })
            : errorInfo({ code: "invalid-2fa", message: "The code is not correct. Try again." });
          return page(twoFaView({
            csrf: active.session.csrf,
            hasPasskey: active.user.passkeys.length > 0,
            error: info.message,
            operator: ctx.operator,
          }), info.status);
        }
        yield* ctx.auth.loginReset(active.user.email);
        const session = yield* ctx.auth.elevate(active.session);
        return redirect("/app", { "Set-Cookie": cookieFor(ctx, session) });
      }).pipe(Effect.catch(error => {
        const info = errorInfo(error);
        return Effect.succeed(page(messageView({ title: info.message, operator: ctx.operator }), info.status));
      }));
    }

    if (op === "passkey/begin") {
      if (method !== "POST") return jsonError(fail("method", "That method is not allowed."));
      if (!active) return jsonError(fail("unauthorized", "Sign-in is required."));
      if (!active.session.pending2fa) return jsonError(fail("already-authenticated", "This session is already verified."));
      return yield* Effect.gen(function* () {
        const body = yield* readFields(request);
        yield* requireCsrf(active.session, body.csrf);
        const lock = yield* ctx.auth.lockState(active.user.email);
        if (lock.locked) return yield* Effect.fail(fail("locked", LOCKED_MESSAGE));
        if (!active.user.passkeys.length) return yield* Effect.fail(fail("no-passkeys", "No passkey is enrolled for this account."));
        const begun = yield* ctx.webauthn.beginAuthentication({
          userId: active.user.id,
          userName: active.user.email,
          displayName: active.user.name || active.user.email,
          rpId: ctx.rpId,
          origin: ctx.requestOrigin,
          rpName: ctx.rpName,
        });
        return json({ ok: true, ...begun });
      }).pipe(Effect.catch(error => Effect.succeed(jsonError(error, "Passkey sign-in failed."))));
    }

    if (op === "passkey/complete") {
      if (method !== "POST") return jsonError(fail("method", "That method is not allowed."));
      if (!active) return jsonError(fail("unauthorized", "Sign-in is required."));
      if (!active.session.pending2fa) return jsonError(fail("already-authenticated", "This session is already verified."));
      return yield* Effect.gen(function* () {
        const body = yield* readFields(request);
        // The one-shot WebAuthn challenge is the CSRF-equivalent proof; still accept and
        // validate the session token when the browser sends it.
        if (body.csrf !== undefined) yield* requireCsrf(active.session, body.csrf);
        const lock = yield* ctx.auth.lockState(active.user.email);
        if (lock.locked) return yield* Effect.fail(fail("locked", LOCKED_MESSAGE));
        yield* ctx.webauthn.completeAuthentication({
          token: body.token,
          credential: body.credential,
          rpId: ctx.rpId,
          origin: ctx.requestOrigin,
        });
        yield* ctx.auth.loginReset(active.user.email);
        const session = yield* ctx.auth.elevate(active.session);
        return json({ ok: true }, 200, { "Set-Cookie": cookieFor(ctx, session) });
      }).pipe(Effect.catch(error => Effect.gen(function* () {
        if (isPasskeyProofFailure(error)) {
          const failed = yield* Effect.result(ctx.auth.loginFail(active.user.email));
          if (Result.isFailure(failed)) return jsonError(failed.failure, "Passkey sign-in failed.");
          if (failed.success.locked) return jsonError(fail("locked", LOCKED_MESSAGE), "Passkey sign-in failed.");
        }
        return jsonError(error, "Passkey sign-in failed.");
      })));
    }

    // Passkey-first (ADR 0034): no session yet, so no CSRF token. The one-shot challenge proves
    // freshness, not which browser posted it: both endpoints require a same-origin JSON request
    // (the viewer's guard), which a cross-site form cannot forge. Begin is limited per client
    // address because it writes a pending row unauthenticated.
    if (op === "passkey/login/begin" || op === "passkey/login/complete") {
      if (method !== "POST") return jsonError(fail("method", "That method is not allowed."));
      if (request.headers.get("Origin") !== new URL(request.url).origin ||
        !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "forbidden" }, 403);
    }
    if (op === "passkey/login/begin") {
      return yield* Effect.gen(function* () {
        // ponytail: keyed per exact address, so one IPv6 /64 holder gets many buckets; key by /64 if abused.
        const limit = yield* ctx.limiter.hit(`passkey-login:${clientIp(request)}`, { limit: PASSKEY_LOGIN_LIMIT, windowMs: PASSKEY_LOGIN_WINDOW_MS });
        if (!limit.allowed) return yield* Effect.fail(fail("rate-limited", "Too many passkey sign-in attempts. Try again in a few minutes."));
        return json({ ok: true, ...yield* ctx.webauthn.beginLogin({ rpId: ctx.rpId, origin: ctx.requestOrigin }) });
      }).pipe(Effect.catch(error => Effect.succeed(jsonError(error, "Passkey sign-in failed."))));
    }

    if (op === "passkey/login/complete") {
      return yield* Effect.gen(function* () {
        const body = yield* readFields(request);
        const { user } = yield* ctx.webauthn.completeLogin({ token: body.token, credential: body.credential });
        const session = yield* ctx.auth.signInVerified(user, active?.session ?? null);
        return json({ ok: true }, 200, { "Set-Cookie": cookieFor(ctx, session) });
      }).pipe(Effect.catch(error => Effect.succeed(jsonError(error, "Passkey sign-in failed."))));
    }

    return page(messageView({ title: "Page not found", operator: ctx.operator }), 404);
  });
}

function handleAccept(request: Request, ctx: AuthContext, method: string, token: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const invite = yield* ctx.auth.findInvite(token);
    if (method === "GET") {
      if (!invite) return page(messageView({ title: "This invitation is not valid, or it has already been used.", operator: ctx.operator }), 410);
      return page(acceptView({ invite: { ...invite, token }, operator: ctx.operator }));
    }
    if (method !== "POST") return page(messageView({ title: "That method is not allowed.", operator: ctx.operator }), 405);
    const parsed = yield* Effect.result(readValues(request));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message, operator: ctx.operator }), info.status);
    }
    const values = parsed.success;
    return yield* ctx.auth.acceptInvite({ token, ...values }).pipe(
      Effect.map(result => redirect("/enroll", { "Set-Cookie": cookieFor(ctx, result.session) })),
      Effect.catch(error => {
        const info = errorInfo(error);
        return Effect.succeed(page(acceptView({
          invite: { ...(invite || {}), token, email: invite?.email || values.email },
          error: info.message,
          values,
          operator: ctx.operator,
        }), info.status));
      }),
    );
  });
}

// ---- the signed-in console ----

/** Handle /app, /settings and /admin — a fully authenticated session is the entry price;
 *  the areas gate themselves further (the platform area is the owner's and admins'). */
export function handleConsole(request: Request, ctx: ConsoleContext, { area = "app", rest = "" }: ConsoleParams = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const method = request.method.toUpperCase();
    const path = String(rest || "").replace(/^\/+|\/+$/g, "");
    const gate = yield* requireFull(request, ctx);
    if (gate.response !== null) return gate.response;
    const active = gate.active;

    if (area === "app") return yield* handleApp(request, ctx, active, method, path);
    if (area === "settings") return yield* handleSettings(request, ctx, active, method, path);
    if (area === "admin") return yield* handleAdminArea(request, ctx, active, method, path);
    return page(messageView({ title: "Page not found" }), 404);
  });
}

// ---- /app: the estate ----

function handleApp(request: Request, ctx: ConsoleContext, active: CurrentSession, method: string, path: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const me = () => ctx.auth.meView(active.user, active.session.csrf);

    if (path === "") {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      return yield* estateOf(ctx, active.user.id).pipe(
        Effect.map(estate => page(appHomeView({ me: me(), estate }))),
        Effect.catch(error => Effect.map(internalError(error), info =>
          page(messageView({ title: info.message }), info.status))),
      );
    }

    // A member's invitation (colleagues join as members; managers get the role choice at
    // /admin/users). The link renders once, in place — a redirect would drop it.
    if (path === "invite") {
      if (method !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
      const parsed = yield* Effect.result(readValues(request, active.session));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(messageView({ title: info.message }), info.status);
      }
      const values = parsed.success;
      return yield* Effect.gen(function* () {
        const role = actorCanManage(active.user) ? values.role : "member";
        const result = yield* ctx.auth.invite({ email: values.email, role: role || "member", invitedBy: active.user.id });
        return page(appHomeView({
          me: me(),
          estate: yield* estateOf(ctx, active.user.id),
          inviteLink: result.link,
          notice: "The invitation was created and sent.",
        }));
      }).pipe(Effect.catch(error => Effect.gen(function* () {
        const info = errorInfo(error);
        return page(appHomeView({
          me: me(),
          estate: yield* estateOf(ctx, active.user.id),
          error: info.message,
        }), info.status);
      })));
    }

    if (path === "folders/new") {
      if (!["GET", "POST"].includes(method)) return page(messageView({ title: "That method is not allowed." }), 405);
      const estate = yield* estateOf(ctx, active.user.id);
      let values: FormValues = {};
      return yield* Effect.gen(function* () {
        if (method === "POST") {
          values = formValues(yield* readForm(request));
          yield* requireCsrf(active.session, values.csrf);
          const name = String(values.name ?? "").trim();
          if (!name) return yield* Effect.fail(fail("invalid-title", "A folder name is required."));
          const folder = yield* ctx.folders.create({ ownerId: active.user.id, name });
          yield* ctx.auth.audit("user", active.user.id, "folder.create", { detail: { folder: folder.id } });
          return redirect(`/app/f/${folder.slug ?? folder.id}`);
        }
        return page(appFolderNewView({ me: me(), estate }));
      }).pipe(Effect.catch(error => {
        const info = errorInfo(error, "The folder could not be created.");
        return Effect.succeed(page(appFolderNewView({ me: me(), estate, values, error: info.message }), info.status));
      }));
    }

    if (path === "new") {
      if (method === "GET") {
        return yield* Effect.gen(function* () {
          // ?folder=<ref> preselects the parent folder (the tree's + menu deep-links here).
          const preselect = new URL(request.url).searchParams.get("folder") || "";
          const estate = yield* estateOf(ctx, active.user.id);
          return page(appNewView({
            me: me(), estate,
            folders: flattenEstate(allRoots(estate), { need: "editor" }),
            values: preselect ? { folder: preselect } : {},
          }));
        }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
          page(messageView({ title: info.message }), info.status))));
      }
      return yield* artefactCreate(request, ctx, active);
    }

    // The two-word actions come first: alternation is first-match, and `share` would otherwise
    // claim the prefix of `share-revoke` and leave the rest to fail the anchor.
    const folderMatch = /^f\/(?<ref>[A-Za-z0-9-]+)(?:\/(?<action>name|rename|alias|move|subfolder|share-revoke|share|grant-revoke|grant|delete))?$/.exec(path);
    if (folderMatch?.groups) return yield* folderPane(request, ctx, active, method, folderMatch.groups.ref, folderMatch.groups.action || "");

    const artefactMatch = /^a\/(?<ref>[A-Za-z0-9-]+)(?:\/(?<action>publish|meta|rename|password|alias|move|view|preview|share-revoke|share|duplicate|restore|delete|download))?$/.exec(path);
    if (artefactMatch?.groups) return yield* artefactPane(request, ctx, active, method, artefactMatch.groups.ref, artefactMatch.groups.action || "");

    return page(messageView({ title: "Page not found" }), 404);
  });
}

/** GET/POST /app/new — paste a document, choose (or found) a folder, set a gate password of
 *  ANY length (ADR 0011: the eight-character floor is a rule of the write API, not of the
 *  owner's console path), and record retired paths. A real artefact can be the contract's full
 *  1.5 MiB, so this route reads its body at 2 MiB. */
function artefactCreate(request: Request, ctx: ConsoleContext, active: CurrentSession): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const estate = yield* estateOf(ctx, active.user.id);
    const me = ctx.auth.meView(active.user, active.session.csrf);
    const parsed = yield* Effect.result(readValues(request, active.session, 2 * 1024 * 1024));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    return yield* Effect.gen(function* () {
      const title = String(values.title ?? "").trim();
      const slug = String(values.slug ?? "").trim();
      const htmlDoc = String(values.html ?? "");
      const retired = yield* validRetiredPaths(values.retiredPaths);
      if (!title) return yield* Effect.fail(fail("invalid-title", "A title is required."));
      if (!slug) return yield* Effect.fail(fail("invalid-slug", "A path (slug) is required."));
      if (!htmlDoc.trim()) return yield* Effect.fail(fail("invalid-content", "Paste the HTML document."));

      let folder: Folder | null;
      let prepared: object | undefined;
      const folderRef = String(values.folder ?? "").trim();
      if (folderRef) {
        folder = yield* writableFolder(ctx, active.user, folderRef);
        if (!folder) return yield* Effect.fail(fail("not-found", "no such folder"));
      } else if (String(values.newFolder ?? "").trim()) {
        prepared = yield* ctx.artifacts.prepare(htmlDoc, { gated: Boolean(values.password) });
        folder = yield* ctx.folders.create({
          ownerId: active.user.id,
          name: String(values.newFolder).trim(),
          slug: String(values.newFolderSlug ?? "").trim() || null,
        });
        yield* ctx.auth.audit("user", active.user.id, "folder.create", { detail: { folder: folder.id, slug: folder.slug } });
      } else {
        return yield* Effect.fail(fail("bad-action", "Choose a folder, or name a new one."));
      }

      const artifact = yield* ctx.artifacts.create({
        // What is published into a colleague's folder belongs to that colleague: the folder's
        // owner keeps their estate whole, and the acting user is recorded as the version's author.
        ownerId: folder.ownerId,
        folderId: folder.id,
        slug,
        title,
        lang: String(values.lang ?? "").trim() || "en",
        html: htmlDoc,
        ...(prepared ? { prepared } : {}),
        // Blank means no gate (secret-link only); any other length is the publisher's call.
        password: String(values.password ?? ""),
        authorType: "user",
        authorId: active.user.id,
      });
      yield* ctx.auth.audit("user", active.user.id, "artifact.create", {
        artifactId: artifact.id,
        detail: { artifact: artifact.id, slug: artifact.slug, folder: folder.id, owner: folder.ownerId },
      });
      for (const path of retired) {
        yield* ctx.artifacts.alias(path, artifact.id);
        yield* ctx.auth.audit("user", active.user.id, "artifact.alias", {
          artifactId: artifact.id,
          detail: { path, artifact: artifact.id },
        });
      }
      return redirect(`/app/a/${artifact.slug ?? artifact.id}`);
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error, "The artefact could not be published.");
      return Effect.succeed(page(appNewView({
        me, estate, folders: flattenEstate(allRoots(estate), { need: "editor" }), error: info.message, values,
      }), info.status));
    }));
  });
}

/** /app/f/<ref>[/<action>] — one folder: GET renders the pane; the actions change its display
 *  name, its friendly path, its retired paths, its parent (move), found subfolders, the visitor
 *  shares of the folder and the colleagues let into it, or delete it with everything in it (ADR 0038). Move
 *  answers JSON to the tree's drag-and-drop and PRGs a plain form (ADR 0025). Every action asks
 *  `access.may` first.
 *
 *  The whole pane — folder row, shares, grants, statistics — is re-read on each render, so a
 *  rename, a revoke or a colleague's parallel change shows on the page that reports it. */
function folderPane(request: Request, ctx: ConsoleContext, active: CurrentSession, method: string, ref: string, action: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const found = yield* readableFolder(ctx, active.user, ref);
    if (!found) return page(messageView({ title: "Page not found" }), 404);
    const me = ctx.auth.meView(active.user, active.session.csrf);
    const render: ScreenRender = (extra = {}, status = 200) => Effect.gen(function* () {
      // A folder deleted meanwhile (a double-click on delete, a colleague's action racing the
      // owner's deletion) has no pane left to show: the same 404 as an unknown ref.
      const folder = yield* ctx.folders.byId(found.id);
      if (!folder) return page(messageView({ title: "Page not found" }), 404);
      const caps = yield* standingOf(ctx, active.user, folderSubject(folder));
      const estate = yield* estateOf(ctx, active.user.id);
      const node = findFolderNode(allRoots(estate), folder.id);
      const shares = caps.manage ? (yield* ctx.shares.listFor({ actorId: active.user.id, kind: "folder", targetId: folder.id })) : [];
      const analytics = yield* summaryFor(ctx, active.user, "folder", folder.id, caps.manage);
      return page(folderPaneView({
        me,
        estate,
        caps,
        folder: {
          id: folder.id, ref: folder.slug ?? folder.id, slug: folder.slug, path: ctx.folders.path(folder),
          displayName: node?.name || (yield* ctx.folders.name(folder)) || folder.slug || folder.id,
          role: caps.role,
          ownerName: folder.ownerId === active.user.id ? "" : (yield* displayName(ctx, folder.ownerId)),
          topLevel: (folder.parentId ?? null) === null,
          artefacts: node?.artefacts ?? [],
          children: node?.children ?? [],
          subtreeArtefacts: node ? countArtefacts(node) : 0,
          parentName: node?.parentId ? (findFolderNode(allRoots(estate), node.parentId)?.name ?? "") : "",
        },
        moveTargets: caps.own ? flattenEstate(estate.mine, { skip: folder.id }) : [],
        folderContents: caps.own ? yield* ctx.folders.contents(folder.id) : null,
        aliases: yield* ctx.folders.aliasesFor(folder.id),
        shares,
        shareStats: statsByShare(analytics),
        grants: caps.own ? (yield* ctx.access.grants({ actorId: active.user.id, folderId: folder.id })) : [],
        analytics,
        expiryDefault: dayStamp(Date.now() + SHARE_DEFAULT_DAYS * DAY_MS),
        expiryMax: dayStamp(Date.now() + SHARE_MAX_DAYS * DAY_MS),
        ...extra,
      }), status);
    });

    if (!action) {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      return yield* render();
    }
    if (method !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const isJson = (request.headers.get("content-type") || "").includes("application/json");
    const parsed = yield* Effect.result(Effect.gen(function* () {
      const values = isJson ? yield* readFields(request) : formValues(yield* readForm(request));
      yield* requireCsrf(active.session, values.csrf);
      return values;
    }));
    if (Result.isFailure(parsed)) {
      if (isJson) return jsonError(parsed.failure);
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    const folder = found;
    return yield* Effect.gen(function* () {
      if (action === "name") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "write");
        const name = String(values.name ?? "").trim();
        if (!name) return yield* Effect.fail(fail("invalid-title", "A name is required."));
        yield* ctx.folders.setName(folder.id, name);
        yield* ctx.auth.audit("user", active.user.id, "folder.rename", { detail: { folder: folder.id, name } });
        return yield* render({ notice: "The name is saved." });
      }
      if (action === "rename") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "write");
        const slug = String(values.slug ?? "").trim();
        if (!slug) return yield* Effect.fail(fail("invalid-slug", "A path (slug) is required."));
        yield* ctx.folders.rename(folder.id, slug);
        yield* ctx.auth.audit("user", active.user.id, "folder.rename", { detail: { folder: folder.id, slug } });
        return redirect(`/app/f/${slug}`);
      }
      if (action === "alias") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "write");
        const paths = yield* validRetiredPaths(values.paths);
        if (!paths.length) return yield* Effect.fail(fail("bad-action", "List at least one path."));
        for (const p of paths) {
          yield* ctx.folders.alias(p, folder.id);
          yield* ctx.auth.audit("user", active.user.id, "folder.alias", { detail: { path: p, folder: folder.id } });
        }
        return yield* render({ notice: `${paths.length} retired path${paths.length === 1 ? "" : "s"} recorded.` });
      }
      if (action === "subfolder") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "write");
        const name = String(values.name ?? "").trim();
        if (!name) return yield* Effect.fail(fail("invalid-title", "A name is required."));
        // A subfolder of a colleague's folder is theirs, like everything else published there.
        const child = yield* ctx.folders.create({ ownerId: folder.ownerId, name, parentId: folder.id });
        yield* ctx.auth.audit("user", active.user.id, "folder.create", { detail: { folder: child.id, parent: folder.id, owner: folder.ownerId } });
        return redirect(`/app/f/${child.slug ?? child.id}`);
      }
      if (action === "move") {
        // The owner's alone: a move carries the folder across access boundaries, which is a
        // decision about who may read it — never an editor's to make.
        yield* requireMay(ctx, active.user, folderSubject(folder), "own");
        const to = String(values.parent ?? "").trim();
        const parent = to === "" || to === "root" ? null : (yield* ownFolder(ctx, active.user, to));
        if (to !== "" && to !== "root" && !parent) return yield* Effect.fail(fail("not-found", "no such folder"));
        yield* ctx.folders.setParent(folder.id, parent?.id ?? null);
        yield* ctx.auth.audit("user", active.user.id, "folder.move", { detail: { folder: folder.id, parent: parent?.id ?? null } });
        if (isJson) return json({ ok: true });
        return yield* render({ notice: parent ? `Moved under ${(yield* ctx.folders.name(parent)) || parent.slug || parent.id}.` : "Moved to the top level." });
      }
      if (action === "share") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "manage");
        if ((folder.parentId ?? null) !== null) {
          return yield* Effect.fail(fail("bad-action", "A visitor share covers a top-level folder and everything inside it. Share the folder at the top of this branch."));
        }
        const form = yield* shareForm(values);
        const share = yield* ctx.shares.create({ actorId: active.user.id, kind: "folder", targetId: folder.id, ...form });
        return yield* render({ notice: shareNotice(share, form.sendMail) });
      }
      if (action === "share-revoke") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "manage");
        const shareId = String(values.shareId ?? "").trim();
        if (!shareId) return yield* Effect.fail(fail("bad-action", "Which share?"));
        if (!(yield* ctx.shares.revoke({ actorId: active.user.id, id: shareId }))) return yield* Effect.fail(fail("not-found", "That share is already gone."));
        return yield* render({ notice: "Share revoked. New requests can no longer open it." });
      }
      if (action === "grant") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "own");
        const email = String(values.email ?? "").trim().toLowerCase();
        const role = String(values.role ?? "").trim();
        if (!EMAIL_SHAPE.test(email)) return yield* Effect.fail(fail("bad-email", "Enter the colleague's e-mail address."));
        if (!GRANT_ROLES.includes(role)) return yield* Effect.fail(fail("bad-role", "Choose viewer, editor or manager."));
        // An exact address, looked up once: the console never lists or searches accounts.
        const colleague = yield* ctx.store.users.byEmail(email);
        if (!colleague || colleague.status !== "active") return yield* Effect.fail(fail("bad-email", "That address is not an active account here."));
        if (colleague.id === active.user.id) return yield* Effect.fail(fail("bad-action", "This folder is already yours."));
        yield* ctx.access.grant({ actorId: active.user.id, folderId: folder.id, userId: colleague.id, role });
        return yield* render({ notice: `${colleague.name || colleague.email} can now ${role === "viewer" ? "read" : role === "editor" ? "publish in" : "manage"} this folder.` });
      }
      if (action === "grant-revoke") {
        yield* requireMay(ctx, active.user, folderSubject(folder), "own");
        const userId = String(values.userId ?? "").trim();
        if (!userId) return yield* Effect.fail(fail("bad-action", "Which colleague?"));
        yield* ctx.access.revoke({ actorId: active.user.id, folderId: folder.id, userId });
        return yield* render({ notice: "Direct access removed. Inherited access, if any, still applies." });
      }
      if (action === "delete") {
        // The owner's alone, like a move: deletion also ends colleague grants and visitor shares. The
        // owner types the folder's label and posts the snapshot of the counts they were shown (ADR 0038);
        // the model writes the folder.delete audit row in the deletion's batch.
        yield* requireMay(ctx, active.user, folderSubject(folder), "own");
        const label = (yield* ctx.folders.name(folder)) || folder.slug || folder.id;
        if (!values.snapshot || String(values.confirm ?? "").trim() !== label.trim()) {
          return yield* Effect.fail(fail("bad-action", "Type the folder's name exactly to confirm its permanent deletion."));
        }
        const parent = folder.parentId ? yield* ctx.folders.byId(folder.parentId) : null;
        yield* ctx.folders.remove(folder.id, { snapshot: String(values.snapshot), actorId: active.user.id });
        const url = parent ? `/app/f/${parent.slug ?? parent.id}` : "/app";
        return isJson ? json({ url }) : redirect(url);
      }
      return yield* Effect.fail(fail("not-found", "Page not found."));
    }).pipe(Effect.catch(error => {
      if (isJson) return Effect.succeed(jsonError(error, action === "delete" ? "The folder could not be deleted." : "The folder could not be moved."));
      const info = errorInfo(error, "The folder could not be changed.");
      return render({ error: info.message }, info.status);
    }));
  });
}

/** Every artefact under a folder node, its subfolders included. */
function countArtefacts(node: EstateTreeNode): number {
  return node.artefacts.length + (node.children ?? []).reduce((n, child) => n + countArtefacts(child), 0);
}

/** Depth-first lookup of one folder node inside the nested estate. */
function findFolderNode(nodes: EstateTreeNode[], id: string): EstateTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findFolderNode(node.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/** /app/a/<ref>[/<action>] — one artefact: GET renders the pane; GET …/preview serves the live
 *  document to the people allowed to read it; the actions publish a new version, edit
 *  title/language, rename the path, set or clear the gate password, record retired paths, move
 *  it, and hand out or revoke its visitor shares. Every action asks `access.may` first.
 *
 *  The artefact row is re-read on every render: after a publish, a gate change or a retitle the
 *  pane must report what the artefact now IS, not what it was when the request came in. */
function artefactPane(request: Request, ctx: ConsoleContext, active: CurrentSession, method: string, ref: string, action: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const found = yield* readableArtifact(ctx, active.user, ref, action === "delete");
    if (!found) return page(messageView({ title: "Page not found" }), 404);
    const me = ctx.auth.meView(active.user, active.session.csrf);
    const render: ScreenRender = (extra = {}, status = 200) => Effect.gen(function* () {
      const artifact = (yield* ctx.artifacts.byId(found.id)) ?? found;
      const caps = yield* standingOf(ctx, active.user, artifactSubject(artifact));
      const estate = yield* estateOf(ctx, active.user.id);
      const shares = caps.manage ? (yield* ctx.shares.listFor({ actorId: active.user.id, kind: "artifact", targetId: artifact.id })) : [];
      const analytics = yield* summaryFor(ctx, active.user, "artifact", artifact.id, caps.manage);
      const roots = allRoots(estate);
      const destinations = flattenEstate(roots, { need: "editor" });
      const folderNode = artifact.folderId ? findFolderNode(roots, artifact.folderId) : null;
      return page(artefactPaneView({
        me,
        estate,
        caps,
        duplicateFolders: destinations,
        // An artefact moves only inside its owner's estate (ADR 0025), and only where the acting
        // person may publish: those two rules are the whole list.
        moveTargets: caps.write ? destinations.filter(folder => folder.ownerId === artifact.ownerId) : [],
        artifact: {
          id: artifact.id,
          ref: artifact.slug ?? artifact.id,
          slug: artifact.slug,
          lang: artifact.lang,
          gated: ctx.artifacts.gated(artifact),
          path: ctx.artifacts.path(artifact),
          currentVersion: artifact.currentVersion,
          folderId: artifact.folderId,
          role: caps.role,
          ownerName: artifact.ownerId === active.user.id ? "" : (yield* displayName(ctx, artifact.ownerId)),
          displayTitle: (yield* ctx.artifacts.title(artifact)) || artifact.slug || artifact.id,
        },
        folder: folderNode ? { ref: folderNode.ref, name: folderNode.name } : null,
        aliases: yield* ctx.artifacts.aliasesFor(artifact.id),
        versions: yield* ctx.artifacts.versions(artifact.id),
        shares,
        shareStats: statsByShare(analytics),
        analytics,
        expiryDefault: dayStamp(Date.now() + SHARE_DEFAULT_DAYS * DAY_MS),
        expiryMax: dayStamp(Date.now() + SHARE_MAX_DAYS * DAY_MS),
        ...extra,
      }), status);
    });

    if (!action) {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      return yield* render();
    }

    if (action === "view") {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      if (!ctx.artifacts.live(found)) return page(messageView({ title: "Nothing is published yet." }), 404);
      return page(artefactReaderView({
        me, estate: yield* estateOf(ctx, active.user.id),
        viewer: yield* viewerDescriptor(request, ctx, {
          artifact: found, source: { kind: "console", artifactId: found.id },
          publicUrl: ctx.artifacts.path(found), gated: false,
        }),
        artifact: {
          id: found.id, ref: found.slug ?? found.id,
          displayTitle: (yield* ctx.artifacts.title(found)) || found.slug || found.id,
        },
      }));
    }

    // Preview remains a stable URL, now serving the same trusted viewer and opaque frame.
    if (action === "preview") {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      if (!ctx.artifacts.live(found)) return page(messageView({ title: "Nothing is published yet." }), 404);
      const viewer = yield* viewerDescriptor(request, ctx, {
        artifact: found, source: { kind: "console", artifactId: found.id },
        publicUrl: ctx.artifacts.path(found), gated: false,
      });
      return page(artifactViewerView({ title: viewer.title, viewer, me }));
    }

    if (action === "download") {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      const selected = new URL(request.url).searchParams.get("version");
      const version = selected === null ? found.currentVersion : Number(selected);
      if (!Number.isInteger(version) || version < 1) return jsonError(fail("bad-action", "Invalid version."));
      return yield* ctx.artifacts.document(found, version).pipe(
        Effect.map(document => new Response(document, { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${found.id}.html"`,
          "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        } })),
        Effect.catch(error => Effect.succeed(jsonError(error))),
      );
    }

    if (method !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const isJson = (request.headers.get("content-type") || "").includes("application/json");
    const parsed = yield* Effect.result(Effect.gen(function* () {
      const values = isJson ? yield* readFields(request) : formValues(yield* readForm(request, 2 * 1024 * 1024));
      yield* requireCsrf(active.session, values.csrf);
      return values;
    }));
    if (Result.isFailure(parsed)) {
      if (isJson) return jsonError(parsed.failure);
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    const artifact = found;
    const subject = artifactSubject(artifact);
    return yield* Effect.gen(function* () {
      if (action === "duplicate") {
        const result = yield* duplicateReadable(ctx, active, artifact, values);
        return isJson ? json(result) : redirect(result.url);
      }
      if (action === "restore") {
        yield* requireMay(ctx, active.user, subject, "write");
        const version = Number(values.version);
        if (!Number.isInteger(version) || version < 1) return yield* Effect.fail(fail("bad-action", "Choose a retained version."));
        yield* ctx.artifacts.restore({ artifactId: artifact.id, version, authorType: "user", authorId: active.user.id });
        yield* ctx.auth.audit("user", active.user.id, "artifact.restore", { artifactId: artifact.id, detail: { sourceVersion: version } });
        return isJson ? json({ ok: true }) : (yield* render({ notice: "The retained version was restored as a new version." }));
      }
      if (action === "delete") {
        yield* requireMay(ctx, active.user, subject, "own");
        if (values.confirm !== "delete") return yield* Effect.fail(fail("bad-action", "Confirm permanent deletion of this artefact and its application data."));
        yield* ctx.artifacts.remove(artifact.id, { authorId: active.user.id }).pipe(
          Effect.onExit(result => {
            const error = Exit.isFailure(result) ? asCodeError(Cause.squash(result.cause)) : null;
            const detail = error
              ? { outcome: error.code === "purge-failed" ? "withdrawn" : "failed", code: error.code || "internal" }
              : { outcome: "purged" };
            return ctx.auth.audit("user", active.user.id, "artifact.delete", { artifactId: artifact.id, detail });
          }),
        );
        return isJson ? json({ url: "/app" }) : redirect("/app");
      }
      if (action === "publish") {
        yield* requireMay(ctx, active.user, subject, "write");
        const htmlDoc = String(values.html ?? "");
        if (!htmlDoc.trim()) return yield* Effect.fail(fail("invalid-content", "Paste the HTML document."));
        const note = String(values.note ?? "").trim() || null;
        const version = yield* ctx.artifacts.publish({
          artifactId: artifact.id, html: htmlDoc, authorType: "user", authorId: active.user.id, note,
        });
        yield* ctx.auth.audit("user", active.user.id, "artifact.publish", {
          artifactId: artifact.id,
          detail: { artifact: artifact.id, version: version.version, note },
        });
        return yield* render({ notice: "The new version is live at the same link." });
      }
      if (action === "meta") {
        yield* requireMay(ctx, active.user, subject, "write");
        const title = String(values.title ?? "").trim();
        if (!title) return yield* Effect.fail(fail("invalid-title", "A title is required."));
        yield* ctx.artifacts.setMeta(artifact.id, { title, lang: String(values.lang ?? "").trim() || artifact.lang });
        yield* ctx.auth.audit("user", active.user.id, "artifact.meta", { artifactId: artifact.id, detail: { artifact: artifact.id, title } });
        return yield* render({ notice: "Saved." });
      }
      if (action === "rename") {
        yield* requireMay(ctx, active.user, subject, "write");
        const slug = String(values.slug ?? "").trim();
        if (!slug) return yield* Effect.fail(fail("invalid-slug", "A path (slug) is required."));
        yield* ctx.artifacts.rename(artifact.id, slug);
        yield* ctx.auth.audit("user", active.user.id, "artifact.rename", { artifactId: artifact.id, detail: { artifact: artifact.id, slug } });
        return redirect(`/app/a/${slug}`);
      }
      if (action === "password") {
        yield* requireMay(ctx, active.user, subject, "write");
        const clearing = values.clear === "1";
        const password = String(values.password ?? "");
        if (!clearing && !password) return yield* Effect.fail(fail("bad-action", "Type a password, or tick the box to remove the gate."));
        yield* ctx.artifacts.setPassword(artifact.id, clearing ? null : password);
        yield* ctx.auth.audit("user", active.user.id, "artifact.password", {
          artifactId: artifact.id,
          detail: { artifact: artifact.id, gate: clearing ? "cleared" : "set" },
        });
        return yield* render({ notice: clearing ? "The password is removed — the artefact stays private to signed-in, authorized accounts." : "The password is saved." });
      }
      if (action === "alias") {
        yield* requireMay(ctx, active.user, subject, "write");
        const paths = yield* validRetiredPaths(values.paths);
        if (!paths.length) return yield* Effect.fail(fail("bad-action", "List at least one path."));
        for (const p of paths) {
          yield* ctx.artifacts.alias(p, artifact.id);
          yield* ctx.auth.audit("user", active.user.id, "artifact.alias", {
            artifactId: artifact.id,
            detail: { path: p, artifact: artifact.id },
          });
        }
        return yield* render({ notice: `${paths.length} retired path${paths.length === 1 ? "" : "s"} recorded.` });
      }
      if (action === "move") {
        // Write at the source, write at the destination, and the same owner on both sides.
        yield* requireMay(ctx, active.user, subject, "write");
        const to = String(values.folder ?? "").trim();
        if (!to) return yield* Effect.fail(fail("bad-action", "Choose the folder to move to."));
        const target = yield* writableFolder(ctx, active.user, to);
        if (!target) return yield* Effect.fail(fail("not-found", "no such folder"));
        if (target.ownerId !== artifact.ownerId) return yield* Effect.fail(fail("forbidden", "An artefact stays inside its owner's estate."));
        yield* ctx.artifacts.moveTo(artifact.id, target.id);
        yield* ctx.auth.audit("user", active.user.id, "artifact.move", {
          artifactId: artifact.id,
          detail: { artifact: artifact.id, folder: target.id },
        });
        if (isJson) return json({ ok: true });
        return yield* render({ notice: `Moved to ${(yield* ctx.folders.name(target)) || target.slug || target.id}.` });
      }
      if (action === "share") {
        yield* requireMay(ctx, active.user, subject, "manage");
        const form = yield* shareForm(values);
        const share = yield* ctx.shares.create({ actorId: active.user.id, kind: "artifact", targetId: artifact.id, ...form });
        return yield* render({ notice: shareNotice(share, form.sendMail) });
      }
      if (action === "share-revoke") {
        yield* requireMay(ctx, active.user, subject, "manage");
        const shareId = String(values.shareId ?? "").trim();
        if (!shareId) return yield* Effect.fail(fail("bad-action", "Which share?"));
        if (!(yield* ctx.shares.revoke({ actorId: active.user.id, id: shareId }))) return yield* Effect.fail(fail("not-found", "That share is already gone."));
        return yield* render({ notice: "Share revoked. New requests can no longer open it." });
      }
      return yield* Effect.fail(fail("not-found", "Page not found."));
    }).pipe(Effect.catch(error => {
      if (isJson) return Effect.succeed(jsonError(error, "The artefact could not be moved."));
      const info = errorInfo(error, "The artefact could not be changed.");
      return render({ error: info.message }, info.status);
    }));
  });
}

// ---- /settings: the account's own ----

function handleSettings(request: Request, ctx: ConsoleContext, active: CurrentSession, method: string, path: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const render: ScreenRender = (extra = {}, status = 200) => Effect.gen(function* () {
      return page(settingsView({
        me: ctx.auth.meView(active.user, active.session.csrf),
        ...yield* settingsEstate(request, ctx, active.user.id),
        passkeys: yield* ctx.webauthn.list(active.user.id),
        ...extra,
      }), status);
    }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
      page(messageView({ title: info.message }), info.status))));

    if (path === "") {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      return yield* render();
    }

    if (path === "profile") {
      if (method !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
      const parsed = yield* Effect.result(readValues(request, active.session));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(messageView({ title: info.message }), info.status);
      }
      const values = parsed.success;
      return yield* Effect.gen(function* () {
        const name = String(values.name ?? "").trim();
        if (!name) return yield* Effect.fail(fail("invalid-title", "A name is required."));
        yield* ctx.store.users.setName(active.user.id, name);
        yield* ctx.auth.audit("user", active.user.id, "user.profile", { detail: { name } });
        return redirect("/settings");
      }).pipe(Effect.catch(error => {
        const info = errorInfo(error);
        return render({ error: info.message }, info.status);
      }));
    }

    if (path === "password") {
      if (method !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
      const parsed = yield* Effect.result(readValues(request, active.session));
      if (Result.isFailure(parsed)) {
        const info = errorInfo(parsed.failure);
        return page(messageView({ title: info.message }), info.status);
      }
      const values = parsed.success;
      return yield* ctx.auth.changePassword(active.user, values.current, values.new, values.confirm).pipe(
        Effect.map(() => redirect("/settings")),
        Effect.catch(error => {
          const info = errorInfo(error);
          return render({ error: info.message }, info.status);
        }),
      );
    }

    if (path === "passkeys/begin") return yield* passkeyBegin(request, ctx, active);
    if (path === "passkeys/complete") return yield* passkeyComplete(request, ctx, active);
    if (path === "passkeys/remove") return yield* passkeyRemove(request, ctx, active, render);

    if (path === "keys" || path.startsWith("keys/")) {
      if (path === "keys") {
        if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
        return yield* keysScreen(ctx, active, {}, request);
      }
      return yield* keysMutation(request, ctx, active, path.slice("keys/".length));
    }

    return page(messageView({ title: "Page not found" }), 404);
  });
}

function passkeyBegin(request: Request, ctx: ConsoleContext, active: CurrentSession): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return jsonError(fail("method", "That method is not allowed."));
    return yield* Effect.gen(function* () {
      const body = yield* readFields(request);
      yield* requireCsrf(active.session, body.csrf);
      const begun = yield* ctx.webauthn.beginRegistration({
        userId: active.user.id,
        userName: active.user.email,
        displayName: active.user.name || active.user.email,
        rpId: ctx.rpId,
        origin: ctx.requestOrigin,
        rpName: ctx.rpName,
      });
      return json({ ok: true, ...begun });
    }).pipe(Effect.catch(error => Effect.succeed(jsonError(error, "Passkey enrollment failed."))));
  });
}

function passkeyComplete(request: Request, ctx: ConsoleContext, active: CurrentSession): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return jsonError(fail("method", "That method is not allowed."));
    return yield* Effect.gen(function* () {
      const body = yield* readFields(request);
      yield* requireCsrf(active.session, body.csrf);
      const passkey = yield* ctx.webauthn.completeRegistration({
        token: body.token,
        credential: body.credential,
        name: body.name,
      });
      return json({ ok: true, passkey: { id: passkey.id, name: passkey.name } });
    }).pipe(Effect.catch(error => Effect.succeed(jsonError(error, "Passkey enrollment failed."))));
  });
}

function passkeyRemove(request: Request, ctx: ConsoleContext, active: CurrentSession, render: ScreenRender): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const parsed = yield* Effect.result(readValues(request, active.session));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    return yield* Effect.gen(function* () {
      const removed = yield* ctx.webauthn.remove(active.user.id, values.passkeyId);
      if (!removed) return yield* Effect.fail(fail("not-found", "Passkey not found."));
      yield* ctx.auth.audit("user", active.user.id, "user.passkey_remove", { detail: { passkey: values.passkeyId } });
      return redirect("/settings");
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error);
      return render({ error: info.message }, info.status);
    }));
  });
}

// ---- /settings/keys ----

/** Render the keys screen (shared by the GET and the mint/rotate re-renders that carry the
 *  one-time plaintext). */
function keysScreen(ctx: ConsoleContext, active: CurrentSession, { status = 200, ...extra }: ScreenExtra & { status?: number } = {}, request?: Request): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    return page(keysView({
      me: ctx.auth.meView(active.user, active.session.csrf),
      ...yield* (request ? settingsEstate(request, ctx, active.user.id) : estateOf(ctx, active.user.id).pipe(Effect.map(estate => ({ estate })))),
      keys: yield* ctx.keys.list(active.user.id),
      artifacts: yield* ctx.artifacts.listByOwner(active.user.id),
      ...extra,
    }), status);
  }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
    page(messageView({ title: info.message }), info.status))));
}


/** CSRF-guarded key mutations, always scoped to the session user. Ownership stays the model's
 *  ruling (mint/rotate/revoke audit themselves); a miss renders as a flat 403 that never tells
 *  missing from someone else's key. Mint and rotate re-render with the plaintext in the notice —
 *  a redirect would have to carry the secret in the URL; revoke is a plain PRG. */
function keysMutation(request: Request, ctx: ConsoleContext, active: CurrentSession, action: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const parsed = yield* Effect.result(readValues(request, active.session));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    return yield* Effect.gen(function* () {
      if (action === "mint") {
        const kind = values.kind === "master" ? "master" : "artifact";
        const artifactId = kind === "artifact" ? String(values.artifactId ?? "").trim() : null;
        if (kind === "artifact" && !artifactId) return yield* Effect.fail(fail("bad-action", "Choose the artifact the key belongs to."));
        const scopes = kind === "master" ? "master" : ["read", "write", "read_write"].includes(values.scopes) ? values.scopes : "read";
        const result = yield* ctx.keys.mint({
          userId: active.user.id, kind, artifactId, scopes, label: null,
          can_read_content: kind === "master" && values.can_read_content === "1",
        });
        return yield* keysScreen(ctx, active, { secret: result.key });
      }

      if (action === "rotate") {
        const result = yield* ctx.keys.rotate(String(values.keyId ?? ""), active.user.id);
        if (!result) return yield* Effect.fail(fail("forbidden", "Key not found, or it is not yours."));
        return yield* keysScreen(ctx, active, { secret: result.key });
      }

      if (action === "revoke") {
        const revokedKey = yield* ctx.keys.revoke(String(values.keyId ?? ""), active.user.id);
        if (!revokedKey) return yield* Effect.fail(fail("forbidden", "Key not found, or it is not yours."));
        return redirect("/settings/keys");
      }

      return yield* Effect.fail(fail("not-found", "Page not found."));
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error, "The key request could not be processed.");
      return keysScreen(ctx, active, { error: info.message, status: info.status });
    }));
  });
}

// ---- /admin: the platform ----

function handleAdminArea(request: Request, ctx: ConsoleContext, active: CurrentSession, method: string, path: string): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (!actorCanManage(active.user)) {
      return page(messageView({ title: "This area runs the platform. It is the owner's and administrators'." }), 403);
    }
    const me = () => ctx.auth.meView(active.user, active.session.csrf);
    if (path === "reports" || /^reports\/[a-f0-9]{32}\/resolve$/.test(path)) {
      return yield* Effect.gen(function* () {
        if (path === "reports" && method === "GET") return page(reportsView({
          me: me(), estate: yield* estateOf(ctx, active.user.id), reports: yield* ctx.reports.list(),
        }));
        if (method !== "POST" || path === "reports") return page(messageView({ title: "That method is not allowed." }), 405);
        yield* readValues(request, active.session);
        const id = path.split("/")[1];
        if (!(yield* ctx.reports.resolve(id, active.user.id))) return yield* Effect.fail(fail("not-found", "Report is already resolved or unavailable."));
        yield* ctx.auth.audit("user", active.user.id, "report.resolve", { detail: { reportId: id } });
        return redirect("/admin/reports");
      }).pipe(Effect.catch(error => Effect.gen(function* () {
        const info = errorInfo(error);
        return page(reportsView({
          me: me(), estate: yield* estateOf(ctx, active.user.id), reports: yield* ctx.reports.list(), error: info.message,
        }), info.status);
      })));
    }

    if (path === "") {
      if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
      return yield* Effect.gen(function* () {
        const counts = yield* ctx.auth.counts();
        const pendingInvites = (yield* ctx.store.invites.pending()).length;
        const audit = yield* ctx.store.audit.recent(50);
        return page(adminHomeView({
          me: me(),
          estate: yield* estateOf(ctx, active.user.id),
          counts,
          pendingInvites,
          audit,
          // Platform-wide reading figures: counts and trends only. Who read what, and which
          // recipient it went to, stays on the folder and artefact panes of the people who own
          // the work — running the platform is not a licence to read over their shoulder.
          analytics: yield* ctx.analytics.platformSummary(),
        }));
      }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
        page(messageView({ title: info.message }), info.status))));
    }

    if (path === "users" || path.startsWith("users/")) {
      if (path === "users" && method === "GET") {
        return yield* Effect.gen(function* () {
          return page(usersView({
            me: me(),
            estate: yield* estateOf(ctx, active.user.id),
            users: yield* ctx.store.users.all(),
            invites: yield* ctx.store.invites.pending(),
          }));
        }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
          page(messageView({ title: info.message }), info.status))));
      }
      return yield* usersMutation(request, ctx, active, path === "users" ? "" : path.slice("users/".length));
    }

    // Platform settings (ADR 0018): the owner's alone — a platform-wide ruling, not a role
    // capability, so an Admin does not inherit it. Analytics retention is the same kind of
    // ruling: how long the platform remembers that anything was read at all.
    if (path === "settings" || path === "settings/retention" || path === "settings/mail" || path === "settings/analytics") {
      if (active.user.role !== "owner") return page(messageView({ title: "Only the platform owner can change settings." }), 403);
      if (path === "settings") {
        if (method !== "GET") return page(messageView({ title: "That method is not allowed." }), 405);
        return yield* platformSettingsScreen(ctx, active);
      }
      if (path === "settings/mail") return yield* mailFromMutation(request, ctx, active);
      if (path === "settings/analytics") return yield* analyticsRetentionMutation(request, ctx, active);
      return yield* retentionMutation(request, ctx, active);
    }

    return page(messageView({ title: "Page not found" }), 404);
  });
}

function usersMutation(request: Request, ctx: ConsoleContext, active: CurrentSession, routeAction = ""): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const parsed = yield* Effect.result(readValues(request, active.session));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    const render: ScreenRender = (extra = {}, status = 200) => Effect.gen(function* () {
      return page(usersView({
        me: ctx.auth.meView(active.user, active.session.csrf),
        estate: yield* estateOf(ctx, active.user.id),
        users: yield* ctx.store.users.all(),
        invites: yield* ctx.store.invites.pending(),
        ...extra,
      }), status);
    }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
      page(messageView({ title: info.message }), info.status))));

    return yield* Effect.gen(function* () {
      const action = routeAction || values.action || "invite";
      if (action === "invite") {
        const result = yield* ctx.auth.invite({ email: values.email, role: values.role, invitedBy: active.user.id });
        return yield* render({ inviteLink: result.link, notice: "The invitation was created and sent." });
      }

      if (action === "cancel-invite") {
        if (!values.inviteId) return yield* Effect.fail(fail("not-found", "Invitation not found."));
        yield* ctx.store.invites.cancel(values.inviteId);
        yield* ctx.auth.audit("user", active.user.id, "user.invite_cancel", { detail: { invite: values.inviteId } });
        return redirect("/admin/users");
      }

      const target = yield* ctx.store.users.byId(values.userId);
      if (!target) return yield* Effect.fail(fail("not-found", "User not found."));
      if (!ctx.auth.canManage(active.user, target)) return yield* Effect.fail(fail("forbidden", "You are not allowed to manage this user."));

      if (action === "role") {
        const role = values.role;
        if ((role !== "member" && role !== "admin" && role !== "owner") || !ctx.auth.canSetRole(active.user, target, role)) {
          return yield* Effect.fail(fail("forbidden", "That role change is not allowed."));
        }
        if (yield* ctx.auth.wouldOrphanOwners(target, { demoting: target.role === "owner" && role !== "owner" })) {
          return yield* Effect.fail(fail("forbidden", "The platform must keep at least one active owner."));
        }
        yield* ctx.store.users.setRole(target.id, role);
        yield* ctx.auth.audit("user", active.user.id, "user.role_change", { detail: { target: target.id, role } });
      } else if (action === "suspend" || action === "status") {
        const status = values.status || (values.suspend === "1" ? "suspended" : "active");
        if (status !== "active" && status !== "suspended") return yield* Effect.fail(fail("bad-action", "Unknown user status."));
        if (yield* ctx.auth.wouldOrphanOwners(target, { suspending: status === "suspended" })) {
          return yield* Effect.fail(fail("forbidden", "The platform must keep at least one active owner."));
        }
        yield* ctx.store.users.setStatus(target.id, status);
        if (status === "suspended") yield* ctx.store.sessions.destroyUser(target.id);
        yield* ctx.auth.audit("user", active.user.id, status === "suspended" ? "user.suspend" : "user.restore", { detail: { target: target.id } });
      } else {
        return yield* Effect.fail(fail("bad-action", "Unknown action."));
      }
      return redirect("/admin/users");
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error);
      return render({ error: info.message }, info.status);
    }));
  });
}

/** Render the platform settings screen (shared by the GET, the successful save and the failed one). */
function platformSettingsScreen(ctx: ConsoleContext, active: CurrentSession, { status = 200, ...extra }: ScreenExtra & { status?: number } = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    return page(platformSettingsView({
      me: ctx.auth.meView(active.user, active.session.csrf),
      estate: yield* estateOf(ctx, active.user.id),
      retention: yield* ctx.store.settings.retention(),
      analyticsRetention: yield* ctx.analytics.retention(),
      mailFrom: yield* ctx.store.settings.mailFrom(),
      ...extra,
    }), status);
  }).pipe(Effect.catch(error => Effect.map(internalError(error), info =>
    page(messageView({ title: info.message }), info.status))));
}

/** How many days of reading records the platform keeps. The model takes no actor — this route
 *  is the owner guard, and `handleAdminArea` has already refused everybody else. */
function analyticsRetentionMutation(request: Request, ctx: ConsoleContext, active: CurrentSession): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const parsed = yield* Effect.result(readValues(request, active.session));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    return yield* Effect.gen(function* () {
      const days = yield* ctx.analytics.setRetention(Number(values.days));
      yield* ctx.auth.audit("user", active.user.id, "platform.analytics_retention", { detail: { days } });
      return yield* platformSettingsScreen(ctx, active, { notice: `Reading records are kept for ${days} days.` });
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error, "Keep reading records for between 1 and 365 days.");
      return platformSettingsScreen(ctx, active, { error: info.message, status: info.status });
    }));
  });
}

function retentionMutation(request: Request, ctx: ConsoleContext, active: CurrentSession): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const parsed = yield* Effect.result(readValues(request, active.session));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    return yield* Effect.gen(function* () {
      const versions = yield* ctx.store.settings.setRetention(Number(values.retention));
      yield* ctx.auth.audit("user", active.user.id, "platform.retention", { detail: { versions } });
      return yield* platformSettingsScreen(ctx, active, { notice: `Retention is set to ${versions} versions.` });
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error, "Retention must be a whole number of versions, at least 1.");
      return platformSettingsScreen(ctx, active, { error: info.message, status: info.status });
    }));
  });
}

function mailFromMutation(request: Request, ctx: ConsoleContext, active: CurrentSession): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return page(messageView({ title: "That method is not allowed." }), 405);
    const parsed = yield* Effect.result(readValues(request, active.session));
    if (Result.isFailure(parsed)) {
      const info = errorInfo(parsed.failure);
      return page(messageView({ title: info.message }), info.status);
    }
    const values = parsed.success;
    return yield* Effect.gen(function* () {
      const from = yield* ctx.store.settings.setMailFrom(String(values.mailFrom ?? ""));
      yield* ctx.auth.audit("user", active.user.id, "platform.mail_from", { detail: { from } });
      return yield* platformSettingsScreen(ctx, active, { notice: `Sender address is set to ${from}.` });
    }).pipe(Effect.catch(error => {
      const info = errorInfo(error, "That sender address is not valid.");
      return platformSettingsScreen(ctx, active, { error: info.message, status: info.status });
    }));
  });
}
