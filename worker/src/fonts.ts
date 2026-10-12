// Publication-only Google Fonts capture. Source-offset edits preserve authored scripts and
// unrelated HTML/CSS; captured font bytes travel inside the same sealed R2 document.
import { Cause, Clock, Effect } from "effect";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import * as css from "css-tree";
import { b64e } from "./crypto.js";
import { asCodeError } from "./types.js";
import type { CodeError } from "./types.js";
import { validateArtefactHtml } from "./validate.js";
import type { ValidationIssue } from "./validate.js";

export const FONT_LIMITS = Object.freeze({ stylesheets: 8, fonts: 32, stylesheetBytes: 256 * 1024,
  fontBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, documentBytes: 12 * 1024 * 1024,
  requestMs: 10_000, totalMs: 30_000, redirects: 3 });
export type FontFetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface PreparedArtifactHtml { html: string; warnings: ValidationIssue[] }
export interface PreparationOptions { gated?: boolean }
export interface OpenedArtifactHtml extends PreparedArtifactHtml { gated: boolean }
export interface ArtifactService {
  prepare(source: unknown, options?: PreparationOptions): Effect.Effect<object, CodeError>;
  open(token: unknown, source: unknown): Effect.Effect<OpenedArtifactHtml | null, CodeError>;
}
type ResourceKind = "css" | "font";
type SourceEdit = { start: number; end: number; text: string };
type ResourceStep = { redirect: string } | { data: string };
type ResourceMeta = { redirect: string } | { stream: ReadableStream<Uint8Array>; mime: string; cap: number };
type SourceEdits = {
  push(edit: SourceEdit): void;
  sort(compare: (a: SourceEdit, b: SourceEdit) => number): SourceEdit[];
};

const encoder = new TextEncoder();
const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const fail = (code: string, message: string): never => { throw coded(code, message); };
const remote = (value: string): boolean => /^(?:https?:)?\/\//i.test(value.replace(/[\t\r\n]/g, "").trim());
const cssName = (name: string | undefined): string => css.ident.decode(name ?? "").toLowerCase();
const editList = (source: string): SourceEdits => {
  let size = encoder.encode(source).byteLength;
  const edits: SourceEdit[] = [];
  return {
    push(edit: SourceEdit) {
      size += encoder.encode(edit.text).byteLength - encoder.encode(source.slice(edit.start, edit.end)).byteLength;
      if (size > FONT_LIMITS.documentBytes) fail("font-limit", "Expanded document exceeds its stored byte limit.");
      edits.push(edit);
    },
    sort: (compare: (a: SourceEdit, b: SourceEdit) => number) => edits.sort(compare),
  };
};
const editsApplied = (source: string, edits: SourceEdits): string => {
  const parts: string[] = [];
  let offset = 0;
  for (const { start, end, text } of edits.sort((a, b) => a.start - b.start)) {
    parts.push(source.slice(offset, start), text);
    offset = end;
  }
  parts.push(source.slice(offset));
  return parts.join("");
};
const attrEscape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
/** Decode CSS escape sequences (`\3a`, `\:`) so an escaped URL attempt cannot pose as local text. */
const cssUnescape = (text: string): string => text.replace(/\\(?:([0-9a-fA-F]{1,6})[\t\n\f\r ]?|(.))/g, (_match: string, hexCode: string | undefined, ch: string | undefined) => {
  if (ch !== undefined) return ch;
  const point = parseInt(hexCode ?? "", 16);
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
});
/** Unparsed regions must not conceal network fetches; comments never load anything. */
const remoteAttempt = (text: string): boolean =>
  /(?:url\s*\(\s*["']?\s*|@import\s+(?:url\s*\(\s*["']?\s*|["']\s*))(?:[a-z][a-z0-9+.-]*:)?\/\//i
    .test(cssUnescape(text.replace(/\/\*[\s\S]*?\*\//g, " ")));

function providerUrl(value: string, kind: ResourceKind): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("font-provider", "Font URLs must be absolute HTTPS URLs."); }
  const host = kind === "css" ? "fonts.googleapis.com" : "fonts.gstatic.com";
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password || url.hash ||
      (kind === "css" ? !["/css", "/css2"].includes(url.pathname) : !url.pathname.startsWith("/s/")))
    fail("font-provider", `Only HTTPS ${host} ${kind === "css" ? "/css or /css2 stylesheets" : "/s/ font assets"} are supported.`);
  return url.href;
}

function fontFormat(bytes: Uint8Array, mime: string): string {
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: "woff2" | "woff" | "otf" | "ttf" | undefined;
  if (signature === "wOF2" && bytes.length >= 48 && view.getUint32(8) === bytes.length) format = "woff2";
  else if (signature === "wOFF" && bytes.length >= 44 && view.getUint32(8) === bytes.length) format = "woff";
  else if (bytes.length >= 12 && (signature === "OTTO" || view.getUint32(0) === 0x00010000))
    format = signature === "OTTO" ? "otf" : "ttf";
  if (!format) return fail("font-format", "Font response has an unsupported or invalid font signature/header.");
  const types = { woff2: ["font/woff2"], woff: ["font/woff", "application/font-woff"],
    ttf: ["font/ttf", "application/x-font-ttf"], otf: ["font/otf", "application/x-font-opentype"] };
  if (!types[format].includes(mime)) fail("font-format", "Font response MIME type does not match its signature.");
  return `font/${format}`;
}

/** A fresh budget/cache per execution: never a shared cross-user fetch/cache side channel. */
export function prepareArtifactHtml(html: unknown, { fetcher = fetch, gated = false }: PreparationOptions & { fetcher?: FontFetcher } = {}): Effect.Effect<PreparedArtifactHtml, CodeError> {
  return Effect.gen(function* () {
    if (typeof html !== "string") return yield* Effect.fail(coded("invalid-content", "Artefact content must be a string."));
    const validation = validateArtefactHtml(html, { gated, checkReferences: false });
    if (validation.errors.length) return yield* Effect.fail(Object.assign(new Error("Document rejected by validation."), {
      code: "validation", issues: validation.errors,
    }));
    const started = yield* Clock.currentTimeMillis, cache = new Map<string, string>();
    let downloaded = 0, stylesheetCount = 0, fontCount = 0;

    const resource = (value: string, kind: ResourceKind): Effect.Effect<string, CodeError> => Effect.gen(function* () {
      const initial = yield* Effect.try({ try: () => providerUrl(value, kind), catch: asCodeError });
      const cached = cache.get(initial);
      if (cached !== undefined) return cached;
      if (kind === "css" ? ++stylesheetCount > FONT_LIMITS.stylesheets : ++fontCount > FONT_LIMITS.fonts)
        return yield* Effect.fail(coded("font-limit", "Too many font resources in one document."));
      const remaining = FONT_LIMITS.totalMs - ((yield* Clock.currentTimeMillis) - started);
      if (remaining <= 0) return yield* Effect.fail(coded("font-timeout", "Font capture exceeded the publication time limit."));
      return yield* Effect.gen(function* () {
        let url = initial;
        for (let redirects = 0; ; redirects++) {
          const controller = new AbortController();
          const abortConnection = Effect.sync(() => {
            if (!controller.signal.aborted) controller.abort();
          });
          const step: ResourceStep = yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: (signal) => fetcher(url, { redirect: "manual", signal: AbortSignal.any([signal, controller.signal]),
                headers: { Accept: kind === "css" ? "text/css" : "font/woff2,font/woff,font/ttf,font/otf",
                  "User-Agent": "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36" } }),
              catch: asCodeError,
            }).pipe(Effect.interruptible),
            (response) => Effect.gen(function* () {
              const meta = yield* Effect.try({ try: (): ResourceMeta => {
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                  if (redirects >= FONT_LIMITS.redirects) fail("font-fetch", "Too many font provider redirects.");
                  const location = response.headers.get("location");
                  if (!location) return fail("font-fetch", "Font provider redirect has no destination.");
                  return { redirect: providerUrl(new URL(location, url).href, kind) };
                }
                if (!response.ok) fail("font-fetch", `Font provider returned HTTP ${response.status}.`);
                const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
                if (kind === "css" && mime !== "text/css") fail("font-format", "Font stylesheet response must be text/css.");
                const cap = kind === "css" ? FONT_LIMITS.stylesheetBytes : FONT_LIMITS.fontBytes;
                if (Number(response.headers.get("content-length")) > cap) fail("font-limit", "Font response exceeds its byte limit.");
                if (!response.body) return fail("font-fetch", "Font provider returned an empty response.");
                return { stream: response.body, mime, cap };
              }, catch: asCodeError });
              if ("redirect" in meta) return { redirect: meta.redirect };
              const bytes = yield* Effect.acquireUseRelease(
                Effect.try({ try: () => meta.stream.getReader(), catch: asCodeError }),
                (reader) => Effect.gen(function* () {
                  const chunks: Uint8Array[] = [];
                  let size = 0;
                  for (;;) {
                    const { done, value: chunk } = yield* Effect.tryPromise({ try: () => reader.read(), catch: asCodeError });
                    if (done) break;
                    size += chunk.byteLength;
                    downloaded += chunk.byteLength;
                    if (size > meta.cap || downloaded > FONT_LIMITS.totalBytes)
                      return yield* Effect.fail(coded("font-limit", "Font capture exceeds its byte budget."));
                    chunks.push(chunk);
                  }
                  const bytes = new Uint8Array(size);
                  let offset = 0;
                  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                  return bytes;
                }),
                (reader) => Effect.gen(function* () {
                  yield* abortConnection;
                  yield* Effect.tryPromise({ try: () => reader.cancel(), catch: asCodeError }).pipe(Effect.ignore);
                }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock()))),
              );
              const data = yield* Effect.try({ try: () => {
                if (kind === "css") {
                  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
                  catch { return fail("font-format", "Font stylesheet is not UTF-8."); }
                }
                return `data:${fontFormat(bytes, meta.mime)};base64,${b64e(bytes)}`;
              }, catch: asCodeError });
              return { data };
            }),
            (response) => Effect.gen(function* () {
              yield* abortConnection;
              const body = response.body;
              if (body && !response.bodyUsed)
                yield* Effect.tryPromise({ try: () => body.cancel(), catch: asCodeError }).pipe(Effect.ignore);
            }),
          ).pipe(Effect.ensuring(abortConnection));
          if ("redirect" in step) { url = step.redirect; continue; }
          cache.set(initial, step.data);
          return step.data;
        }
      }).pipe(
        Effect.timeout(Math.min(FONT_LIMITS.requestMs, remaining)),
        Effect.catch((error) => {
          if (Cause.isTimeoutError(error)) return Effect.fail(coded("font-timeout", "Font capture timed out."));
          if (error.code?.startsWith("font-")) return Effect.fail(error);
          return Effect.fail(coded("font-fetch", "Font provider could not be fetched."));
        }),
      );
    });

    const captureCss = (source: string, { context = "stylesheet", provider = false }: { context?: "stylesheet" | "declarationList"; provider?: boolean } = {}): Effect.Effect<string, CodeError> => Effect.gen(function* () {
      if (provider && /<\/style/i.test(source)) return yield* Effect.fail(coded("font-css", "Font stylesheet contains an HTML closing tag."));
      // Author CSS is tolerant, but every Raw node is scanned for concealed remote references.
      // Provider stylesheets are platform-fetched input and remain strict.
      const syntaxErrors: css.SyntaxParseError[] = [];
      const ast = yield* Effect.try({ try: () => css.parse(source, { context, positions: true, parseCustomProperty: true,
        onParseError: (error) => syntaxErrors.push(error) }), catch: asCodeError }).pipe(Effect.catch((error) => {
          if (error.code) return Effect.fail(error);
          if (provider) return Effect.fail(coded("font-css", "Unsupported or invalid CSS syntax."));
          if (remoteAttempt(source)) return Effect.fail(coded("external-reference", "Unparsed CSS attempts a remote reference."));
          return Effect.succeed(null);
        }));
      if (!ast) return source;
      const edits = editList(source), jobs: Effect.Effect<void, CodeError>[] = [];
      let capturedUrls = 0;
      yield* Effect.try({ try: () => {
        if (provider && syntaxErrors.length) fail("font-css", "Unsupported or invalid CSS syntax.");
        if (provider) {
          if (ast.type !== "StyleSheet") return fail("font-css", "Unsupported or invalid CSS syntax.");
          ast.children.forEach((node) => {
            if (node.type !== "Atrule" || cssName(node.name) !== "font-face")
              fail("font-css", "Provider stylesheets may contain only @font-face rules.");
          });
        }
        css.walk(ast, { enter(this: css.WalkContext, node: css.CssNode) {
          if (node.type === "Function" && cssName(node.name) === "url") {
            if (provider) fail("font-css", "Escaped or malformed CSS URL functions are not supported.");
            if (remoteAttempt(node.loc ? source.slice(node.loc.start.offset, node.loc.end.offset) : "url(//"))
              fail("external-reference", "Escaped or malformed CSS URL attempts a remote reference.");
            return;
          }
          if (node.type === "Raw") {
            if (provider) fail("font-css", "Unsupported or invalid CSS syntax.");
            if (remoteAttempt(node.value)) fail("external-reference", "Unparsed CSS contains a remote reference that cannot be captured.");
            return;
          }
          if (node.type === "Atrule" && cssName(node.name) === "import") {
            if (provider) fail("font-css", "Nested provider imports are not supported.");
            const prelude = node.prelude;
            const first = prelude?.type === "AtrulePrelude" ? prelude.children.first : null;
            if (!first || (first.type !== "Url" && first.type !== "String")) return fail("font-provider", "Only Google Fonts imports are supported.");
            const url = providerUrl(first.value, "css"), loc = node.loc;
            if (!first.loc || !prelude?.loc || !loc) throw new Error("CSS source location is unavailable.");
            const qualifier = source.slice(first.loc.end.offset, prelude.loc.end.offset).trim();
            if (/\b(?:layer|supports)\b/i.test(qualifier)) fail("font-css", "Font imports with layer/supports qualifiers are not supported.");
            jobs.push(Effect.gen(function* () {
              let text = yield* captureCss(yield* resource(url, "css"), { provider: true });
              if (qualifier) text = `@media ${qualifier}{${text}}`;
              yield* Effect.try({ try: () => edits.push({ start: loc.start.offset, end: loc.end.offset, text }), catch: asCodeError });
            }));
            return css.walk.skip;
          }
          if (provider && node.type === "Url" && !remote(node.value))
            fail("font-provider", "Provider font sources must use supported HTTPS font assets.");
          if (node.type === "Url" && remote(node.value)) {
            if (cssName(this.atrule?.name) !== "font-face" || cssName(this.declaration?.property) !== "src")
              fail("external-reference", "Only font-face src may capture a remote CSS URL.");
            const url = providerUrl(node.value, "font"), loc = node.loc;
            if (!loc) throw new Error("CSS source location is unavailable.");
            capturedUrls++;
            jobs.push(Effect.gen(function* () {
              const data = yield* resource(url, "font");
              yield* Effect.try({ try: () => edits.push({ start: loc.start.offset, end: loc.end.offset, text: `url("${data}")` }), catch: asCodeError });
            }));
          }
        } });
        if (provider && capturedUrls === 0) fail("font-css", "Provider stylesheet has no downloadable font faces.");
      }, catch: asCodeError });
      for (const job of jobs) yield* job;
      return editsApplied(source, edits);
    });

    const tree = yield* Effect.try({ try: () => parse(html, { sourceCodeLocationInfo: true }), catch: asCodeError });
    const edits = editList(html);
    const visit = (node: DefaultTreeAdapterTypes.Node): Effect.Effect<void, CodeError> => Effect.gen(function* () {
      if ("tagName" in node) {
        const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
        const location = node.sourceCodeLocation, href = attrs.get("href") ?? "";
        if (node.tagName === "link" && remote(href)) {
          const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
          if (rel.includes("preconnect") || rel.includes("dns-prefetch")) {
            yield* Effect.try({ try: () => {
              let url: URL;
              try { url = new URL(href); } catch { return fail("font-provider", "Invalid font connection hint."); }
              if (url.protocol !== "https:" || !["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname) || url.username || url.password || url.port)
                fail("external-reference", "Only Google Fonts connection hints are supported.");
              if (!location) throw new Error("HTML source location is unavailable.");
              edits.push({ start: location.startOffset, end: location.endOffset, text: "" });
            }, catch: asCodeError });
            return;
          }
          if (rel.includes("preload") && (attrs.get("as") ?? "").toLowerCase() === "font") {
            const data = yield* resource(href, "font");
            yield* Effect.try({ try: () => {
              const loc = location?.attrs?.href;
              if (!loc) throw new Error("HTML attribute source location is unavailable.");
              edits.push({ start: loc.startOffset, end: loc.endOffset, text: `href="${data}"` });
            }, catch: asCodeError });
            return;
          }
          if (rel.includes("stylesheet")) {
            const text = yield* captureCss(yield* resource(href, "css"), { provider: true });
            yield* Effect.try({ try: () => {
              if (/<\/style/i.test(text)) fail("font-css", "Font stylesheet contains an HTML closing tag.");
              const mediaValue = attrs.get("media"), media = mediaValue ? ` media="${attrEscape(mediaValue)}"` : "";
              if (!location) throw new Error("HTML source location is unavailable.");
              edits.push({ start: location.startOffset, end: location.endOffset, text: `<style${media}>${text}</style>` });
            }, catch: asCodeError });
            return;
          }
        }
        for (const attr of node.attrs) {
          if (["src", "href", "xlink:href", "poster", "data", "action", "formaction"].includes(attr.name) && remote(attr.value))
            return yield* Effect.fail(coded("external-reference", "Remote HTML references other than Google Fonts stylesheets are not supported."));
          if (attr.name === "srcset" && /(?:https?:)?\/\//i.test(attr.value))
            return yield* Effect.fail(coded("external-reference", "Remote srcset references are not supported."));
          if (attr.name === "style") {
            const text = yield* captureCss(attr.value, { context: "declarationList" });
            if (text !== attr.value) yield* Effect.try({ try: () => {
              const loc = location?.attrs?.style;
              if (!loc) throw new Error("HTML attribute source location is unavailable.");
              edits.push({ start: loc.startOffset, end: loc.endOffset, text: `style="${attrEscape(text)}"` });
            }, catch: asCodeError });
          }
        }
        if (node.tagName === "style" && location?.startTag && location.endTag) {
          const start = location.startTag.endOffset, end = location.endTag.startOffset;
          const source = html.slice(start, end), text = yield* captureCss(source);
          if (text !== source) yield* Effect.try({ try: () => edits.push({ start, end, text }), catch: asCodeError });
        }
      }
      if ("childNodes" in node) for (const child of node.childNodes) yield* visit(child);
      if ("content" in node) yield* visit(node.content);
    });
    yield* visit(tree);
    const prepared = editsApplied(html, edits);
    if (encoder.encode(prepared).byteLength > FONT_LIMITS.documentBytes)
      return yield* Effect.fail(coded("font-limit", "Expanded document exceeds its stored byte limit."));
    const final = validateArtefactHtml(prepared, { gated, maxChars: FONT_LIMITS.documentBytes });
    if (final.errors.length) return yield* Effect.fail(Object.assign(new Error("Prepared document rejected by validation."), { code: "validation", issues: final.errors }));
    return { html: prepared, warnings: validation.warnings };
  });
}

// ---- prepared-content capabilities -------------------------------------------

/** Source-bound capabilities live only in the minting service's WeakMap, never on the wire. */
export function openArtifactService({ fetcher = fetch }: { fetcher?: FontFetcher } = {}): ArtifactService {
  const minted = new WeakMap<object, { source: string; gated: boolean; captured: PreparedArtifactHtml }>();
  return {
    /** Capture `source` once; the resolved document rides inside the returned capability. */
    prepare(source: unknown, { gated = false }: PreparationOptions = {}): Effect.Effect<object, CodeError> {
      return Effect.gen(function* () {
        if (typeof source !== "string") return yield* Effect.fail(coded("invalid-content", "Artefact content must be a string."));
        const captured = yield* prepareArtifactHtml(source, { fetcher, gated });
        const token = Object.freeze(Object.create(null) as object);
        minted.set(token, { source, gated: Boolean(gated), captured });
        return token;
      });
    },
    /** Open only a capability minted by THIS service for exactly `source`. */
    open(token: unknown, source: unknown): Effect.Effect<OpenedArtifactHtml | null, CodeError> {
      return Effect.sync(() => {
        if (typeof token !== "object" || token === null) return null;
        const sealed = minted.get(token);
        if (!sealed || sealed.source !== source) return null;
        return { html: sealed.captured.html, warnings: sealed.captured.warnings, gated: sealed.gated };
      });
    },
  };
}
