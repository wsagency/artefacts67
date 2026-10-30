import { PAGE_KIT_CSS, PAGE_KIT_RUNTIME, themeConfigurationScript } from "./page-kit.js";
import { buildPageFrameBridge } from "./page-frame-bridge.js";
import type { CompiledTheme } from "./theme-compiler.js";

export type PageColorMode = "light" | "dark";

const escapeHtmlAttribute = (value: string) => value.replace(/[&"'<>]/g, character => {
  switch (character) {
    case "&": return "&amp;";
    case "\"": return "&quot;";
    case "'": return "&#39;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    default: return character;
  }
});

/** Maximum JavaScript string length for a fully composed page document. */
export const PAGE_DOCUMENT_MAX_LENGTH = 1_500_000;

export class PageCompositionError extends Error {
  readonly code = "composed-too-large";
  constructor() {
    super("The composed page document exceeds the 1,500,000-character limit.");
    this.name = "PageCompositionError";
  }
}

type DocumentParts = { head: string; headClose: string; suffix: string };
function pageDocumentParts(compiledTheme: CompiledTheme, mode: PageColorMode, origin: string, textSize: "s" | "m" | "l", lang: string, fontsCss = "", themeScope: "platform" | "project" = "platform"): DocumentParts {
  const base = new URL(origin);
  const images = ["/assets/favicon.ico", "/assets/ws-logo.svg"].map(path => new URL(path, base).href).join(" ");
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob: ${images}; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'`;
  const fontSize = textSize === "s" ? "87.5%" : textSize === "l" ? "120%" : "100%";
  const fontStyle = fontsCss ? `<style id="a67-page-fonts">${fontsCss}</style>` : "";
  return {
    head: `<!doctype html><html lang="${escapeHtmlAttribute(lang)}" data-theme="${mode}" data-a67-theme="${compiledTheme.slug}" style="font-size:${fontSize}"><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artefacts67 page</title><style id="a67-page-kit">${PAGE_KIT_CSS}</style>${fontStyle}<style id="a67-page-theme" data-theme-scope="${themeScope}" data-theme-slug="${compiledTheme.slug}">${compiledTheme.css}</style>`,
    headClose: "</head><body>",
    suffix: `<script>${PAGE_KIT_RUNTIME}</script><script>${themeConfigurationScript(compiledTheme)}</script></body></html>`,
  };
}

function documentLength(parts: DocumentParts, fragment: string): number {
  return parts.head.length + parts.headClose.length + fragment.length + parts.suffix.length;
}

/** Exact `.length` of the hosted page, including its executable parent bridge. */
export function hostedPageDocumentLength(fragment: string, compiledTheme: CompiledTheme, mode: PageColorMode, origin: string, textSize: "s" | "m" | "l", lang: string, nonce: string, canWrite: boolean, fontsCss = "", themeScope: "platform" | "project" = "platform"): number {
  const parts = pageDocumentParts(compiledTheme, mode, origin, textSize, lang, fontsCss, themeScope);
  const bridge = buildPageFrameBridge(nonce, mode, canWrite);
  return documentLength(parts, fragment) + bridge.length;
}

/** Exact `.length` of the same trusted shell used by the standalone composer. */
export function pageDocumentLength(fragment: string, compiledTheme: CompiledTheme, mode: PageColorMode, origin = globalThis.location?.origin ?? "https://example.test", textSize: "s" | "m" | "l" = "m", lang = "en", fontsCss = "", themeScope: "platform" | "project" = "platform"): number {
  return documentLength(pageDocumentParts(compiledTheme, mode, origin, textSize, lang, fontsCss, themeScope), fragment);
}

/** Build the trusted shell for a previously validated page fragment. */
export function composePageDocument(fragment: string, compiledTheme: CompiledTheme, mode: PageColorMode, origin = globalThis.location?.origin ?? "https://example.test", textSize: "s" | "m" | "l" = "m", lang = "en", fontsCss = "", themeScope: "platform" | "project" = "platform"): string {
  const parts = pageDocumentParts(compiledTheme, mode, origin, textSize, lang, fontsCss, themeScope);
  if (documentLength(parts, fragment) > PAGE_DOCUMENT_MAX_LENGTH) throw new PageCompositionError();
  return parts.head + parts.headClose + fragment + parts.suffix;
}

/** Hosted preview assembly includes the exact runtime bridge; downloads intentionally omit it. */
export function composeHostedPageDocument(fragment: string, compiledTheme: CompiledTheme, mode: PageColorMode, origin: string, textSize: "s" | "m" | "l", lang: string, nonce: string, canWrite: boolean, fontsCss = "", themeScope: "platform" | "project" = "platform"): string {
  const parts = pageDocumentParts(compiledTheme, mode, origin, textSize, lang, fontsCss, themeScope);
  const bridge = buildPageFrameBridge(nonce, mode, canWrite);
  if (documentLength(parts, fragment) + bridge.length > PAGE_DOCUMENT_MAX_LENGTH) throw new PageCompositionError();
  return parts.head + bridge + parts.headClose + fragment + parts.suffix;
}

/** Build the downloadable standalone page from the same trusted shell as the hosted preview. */
export function composePageDownload(fragment: string, compiledTheme: CompiledTheme, mode: PageColorMode, origin: string, textSize: "s" | "m" | "l" = "m", lang = "en", fontsCss = "", themeScope: "platform" | "project" = "platform"): string {
  return composePageDocument(fragment, compiledTheme, mode, origin, textSize, lang, fontsCss, themeScope);
}


