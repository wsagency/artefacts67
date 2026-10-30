import { Effect } from "effect";
import { COLOR_TOKENS, compileTheme, contrastRatio, type CompiledTheme, type PlatformThemeDefinition } from "../../frontend/src/theme-compiler.js";
import { getPlatformTheme } from "../../frontend/src/platform-themes.js";
import { openBlob, randomHex, sealBlob, utf8 } from "./crypto.js";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";
import { captureThemeFonts, themeFontByteLength, type FontFetcher } from "./fonts.js";

const enc = new TextEncoder();
const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

export interface ThemeRef { scope: "platform" | "project"; slug: string }
export interface ProjectThemeSnapshot {
  id: string;
  folderId: string;
  slug: string;
  currentRevision: number;
  revision: number;
  definition: unknown;
  actorId: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectThemeSummary {
  id: string;
  folderId: string;
  slug: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ResolvedProjectTheme {
  theme: ThemeRef;
  themeResolution: "explicit" | "fallback";
  compiledTheme: CompiledTheme;
  fontsCss: string;
  brandLock: boolean;
}
export interface ProjectThemeModel {
  /** Internal persistence boundary. Call only after validation and font capture. */
  define(input: { folderId: string; slug: string; definition: unknown; actorId: string; ifRevision?: number }): Effect.Effect<ProjectThemeSnapshot, CodeError>;
  get(input: { folderId: string; theme: ThemeRef }): Effect.Effect<ProjectThemeSnapshot | CompiledTheme, CodeError>;
  list(input: { folderId: string }): Effect.Effect<ProjectThemeSummary[], CodeError>;
  resolveForRead(input: { folderId: string; theme: ThemeRef | null; themeId?: string | null }): Effect.Effect<ResolvedProjectTheme, CodeError>;
  setDefault(input: { folderId: string; theme: ThemeRef | null; actorId: string }): Effect.Effect<void, CodeError>;
  setBrandLock(input: { folderId: string; brandLock: boolean; actorId: string }): Effect.Effect<void, CodeError>;
  delete(input: { folderId: string; slug: string; actorId: string }): Effect.Effect<void, CodeError>;
}

interface RevisionRow {
  id: string;
  folder_id: string;
  slug: string;
  current_revision: number;
  revision: number;
  definition_sealed: Uint8Array<ArrayBuffer>;
  fonts_sealed: Uint8Array<ArrayBuffer>;
  actor_id: string;
  own_fonts_sealed: Uint8Array<ArrayBuffer>;
  created_at: string;
  updated_at: string;
}
interface SummaryRow {
  id: string;
  folder_id: string;
  slug: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw fail("invalid-theme", "Theme definition must be JSON.");
  return serialized;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const knownKeys = (value: JsonObject, allowed: readonly string[]) =>
  Object.keys(value).every(key => allowed.includes(key));
const themeKeys = ["slug", "name", "description", "extends", "tokens", "fonts", "fontSources", "logo", "scales", "recipes"] as const;
const scaleRadius: Record<string, string> = { none: "0", sm: ".35rem", md: ".75rem", lg: "1.25rem", pill: "999px" };
const scaleShadow: Record<string, string> = { none: "none", soft: "0 12px 36px #1729441c", raised: "0 16px 40px #1729441c" };
const shadowScale = (value: string): string => Object.keys(scaleShadow).find(key => scaleShadow[key] === value) ?? "none";
const themeError = (message: string): CodeError => fail("invalid-theme", message);

/** Validates a project definition and compiles the fully resolved token/recipe set. */
export function validateThemeDefinition(definition: unknown, scope: {
  slug: string;
  parent?: CompiledTheme | null;
}): CompiledTheme {
  if (!object(definition) || !knownKeys(definition, themeKeys)) throw themeError("Theme definition contains an unknown key.");
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(scope.slug) || definition.slug !== scope.slug)
    throw themeError("Theme slug is invalid or does not match its project identity.");
  if (typeof definition.name !== "string" || definition.name.length < 1 || definition.name.length > 80 ||
      /[<>\u0000-\u001f]/.test(definition.name)) throw themeError("Theme name is invalid.");
  const description = definition.description ?? "";
  if (typeof description !== "string" || description.length > 240 || /[<>\u0000-\u001f]/.test(description))
    throw themeError("Theme description is invalid.");
  let serialized: string | undefined;
  try { serialized = JSON.stringify(definition); } catch { throw themeError("Theme definition must be JSON."); }
  if (serialized === undefined) throw themeError("Theme definition must be JSON.");
  const bytes = enc.encode(serialized);
  if (bytes.byteLength > 64 * 1024) throw themeError("Theme definition exceeds 64 KiB.");
  if (definition.extends !== undefined && (!object(definition.extends) ||
      !knownKeys(definition.extends, ["scope", "slug"]) ||
      !["platform", "project"].includes(String(definition.extends.scope)) ||
      typeof definition.extends.slug !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(definition.extends.slug)))
    throw themeError("Theme extends must be a valid ThemeRef.");
  const parent = scope.parent ?? (object(definition.extends) && definition.extends.scope === "platform" &&
    typeof definition.extends.slug === "string" ? getPlatformTheme(definition.extends.slug) : null);
  const inputTokens = definition.tokens;
  if (!object(inputTokens) || !knownKeys(inputTokens, ["light", "dark"]) ||
      !object(inputTokens.light) || !object(inputTokens.dark))
    throw themeError("Theme tokens must provide light and dark token objects.");
  const schemes = {} as Record<"light" | "dark", Record<string, string>>;
  for (const scheme of ["light", "dark"] as const) {
    const authored = inputTokens[scheme] as JsonObject;
    if (!knownKeys(authored, COLOR_TOKENS)) throw themeError(`Unknown ${scheme} color token.`);
    const inherited = parent?.tokens[scheme] ?? {};
    const colors = { ...inherited, ...authored } as Record<string, string>;
    if (COLOR_TOKENS.some(token => typeof colors[token] !== "string" || !/^#[\da-f]{6}$/i.test(colors[token]!)))
      throw themeError(`Resolved ${scheme} tokens are incomplete or invalid.`);
    schemes[scheme] = colors;
  }

  const authoredFonts = definition.fonts;
  if (authoredFonts !== undefined && (!object(authoredFonts) || !knownKeys(authoredFonts, ["heading", "body", "mono"])))
    throw themeError("Theme fonts contain an unknown key.");
  const inheritedTokens = parent?.tokens.light;
  const fonts = {} as Record<"heading" | "body" | "mono", { family: string; stack: string }>;
  for (const [key, token] of [["heading", "font-heading"], ["body", "font-body"], ["mono", "font-mono"]] as const) {
    const authored = object(authoredFonts) ? authoredFonts[key] : undefined;
    if (authored !== undefined && (!object(authored) || !knownKeys(authored, ["family", "stack"]) ||
        typeof authored.family !== "string" || authored.family.length < 1 || authored.family.length > 80 ||
        !/^[\p{L}\p{N}_ -]+$/u.test(authored.family) || typeof authored.stack !== "string"))
      throw themeError(`Theme ${key} font is invalid.`);
    const inherited = inheritedTokens?.[token] ?? (key === "mono" ? "ui-monospace, monospace" : "system-ui, sans-serif");
    const family = object(authored) ? authored.family as string : inherited.split(",")[0]!.replace(/^['"]|['"]$/g, "");
    const stack = object(authored) ? authored.stack as string : inherited;
    fonts[key] = { family, stack };
  }

  const scales = definition.scales;
  if (scales !== undefined && (!object(scales) || !knownKeys(scales, ["radius", "density", "shadow"])))
    throw themeError("Theme scales contain an unknown key.");
  const explicitRadius = object(scales) && scales.radius !== undefined;
  const radius = explicitRadius ? scales.radius : "md";
  const density = object(scales) && scales.density !== undefined ? scales.density : Number(inheritedTokens?.density ?? "1");
  const shadow = object(scales) && scales.shadow !== undefined ? scales.shadow : shadowScale(inheritedTokens?.shadow ?? "none");
  if (typeof radius !== "string" || !(radius in scaleRadius) || typeof density !== "number" || !Number.isFinite(density) ||
      density < .75 || density > 1.25 || typeof shadow !== "string" || !(shadow in scaleShadow))
    throw themeError("Theme scales are outside their allowed bounds.");
  if (definition.logo !== undefined && definition.logo !== null &&
      (typeof definition.logo !== "string" || definition.logo.length > 48 * 1024))
    throw themeError("Theme logo is invalid or too large.");
  const fontSources = definition.fontSources === undefined ? [] : definition.fontSources;
  if (!Array.isArray(fontSources) || fontSources.length > 8 || fontSources.some(source =>
      typeof source !== "string" || (() => { try { const url = new URL(source); return url.protocol !== "https:" ||
        url.hostname !== "fonts.googleapis.com" || url.port !== "" || url.username !== "" || url.password !== "" ||
        url.pathname !== "/css2" || url.hash !== ""; } catch { return true; } })()))
    throw themeError("Theme fontSources must use approved Google Fonts CSS2 URLs.");

  const authoredRecipes = definition.recipes === undefined ? {} : definition.recipes;
  if (!object(authoredRecipes) || !knownKeys(authoredRecipes, ["aurora", "glow"]))
    throw themeError("Theme recipes contain an unknown key.");
  const recipes: JsonObject = {};
  for (const key of ["aurora", "glow"] as const) {
    const authored = authoredRecipes[key];
    const inherited = parent?.recipes[key];
    if (authored !== undefined && !object(authored))
      throw themeError(`Theme ${key} recipe must be an object.`);
    if (authored === undefined) {
      if (inherited !== undefined) recipes[key] = structuredClone(inherited);
    } else {
      recipes[key] = { ...(object(inherited) ? inherited : {}), ...authored };
    }
  }
  const resolved: PlatformThemeDefinition = {
    slug: scope.slug, name: definition.name, description,
    tokens: {
      light: { ...schemes.light, "font-heading": fonts.heading.stack, "font-body": fonts.body.stack,
        "font-mono": fonts.mono.stack, radius: explicitRadius ? scaleRadius[radius]! : inheritedTokens?.radius ?? scaleRadius[radius]!,
        space: inheritedTokens?.space ?? "1.15rem", density: String(density), shadow: scaleShadow[shadow]! },
      dark: { ...schemes.dark, "font-heading": fonts.heading.stack, "font-body": fonts.body.stack,
        "font-mono": fonts.mono.stack, radius: explicitRadius ? scaleRadius[radius]! : parent?.tokens.dark.radius ?? scaleRadius[radius]!,
        space: parent?.tokens.dark.space ?? "1.15rem", density: String(density), shadow: scaleShadow[shadow]! },
    },
    recipes: recipes as PlatformThemeDefinition["recipes"],
    logo: typeof definition.logo === "string" ? definition.logo : null,
  };
  let compiled: CompiledTheme;
  try { compiled = compileTheme(resolved); }
  catch (error) { throw themeError(error instanceof Error ? error.message : "Theme definition is invalid."); }
  if (enc.encode(compiled.css).byteLength > 128 * 1024) throw themeError("Resolved theme CSS exceeds 128 KiB.");
  for (const scheme of ["light", "dark"] as const) {
    const tokens = compiled.tokens[scheme];
    if (contrastRatio(tokens.ink!, tokens.bg!) < 4.5) throw themeError(`${scheme} ink/bg contrast below 4.5:1.`);
  }
  return compiled;
}

export function openProjectThemes({ db, masterKeyHex, now = Date.now, fetcher = fetch }: {
  db: DatabaseLike;
  masterKeyHex: string;
  now?: () => number;
  fetcher?: FontFetcher;
}): ProjectThemeModel {
  const nowIso = () => new Date(now()).toISOString();
  const topLevelFolder = Effect.fn(function* (folderId: string) {
    const folder = yield* io(() => db.prepare("SELECT id,parent_id FROM folders WHERE id=?").bind(folderId).first<{ id: string; parent_id: string | null }>());
    if (!folder) return yield* Effect.fail(fail("not-found", "Project folder does not exist."));
    if (folder.parent_id !== null) return yield* Effect.fail(fail("invalid-project", "Project themes belong to a top-level folder."));
    return folder;
  });
  const themeRevision = (row: RevisionRow) => Effect.gen(function* () {
    const opened = yield* openBlob(masterKeyHex, row.definition_sealed);
    let definition: unknown;
    try { definition = JSON.parse(utf8(opened)); }
    catch (error) { return yield* Effect.fail(fail("secrets-auth", error instanceof Error ? error.message : "Theme definition could not be opened.")); }
    return {
      id: row.id, folderId: row.folder_id, slug: row.slug, currentRevision: Number(row.current_revision),
      revision: Number(row.revision), definition, actorId: row.actor_id, createdAt: row.created_at, updatedAt: row.updated_at,
    } satisfies ProjectThemeSnapshot;
  });
  const revisionRow = (folderId: string, slug: string) => io(() => db.prepare(`
    SELECT t.id,t.folder_id,t.slug,t.current_revision,r.revision,r.definition_sealed,r.fonts_sealed,r.own_fonts_sealed,r.actor_id,r.created_at,t.updated_at
    FROM project_themes t JOIN project_theme_revisions r ON r.theme_id=t.id AND r.revision=t.current_revision
    WHERE t.folder_id=? AND t.slug=?
  `).bind(folderId, slug).first<RevisionRow>());


  type ThemeRevisionGuard = { id: string; revision: number };
  type ResolvedThemeParent = { theme: CompiledTheme; fonts: Uint8Array<ArrayBuffer>; revisions: ThemeRevisionGuard[] };
  const declaredFamilies = (theme: CompiledTheme): string[] => [...new Set(
    ["font-heading", "font-body", "font-mono"].map(token =>
      theme.tokens.light[token]!.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "")),
  )];
  const resolveParent = (folderId: string, reference: ThemeRef, ancestry: readonly string[]): Effect.Effect<ResolvedThemeParent, CodeError> =>
    Effect.gen(function* () {
      if (ancestry.includes(`${reference.scope}:${reference.slug}`))
        return yield* Effect.fail(fail("invalid-theme", "Theme inheritance cycle detected."));
      if (reference.scope === "project" && ancestry.length > 4)
        return yield* Effect.fail(fail("invalid-theme", "Theme inheritance exceeds four ancestors."));
      if (reference.scope === "platform") {
        const theme = getPlatformTheme(reference.slug);
        if (!theme) return yield* Effect.fail(fail("invalid-theme", "Platform theme does not exist."));
        return { theme, fonts: new Uint8Array(), revisions: [] };
      }
      if (reference.scope !== "project" || !/^[a-z][a-z0-9-]{0,47}$/.test(reference.slug))
        return yield* Effect.fail(fail("invalid-theme", "Theme extends must be a valid ThemeRef."));
      const row = yield* revisionRow(folderId, reference.slug);
      if (!row) return yield* Effect.fail(fail("invalid-theme", "Project parent theme does not exist in this project."));
      const snapshot = yield* themeRevision(row);
      if (!object(snapshot.definition)) return yield* Effect.fail(fail("invalid-theme", "Project parent theme is invalid."));
      let parent: ResolvedThemeParent | null = null;
      if (object(snapshot.definition.extends)) {
        const ref = snapshot.definition.extends;
        if (ref.scope !== "project" && ref.scope !== "platform")
          return yield* Effect.fail(fail("invalid-theme", "Project parent ThemeRef is invalid."));
        parent = yield* resolveParent(folderId, { scope: ref.scope, slug: String(ref.slug) },
          [...ancestry, `${reference.scope}:${reference.slug}`]);
      }
      let theme: CompiledTheme;
      try { theme = validateThemeDefinition(snapshot.definition, { slug: reference.slug, parent: parent?.theme }); }
      catch (error) { return yield* Effect.fail(asCodeError(error)); }
      const sources = Array.isArray(snapshot.definition.fontSources) ? snapshot.definition.fontSources as string[] : [];
      const localFonts = yield* captureThemeFonts(sources, { fetcher, families: declaredFamilies(theme) });
      const fonts = enc.encode([parent ? utf8(parent.fonts) : "", utf8(localFonts)].filter(Boolean).join("\n")) as Uint8Array<ArrayBuffer>;
      if (themeFontByteLength(fonts) > 256 * 1024)
        return yield* Effect.fail(fail("invalid-theme", "Resolved project theme fonts exceed 256 KiB."));
      const revisions = [...(parent?.revisions ?? []), { id: row.id, revision: Number(row.current_revision) }];
      return { theme, fonts, revisions };
    });

  const resolveStored = (folderId: string, slug: string, ancestry: readonly string[] = []):
    Effect.Effect<{ compiledTheme: CompiledTheme; fontsCss: string }, CodeError> => Effect.gen(function* () {
      if (ancestry.length > 4 || ancestry.includes(slug))
        return yield* Effect.fail(fail("invalid-theme", "Theme inheritance cycle or depth limit was reached."));
      const row = yield* revisionRow(folderId, slug);
      if (!row) return yield* Effect.fail(fail("not-found", "Project theme is not available in this project."));
      const snapshot = yield* themeRevision(row);
      let parent: CompiledTheme | null = null;
      let parentFonts = "";
      if (object(snapshot.definition) && object(snapshot.definition.extends)) {
        const ref = snapshot.definition.extends;
        if (ref.scope === "platform" && typeof ref.slug === "string") parent = getPlatformTheme(ref.slug) ?? null;
        else if (ref.scope === "project" && typeof ref.slug === "string") {
          const resolvedParent = yield* resolveStored(folderId, ref.slug, [...ancestry, slug]);
          parent = resolvedParent.compiledTheme;
          parentFonts = resolvedParent.fontsCss;
        }
      }
      const compiledTheme = validateThemeDefinition(snapshot.definition, { slug, parent });
      const ownFonts = utf8(yield* openBlob(masterKeyHex, row.own_fonts_sealed));
      const fontsCss = [parentFonts, ownFonts].filter(Boolean).join("\n");
      if (themeFontByteLength(enc.encode(fontsCss)) > 256 * 1024)
        return yield* Effect.fail(fail("invalid-theme", "Resolved project theme fonts exceed 256 KiB."));
      return { compiledTheme, fontsCss };
    });

  const validateCurrentDescendants = (folderId: string, parentSlug: string, parentTheme: CompiledTheme, parentFonts: Uint8Array<ArrayBuffer>, parentDepth: number) =>
    Effect.gen(function* () {
      const rows = yield* io(() => db.prepare(`SELECT t.id,t.slug,t.current_revision,r.definition_sealed,r.fonts_sealed,r.own_fonts_sealed,r.created_at
        FROM project_themes t JOIN project_theme_revisions r ON r.theme_id=t.id AND r.revision=t.current_revision WHERE t.folder_id=?`)
        .bind(folderId).all<{ id: string; slug: string; current_revision: number;
          definition_sealed: Uint8Array<ArrayBuffer>; fonts_sealed: Uint8Array<ArrayBuffer>;
          own_fonts_sealed: Uint8Array<ArrayBuffer>; created_at: string }>());
      const definitions = new Map<string, { definition: unknown; row: typeof rows.results[number] }>();
      for (const row of rows.results)
        definitions.set(row.slug, { definition: JSON.parse(utf8(yield* openBlob(masterKeyHex, row.definition_sealed))), row });
      const checked = new Set<string>();
      const visit = (slug: string, parent: CompiledTheme, inheritedFonts: Uint8Array<ArrayBuffer>, depth: number): Effect.Effect<void, CodeError> => Effect.gen(function* () {
        
        for (const [childSlug, entry] of definitions) {
          const { definition, row } = entry;
          if (checked.has(childSlug) || childSlug === parentSlug || !object(definition) || !object(definition.extends)) continue;
          if (definition.extends.scope !== "project" || definition.extends.slug !== slug) continue;
          checked.add(childSlug);
          if (depth > 4) return yield* Effect.fail(fail("invalid-theme", "Theme inheritance exceeds four ancestors."));
          let compiled: CompiledTheme;
          try { compiled = validateThemeDefinition(definition, { slug: childSlug, parent }); }
          catch (error) { return yield* Effect.fail(asCodeError(error)); }
          const ownFonts = yield* openBlob(masterKeyHex, row.own_fonts_sealed);
          const allFonts = enc.encode([utf8(inheritedFonts), utf8(ownFonts)].filter(Boolean).join("\n")) as Uint8Array<ArrayBuffer>;
          if (themeFontByteLength(allFonts) > 256 * 1024)
            return yield* Effect.fail(fail("invalid-theme", "Resolved project theme fonts exceed 256 KiB."));
          yield* visit(childSlug, compiled, allFonts, depth + 1);
        }
      });
      yield* visit(parentSlug, parentTheme, parentFonts, parentDepth);
      return rows.results;
    });

  return {
    define: Effect.fn(function* ({ folderId, slug, definition, actorId, ifRevision }: {
      folderId: string; slug: string; definition: unknown; actorId: string; ifRevision?: number;
    }) {
      yield* topLevelFolder(folderId);
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(slug)) return yield* Effect.fail(fail("invalid-theme", "Theme slug is invalid."));
      if (!actorId) return yield* Effect.fail(fail("invalid-actor", "A theme revision needs an actor."));
      let parent: ResolvedThemeParent | null = null;
      if (object(definition) && object(definition.extends)) {
        const ref = definition.extends;
        if (ref.scope !== "platform" && ref.scope !== "project")
          return yield* Effect.fail(fail("invalid-theme", "Theme extends must be a valid ThemeRef."));
        parent = yield* resolveParent(folderId, { scope: ref.scope, slug: String(ref.slug) }, [`project:${slug}`]);
      }
      let resolved: CompiledTheme;
      try { resolved = validateThemeDefinition(definition, { slug, parent: parent?.theme }); }
      catch (error) { return yield* Effect.fail(asCodeError(error)); }
      const sources = object(definition) && Array.isArray(definition.fontSources) ? definition.fontSources as string[] : [];
      const childFonts = yield* captureThemeFonts(sources, { fetcher, families: declaredFamilies(resolved) });
      const capturedFonts = enc.encode([parent ? utf8(parent.fonts) : "", utf8(childFonts)].filter(Boolean).join("\n")) as Uint8Array<ArrayBuffer>;
      if (themeFontByteLength(capturedFonts) > 256 * 1024)
        return yield* Effect.fail(fail("invalid-theme", "Resolved project theme fonts exceed 256 KiB."));
      const revisionGuards = parent?.revisions ?? [];
      const ancestrySql = revisionGuards.map(() =>
        " AND EXISTS (SELECT 1 FROM project_themes AS ancestor WHERE ancestor.id=? AND ancestor.current_revision=?)").join("");
      const ancestryBindings = revisionGuards.flatMap(({ id, revision }) => [id, revision]);
      const existing = yield* io(() => db.prepare("SELECT id,current_revision FROM project_themes WHERE folder_id=? AND slug=?")
        .bind(folderId, slug).first<{ id: string; current_revision: number }>());
      const canonical = enc.encode(canonicalJson(definition));
      const definitionSealed = yield* sealBlob(masterKeyHex, canonical);
      const fontsSealed = yield* sealBlob(masterKeyHex, capturedFonts);
      const ownFontsBlob = yield* sealBlob(masterKeyHex, childFonts);
      const at = nowIso();
      if (!existing) {
        if (ifRevision !== undefined && ifRevision !== 0)
          return yield* Effect.fail(Object.assign(fail("revision-conflict", "Project theme revision has changed."), { currentRevision: 0 }));
        const id = yield* randomHex(16);
        const results = yield* io(() => db.batch([
          db.prepare(`INSERT INTO project_themes (id,folder_id,slug,current_revision,created_at,updated_at)
            SELECT ?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM folders WHERE id=? AND parent_id IS NULL)${ancestrySql}`)
            .bind(id, folderId, slug, at, at, folderId, ...ancestryBindings),
          db.prepare(`INSERT INTO project_theme_revisions (theme_id,revision,definition_sealed,fonts_sealed,own_fonts_sealed,actor_id,created_at)
            SELECT ?,1,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM project_themes WHERE id=?)${ancestrySql}`)
            .bind(id, definitionSealed, fontsSealed, ownFontsBlob, actorId, at, id, ...ancestryBindings),
        ])).pipe(Effect.catch(error => Effect.gen(function* () {
          if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
            const winner = yield* io(() => db.prepare("SELECT current_revision FROM project_themes WHERE folder_id=? AND slug=?")
              .bind(folderId, slug).first<{ current_revision: number }>());
            if (winner) return yield* Effect.fail(Object.assign(fail("revision-conflict", "Project theme already exists."), {
              currentRevision: Number(winner.current_revision),
            }));
          }
          return yield* Effect.fail(asCodeError(error));
        })));
        if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1) {
          const latest = yield* io(() => db.prepare("SELECT current_revision FROM project_themes WHERE folder_id=? AND slug=?")
            .bind(folderId, slug).first<{ current_revision: number }>());
          return yield* Effect.fail(Object.assign(fail("revision-conflict", "A parent theme changed while the definition was being resolved."), {
            currentRevision: latest ? Number(latest.current_revision) : 0,
          }));
        }
        const row = yield* revisionRow(folderId, slug);
        if (!row) return yield* Effect.fail(fail("secrets-auth", "Created theme revision could not be read."));
        return yield* themeRevision(row);
      }
      const currentRevision = Number(existing.current_revision);
      if (ifRevision !== undefined && ifRevision !== currentRevision) {
        return yield* Effect.fail(Object.assign(fail("revision-conflict", "Project theme revision has changed."), { currentRevision }));
      }
      const themeSet = yield* validateCurrentDescendants(folderId, slug, resolved, capturedFonts,
        (parent?.revisions.length ?? 0) + 1);
      const otherThemes = themeSet.filter(row => row.id !== existing.id);
      const snapshot = JSON.stringify(otherThemes.map(row => ({ id: row.id, revision: row.current_revision })));
      const themeSetGuard = ` AND (SELECT COUNT(*) FROM project_themes WHERE folder_id=?)=?
        AND NOT EXISTS (SELECT 1 FROM project_themes candidate LEFT JOIN json_each(?) expected
          ON json_extract(expected.value,'$.id')=candidate.id
          WHERE candidate.folder_id=? AND candidate.id<>? AND
            (expected.value IS NULL OR json_extract(expected.value,'$.revision')<>candidate.current_revision))`;
      const themeSetBindings = [folderId, themeSet.length, snapshot, folderId, existing.id];
      const revision = currentRevision + 1;
      const results = yield* io(() => db.batch([
        db.prepare(`UPDATE project_themes SET current_revision=?,updated_at=? WHERE id=? AND current_revision=?${ancestrySql}${themeSetGuard}`)
          .bind(revision, at, existing.id, currentRevision, ...ancestryBindings, ...themeSetBindings),
        db.prepare(`INSERT INTO project_theme_revisions (theme_id,revision,definition_sealed,fonts_sealed,own_fonts_sealed,actor_id,created_at)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM project_themes WHERE id=? AND current_revision=?)${ancestrySql}${themeSetGuard}
          AND NOT EXISTS (SELECT 1 FROM project_theme_revisions WHERE theme_id=? AND revision=?)`)
          .bind(existing.id, revision, definitionSealed, fontsSealed, ownFontsBlob, actorId, at,
            existing.id, revision, ...ancestryBindings, ...themeSetBindings, existing.id, revision),
      ]));
      if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1) {
        const latest = yield* io(() => db.prepare("SELECT current_revision FROM project_themes WHERE id=?").bind(existing.id).first<{current_revision:number}>());
        return yield* Effect.fail(Object.assign(fail("revision-conflict", "Project theme revision has changed."), {
          currentRevision: Number(latest?.current_revision ?? currentRevision),
        }));
      }
      const row = yield* revisionRow(folderId, slug);
      if (!row) return yield* Effect.fail(fail("secrets-auth", "Created theme revision could not be read."));
      return yield* themeRevision(row);
    }),
    get: Effect.fn(function* ({ folderId, theme }: { folderId: string; theme: ThemeRef }) {
      yield* topLevelFolder(folderId);
      if (!theme || typeof theme !== "object" || (theme.scope !== "platform" && theme.scope !== "project") || typeof theme.slug !== "string") {
        return yield* Effect.fail(fail("invalid-theme", "ThemeRef must contain a scope and slug."));
      }
      if (theme.scope === "platform") {
        const platformTheme = getPlatformTheme(theme.slug);
        if (!platformTheme) return yield* Effect.fail(fail("not-found", "Platform theme does not exist."));
        return platformTheme;
      }
      const row = yield* revisionRow(folderId, theme.slug);
      if (!row) return yield* Effect.fail(fail("not-found", "Project theme does not exist in this project."));
      return yield* themeRevision(row);
    }),
    list: Effect.fn(function* ({ folderId }: { folderId: string }) {
      yield* topLevelFolder(folderId);
      const rows = yield* io(() => db.prepare(`SELECT id,folder_id,slug,current_revision,created_at,updated_at
        FROM project_themes WHERE folder_id=? ORDER BY slug`).bind(folderId).all<SummaryRow>());
      return rows.results.map(row => ({ id: row.id, folderId: row.folder_id, slug: row.slug,
        currentRevision: Number(row.current_revision), createdAt: row.created_at, updatedAt: row.updated_at }));
    }),
    resolveForRead: Effect.fn(function* ({ folderId, theme, themeId }: {
      folderId: string; theme: ThemeRef | null; themeId?: string | null;
    }) {
      const project = yield* io(() => db.prepare(`WITH RECURSIVE chain(id,parent_id,visited) AS (
        SELECT id,parent_id,'|' || id || '|' FROM folders WHERE id=?
        UNION ALL
        SELECT f.id,f.parent_id,chain.visited || f.id || '|' FROM folders f JOIN chain ON f.id=chain.parent_id
          WHERE instr(chain.visited,'|' || f.id || '|')=0
      ) SELECT id FROM chain WHERE parent_id IS NULL LIMIT 1`).bind(folderId).first<{ id: string }>());
      if (!project) return yield* Effect.fail(fail("not-found", "Project folder does not exist."));
      const projectId = project.id;
      const settings = yield* io(() => db.prepare(`SELECT default_theme_scope,default_theme_slug,default_theme_id,brand_lock
        FROM project_theme_settings WHERE folder_id=?`).bind(projectId)
        .first<{ default_theme_scope: "platform" | "project" | null; default_theme_slug: string | null; default_theme_id: string | null; brand_lock: number }>());
      const projectDefault: ThemeRef = settings?.default_theme_scope === "platform" && settings.default_theme_slug
        ? { scope: "platform", slug: settings.default_theme_slug }
        : settings?.default_theme_scope === "project" && settings.default_theme_slug
          ? { scope: "project", slug: settings.default_theme_slug }
          : { scope: "platform", slug: "report" };
      const explicit = theme !== null;
      const selected = theme ?? projectDefault;
      const selectedId = explicit ? themeId ?? null : settings?.default_theme_id ?? null;
      let fallback = false;
      let resolvedRef = selected;
      let resolved: { compiledTheme: CompiledTheme; fontsCss: string } | null = null;
      const resolveRef = (reference: ThemeRef, id: string | null) => Effect.gen(function* () {
        if (reference.scope === "platform") {
          const compiledTheme = getPlatformTheme(reference.slug);
          if (!compiledTheme) return null;
          return { compiledTheme, fontsCss: "" };
        }
        if (!id) return null;
        const row = yield* io(() => db.prepare("SELECT slug FROM project_themes WHERE id=? AND folder_id=?")
          .bind(id, projectId).first<{ slug: string }>());
        if (!row || row.slug !== reference.slug) return null;
        return yield* resolveStored(projectId, row.slug);
      });
      resolved = yield* resolveRef(selected, selectedId);
      if (!resolved && explicit) {
        fallback = true;
        if (selected.scope === "platform") {
          resolvedRef = { scope: "platform", slug: "report" };
          resolved = yield* resolveRef(resolvedRef, null);
        } else {
          resolvedRef = projectDefault;
          resolved = yield* resolveRef(projectDefault, settings?.default_theme_id ?? null);
        }
      }
      if (!resolved) {
        fallback = true;
        resolvedRef = { scope: "platform", slug: "report" };
        resolved = yield* resolveRef(resolvedRef, null);
      }
      if (!resolved) return yield* Effect.fail(fail("not-found", "The platform report theme is unavailable."));
      return { theme: resolvedRef, themeResolution: fallback ? "fallback" as const : "explicit" as const,
        brandLock: Boolean(settings?.brand_lock), ...resolved };
    }),
    setDefault: Effect.fn(function* ({ folderId, theme, actorId }: { folderId: string; theme: ThemeRef | null; actorId: string }) {
      yield* topLevelFolder(folderId);
      if (!actorId) return yield* Effect.fail(fail("invalid-actor", "Setting a project default needs an actor."));
      let scope: "platform" | "project" | null = null, slug: string | null = null, id: string | null = null;
      if (theme !== null) {
        if (!theme || typeof theme !== "object" || (theme.scope !== "platform" && theme.scope !== "project") || typeof theme.slug !== "string") {
          return yield* Effect.fail(fail("invalid-theme", "ThemeRef must contain a scope and slug."));
        }
        scope = theme.scope;
        slug = theme.slug;
        if (theme.scope === "platform") {
          if (!getPlatformTheme(theme.slug)) return yield* Effect.fail(fail("invalid-theme", "Platform theme is not registered."));
        } else {
          const projectTheme = yield* io(() => db.prepare("SELECT id FROM project_themes WHERE folder_id=? AND slug=?")
            .bind(folderId, theme.slug).first<{ id: string }>());
          if (!projectTheme) return yield* Effect.fail(fail("not-found", "Project theme does not belong to this project."));
          id = projectTheme.id;
        }
      }
      const at = nowIso();
      const result = yield* io(() => db.prepare(`INSERT INTO project_theme_settings
        (folder_id,default_theme_scope,default_theme_slug,default_theme_id,updated_at,updated_by)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM folders WHERE id=? AND parent_id IS NULL)
        ON CONFLICT(folder_id) DO UPDATE SET
        default_theme_scope=excluded.default_theme_scope,default_theme_slug=excluded.default_theme_slug,
        default_theme_id=excluded.default_theme_id,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .bind(folderId, scope, slug, id, at, actorId, folderId).run());
      if (Number(result.meta?.changes ?? 0) !== 1)
        return yield* Effect.fail(fail("invalid-project", "Project theme settings require a top-level folder."));
    }),
    setBrandLock: Effect.fn(function* ({ folderId, brandLock, actorId }: {
      folderId: string; brandLock: boolean; actorId: string;
    }) {
      yield* topLevelFolder(folderId);
      if (typeof brandLock !== "boolean" || !actorId)
        return yield* Effect.fail(fail("invalid-theme", "A boolean brand lock and actor are required."));
      const at = nowIso();
      const result = yield* io(() => db.prepare(`INSERT INTO project_theme_settings
        (folder_id,brand_lock,updated_at,updated_by)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM folders WHERE id=? AND parent_id IS NULL)
        ON CONFLICT(folder_id) DO UPDATE SET brand_lock=excluded.brand_lock,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .bind(folderId, brandLock ? 1 : 0, at, actorId, folderId).run());
      if (Number(result.meta?.changes ?? 0) !== 1)
        return yield* Effect.fail(fail("invalid-project", "Project theme settings require a top-level folder."));
    }),
    delete: Effect.fn(function* ({ folderId, slug }: { folderId: string; slug: string; actorId: string }) {
      yield* topLevelFolder(folderId);
      const theme = yield* io(() => db.prepare("SELECT id,current_revision FROM project_themes WHERE folder_id=? AND slug=?")
        .bind(folderId, slug).first<{ id: string; current_revision: number }>());
      if (!theme) return yield* Effect.fail(fail("not-found", "Project theme does not exist in this project."));
      const children = yield* io(() => db.prepare(`SELECT t.id,t.current_revision,r.definition_sealed FROM project_themes t
        JOIN project_theme_revisions r ON r.theme_id=t.id AND r.revision=t.current_revision WHERE t.folder_id=? AND t.id<>?`)
        .bind(folderId, theme.id).all<{ id: string; current_revision: number; definition_sealed: Uint8Array<ArrayBuffer> }>());
      for (const row of children.results) {
        const definition = JSON.parse(utf8(yield* openBlob(masterKeyHex, row.definition_sealed))) as unknown;
        if (object(definition) && object(definition.extends) && definition.extends.scope === "project" && definition.extends.slug === slug)
          return yield* Effect.fail(fail("theme-referenced", "Project theme is referenced by a child theme."));
      }
      const childSnapshot = JSON.stringify(children.results.map(row => ({ id: row.id, revision: row.current_revision })));
      const guardSql = `AND (SELECT COUNT(*) FROM project_themes WHERE folder_id=? AND id<>?)=?
        AND NOT EXISTS (SELECT 1 FROM project_themes child LEFT JOIN json_each(?) expected
          ON json_extract(expected.value,'$.id')=child.id
          WHERE child.folder_id=? AND child.id<>? AND
            (expected.value IS NULL OR json_extract(expected.value,'$.revision')<>child.current_revision))`;
      const guardBindings = [folderId, theme.id, children.results.length, childSnapshot, folderId, theme.id];
      const result = yield* io(() => db.prepare(`DELETE FROM project_themes WHERE id=? AND folder_id=? AND current_revision=?
        AND NOT EXISTS (SELECT 1 FROM artifact_versions WHERE theme_scope='project' AND theme_id=?)
        AND NOT EXISTS (SELECT 1 FROM project_theme_settings WHERE default_theme_id=?) ${guardSql}`)
        .bind(theme.id, folderId, theme.current_revision, theme.id, theme.id, ...guardBindings).run());
      if (Number(result.meta?.changes ?? 0) !== 1)
        return yield* Effect.fail(fail("theme-referenced", "Project theme is still referenced."));
    }),
  };
}
