import type { FontFetcher } from "../src/fonts.js";

export const THEME_FONT_SOURCE = "https://fonts.googleapis.com/css2?family=Example:wght@400&display=swap";
const THEME_FONT_URL = "https://fonts.gstatic.com/s/example/v1/example.woff2";
const fontBytes = new Uint8Array(48);
fontBytes.set(new TextEncoder().encode("wOF2"));
new DataView(fontBytes.buffer).setUint32(8, fontBytes.length);
const face = (subset: string) => `/* ${subset} */ @font-face { font-family:'Example'; font-style:normal; font-weight:400; src:url('${THEME_FONT_URL}') format('woff2'); unicode-range:U+0000-00FF; }`;

export const themeFontFetcher: FontFetcher = async url => {
  if (url === THEME_FONT_SOURCE) return new Response(`${face("latin")}\n${face("latin-ext")}`, {
    headers: { "content-type": "text/css; charset=utf-8" },
  });
  if (url === THEME_FONT_URL) return new Response(fontBytes, { headers: { "content-type": "font/woff2" } });
  throw new Error(`Unexpected theme font URL: ${url}`);
};

export const validThemeDefinition = (slug = "brand") => ({
  slug,
  name: "Brand",
  extends: { scope: "platform" as const, slug: "report" },
  tokens: { light: {}, dark: {} },
  fonts: {
    heading: { family: "system-ui", stack: "system-ui, sans-serif" },
    body: { family: "system-ui", stack: "system-ui, sans-serif" },
    mono: { family: "ui-monospace", stack: "ui-monospace, monospace" },
  },
});
