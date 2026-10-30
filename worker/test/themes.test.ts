import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { openD1Shim } from "./db.js";
import { openBlob, sealBlob, utf8 } from "../src/crypto.js";
import { openProjectThemes, validateThemeDefinition } from "../src/themes.js";
import { COLOR_TOKENS } from "../../frontend/src/theme-compiler.js";
import { getPlatformTheme } from "../../frontend/src/platform-themes.js";
import type { DatabaseLike } from "../src/types.js";
import { openStore } from "../src/store.js";
import { THEME_FONT_SOURCE, themeFontFetcher, validThemeDefinition } from "./theme-fixtures.js";
import type { FontFetcher } from "../src/fonts.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";
const NOW = "2026-10-30T00:00:00.000Z";
const rejectsCode = (code: string) => (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

async function fixture(fetcher: FontFetcher = themeFontFetcher, now: () => number = () => Date.parse(NOW)) {
  const db = openD1Shim();
  const store = openStore(db);
  await Effect.runPromise(store.users.create({ id: "owner", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}" }));
  db.exec(`INSERT INTO folders (id,slug,name_sealed,owner_id,created_at,updated_at) VALUES
    ('project',NULL,'sealed','owner','${NOW}','${NOW}'),
    ('other',NULL,'sealed','owner','${NOW}','${NOW}')`);
  return { db, model: openProjectThemes({ db, masterKeyHex: MASTER, now, fetcher }) };
}

test("migration creates project theme tables, uniqueness, immutable keys and restricted defaults", async () => {
  const { db } = await fixture();
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>().results.map(row => row.name);
  assert.ok(tableNames.includes("project_themes"));
  assert.ok(tableNames.includes("project_theme_revisions"));
  assert.ok(tableNames.includes("project_theme_settings"));
  const revisionColumns = db.prepare("PRAGMA table_info(project_theme_revisions)").all<{ name: string }>().results.map(row => row.name);
  assert.ok(revisionColumns.includes("own_fonts_sealed"));
  assert.equal(db.prepare("PRAGMA table_info(project_theme_revisions)").all<{ name: string; notnull: number }>().results.find(row => row.name === "own_fonts_sealed")?.notnull, 1);
  const columns = db.prepare("PRAGMA table_info(project_theme_settings)").all<{ name: string }>().results.map(row => row.name);
  assert.ok(columns.includes("default_theme_id"));
  const defaultForeignKey = db.prepare("PRAGMA foreign_key_list(project_theme_settings)").all<{ from: string; on_delete: string }>().results
    .find(key => key.from === "default_theme_id");
  assert.equal(defaultForeignKey?.on_delete, "RESTRICT");
  db.prepare("INSERT INTO project_themes (id,folder_id,slug,current_revision,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .bind("first", "project", "same", 1, NOW, NOW).run();
  assert.throws(() => db.prepare("INSERT INTO project_themes (id,folder_id,slug,current_revision,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .bind("second", "project", "same", 1, NOW, NOW).run(), /UNIQUE/);
  db.close();
});

test("default choices preserve null, platform and project tuple semantics", async () => {
  const { db, model } = await fixture();
  await Effect.runPromise(model.setDefault({ folderId: "project", theme: { scope: "platform", slug: "editorial" }, actorId: "owner" }));
  const platform = await Effect.runPromise(model.get({ folderId: "project", theme: { scope: "platform", slug: "editorial" } }));
  let row = await db.prepare("SELECT default_theme_scope,default_theme_slug,default_theme_id FROM project_theme_settings WHERE folder_id='project'").first<any>();
  assert.equal(platform.slug, "editorial");
  assert.deepEqual({ ...row }, { default_theme_scope: "platform", default_theme_slug: "editorial", default_theme_id: null });
  await Effect.runPromise(model.setDefault({ folderId: "project", theme: null, actorId: "owner" }));
  row = await db.prepare("SELECT default_theme_scope,default_theme_slug,default_theme_id FROM project_theme_settings WHERE folder_id='project'").first<any>();
  assert.deepEqual({ ...row }, { default_theme_scope: null, default_theme_slug: null, default_theme_id: null });
  db.close();
});

test("project default CHECK rejects NULL discriminators with partial tuples", async () => {
  const { db, model } = await fixture();
  const theme = await Effect.runPromise(model.define({
    folderId: "project", slug: "owned", definition: validThemeDefinition("owned"), actorId: "owner",
  }));
  const insert = db.prepare(`INSERT INTO project_theme_settings
    (folder_id,default_theme_scope,default_theme_slug,default_theme_id,updated_at,updated_by) VALUES (?,?,?,?,?,?)`);
  assert.throws(() => insert.bind("project", null, "partial-platform", null, NOW, "owner").run());
  assert.throws(() => insert.bind("project", null, null, theme.id, NOW, "owner").run());
  db.close();
});

test("platform defaults validate against the shipped registry", async () => {
  const { db, model } = await fixture();
  await assert.rejects(Effect.runPromise(model.setDefault({ folderId: "project", theme: { scope: "platform", slug: "not-registered" }, actorId: "owner" })), rejectsCode("invalid-theme"));
  db.close();
});

test("project theme defaults must refer to a theme owned by that project", async () => {
  const { db, model } = await fixture();
  const theme = await Effect.runPromise(model.define({ folderId: "project", slug: "owned", definition: validThemeDefinition("owned"), actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.setDefault({ folderId: "other", theme: { scope: "project", slug: "owned" }, actorId: "owner" })), rejectsCode("not-found"));
  await Effect.runPromise(model.setDefault({ folderId: "project", theme: { scope: "project", slug: "owned" }, actorId: "owner" }));
  const row = await db.prepare("SELECT default_theme_scope,default_theme_slug,default_theme_id FROM project_theme_settings WHERE folder_id='project'").first<any>();
  assert.deepEqual({ ...row }, { default_theme_scope: "project", default_theme_slug: "owned", default_theme_id: theme.id });
  const listed = await Effect.runPromise(model.list({ folderId: "project" }));
  assert.equal(listed[0].slug, "owned");
  assert.equal("definition" in listed[0], false);
  assert.equal("fontBytes" in listed[0], false);
  const fetched = await Effect.runPromise(model.get({ folderId: "project", theme: { scope: "project", slug: "owned" } }));
  assert.ok("revision" in fetched);
  assert.equal(fetched.revision, 1);
  db.close();
});
test("read resolution accepts an artifact's nested folder and resolves its project ancestor", async () => {
  const { db, model } = await fixture();
  db.prepare("INSERT INTO folders (id,slug,name_sealed,owner_id,created_at,updated_at,parent_id) VALUES (?,?,?,?,?,?,?)")
    .bind("child", null, "sealed", "owner", NOW, NOW, "project").run();
  await Effect.runPromise(model.setDefault({ folderId: "project", theme: { scope: "platform", slug: "editorial" }, actorId: "owner" }));
  await Effect.runPromise(model.setBrandLock({ folderId: "project", brandLock: true, actorId: "owner" }));
  const resolved = await Effect.runPromise(model.resolveForRead({ folderId: "child", theme: null }));
  assert.equal(resolved.compiledTheme.slug, "editorial");
  assert.equal(resolved.brandLock, true);
  db.close();
});

test("revisions append immutably and reject stale ifRevision", async () => {
  const { db, model } = await fixture();
  const first = await Effect.runPromise(model.define({ folderId: "project", slug: "owned", definition: validThemeDefinition("owned"), actorId: "owner" }));
  const second = await Effect.runPromise(model.define({ folderId: "project", slug: "owned", definition: { ...validThemeDefinition("owned"), name: "Updated" }, actorId: "owner", ifRevision: 1 }));
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "owned", definition: { ...validThemeDefinition("owned"), name: "Stale" }, actorId: "owner", ifRevision: 1 })), rejectsCode("revision-conflict"));
  assert.throws(() => db.prepare("UPDATE project_theme_revisions SET actor_id='changed' WHERE theme_id=? AND revision=1").bind(first.id).run(), /immutable/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_theme_revisions WHERE theme_id=?").bind(first.id).first<{n:number}>()?.n, 2);
  db.close();
});

test("concurrent ifRevision writers return one revision-conflict without a duplicate append", async () => {
  const { db } = await fixture();
  const initial = openProjectThemes({ db, masterKeyHex: MASTER, now: () => Date.parse(NOW) });
  const theme = await Effect.runPromise(initial.define({
    folderId: "project", slug: "race", definition: validThemeDefinition("race"), actorId: "owner",
  }));
  let readers = 0;
  let releaseReaders!: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReaders = resolve; });
  const raceDb: DatabaseLike = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("SELECT id,current_revision FROM project_themes")) return statement;
      return {
        ...statement,
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            ...bound,
            async first<A>() {
              const row = bound.first<A>();
              readers++;
              if (readers === 2) releaseReaders();
              await bothRead;
              return row;
            },
          };
        },
      };
    },
    batch: statements => db.batch(statements),
  };
  const model = openProjectThemes({ db: raceDb, masterKeyHex: MASTER, now: () => Date.parse(NOW) });
  const attempts = await Promise.allSettled([1, 2].map(value => Effect.runPromise(model.define({
    folderId: "project", slug: "race", definition: { ...validThemeDefinition("race"), name: `Race ${value}` }, actorId: "owner", ifRevision: 1,
  }))));
  assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find(attempt => attempt.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal((rejected.reason as { code?: string }).code, "revision-conflict");
  assert.equal(db.prepare("SELECT current_revision FROM project_themes WHERE id=?").bind(theme.id).first<{current_revision:number}>()?.current_revision, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_theme_revisions WHERE theme_id=?").bind(theme.id).first<{n:number}>()?.n, 2);
  db.close();
});
test("concurrent ifRevision zero definitions map the losing unique insert to revision-conflict", async () => {
  const { db } = await fixture();
  let readers = 0;
  let releaseReaders!: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReaders = resolve; });
  const raceDb: DatabaseLike = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("SELECT id,current_revision FROM project_themes")) return statement;
      return {
        ...statement,
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            ...bound,
            async first<A>() {
              const row = bound.first<A>();
              readers++;
              if (readers === 2) releaseReaders();
              await bothRead;
              return row;
            },
          };
        },
      };
    },
    batch: statements => db.batch(statements),
  };
  const model = openProjectThemes({ db: raceDb, masterKeyHex: MASTER, now: () => Date.parse(NOW) });
  const attempts = await Promise.allSettled([1, 2].map(value => Effect.runPromise(model.define({
    folderId: "project", slug: "first-race", definition: { ...validThemeDefinition("first-race"), name: `First ${value}` },
    actorId: "owner", ifRevision: 0,
  }))));
  assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find(attempt => attempt.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal((rejected.reason as { code?: string }).code, "revision-conflict");
  assert.equal((rejected.reason as { currentRevision?: number }).currentRevision, 1);
  db.close();
});
test("creation failures without an observable winner are not revision conflicts", async () => {
  const { db } = await fixture();
  const failedDb: DatabaseLike = {
    prepare: sql => db.prepare(sql),
    batch: async () => { throw new Error("disk unavailable"); },
  };
  const model = openProjectThemes({ db: failedDb, masterKeyHex: MASTER, now: () => Date.parse(NOW) });
  await assert.rejects(Effect.runPromise(model.define({
    folderId: "project", slug: "unavailable", definition: validThemeDefinition("unavailable"), actorId: "owner",
  })), error => error instanceof Error && error.message === "disk unavailable" &&
    (error as { code?: string }).code !== "revision-conflict");
  db.close();
});

test("unique creation failure without a current winner does not invent revision one", async () => {
  const { db } = await fixture();
  const vanishedWinnerDb: DatabaseLike = {
    prepare(sql) {
      if (sql.startsWith("SELECT current_revision FROM project_themes WHERE folder_id=? AND slug=?"))
        return { ...db.prepare(sql), bind: (..._values: unknown[]) => ({
          ...db.prepare(sql).bind(..._values),
          first: async <A>() => null as A | null,
        }) };
      return db.prepare(sql);
    },
    batch: async () => { throw new Error("UNIQUE constraint failed: project_themes.folder_id, project_themes.slug"); },
  };
  const model = openProjectThemes({ db: vanishedWinnerDb, masterKeyHex: MASTER, now: () => Date.parse(NOW) });
  await assert.rejects(Effect.runPromise(model.define({
    folderId: "project", slug: "vanished", definition: validThemeDefinition("vanished"), actorId: "owner",
  })), error => error instanceof Error && error.message.includes("UNIQUE constraint") &&
    (error as { code?: string }).code !== "revision-conflict" &&
    !("currentRevision" in error));
  db.close();
});

test("definitions and captured font bytes are sealed at rest", async () => {
  const { db, model } = await fixture();
  const base = validThemeDefinition("sealed");
  const definition = { ...base, description: "private definition", fontSources: [THEME_FONT_SOURCE],
    fonts: { ...base.fonts, heading: { family: "Example", stack: '"Example", system-ui, sans-serif' } } };
  const theme = await Effect.runPromise(model.define({ folderId: "project", slug: "sealed", definition, actorId: "owner" }));
  const row = await db.prepare("SELECT definition_sealed,fonts_sealed FROM project_theme_revisions WHERE theme_id=? AND revision=1").bind(theme.id).first<{definition_sealed: Uint8Array<ArrayBuffer>;fonts_sealed: Uint8Array<ArrayBuffer>}>();
  assert.ok(row);
  assert.equal(utf8(row.definition_sealed).includes("private definition"), false);
  assert.equal(utf8(row.fonts_sealed).includes("data:font/woff2"), false);
  const capturedFonts = await Effect.runPromise(openBlob(MASTER, row.fonts_sealed));
  assert.match(utf8(capturedFonts), /\/\* latin \*\//);
  assert.match(utf8(capturedFonts), /\/\* latin-ext \*\//);
  db.close();
});

test("delete is restricted while a default references the project theme", async () => {
  const { db, model } = await fixture();
  await Effect.runPromise(model.define({ folderId: "project", slug: "owned", definition: validThemeDefinition("owned"), actorId: "owner" }));
  await Effect.runPromise(model.setDefault({ folderId: "project", theme: { scope: "project", slug: "owned" }, actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.delete({ folderId: "project", slug: "owned", actorId: "owner" })), rejectsCode("theme-referenced"));
  db.close();
});
test("project theme definitions reject unknown keys without appending a revision", async () => {
  const { db, model } = await fixture();
  await assert.rejects(
    Effect.runPromise(model.define({
      folderId: "project", slug: "strict", definition: { slug: "strict", name: "Strict", invalid: true },
      actorId: "owner",
    })),
    rejectsCode("invalid-theme"),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_themes WHERE folder_id='project'").first<{ n: number }>()?.n, 0);
  db.close();
});
test("inherited project revisions resolve current ancestor fonts and declarations", async () => {
  const { db, model } = await fixture();
  const ancestor = validThemeDefinition("ancestor");
  await Effect.runPromise(model.define({ folderId: "project", slug: "ancestor", definition: ancestor, actorId: "owner" }));
  const bridge = { slug: "bridge", name: "Bridge", extends: { scope: "project", slug: "ancestor" },
    tokens: { light: {}, dark: {} } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "bridge", definition: bridge, actorId: "owner" }));
  const updatedAncestor = { ...ancestor, fontSources: [THEME_FONT_SOURCE],
    fonts: { heading: { family: "Example", stack: '"Example", system-ui, sans-serif' } } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "ancestor", definition: updatedAncestor, actorId: "owner", ifRevision: 1 }));
  const child = { slug: "descendant", name: "Descendant", extends: { scope: "project", slug: "bridge" },
    tokens: { light: {}, dark: {} }, fontSources: [THEME_FONT_SOURCE] };
  await Effect.runPromise(model.define({ folderId: "project", slug: "descendant", definition: child, actorId: "owner" }));
  const row = await db.prepare(`SELECT r.fonts_sealed FROM project_themes t JOIN project_theme_revisions r
    ON r.theme_id=t.id AND r.revision=t.current_revision WHERE t.folder_id='project' AND t.slug='descendant'`).first<{ fonts_sealed: Uint8Array<ArrayBuffer> }>();
  assert.ok(row);
  const resolvedFonts = utf8(await Effect.runPromise(openBlob(MASTER, row.fonts_sealed)));
  assert.equal((resolvedFonts.match(/data:font\/woff2;base64,/g) ?? []).length, 4,
    "The descendant carries both faces from the current ancestor and its own capture.");
  db.close();
});
test("reading a child uses current captured font CSS from its current ancestors", async () => {
  const { db, model } = await fixture();
  const parent = { ...validThemeDefinition("font-parent"), fontSources: [THEME_FONT_SOURCE] };
  parent.fonts.heading = { family: "Example", stack: '"Example", system-ui, sans-serif' };
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-parent", definition: parent, actorId: "owner" }));
  const child = { slug: "font-child", name: "Child", extends: { scope: "project", slug: "font-parent" }, tokens: { light: {}, dark: {} } };
  const childSnapshot = await Effect.runPromise(model.define({ folderId: "project", slug: "font-child", definition: child, actorId: "owner" }));
  const selected = { scope: "project" as const, slug: "font-child" };
  const snapshot = await Effect.runPromise(model.get({ folderId: "project", theme: selected }));
  assert.ok("definition" in snapshot);
  const before = await Effect.runPromise(model.resolveForRead({ folderId: "project", theme: selected, themeId: snapshot.id }));
  assert.match(before.fontsCss, /data:font\/woff2;base64,/);
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-parent", definition: { ...parent, fontSources: [] }, actorId: "owner", ifRevision: 1 }));
  const resolved = await Effect.runPromise(model.resolveForRead({ folderId: "project", theme: selected, themeId: snapshot.id }));
  assert.doesNotMatch(resolved.fontsCss, /data:font\/woff2;base64,/);
  db.close();
});

test("revising a parent cannot invalidate its current descendants", async () => {
  const { db, model } = await fixture();
  const initial = validThemeDefinition("parent");
  (initial.tokens.light as Record<string, string>).bg = "#ffffff";
  (initial.tokens.light as Record<string, string>).surface = "#ffffff";
  (initial.tokens.light as Record<string, string>).ink = "#17202a";
  await Effect.runPromise(model.define({ folderId: "project", slug: "parent", definition: initial, actorId: "owner" }));
  const child = { ...validThemeDefinition("child"), extends: { scope: "project", slug: "parent" },
    tokens: { light: { bg: "#ffffff", surface: "#ffffff" }, dark: {} } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "child", definition: child, actorId: "owner" }));
  const revised = structuredClone(initial);
  (revised.tokens.light as Record<string, string>).bg = "#17202a";
  (revised.tokens.light as Record<string, string>).surface = "#202a35";
  (revised.tokens.light as Record<string, string>).ink = "#ffffff";
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "parent", definition: revised, actorId: "owner", ifRevision: 1 })), rejectsCode("invalid-theme"));
  const latest = await Effect.runPromise(model.get({ folderId: "project", theme: { scope: "project", slug: "parent" } }));
  assert.ok("definition" in latest);
  assert.equal(latest.currentRevision, 1);
  db.close();
});

test("deleting a project theme is restricted while a current child extends it", async () => {
  const { db, model } = await fixture();
  await Effect.runPromise(model.define({ folderId: "project", slug: "parent", definition: validThemeDefinition("parent"), actorId: "owner" }));
  await Effect.runPromise(model.define({ folderId: "project", slug: "child",
    definition: { ...validThemeDefinition("child"), extends: { scope: "project", slug: "parent" } }, actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.delete({ folderId: "project", slug: "parent", actorId: "owner" })), rejectsCode("theme-referenced"));
  db.close();
});

test("read resolution accepts the four-ancestor inheritance limit allowed at definition", async () => {
  const { db, model } = await fixture();
  for (let depth = 0; depth <= 4; depth++) await Effect.runPromise(model.define({ folderId: "project", slug: `read-depth-${depth}`,
    definition: depth === 0 ? validThemeDefinition(`read-depth-${depth}`) :
      { ...validThemeDefinition(`read-depth-${depth}`), extends: { scope: "project", slug: `read-depth-${depth - 1}` } }, actorId: "owner" }));
  const theme = await Effect.runPromise(model.get({ folderId: "project", theme: { scope: "project", slug: "read-depth-4" } }));
  assert.ok("definition" in theme);
  const resolved = await Effect.runPromise(model.resolveForRead({ folderId: "project", theme: { scope: "project", slug: "read-depth-4" }, themeId: theme.id }));
  db.close();
});
test("parentless inheritance accepts four ancestors and rejects a fifth", async () => {
  const { db, model } = await fixture();
  const report = getPlatformTheme("report");
  assert.ok(report);
  const parentless = (slug: string) => ({
    slug, name: slug, tokens: {
      light: Object.fromEntries(COLOR_TOKENS.map(token => [token, report.tokens.light[token]])),
      dark: Object.fromEntries(COLOR_TOKENS.map(token => [token, report.tokens.dark[token]])),
    },
  });
  for (let depth = 0; depth <= 4; depth++) await Effect.runPromise(model.define({ folderId: "project", slug: `plain-depth-${depth}`,
    definition: depth === 0 ? parentless(`plain-depth-${depth}`) :
      { ...validThemeDefinition(`plain-depth-${depth}`), extends: { scope: "project", slug: `plain-depth-${depth - 1}` } }, actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "plain-depth-5",
    definition: { ...validThemeDefinition("plain-depth-5"), extends: { scope: "project", slug: "plain-depth-4" } }, actorId: "owner" })), rejectsCode("invalid-theme"));
  db.close();
});

test("parent revisions support large theme snapshots without exceeding D1 bind limits", async () => {
  const { db, model } = await fixture();
  for (let index = 0; index < 47; index++) await Effect.runPromise(model.define({
    folderId: "project", slug: `many-${index}`, definition: validThemeDefinition(`many-${index}`), actorId: "owner",
  }));
  const initial = validThemeDefinition("many-0");
  await Effect.runPromise(model.define({ folderId: "project", slug: "many-0",
    definition: { ...initial, name: "revised" }, actorId: "owner", ifRevision: 1 }));
  await Effect.runPromise(model.delete({ folderId: "project", slug: "many-1", actorId: "owner" }));
  db.close();
});
test("parent revisions cannot push current descendants beyond inheritance depth", async () => {
  const { db, model } = await fixture();
  const report = getPlatformTheme("report");
  assert.ok(report);
  const parentless = (slug: string) => ({
    slug, name: slug, tokens: {
      light: Object.fromEntries(COLOR_TOKENS.map(token => [token, report.tokens.light[token]])),
      dark: Object.fromEntries(COLOR_TOKENS.map(token => [token, report.tokens.dark[token]])),
    },
  });
  await Effect.runPromise(model.define({ folderId: "project", slug: "depth-extra", definition: parentless("depth-extra"), actorId: "owner" }));
  for (let depth = 0; depth <= 4; depth++) await Effect.runPromise(model.define({ folderId: "project", slug: `revision-depth-${depth}`,
    definition: depth === 0 ? parentless(`revision-depth-${depth}`) :
      { ...validThemeDefinition(`revision-depth-${depth}`), extends: { scope: "project", slug: `revision-depth-${depth - 1}` } }, actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "revision-depth-0",
    definition: { ...validThemeDefinition("revision-depth-0"), extends: { scope: "project", slug: "depth-extra" } },
    actorId: "owner", ifRevision: 1 })), rejectsCode("invalid-theme"));
  db.close();
});

test("three-level project theme chains keep child-owned fonts when an ancestor revision changes", async () => {
  let timestamp = Date.parse(NOW);
  const { db, model } = await fixture(themeFontFetcher, () => timestamp += 1_000);
  const root = { ...validThemeDefinition("font-root"), fontSources: [THEME_FONT_SOURCE],
    fonts: { heading: { family: "Example", stack: '"Example", sans-serif' } } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-root", definition: root, actorId: "owner" }));
  const middle = { ...validThemeDefinition("font-middle"), extends: { scope: "project", slug: "font-root" } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-middle", definition: middle, actorId: "owner" }));
  const child = { ...validThemeDefinition("font-child"), extends: { scope: "project", slug: "font-middle" }, fontSources: [THEME_FONT_SOURCE],
    fonts: { heading: { family: "Example", stack: '"Example", sans-serif' } } };
  const childSnapshot = await Effect.runPromise(model.define({ folderId: "project", slug: "font-child", definition: child, actorId: "owner" }));
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-root",
    definition: { ...validThemeDefinition("font-root"), name: "Root without captured font" }, actorId: "owner", ifRevision: 1 }));
  const resolved = await Effect.runPromise(model.resolveForRead({ folderId: "project",
    theme: { scope: "project", slug: "font-child" }, themeId: childSnapshot.id }));
  const ownCapture = db.prepare("SELECT own_fonts_sealed FROM project_theme_revisions WHERE theme_id=? AND revision=1")
    .bind(childSnapshot.id).first<{ own_fonts_sealed: Uint8Array<ArrayBuffer> }>();
  assert.ok(ownCapture?.own_fonts_sealed instanceof Uint8Array);
  assert.equal(resolved.fontsCss, utf8(await Effect.runPromise(openBlob(MASTER, ownCapture.own_fonts_sealed))));
  const revisions = db.prepare("SELECT own_fonts_sealed FROM project_theme_revisions WHERE theme_id IN (SELECT id FROM project_themes WHERE slug IN ('font-root','font-middle','font-child'))").all<{ own_fonts_sealed: Uint8Array }>();
  assert.ok(revisions.results.every(row => row.own_fonts_sealed instanceof Uint8Array));
  db.close();
});

test("name-only update of a parent with a valid four-ancestor descendant succeeds", async () => {
  const { db, model } = await fixture();
  for (let depth = 0; depth <= 4; depth++) await Effect.runPromise(model.define({
    folderId: "project", slug: `four-update-${depth}`,
    definition: depth === 0 ? validThemeDefinition(`four-update-${depth}`) :
      { ...validThemeDefinition(`four-update-${depth}`), extends: { scope: "project", slug: `four-update-${depth - 1}` } },
    actorId: "owner",
  }));
  await Effect.runPromise(model.define({
    folderId: "project", slug: "four-update-0", definition: { ...validThemeDefinition("four-update-0"), name: "Updated" },
    actorId: "owner", ifRevision: 1,
  }));
  assert.equal(db.prepare("SELECT current_revision FROM project_themes WHERE slug='four-update-0'")
    .first<{ current_revision: number }>()?.current_revision, 2);
  db.close();
});

test("parent revisions cannot push descendant composed font captures over the limit", async () => {
  const source = "https://fonts.googleapis.com/css2?family=Example:wght@400&display=swap";
  const url = "https://fonts.gstatic.com/s/example/v1/example.woff2";
  const bytes = new Uint8Array(112_000);
  bytes.set(new TextEncoder().encode("wOF2"));
  new DataView(bytes.buffer).setUint32(8, bytes.length);
  const cssFace = (subset: string) => `/* ${subset} */ @font-face { font-family:'Example'; font-style:normal; font-weight:400; src:url('${url}') format('woff2'); unicode-range:U+0000-00FF; }`;
  const fetcher: FontFetcher = async requested => requested === source
    ? new Response(`${cssFace("latin")}\n${cssFace("latin-ext")}`, { headers: { "content-type": "text/css; charset=utf-8" } })
    : new Response(bytes, { headers: { "content-type": "font/woff2" } });
  const { db, model } = await fixture(fetcher);
  const parent = { ...validThemeDefinition("font-budget-parent"), fonts: { heading: { family: "Example", stack: '"Example", sans-serif' } } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-budget-parent", definition: parent, actorId: "owner" }));
  const child = { ...validThemeDefinition("font-budget-child"), extends: { scope: "project", slug: "font-budget-parent" }, fontSources: [source],
    fonts: { heading: { family: "Example", stack: '"Example", sans-serif' } } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "font-budget-child", definition: child, actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "font-budget-parent",
    definition: { ...parent, fontSources: [source] }, actorId: "owner", ifRevision: 1 })), rejectsCode("invalid-theme"));
  db.close();
});
test("parentless project themes use the default light spacing token", async () => {
  const { db, model } = await fixture();
  const report = getPlatformTheme("report");
  assert.ok(report);
  const definition = {
    slug: "parentless",
    name: "Parentless",
    tokens: {
      light: Object.fromEntries(COLOR_TOKENS.map(token => [token, report.tokens.light[token]])),
      dark: Object.fromEntries(COLOR_TOKENS.map(token => [token, report.tokens.dark[token]])),
    },
  };
  await Effect.runPromise(model.define({ folderId: "project", slug: "parentless", definition, actorId: "owner" }));
  db.close();
});

test("project theme inheritance preserves the compiled parent radius unless explicitly overridden", () => {
  const parent = getPlatformTheme("report");
  assert.ok(parent);
  const resolved = validateThemeDefinition(validThemeDefinition("radius"), { slug: "radius", parent });
  assert.equal(resolved.tokens.light.radius, parent.tokens.light.radius);
  assert.equal(resolved.tokens.dark.radius, parent.tokens.dark.radius);
});

test("falsy project recipes are rejected instead of bypassing recipe validation", async () => {
  const { db, model } = await fixture();
  for (const value of [false, 0] as const) {
    const slug = value === false ? "false-recipe" : "zero-recipe";
    await assert.rejects(Effect.runPromise(model.define({
      folderId: "project", slug, definition: { ...validThemeDefinition(slug), recipes: { aurora: value } }, actorId: "owner",
    })), rejectsCode("invalid-theme"));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_themes WHERE folder_id='project'").first<{ n: number }>()?.n, 0);
  db.close();
});

test("reciprocal concurrent inheritance updates cannot create a cycle", async () => {
  let waiting = 0, openGate!: () => void;
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  const fetcher: FontFetcher = async (url, init) => {
    if (url === THEME_FONT_SOURCE && ++waiting === 2) openGate();
    if (url === THEME_FONT_SOURCE) await gate;
    return themeFontFetcher(url, init);
  };
  const { db, model } = await fixture(fetcher);
  await Effect.runPromise(model.define({ folderId: "project", slug: "cycle-a", definition: validThemeDefinition("cycle-a"), actorId: "owner" }));
  await Effect.runPromise(model.define({ folderId: "project", slug: "cycle-b", definition: validThemeDefinition("cycle-b"), actorId: "owner" }));
  const update = (slug: string, parent: string) => {
    const base = validThemeDefinition(slug);
    return Effect.runPromise(model.define({
      folderId: "project", slug, actorId: "owner", ifRevision: 1,
      definition: { ...base, extends: { scope: "project", slug: parent }, fontSources: [THEME_FONT_SOURCE],
        fonts: { ...base.fonts, heading: { family: "Example", stack: '"Example", system-ui, sans-serif' } } },
    }));
  };
  const results = await Promise.allSettled([update("cycle-a", "cycle-b"), update("cycle-b", "cycle-a")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected && rejectsCode("revision-conflict")(rejected.reason));
  db.close();
});

test("resolved project themes reject contrast failures in either color scheme without revisions", async () => {
  const { db, model } = await fixture();
  for (const [slug, scheme, color] of [["bad-light", "light", "#ffffff"], ["bad-dark", "dark", "#000000"]] as const) {
    const definition = validThemeDefinition(slug);
    (definition.tokens[scheme] as Record<string, string>).ink = color;
    await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug, definition, actorId: "owner" })), rejectsCode("invalid-theme"));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_themes WHERE folder_id='project'").first<{ n: number }>()?.n, 0);
  db.close();
});

test("project inheritance resolves only same-project parents and rejects cycles/depth over four", async () => {
  const { db, model } = await fixture();
  await Effect.runPromise(model.define({ folderId: "other", slug: "shared", definition: validThemeDefinition("shared"), actorId: "owner" }));
  await assert.rejects(Effect.runPromise(model.define({
    folderId: "project", slug: "foreign-child", definition: { ...validThemeDefinition("foreign-child"), extends: { scope: "project", slug: "shared" } }, actorId: "owner",
  })), rejectsCode("invalid-theme"));
  await Effect.runPromise(model.define({ folderId: "project", slug: "parent", definition: validThemeDefinition("parent"), actorId: "owner" }));
  const child = { ...validThemeDefinition("child"), extends: { scope: "project" as const, slug: "parent" } };
  await Effect.runPromise(model.define({ folderId: "project", slug: "child", definition: child, actorId: "owner" }));
  await Effect.runPromise(model.define({ folderId: "project", slug: "cycle-a", definition: validThemeDefinition("cycle-a"), actorId: "owner" }));
  await Effect.runPromise(model.define({
    folderId: "project", slug: "cycle-b", definition: { ...validThemeDefinition("cycle-b"), extends: { scope: "project", slug: "cycle-a" } }, actorId: "owner",
  }));
  await assert.rejects(Effect.runPromise(model.define({
    folderId: "project", slug: "cycle-a", definition: { ...validThemeDefinition("cycle-a"), extends: { scope: "project", slug: "cycle-b" } }, actorId: "owner", ifRevision: 1,
  })), rejectsCode("invalid-theme"));
  for (let depth = 0; depth <= 4; depth++) {
    const slug = `depth-${depth}`;
    await Effect.runPromise(model.define({
      folderId: "project", slug, definition: depth === 0 ? validThemeDefinition(slug) :
        { ...validThemeDefinition(slug), extends: { scope: "project", slug: `depth-${depth - 1}` } }, actorId: "owner",
    }));
  }
  await assert.rejects(Effect.runPromise(model.define({
    folderId: "project", slug: "depth-5",
    definition: { ...validThemeDefinition("depth-5"), extends: { scope: "project", slug: "depth-4" } }, actorId: "owner",
  })), rejectsCode("invalid-theme"));
  assert.equal(db.prepare("SELECT current_revision FROM project_themes WHERE folder_id='project' AND slug='cycle-a'").first<{ current_revision: number }>()?.current_revision, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_themes WHERE folder_id='project' AND slug='depth-5'").first<{ n: number }>()?.n, 0);
  db.close();
});

test("project recipe parameters remain bounded after inheritance", async () => {
  const { db, model } = await fixture();
  const definition = { ...validThemeDefinition("bounded"), recipes: { aurora: {
    colors: ["accent", "c1", "c5"], intensity: 1, angle: 136, positions: ["80% 16%", "93% 68%", "65% 90%"],
  } } };
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "bounded", definition, actorId: "owner" })), rejectsCode("invalid-theme"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_themes WHERE folder_id='project' AND slug='bounded'").first<{ n: number }>()?.n, 0);
  db.close();
});
test("font capture failures leave project theme revisions untouched", async () => {
  const fontUrl = "https://fonts.gstatic.com/s/example/v1/example.woff2";
  const fontBytes = new Uint8Array(48);
  fontBytes.set(new TextEncoder().encode("wOF2"));
  new DataView(fontBytes.buffer).setUint32(8, fontBytes.byteLength);
  const fetcher: FontFetcher = async url => {
    if (url === THEME_FONT_SOURCE) return new Response(
      `/* latin */ @font-face { font-family:'Example'; font-weight:400; src:url('${fontUrl}') format('woff2'); }`,
      { headers: { "content-type": "text/css; charset=utf-8" } },
    );
    if (url === fontUrl) return new Response(fontBytes, { headers: { "content-type": "font/ttf" } });
    throw new Error(`Unexpected font URL: ${url}`);
  };
  const { db, model } = await fixture(fetcher);
  const base = validThemeDefinition("bad-font");
  const definition = { ...base, fontSources: [THEME_FONT_SOURCE],
    fonts: { ...base.fonts, heading: { family: "Example", stack: '"Example", system-ui, sans-serif' } } };
  await assert.rejects(Effect.runPromise(model.define({ folderId: "project", slug: "bad-font", definition, actorId: "owner" })), rejectsCode("font-format"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_themes WHERE folder_id='project' AND slug='bad-font'").first<{ n: number }>()?.n, 0);
  db.close();
});
