// Request/response helpers for the Worker handlers. Pure `Request`/`Response` (no node:http),
// so the same code runs under workerd and `node --test`. Ported in spirit from lib/http.js:
// the same hygiene headers, cookie attributes and body-size cap; the socket-level details are
// gone (a Worker never sees a raw socket).
import { Effect, Exit } from "effect";
import { asCodeError } from "./types.js";
import type { CodeError } from "./types.js";

/** Response hygiene every rendered page carries (1.x HYGIENE, verbatim). */
export const HYGIENE = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const coded = (code: string, msg: string): CodeError => Object.assign(new Error(msg), { code });

/** The deployment's public origin: `PUBLIC_ORIGIN` when set, else the request's own origin. */
export function originOf(env: { PUBLIC_ORIGIN?: string }, request: Request): string {
  return String(env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
}

/** text/html response (never cached: these are authenticated pages). */
export function html(body: BodyInit | null, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-src 'self'", ...HYGIENE, ...extra },
  });
}

/** application/json response (never cached). */
export function json(obj: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...HYGIENE, ...extra },
  });
}

/** Redirect after a form POST — 303 See Other (RFC 7231 §6.4.4); pass 301 for a permanently
 *  moved URL (the legacy console paths of ADR 0024). */
export function redirect(location: string, extra: Record<string, string> = {}, status = 303): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", ...HYGIENE, ...extra } });
}

/** plain text (robots.txt, health). */
export function text(body: BodyInit | null, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...HYGIENE, ...extra } });
}

/** A project file download (ADR 0035): always an opaque attachment, never rendered or sniffed.
 *  The quoted name is printable ASCII without quote/slash/backslash; `filename*` carries the real name. */
export function fileResponse(file: { name: string; type: string; size: number }, body: ReadableStream<Uint8Array>): Response {
  const fallback = file.name.replace(/[^\x20-\x7e]|["\\/]/gu, "_");
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(body, { status: 200, headers: {
    ...HYGIENE, "Content-Type": "application/octet-stream", "Content-Length": String(file.size),
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    ...(file.type !== "" ? { "X-Artefacts-File-Type": file.type } : {}),
    "Content-Security-Policy": "sandbox", "Cache-Control": "no-store",
  } });
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Serialize a Set-Cookie value. `maxAge` in seconds (0 = delete). `secure` must be false for
 *  http:// dev origins (a Secure cookie is dropped over http, which would break wrangler dev). */
export function setCookie(name: string, value: string, { maxAge = 0, path = "/", httpOnly = true, secure = true, sameSite = "Lax" }: CookieOptions = {}): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}` +
    (httpOnly ? "; HttpOnly" : "") + (secure ? "; Secure" : "") + `; SameSite=${sameSite}`;
}

export const clearCookie = (name: string, opts: CookieOptions = {}): string => setCookie(name, "", { ...opts, maxAge: 0 });

/** Parse the Cookie header into a plain object (last wins, like 1.x parseCookies). */
export function parseCookies(request: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** Read a request body without retaining chunks beyond `limit` bytes. */
function readBody(request: Request, limit: number): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (Number.isFinite(declared) && declared > limit) return yield* Effect.fail(coded("too-large", `body larger than ${limit} bytes`));
    const stream = request.body;
    if (!stream) return "";
    return yield* Effect.acquireUseRelease(
      Effect.try({ try: () => stream.getReader(), catch: asCodeError }),
      (reader) => Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { value, done } = yield* Effect.tryPromise({ try: () => reader.read(), catch: asCodeError });
          if (done) break;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          total += bytes.byteLength;
          if (total > limit) return yield* Effect.fail(coded("too-large", `body larger than ${limit} bytes`));
          chunks.push(bytes);
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder().decode(body);
      }),
      (reader, exit) => (Exit.isSuccess(exit) ? Effect.void :
        Effect.tryPromise({ try: () => reader.cancel(), catch: asCodeError }).pipe(Effect.ignore)
      ).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock()))),
    );
  });
}

/** The one project-file part size (ADR 0035) for runtime, API and MCP. */
export const PART_BYTES = 8 * 1024 * 1024; // 8,388,608

/** Read a raw part body of exactly `expected` bytes straight into one buffer: `Content-Length`
 *  must equal `expected` (missing or smaller → `validation` on `part`, larger → `too-large`). */
export function readBytes(request: Request, expected: number): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  const short = () => Object.assign(coded("validation", "Invalid part."), { issues: [{ field: "part", message: `Part must be exactly ${expected} bytes.` }] });
  return Effect.gen(function* () {
    const declared = request.headers.get("Content-Length");
    if (declared === null || !/^\d+$/.test(declared) || Number(declared) < expected) return yield* Effect.fail(short());
    if (Number(declared) > expected) return yield* Effect.fail(coded("too-large", `part larger than ${expected} bytes`));
    const stream = request.body;
    if (!stream) return yield* Effect.fail(short());
    return yield* Effect.acquireUseRelease(
      Effect.try({ try: () => stream.getReader(), catch: asCodeError }),
      (reader) => Effect.gen(function* () {
        const body = new Uint8Array(expected);
        let offset = 0;
        for (;;) {
          const { value, done } = yield* Effect.tryPromise({ try: () => reader.read(), catch: asCodeError });
          if (done) break;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (offset + bytes.byteLength > expected) return yield* Effect.fail(coded("too-large", `part larger than ${expected} bytes`));
          body.set(bytes, offset);
          offset += bytes.byteLength;
        }
        if (offset !== expected) return yield* Effect.fail(short());
        return body;
      }),
      (reader, exit) => (Exit.isSuccess(exit) ? Effect.void :
        Effect.tryPromise({ try: () => reader.cancel(), catch: asCodeError }).pipe(Effect.ignore)
      ).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock()))),
    );
  });
}

/** Read + size-cap a form body. Returns URLSearchParams. */
export function readForm(request: Request, limit = 64 * 1024): Effect.Effect<URLSearchParams, CodeError> {
  return Effect.gen(function* () {
    return new URLSearchParams(yield* readBody(request, limit));
  });
}

/** Read + size-cap a JSON body; the caller validates the parsed wire value. */
export function readJson<A = unknown>(request: Request, limit = 64 * 1024): Effect.Effect<A, CodeError> {
  return Effect.gen(function* () {
    const raw = yield* readBody(request, limit);
    return yield* Effect.try({
      try: () => JSON.parse(raw || "{}") as A,
      catch: () => coded("bad-json", "request body is not valid JSON"),
    });
  });
}

/** The client address. Cloudflare terminates TLS and sets CF-Connecting-IP; behind the legacy
 *  1.x host's reverse proxy it was the first X-Forwarded-For hop (1.x clientIp). Never trust a bare
 *  X-Forwarded-For on the edge. */
export function clientIp(request: Request): string {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}
