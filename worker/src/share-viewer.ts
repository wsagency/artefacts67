// Visitor shares retain neutral responses for unknown, revoked, expired and out-of-scope links.
// Password-bearing shares release their wrap chain only after verification and live lockout
// checks. Passwordless shares use their persisted access policy (ADR 0027), not the ordinary
// artefact gate. No observation proof or ciphertext is attached before authorization.

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { clientIp, html, json, readJson } from "./http.js";
import { normalizePath } from "./paths.js";
import { folderIndexPage } from "./viewer.js";
import { artifactViewerView, viewerView } from "./views.js";
import {
  runtimeSession, viewerDescriptor, writableDestinations,
  type ArtifactRuntime, type RuntimeReadContext, type ViewerContext as DescriptorContext,
} from "./artifact-runtime.js";
import type { Artifact } from "./artifacts.js";
import type { Shares, VisitorShare } from "./shares.js";
import type { RateLimiter, RateResult } from "./ratelimit.js";
import type { RouteParams } from "./router.js";
import type { Audit } from "./store.js";
import { asCodeError, type CodeError } from "./types.js";

export type ShareViewerContext = DescriptorContext & Omit<RuntimeReadContext, "limiter"> & {
  shares: Pick<Shares, "resolve" | "contents" | "verifyPassword" | "gatePayload">;
  artifactRuntime: Pick<ArtifactRuntime, "issue" | "presentation">;
  limiter: RateLimiter;
  gate: { threshold: number; lockMs: number };
  store: { audit: Pick<Audit, "write"> };
  neutral(): Response;
};
type GateBody = { password: string } | { response: Response };
type GateResult = { response: Response } | { state: RateResult };
interface UnlockInput { path: string; token: string; share: VisitorShare; artifact?: Artifact }

/** Gate body cap (1.x BODY_LIMIT): a password, never a document. */
const GATE_BODY_LIMIT = 8192;
const locked = (retryAfter: number) =>
  json({ error: "locked", retryAfter }, 429, { "Retry-After": String(retryAfter) });
/** Use the path the visitor actually opened, so aliases keep working throughout the subtree. */
const shareBase = (path: string, token: string) => `/${path}/s/${token}/`;
const childPath = (path: string, token: string, artifactId: string) => `${shareBase(path, token)}a/${artifactId}/`;

/** Resolve actor/destinations once per index, but keep each child's authority check live. */
function visitorContext(request: Request, ctx: ShareViewerContext) {
  return Effect.gen(function* () {
    const active = yield* runtimeSession(request, ctx);
    return { active, folders: yield* writableDestinations(ctx, active) };
  });
}

/** GET a share link: a folder index, or one document's trusted native-iframe descriptor. */
export function handleShare(request: Request, ctx: ShareViewerContext, params: RouteParams = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    const path = normalizePath(params.path);
    const token = String(params.token ?? "").toLowerCase();
    if (!path) return ctx.neutral();
    const resolved = yield* ctx.shares.resolve({ path, token, artifactId: params.artefact ?? null });
    if (!resolved) return ctx.neutral();
    const { share, folder, artifact } = resolved;
    if (!artifact) {
      const name = (yield* ctx.folders.name(folder)) || path;
      // Titles are withheld until a gated folder share has accepted the password.
      if (share.gated) {
        const viewer = yield* viewerDescriptor(request, ctx, {
          source: { kind: "share", path, token }, publicUrl: shareBase(path, token), gated: true, mode: "index",
        });
        return html(artifactViewerView({ title: name, viewer: { ...viewer, title: name } }));
      }
      const artefacts = yield* ctx.shares.contents(share.id);
      return html(folderIndexPage({
        name, note: "shared with you",
        artefacts: yield* Effect.forEach(artefacts, item => Effect.gen(function* () {
          return { title: (yield* ctx.artifacts.title(item)) || item.id,
            path: childPath(path, token, item.id), gated: false };
        })),
      }));
    }
    const viewer = yield* viewerDescriptor(request, ctx, {
      artifact, source: { kind: "share", path, token, artifactId: artifact.id },
      publicUrl: childPath(path, token, artifact.id), gated: share.gated,
    });
    return html(artifactViewerView({ title: viewer.title, viewer }));
  });
}

/** POST /_gate/<target>/s/<token>/[a/<artifactId>/] — verify, count, release. */
export function handleShareGate(request: Request, ctx: ShareViewerContext, params: RouteParams = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method.toUpperCase() !== "POST") return json({ error: "method not allowed" }, 405);
    if (request.headers.get("Origin") !== new URL(request.url).origin ||
      !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "forbidden" }, 403);
    const path = normalizePath(params.path);
    const token = String(params.token ?? "").toLowerCase();
    if (!path) return json({ error: "not found" }, 404);
    const resolved = yield* ctx.shares.resolve({ path, token, artifactId: params.artefact ?? null });
    if (!resolved || !resolved.share.gated) return json({ error: "not found" }, 404);
    const { share, artifact } = resolved;
    const { threshold, lockMs } = ctx.gate;
    // Per share: wrong guesses against one invitation never lock another invitation.
    const key = `share:${clientIp(request)}|${share.id}`;
    const retryAfterSec = (state: RateResult) => Math.max(1, Number(state.retryAfter) || Math.ceil(lockMs / 1000));
    const bodyResult = yield* readJson(request, GATE_BODY_LIMIT).pipe(
      Effect.flatMap(body => Effect.try({
        try: (): GateBody => ({
          password: String(body !== null && typeof body === "object" && "password" in body ? body.password ?? "" : ""),
        }),
        catch: asCodeError,
      })),
      Effect.catch(error => Effect.succeed<GateBody>({ response: error.code === "too-large"
        ? json({ error: "too large" }, 413) : json({ error: "bad request" }, 400) })),
    );
    if ("response" in bodyResult) return bodyResult.response;
    const attempt: Effect.Effect<GateResult, CodeError> = Effect.gen(function* () {
      const state = yield* ctx.limiter.check(key, { limit: threshold, windowMs: lockMs });
      if (state.locked) return { response: locked(retryAfterSec(state)) };
      if (yield* ctx.shares.verifyPassword(share.id, bodyResult.password)) {
        // Reset alone is best-effort; never recover a failed check/hit as authorization.
        yield* ctx.limiter.reset(key).pipe(Effect.catchCause(cause =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void));
        const payload = yield* unlocked(request, ctx, { path, token, share, artifact });
        const { cookie, ...wire } = payload;
        return { response: json(wire, 200, cookie ? { "Set-Cookie": cookie } : {}) };
      }
      return { state: yield* ctx.limiter.hit(key, { limit: threshold, windowMs: lockMs }) };
    });
    const result = yield* attempt.pipe(Effect.catchCause(cause => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const error = asCodeError(Cause.squash(cause));
      return Effect.succeed<GateResult>({ response: error.code === "rate-limited"
        ? json({ error: error.code, message: error.message, retryAfter: 60 }, 429, { "Retry-After": "60" })
        : json({ error: "unavailable" }, 503) });
    }));
    if ("response" in result) return result.response;
    const state = result.state;
    if (state.locked) {
      yield* ctx.store.audit.write({ actorType: "system", actorId: clientIp(request), action: "share.lockout",
        artifactId: artifact?.id ?? null, detail: { shareId: share.id, path } });
      return locked(retryAfterSec(state));
    }
    return json({ error: "wrong", remaining: state.remaining }, 401);
  });
}

/** Authorized folder titles/safe child descriptors, or one document's wrapped-key payload. */
function unlocked(request: Request, ctx: ShareViewerContext, { path, token, share, artifact }: UnlockInput) {
  return Effect.gen(function* () {
    if (!artifact) {
      const visitor = yield* visitorContext(request, ctx);
      const artefacts = yield* ctx.shares.contents(share.id);
      return {
        cookie: undefined,
        index: yield* Effect.forEach(artefacts, item => Effect.gen(function* () {
          const version = (yield* ctx.artifacts.versions(item.id)).find(current => current.version === item.currentVersion);
          const page = version?.type === "page" ? yield* ctx.artifactRuntime.presentation(version, item.lang, item.folderId) : null;
          return { title: (yield* ctx.artifacts.title(item)) || item.id, page,
            viewer: viewerView(yield* viewerDescriptor(request, ctx, {
              artifact: item, source: { kind: "share", path, token, artifactId: item.id },
              publicUrl: childPath(path, token, item.id), gated: true,
              session: visitor.active, folders: visitor.folders,
            })) };
        })),
      };
    }
    const payload = yield* ctx.shares.gatePayload({ shareId: share.id, artifactId: artifact.id });
    const issued = yield* ctx.artifactRuntime.issue(request, ctx, {
      artifact, share, source: { kind: "share", path, token, artifactId: artifact.id },
    });
    const version = (yield* ctx.artifacts.versions(artifact.id)).find(current => current.version === artifact.currentVersion);
    const page = version?.type === "page" ? yield* ctx.artifactRuntime.presentation(version, artifact.lang, artifact.folderId) : null;
    return { ...payload, ...issued, ...(page ? { page } : {}) };
  });
}
