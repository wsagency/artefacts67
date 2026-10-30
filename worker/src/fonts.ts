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
type ThemeFaceFilter = ReadonlyMap<string, ReadonlySet<string>>;
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

function providerUrl(value: string, kind: ResourceKind, css2Only = false): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("font-provider", "Font URLs must be absolute HTTPS URLs."); }
  const host = kind === "css" ? "fonts.googleapis.com" : "fonts.gstatic.com";
  const cssPath = css2Only ? url.pathname === "/css2" : ["/css", "/css2"].includes(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password || url.hash ||
      (kind === "css" ? !cssPath : !url.pathname.startsWith("/s/")))
    fail("font-provider", `Only HTTPS ${host} ${kind === "css" ? css2Only ? "/css2 stylesheets" : "/css or /css2 stylesheets" : "/s/ font assets"} are supported.`);
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
export function prepareArtifactHtml(html: unknown, { fetcher = fetch, gated = false, themeFaceFilter }: PreparationOptions & {
  fetcher?: FontFetcher; themeFaceFilter?: ThemeFaceFilter;
} = {}): Effect.Effect<PreparedArtifactHtml, CodeError> {
  return Effect.gen(function* () {
    if (typeof html !== "string") return yield* Effect.fail(coded("invalid-content", "Artefact content must be a string."));
    const validation = validateArtefactHtml(html, { gated, checkReferences: false });
    if (validation.errors.length) return yield* Effect.fail(Object.assign(new Error("Document rejected by validation."), {
      code: "validation", issues: validation.errors,
    }));
    const started = yield* Clock.currentTimeMillis, cache = new Map<string, string>();
    let downloaded = 0, stylesheetCount = 0, fontCount = 0;

    const resource = (value: string, kind: ResourceKind, css2Only = false): Effect.Effect<string, CodeError> => Effect.gen(function* () {
      const initial = yield* Effect.try({ try: () => providerUrl(value, kind, css2Only), catch: asCodeError });
      const cacheKey = css2Only ? `${initial}\u0000css2` : initial;
      const cached = cache.get(cacheKey);
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
                  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" } }),
              catch: asCodeError,
            }).pipe(Effect.interruptible),
            (response) => Effect.gen(function* () {
              const meta = yield* Effect.try({ try: (): ResourceMeta => {
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                  if (redirects >= FONT_LIMITS.redirects) fail("font-fetch", "Too many font provider redirects.");
                  const location = response.headers.get("location");
                  if (!location) return fail("font-fetch", "Font provider redirect has no destination.");
                  return { redirect: providerUrl(new URL(location, url).href, kind, css2Only) };
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
          cache.set(cacheKey, step.data);
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

    const captureCss = (source: string, { context = "stylesheet", provider = false, themeFaceFilter, css2Only = false }: {
      context?: "stylesheet" | "declarationList"; provider?: boolean; themeFaceFilter?: ThemeFaceFilter; css2Only?: boolean;
    } = {}): Effect.Effect<string, CodeError> => Effect.gen(function* () {
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
      const providerRules = ast!.type === "StyleSheet" ? ast!.children.toArray() : [];
      const edits = editList(source), jobs: Effect.Effect<void, CodeError>[] = [];
      let capturedUrls = 0;
      yield* Effect.try({ try: () => {
        if (provider && syntaxErrors.length) fail("font-css", "Unsupported or invalid CSS syntax.");
        if (provider) {
          if (ast!.type !== "StyleSheet") return fail("font-css", "Unsupported or invalid CSS syntax.");
          providerRules.forEach((node) => {
            if (node.type !== "Atrule" || cssName(node.name) !== "font-face")
              fail("font-css", "Provider stylesheets may contain only font-face rules.");
          });
        }
        const selectedFaces = new Set<object>();
        if (provider && themeFaceFilter) {
          for (const candidate of providerRules) {
            if (candidate.type !== "Atrule" || cssName(candidate.name) !== "font-face" || !candidate.loc) continue;
            const start = candidate.loc.start.offset, end = candidate.loc.end.offset;
            const preceding = source.slice(0, start);
            const subset = /\/\*\s*(latin-ext|latin)\s*\*\/\s*$/.exec(preceding)?.[1];
            let weight: string | undefined, family: string | undefined;
            css.walk(candidate, node => {
              if (node.type !== "Declaration") return;
              const property = cssName(node.property);
              if (property === "font-weight") weight = css.generate(node.value);
              if (property === "font-family") family = css.generate(node.value).replace(/^['"]|['"]$/g, "").toLocaleLowerCase();
            });
            const weights = family ? themeFaceFilter.get(family) : undefined;
            if ((subset === "latin" || subset === "latin-ext") && weights && weight &&
                (weights.has(weight) || weights.has(weight.replace(/\s+/g, "..")))) {
              selectedFaces.add(candidate);
            } else {
              edits.push({ start, end, text: "" });
            }
          }
        }
        css.walk(ast!, { enter(this: css.WalkContext, node: css.CssNode) {
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
              let text = yield* captureCss(yield* resource(url, "css", css2Only), {
                provider: true, themeFaceFilter, css2Only,
              });
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
            if (provider && themeFaceFilter && !selectedFaces.has(this.atrule!)) return;
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
            const text = yield* captureCss(yield* resource(href, "css", !!themeFaceFilter), {
              provider: true, themeFaceFilter, css2Only: !!themeFaceFilter,
            });
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

/** Captures and seals the Google CSS2 WOFF2 faces used by one project theme. */
export function captureThemeFonts(sources: readonly string[], { fetcher = fetch, families }: { fetcher?: FontFetcher; families?: readonly string[] } = {}): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  return Effect.gen(function* () {
    if (sources.length > 8) return yield* Effect.fail(coded("font-limit", "A project theme may use at most eight font sources."));
    const allowedWeights = new Map<string, Set<string>>();
    for (const source of sources) {
      let url: URL;
      try { url = new URL(source); } catch { return yield* Effect.fail(coded("font-provider", "Font URLs must be absolute Google CSS2 URLs.")); }
      if (url.protocol !== "https:" || url.hostname !== "fonts.googleapis.com" || url.pathname !== "/css2" ||
          url.port || url.username || url.password || url.hash)
        return yield* Effect.fail(coded("font-provider", "Project theme fonts require approved Google CSS2 URLs."));
      for (const family of url.searchParams.getAll("family")) {
        const [name, ...axes] = family.split(":");
        const axis = axes.join(":");
        const weightIndex = axis.indexOf("wght@");
        const requested = weightIndex >= 0 ? axis.slice(weightIndex + "wght@".length)
          .split(";").map(tuple => tuple.split(",").at(-1) ?? "").filter(Boolean) : [];
        if (!requested.length || !name) continue;
        if (families && !families.some(declared => declared.toLocaleLowerCase() === name.toLocaleLowerCase()))
          return yield* Effect.fail(coded("font-css", "Google CSS2 requests a font family not declared by the theme."));
        const key = name.toLocaleLowerCase();
        let weights = allowedWeights.get(key);
        if (!weights) {
          weights = new Set();
          allowedWeights.set(key, weights);
        }
        for (const weight of requested) weights.add(weight);
      }
    }
    if (sources.length && allowedWeights.size === 0)
      return yield* Effect.fail(coded("font-css", "Project theme font sources must declare requested weights."));
    const links = sources.map(source => `<link rel="stylesheet" href="${attrEscape(source)}">`).join("");
    const html = `<!doctype html><html><head>${links}</head><body></body></html>`;
    const prepared = yield* prepareArtifactHtml(html, { fetcher, themeFaceFilter: allowedWeights });
    const styles = [...prepared.html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map(match => match[1]!);
    const selected: string[] = [];
    let fontBytes = 0;
    for (const stylesheet of styles) {
      const parsed = css.parse(stylesheet, { positions: true });
      if (parsed.type !== "StyleSheet") return yield* Effect.fail(coded("font-css", "Google CSS2 returned an invalid stylesheet."));
      for (const rule of parsed.children.toArray()) {
        if (rule.type !== "Atrule" || cssName(rule.name) !== "font-face" || !rule.loc)
          return yield* Effect.fail(coded("font-css", "Google CSS2 may contain only font-face rules."));
        const start = rule.loc.start.offset, end = rule.loc.end.offset;
        const preceding = stylesheet.slice(0, start);
        const subset = /\/\*\s*(latin-ext|latin)\s*\*\/\s*$/.exec(preceding)?.[1];
        if (subset !== "latin" && subset !== "latin-ext") continue;
        let weight: string | undefined, faceUrl: string | undefined, family: string | undefined;
        css.walk(rule, node => {
          if (node.type !== "Declaration") {
            if (node.type === "Url") faceUrl = node.value;
            return;
          }
          const property = cssName(node.property);
          if (property === "font-weight") weight = css.generate(node.value);
          if (property === "font-family") family = css.generate(node.value).replace(/^['"]|['"]$/g, "").toLocaleLowerCase();
        });
        if (!weight || !faceUrl || !family) continue;
        const requestedWeights = allowedWeights.get(family);
        if (!requestedWeights || (!requestedWeights.has(weight) && !requestedWeights.has(weight.replace(/\s+/g, "..")))) continue;
        const faceCss = stylesheet.slice(start, end);
        if (/data:font\/(?:woff|otf|ttf);base64,/i.test(faceCss))
          return yield* Effect.fail(coded("font-format", "Project theme font faces must contain only WOFF2 data."));
        const dataUrl = /url\(["']?(data:font\/woff2;base64,[A-Za-z0-9+/=]+)["']?\)/.exec(faceCss)?.[1];
        if (!dataUrl) return yield* Effect.fail(coded("font-format", "Google CSS2 theme faces must be WOFF2."));
        const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const bytes = atob(encoded).length;
        fontBytes += bytes;
        if (fontBytes > 256 * 1024) return yield* Effect.fail(coded("font-limit", "Resolved project theme fonts exceed 256 KiB."));
        const comment = /\/\*\s*(?:latin-ext|latin)\s*\*\/\s*$/.exec(preceding)?.[0] ?? "";
        selected.push(`${comment}${stylesheet.slice(start, end)}`);
      }
    }
    if (sources.length && selected.length === 0)
      return yield* Effect.fail(coded("font-css", "Google CSS2 returned no declared Latin WOFF2 faces."));
    return encoder.encode(selected.join("\n")) as Uint8Array<ArrayBuffer>;
  });
}

/** Measures actual embedded bytes rather than the base64/descriptor payload size. */
export function themeFontByteLength(fontPayload: Uint8Array): number {
  const stylesheet = new TextDecoder("utf-8", { fatal: true }).decode(fontPayload);
  const source = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g;
  let total = 0, face: RegExpExecArray | null;
  while ((face = source.exec(stylesheet))) total += atob(face[1]!).length;
  return total;
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
