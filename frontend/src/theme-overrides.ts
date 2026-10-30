import { compileTheme, type CompiledTheme, type PlatformThemeDefinition } from "./theme-compiler.js";

/** Compile the same token and recipe overrides used by the hosted page presentation. */
export function compileThemeOverrides(base: CompiledTheme, value: unknown): CompiledTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Stored page theme overrides are invalid.");
  const overrides = value as Record<string, unknown>;
  if (Object.keys(overrides).some(key => key !== "tokens" && key !== "recipes")) throw new TypeError("Stored page theme overrides are invalid.");
  const rawTokens = overrides.tokens ?? {};
  const rawRecipes = overrides.recipes ?? {};
  if (!rawTokens || typeof rawTokens !== "object" || Array.isArray(rawTokens) || !rawRecipes || typeof rawRecipes !== "object" || Array.isArray(rawRecipes)) {
    throw new TypeError("Stored page theme overrides are invalid.");
  }
  const tokens: Record<string, string> = {};
  for (const [key, token] of Object.entries(rawTokens)) {
    const name = key.startsWith("--a67-") ? key.slice(6) : key;
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof token !== "string") throw new TypeError("Stored page theme overrides are invalid.");
    tokens[name] = token;
  }
  const definition: PlatformThemeDefinition = {
    slug: base.slug, name: base.name, description: base.description,
    tokens: {
      light: { ...base.tokens.light, ...tokens },
      dark: { ...base.tokens.dark, ...tokens },
    },
    recipes: { ...base.recipes, ...(rawRecipes as PlatformThemeDefinition["recipes"]) },
    logo: base.logo,
  };
  return compileTheme(definition);
}
