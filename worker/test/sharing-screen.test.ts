// Console collaboration boundaries: direct requests must enforce roles and CSRF
// independently of the React controls. Presentation is exercised in the browser;
// these fixtures track whether refused actions can reach the underlying models.

import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";

import { handleConsole } from "../src/console.js";
import { openConsoleContext, type TestConsoleContext } from "./doubles.js";
import type { CurrentSession } from "../src/auth.js";
import type { Access, EstateRole, GrantInput, Permission } from "../src/access.js";
import type { Artifact, Artifacts, CreateArtifact, PublishArtifact } from "../src/artifacts.js";
import type { Analytics, AnalyticsSummary } from "../src/analytics.js";
import type { Folder, Folders, CreateFolder } from "../src/folders.js";
import type { ShareView, Shares, CreateShareInput } from "../src/shares.js";
import type { AuditEntry, User } from "../src/store.js";
import type { CodeError } from "../src/types.js";

const HTML = `<!doctype html><html lang="en"><head><title>Doc</title></head><body><h1>Hi</h1></body></html>`;

const OWNER: User = {
  id: "u-owner", email: "owner@example.test", name: "Olive Owner", role: "member", status: "active", passwordHash: "{}",
  totpSecretSealed: null, totpSecretPendingSealed: null, passkeys: [], invitedBy: null, createdAt: "", lastLoginAt: null,
};
const MATE: User = { ...OWNER, id: "u-mate", email: "mate@example.test", name: "Milo Mate" };
const GHOST: User = { ...OWNER, id: "u-ghost", email: "ghost@example.test", name: "Gone", status: "suspended" };
const THIRD: User = { ...OWNER, id: "u-third", email: "third@example.test", name: "Third" };

const FOLDER: Folder = { id: "f1", slug: "acme", nameSealed: "s", ownerId: OWNER.id, parentId: null, createdAt: "", updatedAt: "" };
const SUBFOLDER: Folder = { ...FOLDER, id: "f2", slug: "acme-sub", parentId: "f1" };
const ARTEFACT: Artifact = {
  id: "a1", ownerId: OWNER.id, folderId: "f1", slug: "report", lang: "en", currentVersion: 2,
  titleSealed: "s", headerUi: true, verifier: null, wrapMaster: null, maxVersions: null,
  wrapPassword: { v: 1, ksalt: "", iter: 1, iv: "", ct: "", tag: "" },
  createdAt: "", updatedAt: "", deletedAt: null, purgedAt: null,
};

const FOLDERS: Record<string, Folder> = { f1: FOLDER, f2: SUBFOLDER };
const BY_SLUG: Record<string, Folder> = { acme: FOLDER, "acme-sub": SUBFOLDER };

const SHARE: ShareView = {
  id: "sh1", kind: "artifact", targetId: "a1", name: "Acme board pack", recipient: "client@example.test",
  url: "https://example.test/report/s/" + "a".repeat(40) + "/",
  createdAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-10-01T23:59:59.000Z", revokedAt: null, gated: true,
  lastSentAt: null, allowProtected: false,
};

const SUMMARY: AnalyticsSummary = {
  totals: { opens: 12, activeSeconds: 930, scroll25: 11, scroll50: 9, scroll75: 5, scroll100: 3 },
  shares: [{ shareId: "sh1", opens: 12, activeSeconds: 930, maxScroll: 100, lastOpenedAt: "2026-09-18T08:30:00.000Z" }],
  days: [{ day: "2026-09-17", opens: 5, activeSeconds: 400 }, { day: "2026-09-18", opens: 7, activeSeconds: 530 }],
};

const RANK: Record<EstateRole, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 };
const NEED: Record<Permission, number> = { read: 1, write: 2, manage: 3, own: 4 };
interface HarnessOptions { as?: User; role?: EstateRole | null; shareError?: CodeError; grantError?: CodeError }
interface AuditCall {
  actorType: string; actorId: unknown; action: string; options?: Pick<AuditEntry, "artifactId" | "detail">;
}

/**
 * One synthetic console. `as` is the acting user and `role` their standing over the fixture
 * folder — "owner" means they are the owner themselves, null means a stranger with no grant.
 * The access stub is the real ladder in miniature: `may` is derived from the same role `role()`
 * reports, so a handler that forgets to ask is the only way a refusal can go missing.
 */
function harness({ as = OWNER, role = "owner", shareError, grantError }: HarnessOptions = {}) {
  const base = openConsoleContext();
  const calls = {
    shareCreate: [] as Array<CreateShareInput | undefined>,
    shareRevoke: [] as Array<Parameters<Shares["revoke"]>[0]>,
    grant: [] as Array<["list", Parameters<Access["grants"]>[0]] | ["grant", GrantInput]>,
    grantRevoke: [] as Array<Parameters<Access["revoke"]>[0]>,
    summary: [] as Array<Parameters<Analytics["summary"]>[0]>, platformSummary: [] as boolean[],
    setRetention: [] as unknown[], publish: [] as PublishArtifact[],
    setPassword: [] as Array<Parameters<Artifacts["setPassword"]>>,
    setMeta: [] as Array<Parameters<Artifacts["setMeta"]>>,
    moveTo: [] as Array<Parameters<Artifacts["moveTo"]>>,
    setParent: [] as Array<Parameters<Folders["setParent"]>>,
    foldersCreate: [] as CreateFolder[],
    foldersAlias: [] as Array<Parameters<Folders["alias"]>>,
    artifactsAlias: [] as Array<Parameters<Artifacts["alias"]>>,
    foldersSetName: [] as Array<Parameters<Folders["setName"]>>, document: [] as string[],
  };
  const rank = () => {
    const standing = as.id === OWNER.id ? "owner" : role;
    return standing ? RANK[standing] : 0;
  };
  const access: Access = {
    ...base.access,
    role: (userId, folderId) => Effect.succeed(FOLDERS[String(folderId)] ? (userId === OWNER.id ? "owner" : role) : null),
    may: (userId, subject, need = "read") => Effect.sync(() => {
      if (subject?.ownerId === userId) return true;
      if (!subject?.folderId || (need !== "read" && need !== "write" && need !== "manage" && need !== "own")) return false;
      return rank() >= NEED[need];
    }),
    foldersFor: userId => Effect.succeed(userId === OWNER.id || rank() > 0 ? [FOLDER, SUBFOLDER] : []),
    grants: args => Effect.sync(() => {
      calls.grant.push(["list", args]);
      return [
        { userId: MATE.id, email: MATE.email, name: MATE.name ?? MATE.email, role: "editor", folderId: "f1", inherited: false, active: true, createdAt: "" },
        { userId: THIRD.id, email: THIRD.email, name: THIRD.name ?? THIRD.email, role: "viewer", folderId: "f1", inherited: true, active: true, createdAt: "" },
      ];
    }),
    grant: args => Effect.gen(function* () {
      calls.grant.push(["grant", args]);
      if (grantError) return yield* Effect.fail(grantError);
      return {
        folderId: args.folderId, userId: args.userId, role: args.role === "manager" ? "manager" as const : args.role === "editor" ? "editor" as const : "viewer" as const,
        grantedBy: args.actorId, createdAt: "", updatedAt: "",
      };
    }),
    revoke: args => Effect.sync(() => { calls.grantRevoke.push(args); return true; }),
  };
  const shares: Shares = {
    ...base.shares,
    listFor: () => Effect.succeed([SHARE]),
    create: args => Effect.gen(function* () {
      calls.shareCreate.push(args);
      if (shareError) return yield* Effect.fail(shareError);
      return { ...SHARE, id: "sh-new", ownerId: OWNER.id, mailStatus: "not-requested" as const };
    }),
    revoke: args => Effect.sync(() => { calls.shareRevoke.push(args); return true; }),
  };
  const analytics: Analytics = {
    ...base.analytics,
    summary: args => Effect.sync(() => { calls.summary.push(args); return SUMMARY; }),
    platformSummary: () => Effect.sync(() => {
      calls.platformSummary.push(true);
      return { totals: { opens: 40, activeSeconds: 6000, shares: 3 }, days: SUMMARY.days };
    }),
    setRetention: value => Effect.gen(function* () {
      calls.setRetention.push(value);
      return yield* base.analytics.setRetention(value);
    }),
  };
  const active: CurrentSession = {
    session: { id: "session", userId: as.id, csrf: "csrf", pending2fa: false, createdAt: "", expiresAt: "" }, user: as,
  };
  const audits: AuditCall[] = [];
  const usersById: Record<string, User> = { [OWNER.id]: OWNER, [MATE.id]: MATE, [THIRD.id]: THIRD };
  const usersByEmail: Record<string, User> = { [OWNER.email]: OWNER, [MATE.email]: MATE, [GHOST.email]: GHOST };
  const ctx: TestConsoleContext = {
    ...base,
    auth: {
      ...base.auth,
      currentSession: () => Effect.succeed(active),
      audit: (actorType, actorId, action, options) => Effect.sync(() => { audits.push({ actorType, actorId, action, options }); }),
    },
    store: { ...base.store, users: {
      ...base.store.users,
      byId: id => Effect.succeed(usersById[String(id)] ?? null),
      byEmail: email => Effect.succeed(usersByEmail[email] ?? null),
      all: () => Effect.succeed([OWNER, MATE]),
    } },
    access, shares, analytics,
    folders: {
      ...base.folders,
      all: () => Effect.succeed([FOLDER, SUBFOLDER]),
      bySlug: slug => Effect.succeed(BY_SLUG[String(slug)] ?? null),
      byId: id => Effect.succeed(FOLDERS[String(id)] ?? null),
      aliasesFor: () => Effect.succeed([]),
      name: folder => Effect.succeed(folder === FOLDER ? "Acme" : "Acme sub"),
      create: args => Effect.sync(() => {
        calls.foldersCreate.push(args);
        return { ...FOLDER, id: "f-new", slug: null, ownerId: args.ownerId, parentId: args.parentId ?? null };
      }),
      alias: (path, id) => Effect.sync(() => { calls.foldersAlias.push([path, id]); return String(path); }),
      setName: (id, name) => Effect.sync(() => { calls.foldersSetName.push([id, name]); return { ...FOLDER, id }; }),
      setParent: (id, parentId) => Effect.sync(() => { calls.setParent.push([id, parentId]); return { ...FOLDER, id, parentId }; }),
    },
    artifacts: {
      ...base.artifacts,
      listByFolder: folderId => Effect.succeed(folderId === "f1" ? [ARTEFACT] : []),
      listByOwner: () => Effect.succeed([ARTEFACT]),
      listForEstate: (ownerId, folderIds) => Effect.succeed(
        folderIds.includes(ARTEFACT.folderId ?? "") || (!ARTEFACT.folderId && ARTEFACT.ownerId === ownerId) ? [ARTEFACT] : [],
      ),
      title: () => Effect.succeed("Quarterly report"),
      bySlug: slug => Effect.succeed(slug === "report" ? ARTEFACT : null),
      byId: id => Effect.succeed(id === "a1" ? ARTEFACT : null),
      aliasesFor: () => Effect.succeed([]),
      versions: () => Effect.succeed([{
        artifactId: "a1", version: 2, size: 120, authorType: "user", authorId: OWNER.id, r2Key: "art/a1/2.enc", sha256: "",
        note: null, createdAt: "2026-09-10T10:00:00.000Z", type: "site", themeScope: null, themeId: null,
        themeSlug: null, themeOverridesSealed: null, brandLock: false,
      }]),
      document: artifact => Effect.sync(() => { calls.document.push(artifact?.id ?? ""); return HTML; }),
      publish: args => Effect.sync(() => { calls.publish.push(args); return { version: 3, size: 120, createdAt: "", warnings: [] }; }),
      setMeta: (id, meta) => Effect.sync(() => { calls.setMeta.push([id, meta]); return { ...ARTEFACT, id }; }),
      setPassword: (id, password) => Effect.sync(() => { calls.setPassword.push([id, password]); return { ...ARTEFACT, id }; }),
      alias: (path, id) => Effect.sync(() => { calls.artifactsAlias.push([path, id]); return String(path); }),
      moveTo: (id, folderId) => Effect.sync(() => { calls.moveTo.push([id, folderId]); return { ...ARTEFACT, id, folderId }; }),
    },
  };
  const request = (path: string, init: RequestInit = {}) =>
    Effect.runPromise(handleConsole(new Request(`https://example.test${path}`, { headers: { cookie: "wsa_session=session" }, ...init }), ctx,
      { area: path.split("/")[1], rest: path.replace(/^\/[^/]+\/?/, "") }));
  const post = (path: string, fields: Record<string, string>) => request(path, {
    method: "POST",
    headers: { cookie: "wsa_session=session", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { ctx, calls, audits, request, post };
}

const body = (response: Response) => response.text();

// ---- and what each standing is refused when it posts anyway ------------------------

test("a viewer posting straight at the write endpoints is refused, and nothing moves", async () => {
  const { post, calls } = harness({ as: MATE, role: "viewer" });
  const attempts: Array<[string, Record<string, string>]> = [
    ["/app/a/report/publish", { html: HTML }],
    ["/app/a/report/meta", { title: "Mine now" }],
    ["/app/a/report/password", { password: "x" }],
    ["/app/a/report/alias", { paths: "old" }],
    ["/app/a/report/move", { folder: "acme-sub" }],
    ["/app/f/acme/name", { name: "Mine" }],
    ["/app/f/acme/alias", { paths: "old" }],
    ["/app/f/acme/subfolder", { name: "Mine" }],
  ];
  for (const [path, fields] of attempts) {
    const response = await post(path, { csrf: "csrf", ...fields });
    assert.equal(response.status, 403, path);
  }
  assert.deepEqual(calls.publish, []);
  assert.deepEqual(calls.setMeta, []);
  assert.deepEqual(calls.setPassword, []);
  assert.deepEqual(calls.moveTo, []);
  assert.deepEqual(calls.foldersCreate, []);
  assert.deepEqual(calls.foldersSetName, []);
  assert.deepEqual(calls.artifactsAlias, []);
  assert.deepEqual(calls.foldersAlias, []);
});

test("an editor may not mint or revoke a visitor share", async () => {
  const { post, calls } = harness({ as: MATE, role: "editor" });
  assert.equal((await post("/app/a/report/share", { csrf: "csrf", name: "Theirs", recipient: "x@example.test" })).status, 403);
  assert.equal((await post("/app/f/acme/share", { csrf: "csrf", name: "Theirs", recipient: "x@example.test" })).status, 403);
  assert.equal((await post("/app/a/report/share-revoke", { csrf: "csrf", shareId: "sh1" })).status, 403);
  assert.deepEqual(calls.shareCreate, []);
  assert.deepEqual(calls.shareRevoke, []);
});

test("a manager may not change who else gets in — that stays the owner's", async () => {
  const { post, calls } = harness({ as: MATE, role: "manager" });
  assert.equal((await post("/app/f/acme/grant", { csrf: "csrf", email: "third@example.test", role: "editor" })).status, 403);
  assert.equal((await post("/app/f/acme/grant-revoke", { csrf: "csrf", userId: "u-third" })).status, 403);
  assert.equal((await post("/app/f/acme/move", { csrf: "csrf", parent: "root" })).status, 403);
  assert.deepEqual(calls.grant.filter(([kind]) => kind === "grant"), []);
  assert.deepEqual(calls.grantRevoke, []);
  assert.deepEqual(calls.setParent, []);
});

test("a stranger gets the same flat 404 for a pane, an action and the preview", async () => {
  const { request, post, calls } = harness({ as: MATE, role: null });
  assert.equal((await request("/app/f/acme")).status, 404);
  assert.equal((await request("/app/a/report")).status, 404);
  assert.equal((await request("/app/a/report/view")).status, 404);
  assert.equal((await request("/app/a/report/preview")).status, 404);
  assert.equal((await post("/app/a/report/publish", { csrf: "csrf", html: HTML })).status, 404);
  assert.equal((await post("/app/f/acme/share", { csrf: "csrf", name: "Theirs", recipient: "x@example.test" })).status, 404);
  assert.deepEqual(calls.document, []);
  assert.deepEqual(calls.publish, []);
  assert.deepEqual(calls.shareCreate, []);
});

test("every new door refuses a wrong CSRF token before it reaches a model", async () => {
  const { post, calls } = harness();
  const attempts: Array<[string, Record<string, string>]> = [
    ["/app/a/report/share", { name: "Acme board", recipient: "x@example.test" }],
    ["/app/a/report/share-revoke", { shareId: "sh1" }],
    ["/app/f/acme/share", { name: "Acme board", recipient: "x@example.test" }],
    ["/app/f/acme/share-revoke", { shareId: "sh1" }],
    ["/app/f/acme/grant", { email: MATE.email, role: "editor" }],
    ["/app/f/acme/grant-revoke", { userId: MATE.id }],
  ];
  for (const [path, fields] of attempts) {
    assert.equal((await post(path, { csrf: "wrong", ...fields })).status, 403, path);
  }
  assert.deepEqual(calls.shareCreate, []);
  assert.deepEqual(calls.shareRevoke, []);
  assert.deepEqual(calls.grantRevoke, []);
  assert.deepEqual(calls.grant.filter(([kind]) => kind === "grant"), []);
});

// ---- the share form itself ---------------------------------------------------------

test("a nonsense expiry is refused on the form, before the model is asked", async () => {
  const { post, calls } = harness();
  const past = await post("/app/a/report/share", { csrf: "csrf", name: "Acme board", recipient: "c@example.test", expiresAt: "2020-01-01" });
  assert.equal(past.status, 400);
  const far = await post("/app/a/report/share", { csrf: "csrf", name: "Acme board", recipient: "c@example.test", expiresAt: "2099-12-31" });
  assert.equal(far.status, 400);
  const bad = await post("/app/a/report/share", { csrf: "csrf", name: "Acme board", recipient: "not-an-address" });
  assert.equal(bad.status, 400);
  assert.deepEqual(calls.shareCreate, []);
});

test("typed share and grant failures recover to refused HTTP responses", async () => {
  const denied: CodeError = Object.assign(new Error("The target cannot be managed."), { code: "forbidden" });
  const { post } = harness({ shareError: denied, grantError: denied });
  for (const path of ["/app/a/report/share", "/app/f/acme/share"]) {
    const response = await post(path, { csrf: "csrf", name: "Client copy" });
    assert.equal(response.status, 403);
  }
  const grant = await post("/app/f/acme/grant", { csrf: "csrf", email: MATE.email, role: "editor" });
  assert.equal(grant.status, 403);
});



// ---- colleague grants ---------------------------------------------------------------

test("a grant is made by exact address, and an unknown or suspended one is refused", async () => {
  const { post, calls } = harness();
  const ok = await post("/app/f/acme/grant", { csrf: "csrf", email: "Mate@Example.test", role: "manager" });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.grant.filter(([kind]) => kind === "grant").map(([, args]) => args), [
    { actorId: OWNER.id, folderId: "f1", userId: MATE.id, role: "manager" },
  ]);

  const unknown = await post("/app/f/acme/grant", { csrf: "csrf", email: "nobody@example.test", role: "viewer" });
  assert.equal(unknown.status, 400);
  const suspended = await post("/app/f/acme/grant", { csrf: "csrf", email: GHOST.email, role: "viewer" });
  assert.equal(suspended.status, 400);
  const badRole = await post("/app/f/acme/grant", { csrf: "csrf", email: MATE.email, role: "owner" });
  assert.equal(badRole.status, 400);
  assert.equal(calls.grant.filter(([kind]) => kind === "grant").length, 1);   // only the good one landed
});


// ---- the authenticated preview -------------------------------------------------------

test("the authenticated preview keeps authored content out of its trusted parent response", async () => {
  const { request, calls } = harness({ as: MATE, role: "viewer" });
  const response = await request("/app/a/report/preview");
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(HTML), false);
  assert.deepEqual(calls.document, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
});

test("the preview is a GET; a POST at it is not an alternative route into the document", async () => {
  const { request, calls } = harness();
  const response = await request("/app/a/report/preview", { method: "POST", headers: { cookie: "wsa_session=session" } });
  assert.equal(response.status, 405);
  assert.deepEqual(calls.document, []);
});

// ---- the platform's own figures --------------------------------------------------------

test("the platform overview does not disclose recipients", async () => {
  const { request, calls } = harness({ as: { ...OWNER, role: "admin" } });
  const page = await body(await request("/admin"));
  assert.equal(calls.platformSummary.length, 1);
  assert.equal(page.includes("client@example.test"), false);    // never a recipient here
});

test("analytics retention is the owner's; an administrator cannot read or set it", async () => {
  const owner = harness({ as: { ...OWNER, role: "owner" } });
  assert.equal((await owner.request("/admin/settings")).status, 200);
  const saved = await owner.post("/admin/settings/analytics", { csrf: "csrf", days: "30" });
  assert.equal(saved.status, 200);
  assert.deepEqual(owner.calls.setRetention, [30]);

  const admin = harness({ as: { ...OWNER, role: "admin" } });
  assert.equal((await admin.request("/admin/settings")).status, 403);
  assert.equal((await admin.post("/admin/settings/analytics", { csrf: "csrf", days: "5" })).status, 403);
  assert.deepEqual(admin.calls.setRetention, []);
});

test("analytics retention refuses a wrong CSRF token and an out-of-range span", async () => {
  const { post, calls } = harness({ as: { ...OWNER, role: "owner" } });
  assert.equal((await post("/admin/settings/analytics", { csrf: "wrong", days: "30" })).status, 403);
  assert.deepEqual(calls.setRetention, []);
  const wide = await post("/admin/settings/analytics", { csrf: "csrf", days: "4000" });
  assert.equal(wide.status, 400);
});

// ---- publishing into a colleague's folder ----------------------------------------------

test("an editor publishing into a shared folder hands the artefact to the folder's owner", async () => {
  const { post, ctx, calls } = harness({ as: MATE, role: "editor" });
  const created: CreateArtifact[] = [];
  ctx.artifacts.create = args => Effect.sync(() => {
    created.push(args);
    return { ...ARTEFACT, id: "a-new", slug: args.slug ?? null, ownerId: args.ownerId, folderId: args.folderId ?? null };
  });
  const response = await post("/app/new", {
    csrf: "csrf", folder: "acme", title: "New", slug: "new-doc", lang: "en", html: HTML,
  });
  assert.equal(response.status, 303);
  assert.equal(created[0].ownerId, OWNER.id);                   // the folder's owner, not the publisher
  assert.equal(created[0].authorId, MATE.id);                   // ...who is still the version's author
  assert.equal(created[0].folderId, "f1");

  // ...and a subfolder founded there belongs to the same owner.
  await post("/app/f/acme/subfolder", { csrf: "csrf", name: "Nested" });
  assert.deepEqual(calls.foldersCreate, [{ ownerId: OWNER.id, name: "Nested", parentId: "f1" }]);
});

test("a viewer cannot publish into the folder they may only read", async () => {
  const { post, ctx } = harness({ as: MATE, role: "viewer" });
  const created: CreateArtifact[] = [];
  ctx.artifacts.create = args => Effect.sync(() => {
    created.push(args);
    return { ...ARTEFACT, id: "a-new", slug: args.slug ?? null, ownerId: args.ownerId, folderId: args.folderId ?? null };
  });
  const response = await post("/app/new", {
    csrf: "csrf", folder: "acme", title: "New", slug: "new-doc", lang: "en", html: HTML,
  });
  assert.equal(response.status, 404);                           // a folder you may not write into is a miss
  assert.deepEqual(created, []);
});

