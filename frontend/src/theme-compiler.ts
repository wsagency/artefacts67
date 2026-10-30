export const COLOR_TOKENS = [
  "bg", "surface", "ink", "muted", "line", "accent", "accent-ink", "on-accent",
  "ok", "warn", "crit", "focus", "c1", "c2", "c3", "c4", "c5", "c6",
] as const;
const REQUIRED_TOKENS = [...COLOR_TOKENS, "font-heading", "font-body", "font-mono", "radius", "space", "density", "shadow"] as const;
const TEXT_PAIRS = [["ink", "bg"], ["ink", "surface"], ["muted", "bg"], ["muted", "surface"], ["accent-ink", "bg"], ["on-accent", "accent"]] as const;
const UI_PAIRS = [["line", "bg"], ["focus", "bg"], ...(["c1", "c2", "c3", "c4", "c5", "c6", "ok", "warn", "crit"] as const).map(token => [token, "bg"] as const)] as const;
const RECIPE_KEYS: Record<string, true> = { aurora: true, glow: true };
const AURORA_COLOR_TOKENS: Record<string, true> = { accent: true, c1: true, c2: true, c3: true, c4: true, c5: true, c6: true };
const GLOW_COLOR_TOKENS: Record<string, true> = { accent: true, c1: true, c2: true, c3: true, c4: true, c5: true, c6: true };
const SAFE_FONT = /^(?:"[\w -]+"|(?:[_A-Za-z]|-{1,2}[A-Za-z_])[\w-]*)(?:\s*,\s*(?:"[\w -]+"|(?:[_A-Za-z]|-{1,2}[A-Za-z_])[\w-]*))*$/;

export interface ThemeTokens { [key: string]: string }
export interface AuroraRecipe { colors: readonly [string, string, string]; intensity: number; angle: number; positions: readonly [string, string, string] }
export interface GlowRecipe { color: string; intensity: number }
export interface PlatformThemeDefinition {
  slug: string;
  name: string;
  description: string;
  tokens: { light: ThemeTokens; dark: ThemeTokens };
  recipes: { aurora?: AuroraRecipe; glow?: GlowRecipe };
  logo?: string | null;
}
export interface CompiledTheme {
  slug: string;
  name: string;
  description: string;
  tokens: { light: Readonly<ThemeTokens>; dark: Readonly<ThemeTokens> };
  recipes: Readonly<{ aurora?: Readonly<AuroraRecipe>; glow?: Readonly<GlowRecipe> }>;
  css: string;
  logo: string | null;
}

function validLogo(value: string): boolean {
  const match = /^data:image\/(png|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return false;
  let bytes: Uint8Array;
  try {
    const binary = atob(match[2]!);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { return false; }
  if (bytes.length > 32 * 1024) return false;
  const canonical: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x6000)
    canonical.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
  if (canonical.join("") !== match[2]) return false;
  if (match[1] === "png") {
    if (bytes.length < 45 || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return false;
    const readUint32 = (offset: number) => bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000 + bytes[offset + 2]! * 0x100 + bytes[offset + 3]!;
    if (readUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return false;
    const width = readUint32(16), height = readUint32(20);
    if (!width || !height || width > 512 || height > 512) return false;
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = readUint32(offset), next = offset + length + 12;
      if (next > bytes.length) return false;
      if (offset === 8 && (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR" || length !== 13)) return false;
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "IEND") {
        ended = length === 0 && next === bytes.length;
        break;
      }
      offset = next;
    }
    return ended;
  }
  let svg: string;
  try { svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return false; }
  const root = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="([\d. -]+)">([\s\S]*)<\/svg>$/.exec(svg);
  if (!root) return false;
  const box = root[1]!.trim().split(/\s+/).map(Number);
  if (box.length !== 4 || box.some(value => !Number.isFinite(value)) || box[2]! <= 0 || box[3]! <= 0 || box[2]! > 4096 || box[3]! > 4096) return false;
  const element = /<(path|circle|rect|line|polygon|polyline)([^<>]*)\/>/g;
  const attribute = /\s+([a-z-]+)="([^"]*)"/g;
  const numeric = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  const color = /^(?:#[0-9a-fA-F]{3,8}|none|currentColor)$/;
  let body = root[2]!, matchElement: RegExpExecArray | null, consumed = "";
  while ((matchElement = element.exec(body))) {
    if (matchElement.index !== consumed.length) return false;
    let attrs = matchElement[2]!, consumedAttrs = "", matchAttribute: RegExpExecArray | null;
    attribute.lastIndex = 0;
    while ((matchAttribute = attribute.exec(attrs))) {
      if (matchAttribute.index !== consumedAttrs.length) return false;
      consumedAttrs += matchAttribute[0];
      const [, name, value] = matchAttribute;
      if (name === "d") {
        if (matchElement[1] !== "path" || !/^[-+0-9., MmLlHhVvCcSsQqTtAaZzEe]{1,4096}$/.test(value!)) return false;
      } else if (name === "fill" || name === "stroke") {
        if (!color.test(value!)) return false;
      } else if (!["cx", "cy", "r", "x", "y", "x1", "x2", "y1", "y2", "width", "height"].includes(name!) || !numeric.test(value!)) return false;
    }
    if (consumedAttrs !== attrs) return false;
    consumed += matchElement[0];
  }
  return consumed.length === body.length;
}
function fail(message: string): never { throw new TypeError(`Invalid theme: ${message}`); }
function parseHex(value: string): [number, number, number] | null {
  const match = /^#([\da-f]{6})$/i.exec(value);
  if (!match) return null;
  const hex = match[1]!;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function luminance(value: string): number {
  const rgb = parseHex(value);
  if (!rgb) return fail(`invalid color token ${value}`);
  const linear = rgb.map(component => { const channel = component / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
function validateTokens(definition: PlatformThemeDefinition, scheme: "light" | "dark"): Readonly<ThemeTokens> {
  const source = definition.tokens?.[scheme];
  if (!source || Object.keys(source).length !== REQUIRED_TOKENS.length || REQUIRED_TOKENS.some(token => !(token in source))) fail(`missing or unknown ${scheme} token`);
  const tokens: ThemeTokens = {};
  for (const token of COLOR_TOKENS) {
    const value = source[token];
    if (typeof value !== "string" || !parseHex(value)) fail(`invalid ${scheme} ${token} token`);
    tokens[token] = value;
  }
  for (const token of ["font-heading", "font-body", "font-mono"] as const) {
    const value = source[token];
    if (typeof value !== "string" || value.length > 160 || !SAFE_FONT.test(value)) fail(`invalid ${scheme} ${token} token`);
    tokens[token] = value;
  }
  const fixed = { radius: /^(?:0|\.35rem|\.75rem|1rem|1\.25rem|999px)$/, space: /^\d+(?:\.\d+)?rem$/, shadow: /^(?:none|0 12px 36px #1729441c|0 16px 40px #1729441c)$/i } as const;
  for (const token of ["radius", "space", "shadow"] as const) {
    const value = source[token];
    if (typeof value !== "string" || !fixed[token].test(value)) fail(`invalid ${scheme} ${token} token`);
    tokens[token] = value;
  }
  const density = Number(source.density);
  if (typeof source.density !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(source.density) || !Number.isFinite(density) || density < 0.75 || density > 1.25) fail(`invalid ${scheme} density token`);
  tokens.density = source.density;
  for (const [fg, bg] of TEXT_PAIRS) if (contrastRatio(tokens[fg]!, tokens[bg]!) < 4.5) fail(`${scheme} ${fg}/${bg} contrast below 4.5:1`);
  for (const [fg, bg] of UI_PAIRS) if (contrastRatio(tokens[fg]!, tokens[bg]!) < 3) fail(`${scheme} ${fg}/${bg} contrast below 3:1`);
  return Object.freeze(tokens);
}
function blend(foreground: string, background: string, alpha: number): string {
  const top = parseHex(foreground)!, bottom = parseHex(background)!;
  return `#${top.map((channel, i) => Math.round(channel * alpha + bottom[i]! * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}
function validateRecipes(definition: PlatformThemeDefinition, tokens: { light: ThemeTokens; dark: ThemeTokens }): Readonly<{ aurora?: Readonly<AuroraRecipe>; glow?: Readonly<GlowRecipe> }> {
  const recipes = definition.recipes ?? {};
  if (Object.keys(recipes).some(key => RECIPE_KEYS[key] !== true)) fail("unregistered recipe or CSS property");
  const checked: { aurora?: Readonly<AuroraRecipe>; glow?: Readonly<GlowRecipe> } = {};
  if (recipes.aurora) {
    const recipe = recipes.aurora;
    if (Object.keys(recipe).sort().join(",") !== "angle,colors,intensity,positions" || !Array.isArray(recipe.colors) || recipe.colors.length !== 3 || recipe.colors.some(color => AURORA_COLOR_TOKENS[color] !== true) ||
      !Number.isFinite(recipe.intensity) || recipe.intensity < 0.4 || recipe.intensity > 0.72 || !Number.isFinite(recipe.angle) || recipe.angle < 0 || recipe.angle > 360 ||
      !Array.isArray(recipe.positions) || recipe.positions.length !== 3 || recipe.positions.some(position => {
        const match = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(position);
        return !match || Number(match[1]) > 100 || Number(match[2]) > 100;
      })) fail("aurora recipe out of bounds");
    for (const scheme of ["light", "dark"] as const) {
      const surface = tokens[scheme].surface, ink = tokens[scheme].ink;
      const wash = [blend(tokens[scheme].accent, surface, 36 / 255), blend(tokens[scheme].c5, surface, 36 / 255)];
      for (const color of recipe.colors) {
        const stops = [1, 0.78, 0.64].map(factor => blend(tokens[scheme][color]!, surface, Math.round(recipe.intensity * factor * 255) / 255));
        for (const composite of [...stops, ...wash]) if (contrastRatio(ink, composite) < 4.5) fail(`${definition.slug} ${scheme} aurora ${color} on ${composite} contrast ${contrastRatio(ink, composite).toFixed(2)} below 4.5:1`);
      }
      if (contrastRatio(ink, surface) < 4.5) fail(`${scheme} aurora surface text contrast below 4.5:1`);
    }
    checked.aurora = Object.freeze({ colors: Object.freeze([...recipe.colors]) as unknown as readonly [string, string, string], intensity: recipe.intensity, angle: recipe.angle, positions: Object.freeze([...recipe.positions]) as unknown as readonly [string, string, string] });
  }
  if (recipes.glow) {
    const recipe = recipes.glow;
    if (Object.keys(recipe).sort().join(",") !== "color,intensity" || GLOW_COLOR_TOKENS[recipe.color] !== true || !Number.isFinite(recipe.intensity) || recipe.intensity < 0 || recipe.intensity > 0.4) fail("glow recipe out of bounds");
    for (const scheme of ["light", "dark"] as const) if (contrastRatio(tokens[scheme].ink, tokens[scheme].surface) < 4.5) fail(`${scheme} glow text contrast below 4.5:1`);
    checked.glow = Object.freeze({ color: recipe.color, intensity: recipe.intensity });
  }
  return Object.freeze(checked);
}

export function compileTheme(input: PlatformThemeDefinition): CompiledTheme {
  if (!input || !/^[a-z][a-z0-9-]{0,47}$/.test(input.slug) || typeof input.name !== "string" || input.name.length < 1 || input.name.length > 80 || /[<>\u0000-\u001f]/.test(input.name) ||
    typeof input.description !== "string" || input.description.length > 240 || /[<>\u0000-\u001f]/.test(input.description)) fail("invalid theme identity");
  const definition: PlatformThemeDefinition = {
    slug: input.slug, name: input.name, description: input.description,
    tokens: { light: { ...input.tokens?.light }, dark: { ...input.tokens?.dark } },
    recipes: structuredClone(input.recipes ?? {}), logo: input.logo ?? null,
  };
  if (Object.keys(input).some(key => !["slug", "name", "description", "tokens", "recipes", "logo"].includes(key))) fail("unrecognized theme key");
  if (definition.logo !== null && (typeof definition.logo !== "string" || !validLogo(definition.logo))) fail("invalid resolved logo token");
  const light = validateTokens(definition, "light"), dark = validateTokens(definition, "dark");
  const recipes = validateRecipes(definition, { light: light as ThemeTokens, dark: dark as ThemeTokens });
  const css: string[] = [`@layer theme{[data-a67-theme="${definition.slug}"]{`];
  for (const [scheme, values] of [["light", light], ["dark", dark]] as const) {
    css.push(scheme === "light" ? "" : `}[data-a67-theme="${definition.slug}"][data-theme="dark"]{`);
    for (const [token, value] of Object.entries(values)) css.push(`--a67-${token}:${value};`);
  }
  css.push("}}");
  for (const scheme of ["light", "dark"] as const) {
    const values = definition.tokens[scheme], selector = `[data-a67-theme="${definition.slug}"]${scheme === "dark" ? `[data-theme="dark"]` : ""}`;
    if (recipes.aurora) {
      const recipe = recipes.aurora;
      const heroHeaderSelector = `header[data-variant="hero"][data-style="aurora"]`;
      const heroFigureSelector = `${heroHeaderSelector} > figure`;
      const heroFigure = `${selector} ${heroFigureSelector}`;
      const inverseSurfaceText = `:is(h1,h2,h3,h4,h5,h6,a):not(${heroFigure} [data-tone="inverse"]):not(${heroFigure} [data-tone="inverse"] *)`;
      const inverseSurfaceTextSelector = `${selector} [data-tone="inverse"] ${heroFigureSelector} ${inverseSurfaceText},${selector} ${heroHeaderSelector}[data-tone="inverse"] > figure ${inverseSurfaceText}`;
      css.push(`@layer recipes{${heroFigure}{position:relative;isolation:isolate;background-color:var(--a67-surface);color:var(--a67-ink)}${heroFigure}::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background-image:radial-gradient(ellipse at ${recipe.positions[0]},${values[recipe.colors[0]]}${Math.round(recipe.intensity * 255).toString(16).padStart(2, "0")},transparent 60%),radial-gradient(ellipse at ${recipe.positions[1]},${values[recipe.colors[1]]}${Math.round(recipe.intensity * 0.78 * 255).toString(16).padStart(2, "0")},transparent 62%),radial-gradient(ellipse at ${recipe.positions[2]},${values[recipe.colors[2]]}${Math.round(recipe.intensity * 0.64 * 255).toString(16).padStart(2, "0")},transparent 64%),linear-gradient(${recipe.angle}deg,${values.accent}24,${values.c5}24)}${heroFigure}>:not(figcaption):not([data-tone="inverse"]){background-color:var(--a67-surface);color:var(--a67-ink)}${heroFigure}>[data-tone="inverse"]{background-color:var(--a67-accent);color:var(--a67-on-accent)}${inverseSurfaceTextSelector}{color:var(--a67-ink)}${heroFigure} figcaption{position:relative;background-color:var(--a67-surface);color:var(--a67-muted)}${heroFigure} figcaption[data-tone="inverse"]{background-color:var(--a67-accent);color:var(--a67-on-accent)}${heroFigure} svg text:not([fill]){fill:var(--a67-ink)}}`);
    }
    if (recipes.glow) css.push(`@layer recipes{${selector} a67-kpi[data-style="glow"]>[role="group"]{display:block;background-color:var(--a67-surface);color:var(--a67-ink);box-shadow:${recipes.glow.intensity === 0 ? "none" : `inset 0 0 0 ${recipes.glow.intensity * 4}px ${values[recipes.glow.color]}40`}}}`);
  }
  return Object.freeze({ slug: definition.slug, name: definition.name, description: definition.description, tokens: Object.freeze({ light, dark }), recipes, css: css.join(""), logo: definition.logo ?? null });
}
