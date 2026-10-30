import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLATFORM_THEMES } from "../../frontend/src/platform-themes.js";
import { themeConfigurationScript } from "../../frontend/src/page-kit.js";
import { compileTheme, contrastRatio, type PlatformThemeDefinition } from "../../frontend/src/theme-compiler.js";

const requiredTokens = ["bg", "surface", "ink", "muted", "line", "accent", "accent-ink", "on-accent", "ok", "warn", "crit", "focus", "c1", "c2", "c3", "c4", "c5", "c6"] as const;
const textPairs = [["ink", "bg"], ["ink", "surface"], ["muted", "bg"], ["muted", "surface"], ["accent-ink", "bg"], ["on-accent", "accent"]] as const;
const uiPairs = [["line", "bg"], ["focus", "bg"], ...(["c1", "c2", "c3", "c4", "c5", "c6", "ok", "warn", "crit"] as const).map(token => [token, "bg"] as const)] as const;
const sourceDefinition = (theme = PLATFORM_THEMES[0]!): PlatformThemeDefinition => ({
  slug: theme.slug, name: theme.name, description: theme.description,
  tokens: { light: { ...theme.tokens.light }, dark: { ...theme.tokens.dark } },
  recipes: structuredClone(theme.recipes), logo: theme.logo,
});

test("platform themes have every required light and dark token and meet appendix contrast ratios", () => {
  assert.deepEqual(PLATFORM_THEMES.map(theme => theme.slug), ["report", "editorial", "launch"]);
  for (const theme of PLATFORM_THEMES) for (const scheme of ["light", "dark"] as const) {
    const tokens = theme.tokens[scheme];
    for (const token of requiredTokens) assert.match(tokens[token] ?? "", /^#[0-9a-f]{6}$/i, `${theme.slug}.${scheme}.${token}`);
    for (const [fg, bg] of textPairs) assert(contrastRatio(tokens[fg], tokens[bg]) >= 4.5, `${theme.slug}.${scheme}: ${fg}/${bg}`);
    for (const [fg, bg] of uiPairs) assert(contrastRatio(tokens[fg], tokens[bg]) >= 3, `${theme.slug}.${scheme}: ${fg}/${bg}`);
  }
});

test("compiler rejects missing, malformed, and low-contrast required tokens", () => {
  const source = sourceDefinition();
  const invalid = [
    { ...source, tokens: { ...source.tokens, light: { ...source.tokens.light, ink: undefined } } },
    { ...source, tokens: { ...source.tokens, light: { ...source.tokens.light, ink: "red; background:url(https://evil.test)" } } },
    { ...source, tokens: { ...source.tokens, light: { ...source.tokens.light, ink: "#777777" } } },
  ] as unknown as PlatformThemeDefinition[];
  for (const definition of invalid) assert.throws(() => compileTheme(definition), /token|contrast/i);
});

test("compiler rejects unbounded aurora values and any unaudited CSS input", () => {
  const source = sourceDefinition();
  assert.throws(() => compileTheme({ ...source, recipes: { ...source.recipes, aurora: { ...source.recipes.aurora!, intensity: 0.73 } } }), /aurora|bound/i);
  assert.throws(() => compileTheme({ ...source, recipes: { ...source.recipes, aurora: { ...source.recipes.aurora!, css: "body{display:none}" } } } as unknown as PlatformThemeDefinition), /recipe|key|css/i);
});

test("aurora validates declared stops, wash endpoints, and rendered text contrast at worst compositing", () => {
  const source = sourceDefinition();
  const bad = {
    ...source,
    tokens: { ...source.tokens, dark: { ...source.tokens.dark, accent: "#b3caff", "on-accent": "#121a29" } },
    recipes: { ...source.recipes, aurora: { ...source.recipes.aurora!, colors: ["accent", "accent", "accent"], intensity: 0.72 } },
  };
  assert.throws(() => compileTheme(bad as unknown as PlatformThemeDefinition), /aurora accent on .* contrast .* below 4.5:1/);
});

test("only bounded recipes with passing composite checks are emitted as theme-scoped CSS", () => {
  for (const theme of PLATFORM_THEMES) {
    assert.match(theme.css, new RegExp(`\\[data-a67-theme=\\"${theme.slug}\\"\\]`));
    assert(!/grain|band/.test(theme.css));
    assert(!/url\(|@import|expression\(/i.test(theme.css));
    assert.equal(theme.logo ?? null, null);
  }
});

test("zero-intensity glow emits no visible shadow", () => {
  const source = sourceDefinition();
  const theme = compileTheme({ ...source, recipes: { glow: { color: "accent", intensity: 0 } } });
  assert.match(theme.css, /box-shadow:none/);
});

test("compiled resolved logo token is preserved for Task 6 page-kit configuration", () => {
  const logo = `data:image/png;base64,${readFileSync(new URL("./fixtures/page-image.png", import.meta.url), { encoding: "base64" })}`;
  const theme = compileTheme({ ...sourceDefinition(), logo });
  assert.equal(theme.logo, logo);
  assert.equal(themeConfigurationScript(theme), `window.__a67PageKit.configure({logo:${JSON.stringify(logo)}});`);
});
test("font tokens require complete, balanced CSS family stacks and valid identifiers", () => {
  const source = sourceDefinition();
  const unmatchedQuote = { ...source.tokens.dark, "font-heading": "'" };
  assert.throws(() => compileTheme({ ...source, tokens: { ...source.tokens, dark: unmatchedQuote } }), /font/i);
  const numericIdentifier = { ...source.tokens.light, "font-heading": "123, sans-serif" };
  assert.throws(() => compileTheme({ ...source, tokens: { ...source.tokens, light: numericIdentifier } }), /font/i);
});

test("aurora gives direct figure text and child content a checked opaque surface", () => {
  const theme = compileTheme(sourceDefinition());
  assert.match(theme.css, /header\[data-variant="hero"\]\[data-style="aurora"\]\s*>\s*figure\{[^}]*background-color:var\(--a67-surface\);color:var\(--a67-ink\)/);
  assert.match(theme.css, /figure\s*>\s*:not\(figcaption\):not\(\[data-tone="inverse"\]\)\{background-color:var\(--a67-surface\);color:var\(--a67-ink\)\}/);
  assert.match(theme.css, /figcaption\{[^}]*background-color:var\(--a67-surface\)/);
});

test("aurora and glow keep ancestor inverse-region text on their checked opaque surfaces", () => {
  const theme = compileTheme(sourceDefinition());
  assert.match(theme.css, /\[data-tone="inverse"\]\s+header\[data-variant="hero"\]\[data-style="aurora"\]\s*>\s*figure/);
  assert.match(theme.css, /:is\(h1,h2,h3,h4,h5,h6,a\):not\([^)]*\[data-tone="inverse"\]\):not\([^)]*\[data-tone="inverse"\]\s+\*\)\{color:var\(--a67-ink\)\}/);
  assert.match(theme.css, /a67-kpi\[data-style="glow"\]>\[role="group"\]\{[^}]*background-color:var\(--a67-surface\);color:var\(--a67-ink\)/);
});

test("aurora figure surfaces handle inverse tone on the hero header itself", () => {
  const theme = compileTheme(sourceDefinition());
  assert.match(theme.css, /\[data-a67-theme="report"\]\s+header\[data-variant="hero"\]\[data-style="aurora"\]\[data-tone="inverse"\]\s*>\s*figure/);
});

test("aurora inverse child headings and inverse captions retain checked accent foreground pairs", () => {
  const theme = compileTheme(sourceDefinition());
  assert.match(theme.css, /figure>\[data-tone="inverse"\]\{background-color:var\(--a67-accent\);color:var\(--a67-on-accent\)\}/);
  assert.match(theme.css, /figcaption\[data-tone="inverse"\]\{background-color:var\(--a67-accent\);color:var\(--a67-on-accent\)\}/);
  assert.match(theme.css, /:not\([^)]*\[data-tone="inverse"\]\):not\([^)]*\[data-tone="inverse"\]\s+\*\)\{color:var\(--a67-ink\)\}/);
});
test("aurora preserves nested inverse regions within surface-painted children", () => {
  const theme = compileTheme(sourceDefinition());
  assert.match(theme.css, /figure\s*>\s*:not\(figcaption\):not\(\[data-tone="inverse"\]\)/);
  assert.match(theme.css, /:not\([^{}]*\[data-tone="inverse"\][^{}]*\s+\*\)\{color:var\(--a67-ink\)\}/);
});

test("aurora leaves explicitly painted SVG text unchanged", () => {
  const theme = compileTheme(sourceDefinition());
  assert.match(theme.css, /figure svg text:not\(\[fill\]\)\{fill:var\(--a67-ink\)\}/);
});

test("compiler rejects malformed and oversized logo bytes and accepts the 512px limit", () => {
  const source = sourceDefinition();
  const fixture = readFileSync(new URL("./fixtures/page-image.png", import.meta.url), { encoding: "base64" });
  const logo = `data:image/png;base64,${fixture}`;
  assert.equal(compileTheme({ ...source, logo }).logo, logo);
  assert.throws(() => compileTheme({ ...source, logo: "data:image/png;base64,AA==" }), /logo/i);
  assert.throws(() => compileTheme({ ...source, logo: `data:image/png;base64,${"A".repeat(44_000)}` }), /logo/i);
  const png = (width: number, height: number) => {
    const bytes = Uint8Array.from(atob(fixture), character => character.charCodeAt(0));
    const writeDimension = (offset: number, value: number) => bytes.set([value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255], offset);
    writeDimension(16, width);
    writeDimension(20, height);
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  };
  assert.doesNotThrow(() => compileTheme({ ...source, logo: png(512, 512) }));
  assert.throws(() => compileTheme({ ...source, logo: png(513, 512) }), /logo/i);
  assert.throws(() => compileTheme({ ...source, logo: png(512, 513) }), /logo/i);
});

test("compiler rejects malformed and oversized logo bytes and accepts a validated PNG", () => {
  const source = sourceDefinition();
  const fixture = readFileSync(new URL("./fixtures/page-image.png", import.meta.url), { encoding: "base64" });
  const logo = `data:image/png;base64,${fixture}`;
  assert.equal(compileTheme({ ...source, logo }).logo, logo);
  assert.throws(() => compileTheme({ ...source, logo: "data:image/png;base64,AA==" }), /logo/i);
  assert.throws(() => compileTheme({ ...source, logo: `data:image/png;base64,${"A".repeat(44_000)}` }), /logo/i);
  const oversized = Uint8Array.from(atob(fixture), character => character.charCodeAt(0));
  oversized.set([0, 0, 16, 1], 16);
  assert.throws(() => compileTheme({ ...source, logo: `data:image/png;base64,${btoa(String.fromCharCode(...oversized))}` }), /logo/i);
});

test("compiler rejects active SVG logo content and accepts only the safe shape subset", () => {
  const source = sourceDefinition();
  const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`).toString("base64")}`;
  const safe = svg('<path d="M0 0L10 10" fill="#123456"/>');
  assert.equal(compileTheme({ ...source, logo: safe }).logo, safe);
  assert.throws(() => compileTheme({ ...source, logo: svg('<script>alert(1)</script>') }), /logo/i);
  assert.throws(() => compileTheme({ ...source, logo: svg('<image href="https://example.test/x"/>') }), /logo/i);
});
