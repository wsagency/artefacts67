// Route table. Order is the contract: exact system paths first, then the slug
// catch-all. The human console lives on plain public paths reserved in paths.js
// (ADR 0024); the machine surface keeps its /_ namespaces, which no slug can
// collide with because the slug charset excludes _ entirely.
//
// An ordinary artefact path is ONE segment: its slug, or its id while unnamed.
// The two-segment 1.x `<folderToken>/<artToken>/` form remains an import-time alias.
// Both forms require a current authorized session; neither is a visitor capability.
// Both tolerate a trailing slash, because 1.x links carried one.

/** One path segment: lowercase alphanumeric, inner hyphens, 1–64 chars, no `_`. */
export const SLUG_SEGMENT = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";

const SLUG = new RegExp(`^/(?<slug>${SLUG_SEGMENT})/?$`);
const LEGACY = new RegExp(`^/(?<folder>${SLUG_SEGMENT})/(?<artefact>${SLUG_SEGMENT})/?$`);
// `rest` is the ordinary private path without its trailing slash. Its additional password
// gate also requires resource authority; non-POST requests answer 405 inside the handler.
const GATE = /^\/_gate\/(?<rest>.+?)\/?$/;
// The console (ADR 0024): auth pages on plain paths, and the three signed-in areas
// (/app the estate, /settings personal, /admin the platform) sharing one handler.
const AUTH_PAGE = /^\/(?<action>login|register|2fa|enroll|logout)\/?$/;
const INVITE = /^\/invite\/(?<token>[A-Za-z0-9._~-]+)\/?$/;
const PASSKEY = /^\/passkey\/(?<op>(?:login\/)?(?:begin|complete))\/?$/;
const CONSOLE = /^\/(?<area>app|admin|settings)(?:\/(?<rest>.*))?$/;
// The M1 URLs, kept as 301s: an invitation mail sent before ADR 0024 must not die.
const LEGACY_AUTH = /^\/_auth(?:\/(?<rest>.*))?$/;
const LEGACY_ADMIN = /^\/_admin(?:\/(?<rest>.*))?$/;
// A visitor share (M6): the target's ordinary path, then `/s/<40 hex>/`, and for a folder
// share optionally `/a/<artefact>/` naming one document inside it. Three segments or more, so
// it can never be confused with an artefact path or a 1.x two-segment link — and the target
// prefix accepts both of those shapes, because an alias that stopped working would break the
// promise a share is built on. The `_gate` twin is the POST that releases the wrapped payload.
const SHARE_TARGET = `(?<path>${SLUG_SEGMENT}(?:/${SLUG_SEGMENT})?)/s/(?<token>[0-9a-f]{40})(?:/a/(?<artefact>${SLUG_SEGMENT}))?`;
const SHARE = new RegExp(`^/${SHARE_TARGET}/?$`);
const SHARE_GATE = new RegExp(`^/_gate/${SHARE_TARGET}/?$`);

interface RouteDefinition { method?: string; pattern: RegExp; handler: string }
export type RouteParams = {
  slug?: string; folder?: string; artefact?: string; rest?: string; action?: string;
  token?: string; op?: string; area?: string; path?: string;
};

export const routes = [
  { method: "GET", pattern: /^\/$/, handler: "root" },
  { method: "GET", pattern: /^\/_health$/, handler: "health" },
  { pattern: /^\/_ev\/?$/, handler: "analytics" },
  { pattern: /^\/_runtime\/(?<action>load|state|check|report|duplicate|data)\/?$/, handler: "runtime" },
  { pattern: /^\/_runtime\/files\/(?<rest>.+)$/, handler: "runtimeFiles" },
  { method: "GET", pattern: /^\/robots\.txt$/, handler: "robots" },
  { method: "GET", pattern: /^\/instructions$/, handler: "instructions" },
  { method: "GET", pattern: /^\/llms\.txt$/, handler: "agentInstructions" },
  { pattern: SHARE_GATE, handler: "shareGate" },
  { pattern: GATE, handler: "gate" },
  { method: "GET", pattern: LEGACY_AUTH, handler: "legacyAuth" },
  { method: "GET", pattern: LEGACY_ADMIN, handler: "legacyAdmin" },
  { pattern: AUTH_PAGE, handler: "auth" },
  { pattern: INVITE, handler: "auth" },
  { method: "POST", pattern: PASSKEY, handler: "auth" },
  { pattern: CONSOLE, handler: "console" },
  { method: "GET", pattern: SHARE, handler: "share" },
  { pattern: /^\/_mcp\/?$/, handler: "mcp" },
  { pattern: /^\/_api\/(?<rest>.+)$/, handler: "api" },
  { method: "GET", pattern: LEGACY, handler: "viewer" },
  { method: "GET", pattern: SLUG, handler: "viewer" },
] as const satisfies readonly RouteDefinition[];

export type RouteHandler = (typeof routes)[number]["handler"];
export interface RouteMatch { handler: RouteHandler; params: RouteParams }

// Pure so plain `node --test` can exercise it without workerd.
export function route(method: string, pathname: string): RouteMatch | null {
  const effectiveMethod = method === "HEAD" ? "GET" : method;
  for (const r of routes) {
    if ("method" in r && r.method !== effectiveMethod) continue;
    const match = r.pattern.exec(pathname);
    if (match) return { handler: r.handler, params: (match.groups ?? {}) as RouteParams };
  }
  return null;
}

/** The ordinary path a viewer/gate request is about: `slug`, or `folder/artefact` for a
 * legacy link. Shared by the router's callers so the two never disagree. */
export function publicPath(params: RouteParams = {}): string {
  return params.artefact ? `${params.folder}/${params.artefact}` : String(params.slug ?? "");
}