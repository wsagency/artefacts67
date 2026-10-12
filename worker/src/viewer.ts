import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
// Ordinary artefact and folder addresses are private: only a current signed-in reader with
// resource authority reaches metadata or content. Visitor shares use share-viewer.ts.
// A document password is an additional gate, never a substitute for sharing.
// Unknown and denied ordinary links answer the same neutral page to avoid an existence oracle.

import { clientIp, html, json, readJson } from "./http.js";
import { normalizePath } from "./paths.js";
import { publicPath, type RouteParams } from "./router.js";
import { esc, artifactViewerView, FAVICONS, KIT_CSS, PRODUCT_LOGO } from "./views.js";
import {
  runtimeSession, viewerDescriptor, type ArtifactRuntime, type RuntimeReadContext, type ViewerContext as DescriptorContext,
} from "./artifact-runtime.js";
import type { Artifacts } from "./artifacts.js";
import type { Folders } from "./folders.js";
import type { RateLimiter, RateResult } from "./ratelimit.js";
import type { Audit } from "./store.js";
import { asCodeError, type CodeError } from "./types.js";

export type ViewerContext = DescriptorContext & {
  artifacts: Pick<Artifacts, "byPath" | "live" | "listByFolder" | "title" | "path" | "gated" | "versions">;
  folders: Pick<Folders, "byPath" | "name">;
  neutral(): Response;
};
export type GateContext = Omit<RuntimeReadContext, "limiter"> & {
  artifacts: Pick<Artifacts, "byId" | "byPath" | "live" | "gated" | "verifyPassword" | "gatePayload">;
  artifactRuntime: Pick<ArtifactRuntime, "issue">;
  limiter: RateLimiter;
  gate: { threshold: number; lockMs: number };
  store: { audit: Pick<Audit, "write"> };
};

type GateResult = { response: Response } | { state: RateResult };
type GateBody = { password: string } | { response: Response };


/** Gate body cap (1.x BODY_LIMIT): a password, never a document. */
const GATE_BODY_LIMIT = 8192;

export function handleViewer(request: Request, ctx: ViewerContext, params: RouteParams = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
  const path = publicPath(params);
  const active = yield* runtimeSession(request, ctx);
  if (!active) return ctx.neutral();
  // A folder index and an artefact share the single-segment namespace (ADR 0017); paths are
  // unique across both, so this order is a formality, not a precedence rule.
  const folder = path.includes("/") ? null : yield* ctx.folders.byPath(path);
  if (folder) {
    if (!(yield* ctx.access.may(active.user.id, { ownerId: folder.ownerId, folderId: folder.id }, "read"))) return ctx.neutral();
    const artefacts = yield* ctx.artifacts.listByFolder(folder.id);
    return html(folderIndexPage({
      name: (yield* ctx.folders.name(folder)) || path,
      artefacts: yield* Effect.all(artefacts.map((artifact) => Effect.gen(function* () { return ({
        title: (yield* ctx.artifacts.title(artifact)) || artifact.id,
        path: ctx.artifacts.path(artifact),
        gated: ctx.artifacts.gated(artifact),
      }); }))),
    }));
  }

  const artifact = yield* ctx.artifacts.byPath(path);
  if (!artifact || !ctx.artifacts.live(artifact)) return ctx.neutral();
  if (!(yield* ctx.access.may(active.user.id, artifact, "read"))) return ctx.neutral();
  const viewer = yield* viewerDescriptor(request, ctx, {
    artifact, source: { kind: "public", path }, publicUrl: `/${path}/`, gated: ctx.artifacts.gated(artifact), session: active,
  });
  return html(artifactViewerView({ title: viewer.title, viewer }));
});
}

/** POST /_gate/<path> — an authorized reader may unlock the additional document password. */
export function handleGate(request: Request, ctx: GateContext, params: RouteParams = {}): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
  if (request.method.toUpperCase() !== "POST") return json({ error: "method not allowed" }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin ||
    !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "forbidden" }, 403);
  const path = normalizePath(params.rest);
  const artifact = path ? yield* ctx.artifacts.byPath(path) : null;
  const active = yield* runtimeSession(request, ctx);
  // Unknown, denied and absent gates share one answer, before verifier/key access.
  if (!path || !artifact || !active || !(yield* ctx.access.may(active.user.id, artifact, "read")) ||
    !ctx.artifacts.gated(artifact) || !ctx.artifacts.live(artifact)) {
    return json({ error: "not found" }, 404);
  }

  const { threshold, lockMs } = ctx.gate;
  const key = `gate:${clientIp(request)}|${artifact.id}`;
  const retryAfterSec = (state: RateResult) =>
    Math.max(1, Number(state?.retryAfter ?? 0) || Math.ceil(lockMs / 1000));

  const bodyResult = yield* readJson(request, GATE_BODY_LIMIT).pipe(
    Effect.flatMap(body => Effect.try({
      try: (): GateBody => ({
        password: String(body !== null && typeof body === "object" && "password" in body ? body.password ?? "" : ""),
      }),
      catch: asCodeError,
    })),
    Effect.catch((error) => Effect.succeed<GateBody>({
      response: error.code === "too-large"
        ? json({ error: "too large" }, 413)
        : json({ error: "bad request" }, 400),
    })),
  );
  if ("response" in bodyResult) return bodyResult.response;
  const password = bodyResult.password;

  // Fail closed: a counter we cannot read is a lockout we cannot enforce.
  const attempt: Effect.Effect<GateResult, CodeError> = Effect.gen(function* () {
    const state = yield* ctx.limiter.check(key, { limit: threshold, windowMs: lockMs });
    if (state.locked) return { response: locked(retryAfterSec(state)) };
    if (yield* ctx.artifacts.verifyPassword(artifact, password)) {
      // Reset alone is best-effort; a failed check, hit or payload still fails closed.
      yield* ctx.limiter.reset(key).pipe(Effect.catchCause(cause =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void));
      const payload = yield* ctx.artifacts.gatePayload(artifact);
      const issued = yield* ctx.artifactRuntime.issue(request, ctx, { artifact, source: { kind: "public", path } });
      return { response: json({ ...payload, runtime: issued.runtime }, 200, issued.cookie ? { "Set-Cookie": issued.cookie } : {}) };
    }
    return { state: yield* ctx.limiter.hit(key, { limit: threshold, windowMs: lockMs }) };
  });
  const gateResult = yield* attempt.pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
    const error = asCodeError(Cause.squash(cause));
    return Effect.succeed<GateResult>({
      response: error.code === "rate-limited"
        ? json({ error: error.code, message: error.message, retryAfter: 60 }, 429, { "Retry-After": "60" })
        : json({ error: "unavailable" }, 503),
    });
  }));
  if ("response" in gateResult) return gateResult.response;
  const state = gateResult.state;

  if (state.locked) {
    yield* ctx.store.audit.write({
      actorType: "system",
      actorId: clientIp(request),
      action: "gate.lockout",
      artifactId: artifact.id,
      detail: { path },
    });
    return locked(retryAfterSec(state));
  }
  return json({ error: "wrong", remaining: state.remaining }, 401);
});
}

const locked = (retryAfter: number) =>
  json({ error: "locked", retryAfter }, 429, { "Retry-After": String(retryAfter) });

export interface FolderIndexItem { title: string; path: string; gated: boolean }
export interface FolderIndexOptions { name?: string; artefacts?: FolderIndexItem[]; note?: string }

/**
 * The folder index — the page served at a folder's link (`CONTEXT.md`), listing every artefact
 * published in it. The 1.x card grid on the WS design kit's tokens and fonts, with the product
 * logo and the lock badge on gated artefacts. Rendered per request
 * from D1, so it can never disagree with what is published.
 *
 * A visitor share renders the same page over its own subtree, which is why the card link and
 * the standfirst are the caller's to choose.
 */
export function folderIndexPage({ name, artefacts = [], note = "private · sign-in and access required; share with visitors only through a visitor share" }: FolderIndexOptions = {}): string {
  const card = (artefact: FolderIndexItem) => `    <a class="card" href="${esc(artefact.path)}">
      <div class="card-main"><span class="card-title">${esc(artefact.title)}${artefact.gated ? '<span class="lock" title="Password protected">🔒</span>' : ""}</span></div>
      <div class="card-meta"><span class="card-go">open →</span></div>
    </a>`;
  const cards = artefacts.length
    ? artefacts.map(card).join("\n")
    : '    <p class="sub">No artefacts have been published yet.</p>';

  return `<!doctype html>
<html class="wsa-brand" data-identity="original" data-appearance="auto" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Artefacts67</title>
<meta name="robots" content="noindex,nofollow">
${KIT_CSS}
<style>
  :root{
    --bg:var(--wsa-background); --ink:var(--wsa-foreground); --muted:var(--wsa-muted); --line:var(--wsa-border); --card:var(--wsa-surface);
    --chrome:var(--wsa-surface); --accent:var(--wsa-accent); --accent-ink:var(--wsa-accent-text);
    --sans:var(--wsa-font);
    --mono:var(--wsa-font-mono);
  }
  *{box-sizing:border-box} html,body{margin:0}
  body{background:var(--bg); color:var(--ink); font-family:var(--sans); font-synthesis-style:none; line-height:1.55; -webkit-font-smoothing:antialiased}
  .chrome{background:var(--chrome); color:var(--ink); border-bottom:1px solid var(--line); padding:.85rem clamp(1rem,4vw,2.5rem); display:flex; align-items:center}
  .brand{display:flex; align-items:center; text-decoration:none; color:inherit}
  .brand img{display:block; width:180px; height:auto}
  .wrap{max-width:52rem; margin:0 auto; padding:clamp(1.6rem,5vw,3.2rem) clamp(1rem,4vw,2rem) 3rem}
  .eyebrow{font-size:.72rem; letter-spacing:.2em; text-transform:uppercase; color:var(--accent-ink); font-weight:700; margin:0 0 .45rem}
  h1{font-size:clamp(1.7rem,4.5vw,2.4rem); line-height:1.1; letter-spacing:-.015em; margin:0; text-wrap:balance}
  .sub{color:var(--muted); margin:.55rem 0 0; font-size:.95rem}
  .cards{display:flex; flex-direction:column; gap:.7rem; margin-top:2rem}
  .card{display:flex; align-items:center; justify-content:space-between; gap:1rem;
    background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1rem 1.15rem;
    text-decoration:none; color:inherit; transition:border-color .15s, box-shadow .15s, transform .05s}
  .card:hover{border-color:var(--accent); box-shadow:0 4px 18px -8px color-mix(in srgb,var(--accent) 45%,transparent)}
  .card:active{transform:translateY(1px)}
  .card-main{display:flex; flex-direction:column; gap:.15rem; min-width:0}
  .card-title{font-weight:650; font-size:1.02rem; display:flex; align-items:center; gap:.45rem}
  .card-meta{display:flex; flex-direction:column; align-items:flex-end; gap:.2rem; flex:none}
  .card-go{color:var(--accent-ink); font-weight:600; font-size:.85rem}
  .lock{font-size:.85rem; filter:saturate(.4)}
  .foot{max-width:52rem; margin:0 auto; padding:1.4rem clamp(1rem,4vw,2rem) 2.5rem; color:var(--muted); font-size:.82rem; border-top:1px solid var(--line)}
  .foot span{font-family:var(--mono)}
  @media (max-width:520px){ .card{flex-direction:column; align-items:flex-start} .card-meta{flex-direction:row; align-items:center; gap:.8rem} }
</style>
${FAVICONS}
</head>
<body>
  <header class="chrome"><a class="brand" href="#">${PRODUCT_LOGO}</a></header>
  <main class="wrap">
    <p class="eyebrow">Folder</p>
    <h1>${esc(name)}</h1>
    <p class="sub">${artefacts.length} artefact${artefacts.length === 1 ? "" : "s"} · ${esc(note)}</p>
    <div class="cards">
${cards}
    </div>
  </main>
  <footer class="foot">Artefacts67</footer>
</body>
</html>`;
}
