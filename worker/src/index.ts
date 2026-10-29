// Artefacts67 2.0 — Worker entrypoint. M0 bindings remain visible through /_health;
// `/` redirects to sign-in, while the console (ADR 0024) owns auth pages,
// /app, /settings, and /admin. The viewer serves artefacts and their password gate;
// /_api and /_gate keep their machine namespaces.

import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import type { CodeError, DatabaseLike, WorkerEnv } from "./types.js";
import { route, type RouteMatch } from "./router.js";
import { html, json, originOf, redirect, text } from "./http.js";
import { health } from "./health.js";
import { RateLimit, openRateLimiter, type RateLimiter } from "./ratelimit.js";
import { openStore, type Store } from "./store.js";
import { openAuth, type Auth } from "./auth.js";
import { openWebAuthn, type WebAuthn } from "./webauthn.js";
import { openArtifacts, type Artifacts } from "./artifacts.js";
import { openFolders, type Folders } from "./folders.js";
import { openKeys, type Keys } from "./keys.js";
import { openAccess, type Access } from "./access.js";
import { openShares, type Shares } from "./shares.js";
import { openAnalytics, handleAnalytics, type Analytics } from "./analytics.js";
import { ANALYTICS_CLIENT, instrumentDocument } from "./analytics-client.js";
import { handleShare, handleShareGate } from "./share-viewer.js";
import { handleViewer, handleGate } from "./viewer.js";
import { handleApi } from "./api.js";
import { handleMcp } from "./mcp.js";
import { contract } from "./contract.js";
import { instructionsPage, agentInstructions } from "./instructions.js";
import { openMailer, type Mailer } from "./mail.js";
import { handleAuth, handleConsole, legacyAuthRedirect, legacyAdminRedirect } from "./console.js";
import { homeView, setWebAnalyticsToken } from "./views.js";
import { openArtifactRuntime, type ArtifactRuntime } from "./artifact-runtime.js";
import { openRuntimeState, type RuntimeState } from "./runtime-state.js";
import { openProjectData, type ProjectData } from "./project-data.js";
import { openProjectFiles, type ProjectFiles } from "./project-files.js";
import { openReports, type Reports } from "./reports.js";

export { RateLimit };

const VERSION = "2.0.0-m7";
interface CachedRuntime {
  store: Store; auth: Auth; webauthn: WebAuthn; mailer: Mailer; limiter: RateLimiter;
  artifacts: Artifacts; folders: Folders; keys: Keys; access: Access; shares: Shares;
  artifactRuntime: ArtifactRuntime; runtimeState: RuntimeState; reports: Reports; analytics: Analytics;
  projectData: ProjectData; projectFiles: ProjectFiles;
  analyticsClient: { ANALYTICS_CLIENT: string; instrumentDocument: typeof instrumentDocument };
  publicOrigin: string; rpName: string; rpId: string; gate: { threshold: number; lockMs: number };
  contract(): Response; neutral(): Response;
}
interface RuntimeContext extends CachedRuntime { requestOrigin: string; secureCookies: boolean; operator: string }
const runtimes = new WeakMap<DatabaseLike, CachedRuntime>();



// `cache = false` builds a runtime without storing it: the cron on a deployment without
// PUBLIC_ORIGIN must not freeze its placeholder origin and RP ID for the isolate.
function runtimeFor(env: WorkerEnv, request: Request, cache = true): RuntimeContext {
  if (!env?.DB || (typeof env.DB !== "object" && typeof env.DB !== "function")) {
    throw new Error("DB binding is required for the platform routes");
  }
  if (!env?.RATELIMIT || typeof env.RATELIMIT.idFromName !== "function" || typeof env.RATELIMIT.get !== "function") {
    throw new Error("RATELIMIT binding is required for the platform routes");
  }
  if (!env?.ARTIFACTS || typeof env.ARTIFACTS.get !== "function" || typeof env.ARTIFACTS.put !== "function") {
    throw new Error("ARTIFACTS binding is required for the platform routes");
  }
  if (!env.ARTEFACTS_MASTER_KEY) {
    throw new Error("ARTEFACTS_MASTER_KEY is required for platform routes");
  }
  const masterKeyHex = String(env.ARTEFACTS_MASTER_KEY);
  let runtime = runtimes.get(env.DB);
  const requestUrl = new URL(request.url);
  if (!runtime) {
    const publicOrigin = originOf(env, request);
    const store = openStore(env.DB);
    const limiter = openRateLimiter(env);
    const mailer = openMailer({
      host: env.SMTP_HOST || "",
      port: Number(env.SMTP_PORT || 465),
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
      from: env.SMTP_FROM || "artefacts@localhost",
    });
    const rpName = env.WEBAUTHN_RP_NAME || "Artefacts67";
    const rpId = env.WEBAUTHN_RP_ID || requestUrl.hostname;
    const access = openAccess({ db: env.DB, audit: store.audit });
    let shares: Shares;
    const artifacts = openArtifacts({
      db: env.DB, bucket: env.ARTIFACTS, masterKeyHex, settings: store.settings,
      onChange: (artifactId: string) => shares.syncArtifact(artifactId),
      prepareDocument: (source: string) => instrumentDocument(source),
    });
    const folders = openFolders({
      db: env.DB, masterKeyHex, onChange: (folderId: string) => shares.syncFolder(folderId),
    });
    shares = openShares({
      db: env.DB, masterKeyHex, artifacts, folders, access, audit: store.audit,
      publicOrigin, mailer, settings: store.settings,
    });
    const built = {
      store,
      mailer,
      limiter,
      artifacts,
      folders,
      access,
      shares,
      artifactRuntime: openArtifactRuntime({ db: env.DB, masterKeyHex }),
      runtimeState: openRuntimeState({ db: env.DB, masterKeyHex }),
      projectData: openProjectData({ db: env.DB, masterKeyHex }),
      projectFiles: openProjectFiles({ db: env.DB, bucket: env.ARTIFACTS, masterKeyHex }),
      reports: openReports({ db: env.DB, masterKeyHex }),
      analytics: openAnalytics({ db: env.DB, shares, access, masterKeyHex, limiter }),
      analyticsClient: { ANALYTICS_CLIENT, instrumentDocument },
      keys: openKeys({ db: env.DB, audit: store.audit, access }),
      contract,
      publicOrigin,
      // Gate lockout: 1.x defaults (the Nth wrong password locks out for an hour).
      gate: {
        threshold: Number(env.GATE_THRESHOLD || 4),
        lockMs: Number(env.GATE_LOCK_SECONDS || 3600) * 1000,
      },
      auth: openAuth({
        store,
        mailer,
        rateLimiter: limiter,
        masterKeyHex,
        origin: publicOrigin,
        rpName,
        rpId,
      }),
      webauthn: openWebAuthn(store),
      rpName,
      rpId,
      // Unknown artefact paths answer the front door at 200 rather than a 404 oracle.
      neutral: () => html(homeView({})),
    };
    runtime = built;
    if (cache) runtimes.set(env.DB, runtime);
  }
  return {
    ...runtime,
    requestOrigin: requestUrl.origin,
    secureCookies: requestUrl.protocol === "https:",
    operator: String(env.OPERATOR_NAME ?? "").trim(),
  };
}

const responseProgram = (request: Request, env: WorkerEnv, match: RouteMatch): Effect.Effect<Response, CodeError> =>
  Effect.gen(function* () {
    switch (match.handler) {
      case "root":
        return redirect("/login", {}, 302);
      case "health":
        return yield* health(env, VERSION);
      case "robots":
        return text("User-agent: *\nDisallow: /\n");
      case "legacyAuth":
        return legacyAuthRedirect(match.params);
      case "legacyAdmin":
        return legacyAdminRedirect(match.params);
      case "auth":
        return yield* handleAuth(request, runtimeFor(env, request), match.params);
      case "console":
        return yield* handleConsole(request, runtimeFor(env, request), match.params);
      case "share":
        return yield* handleShare(request, runtimeFor(env, request), match.params);
      case "shareGate":
        return yield* handleShareGate(request, runtimeFor(env, request), match.params);
      case "analytics":
        return yield* handleAnalytics(request, runtimeFor(env, request));
      case "runtime": {
        const context = runtimeFor(env, request);
        return yield* context.artifactRuntime.handle(request, context, match.params);
      }
      case "runtimeFiles": {
        const context = runtimeFor(env, request);
        return yield* context.artifactRuntime.files(request, context, match.params);
      }
      case "viewer":
        return yield* handleViewer(request, runtimeFor(env, request), match.params);
      case "gate":
        return yield* handleGate(request, runtimeFor(env, request), match.params);
      case "api":
        return yield* handleApi(request, runtimeFor(env, request), match.params);
      case "mcp":
        return yield* handleMcp(request, runtimeFor(env, request));
      case "instructions":
        return html(instructionsPage(originOf(env, request), env));
      case "agentInstructions":
        return text(agentInstructions(originOf(env, request), env), 200, { "Cache-Control": "no-store" });
      default:
        return json({ error: "not_found", handler: match.handler, params: match.params }, 404);
    }
  });

export default {
  async scheduled(_event: ScheduledController, env: WorkerEnv, execution: ExecutionContext): Promise<void> {
    const request = new Request(env.PUBLIC_ORIGIN || "http://localhost");
    const runtime = runtimeFor(env, request, Boolean(env.PUBLIC_ORIGIN));
    execution.waitUntil(Effect.runPromise(runtime.analytics.prune()));
    // Expired anonymous state stopped counting the moment it expired; this reclaims the
    // rows physically, in bounded batches independently of observation cleanup.
    execution.waitUntil(Effect.runPromise(runtime.runtimeState.pruneExpired()));
    // Deleted and expired project files: R2 objects first, then their rows, in bounded batches.
    execution.waitUntil(Effect.runPromise(runtime.projectFiles.sweep()));
    // Withdrawn artefacts past an hour's grace: R2 objects first, then their versions and runtime state.
    execution.waitUntil(Effect.runPromise(runtime.artifacts.sweep()));
  },

  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    setWebAnalyticsToken(env.WEB_ANALYTICS_TOKEN);
    const isHead = request.method === "HEAD";
    const dispatchRequest = isHead ? new Request(request, { method: "GET" }) : request;
    const finish = (response: Response) => isHead
      ? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
      : response;
    const url = new URL(dispatchRequest.url);
    const origin = String(env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
    const legacy = String(env.LEGACY_HOSTS || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    if (origin && legacy.includes(url.hostname)) return finish(redirect(origin + url.pathname + url.search, {}, 308));
    if (url.pathname.startsWith("/_ui/")) {
      return finish(env.ASSETS?.fetch ? await env.ASSETS.fetch(dispatchRequest) : json({ error: "not_found" }, 404));
    }
    const match = route(dispatchRequest.method, url.pathname);
    if (!match) {
      if (env.ASSETS?.fetch) {
        // Keep the 1.x `/assets/*` URLs while Wrangler mounts this small asset directory at `/`.
        const assetUrl = new URL(dispatchRequest.url);
        if (assetUrl.pathname.startsWith("/assets/")) {
          assetUrl.pathname = assetUrl.pathname.slice("/assets".length);
          return finish(await env.ASSETS.fetch(new Request(assetUrl, dispatchRequest)));
        }
        return finish(await env.ASSETS.fetch(dispatchRequest));
      }
      return finish(json({ error: "not_found" }, 404));
    }

    const program = responseProgram(dispatchRequest, env, match).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        const error = Cause.squash(cause);
        console.error("artefacts67 request error", error);
        return json({ error: "internal_error" }, 500);
      })),
    );
    return finish(await Effect.runPromise(program));
  },
};

