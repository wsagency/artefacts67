import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";

import worker from "../src/index.js";
import { handleConsole, handleAuth } from "../src/console.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding, openConsoleContext } from "./doubles.js";
import { openStore } from "../src/store.js";
import { openAuth } from "../src/auth.js";
import { openMailer } from "../src/mail.js";
import { totpCode } from "../src/crypto.js";
import { asCodeError } from "../src/types.js";

const MASTER = "6465762d6d61737465722d6b65792d4e4f542d464f522d70726f642d75736521";


function services() {
  const DB = openD1Shim();
  const store = openStore(DB);
  const auth = openAuth({ store, mailer: openMailer(), masterKeyHex: MASTER, origin: "https://example.test" });
  return { DB, store, auth };
}

function cookieOf(response: Response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";", 1)[0];
}

interface ScreenProps { secret?: string; csrf?: string; me?: { csrf?: string } }
function screenProps(html: string): ScreenProps {
  const script = /<script\b[^>]*\bid="ws-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!script) throw new Error("Screen JSON bootstrap is missing.");
  const bootstrap: unknown = JSON.parse(script[1]);
  if (!bootstrap || typeof bootstrap !== "object" || !("props" in bootstrap))
    throw new Error("Screen props are missing.");
  const props = bootstrap.props;
  if (!props || typeof props !== "object") throw new Error("Screen props must be an object.");
  const me = "me" in props ? props.me : undefined;
  return {
    secret: "secret" in props && typeof props.secret === "string" ? props.secret : undefined,
    csrf: "csrf" in props && typeof props.csrf === "string" ? props.csrf : undefined,
    me: me && typeof me === "object" && "csrf" in me && typeof me.csrf === "string" ? { csrf: me.csrf } : undefined,
  };
}

function csrfOf(body: string) {
  const props = screenProps(body);
  return props.csrf ?? props.me?.csrf ?? "";
}

async function body(response: Response) {
  return response.text();
}

test("owner bootstrap, mandatory TOTP, invite lifecycle and role rules", async t => {
  const { DB, store, auth } = services();
  t.after(() => DB.close());
  const boot = await Effect.runPromise(auth.registerOwner({
    name: "Owner", email: "owner@example.test", password: "correct horse", confirm: "correct horse",
  }));
  assert.equal(boot.user.role, "owner");
  assert.equal(boot.session.pending2fa, true);
  assert.equal((await Effect.runPromise(auth.currentSession(boot.session.id)))?.session.pending2fa, true);

  const setup = await Effect.runPromise(auth.beginTotpEnroll(boot.user));
  const staged = await Effect.runPromise(store.users.byId(boot.user.id));
  assert.ok(staged);
  assert.equal(await Effect.runPromise(auth.confirmTotpEnroll(staged, "not-a-code")), false);
  assert.equal(await Effect.runPromise(auth.confirmTotpEnroll(staged, await Effect.runPromise(totpCode(setup.secret, Date.now())))), true);

  const owner = await Effect.runPromise(store.users.byId(boot.user.id));
  assert.ok(owner);
  assert.equal(owner.totpSecretSealed !== null, true);
  const full = await Effect.runPromise(auth.elevate(boot.session));
  assert.notEqual(full.id, boot.session.id);
  assert.notEqual(full.csrf, boot.session.csrf);
  assert.equal(await Effect.runPromise(store.sessions.get(boot.session.id)), null);
  assert.equal((await Effect.runPromise(auth.currentSession(full.id)))?.session.pending2fa, false);

  const pendingLogin = await Effect.runPromise(auth.login({ email: "OWNER@example.test", password: "correct horse" }));
  assert.equal(pendingLogin.user.id, owner.id);
  assert.equal(pendingLogin.session.pending2fa, true);
  assert.equal(await Effect.runPromise(auth.verifyTotp(owner, await Effect.runPromise(totpCode(setup.secret, Date.now())))), true);

  const invite = await Effect.runPromise(auth.invite({ email: "member@example.test", role: "member", invitedBy: owner.id }));
  const member = await Effect.runPromise(auth.acceptInvite({ token: invite.token, name: "Member", password: "member pass", confirm: "member pass" }));
  assert.equal(member.user.role, "member");
  await assert.rejects(() => Effect.runPromise(auth.acceptInvite({ token: invite.token, name: "Again", password: "member pass", confirm: "member pass" })), /This invitation is not valid, or it has already been used\./);
  await assert.rejects(() => Effect.runPromise(auth.invite({ email: "admin@example.test", role: "admin", invitedBy: member.user.id })), (error: unknown) => asCodeError(error).code === "forbidden");

  assert.equal(auth.canManage(owner, member.user), true);
  assert.equal(auth.canManage(member.user, owner), false);
  assert.equal(await Effect.runPromise(auth.wouldOrphanOwners(owner, { demoting: true })), true);
});

test("HTTP bootstrap and admin surface enforce the 2FA gate and CSRF", async t => {
  const env = {
    DB: openD1Shim(),
    ARTEFACTS_MASTER_KEY: MASTER,
    RATELIMIT: rateLimitBinding(),
    ARTIFACTS: memoryBucket(),
  };
  t.after(() => env.DB.close());
  const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env);

  let response = await request("/login");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/register");

  for (const expected of [401, 401, 429]) {
    response = await request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "nobody@example.test", password: "wrong password" }),
    });
    assert.equal(response.status, expected);
  }
  response = await request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "nobody@example.test", password: "wrong password" }),
  });
  assert.equal(response.status, 429);

  response = await request("/register", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Owner", email: "owner@example.test", password: "correct horse", confirm: "correct horse" }),
  });
  assert.equal(response.status, 303);
  const pendingCookie = cookieOf(response);
  assert.match(pendingCookie, /^wsa_session=[a-f0-9]{64}$/);
  assert.match(response.headers.get("set-cookie") ?? "", /; Secure/);

  response = await request("/app", { headers: { cookie: pendingCookie } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/enroll");

  response = await request("/enroll", { headers: { cookie: pendingCookie } });
  const enrollPage = await body(response);
  const secret = screenProps(enrollPage).secret;
  assert.ok(secret);
  const csrf = csrfOf(enrollPage);
  assert.equal(response.status, 200);
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(csrf, /^[a-f0-9]{32}$/);

  response = await request("/enroll", {
    method: "POST",
    headers: { cookie: pendingCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, code: await Effect.runPromise(totpCode(secret, Date.now())) }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/app");
  const fullCookie = cookieOf(response);

  response = await request("/settings", { headers: { cookie: fullCookie } });
  const accountPage = await body(response);
  const accountCsrf = csrfOf(accountPage);
  assert.equal(response.status, 200);

  response = await request("/settings/password", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong", current: "correct horse", new: "new correct horse", confirm: "new correct horse" }),
  });
  assert.equal(response.status, 403);

  response = await request("/settings/password", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: accountCsrf, current: "correct horse", new: "new correct horse", confirm: "new correct horse" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/settings");

  const ownerRow = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("owner@example.test").first<{ id: string }>();
  assert.ok(ownerRow);
  await Effect.runPromise(openStore(env.DB).users.setPasskeys(ownerRow.id, [{
    id: "fake-passkey", name: "Test", alg: -8, kty: 1, crv: 6,
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", signCount: 0,
    createdAt: new Date().toISOString(), lastUsedAt: null,
  }]));
  response = await request("/settings", { headers: { cookie: fullCookie } });
  const passkeyPage = await body(response);
  const passkeyCsrf = csrfOf(passkeyPage);
  response = await request("/settings/passkeys/remove", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: passkeyCsrf, passkeyId: "fake-passkey" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/settings");
  const passkeysAfter = await env.DB.prepare("SELECT passkeys FROM users WHERE id = ?").bind(ownerRow.id).first<{ passkeys: string }>();
  assert.ok(passkeysAfter);
  assert.deepEqual(JSON.parse(passkeysAfter.passkeys), []);

  response = await request("/app", { headers: { cookie: fullCookie } });
  const invitePage = await body(response);
  const adminCsrf = csrfOf(invitePage);
  assert.equal(response.status, 200);

  response = await request("/app/invite", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong", email: "member@example.test", role: "member" }),
  });
  assert.equal(response.status, 403);

  response = await request("/app/invite", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: adminCsrf, email: "member@example.test", role: "member" }),
  });
  const invitedPage = await body(response);
  assert.equal(response.status, 200);
  const inviteToken = /\/invite\/([a-f0-9]{48})/.exec(invitedPage)?.[1];
  assert.ok(inviteToken);
  response = await request(`/invite/${inviteToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Member", password: "member pass", confirm: "member pass" }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/enroll");
  const memberRow = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("member@example.test").first<{ id: string }>();
  assert.ok(memberRow);

  response = await request("/admin/users", { headers: { cookie: fullCookie } });
  const usersPage = await body(response);
  const usersCsrf = csrfOf(usersPage);
  assert.equal(response.status, 200);
  response = await request("/admin/users/role", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: usersCsrf, userId: memberRow.id, role: "admin" }),
  });
  assert.equal(response.status, 303);
  const promoted = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(memberRow.id).first<{ role: string }>();
  assert.equal(promoted?.role, "admin");

  response = await request("/admin/users/suspend", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: usersCsrf, userId: memberRow.id, suspend: "1" }),
  });
  assert.equal(response.status, 303);
  const suspended = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(memberRow.id).first<{ status: string }>();
  assert.equal(suspended?.status, "suspended");


  response = await request("/admin/settings", { headers: { cookie: fullCookie } });
  const settingsPage = await body(response);
  const settingsCsrf = csrfOf(settingsPage);
  assert.equal(response.status, 200);

  response = await request("/admin/settings/retention", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong", retention: "25" }),
  });
  assert.equal(response.status, 403);                           // CSRF still guards it

  response = await request("/admin/settings/retention", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: settingsCsrf, retention: "25" }),
  });
  assert.equal(response.status, 200);
  const retentionRow = await env.DB.prepare("SELECT retention FROM platform_settings WHERE id = 'platform'").first<{ retention: number }>();
  assert.equal(retentionRow?.retention, 25);

  response = await request("/logout", {
    method: "POST",
    headers: { cookie: fullCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong" }),
  });
  assert.equal(response.status, 403);
});

test("platform settings are the owner's alone, not an admin capability", async t => {
  const ctx = openConsoleContext();
  t.after(() => ctx.db.close());
  const admin = await Effect.runPromise(ctx.store.users.create({
    id: "u1", email: "admin@example.test", name: "Admin", role: "admin", passwordHash: "{}",
  }));
  const session = await Effect.runPromise(ctx.store.sessions.create(admin.id, { csrf: "csrf" }));
  const request = (path: string, init: RequestInit = {}) => Effect.runPromise(handleConsole(
    new Request(`https://example.test${path}`, { headers: { cookie: `wsa_session=${session.id}` }, ...init }), ctx,
    { area: path.split("/")[1], rest: path.replace(/^\/[^/]+\/?/, "") }));
  assert.equal((await request("/admin/settings")).status, 403);
  assert.equal((await request("/admin/settings/retention", { method: "POST" })).status, 403);
});

test("locked second-factor routes reject before verification", async t => {
  const ctx = openConsoleContext();
  t.after(() => ctx.db.close());
  const calls = { totp: 0, begin: 0, complete: 0 };
  const user = await Effect.runPromise(ctx.store.users.create({
    id: "user", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
    passkeys: [{ id: "passkey", name: "Test", alg: -8, kty: 1, crv: 6,
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", signCount: 0,
      createdAt: new Date().toISOString(), lastUsedAt: null }],
  }));
  await Effect.runPromise(ctx.store.users.setTotpSecret(user.id, "sealed"));
  const session = await Effect.runPromise(ctx.store.sessions.create(user.id, { csrf: "csrf", pending2fa: true }));
  ctx.auth = {
    ...ctx.auth,
    lockState: () => Effect.succeed({ locked: true, remaining: 0, retryAfterSec: 120 }),
    verifyTotp: () => Effect.sync(() => { calls.totp += 1; return true; }),
  };
  ctx.webauthn = {
    ...ctx.webauthn,
    beginAuthentication: () => Effect.sync(() => { calls.begin += 1; throw new Error("must not begin"); }),
    completeAuthentication: () => Effect.sync(() => { calls.complete += 1; throw new Error("must not complete"); }),
  };
  const headers = { cookie: `wsa_session=${session.id}`, "content-type": "application/json" };
  let response = await Effect.runPromise(handleAuth(new Request("https://example.test/2fa", {
    method: "POST",
    headers: { cookie: headers.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "csrf", code: "000000" }),
  }), ctx, { action: "2fa" }));
  assert.equal(response.status, 429);
  assert.equal(calls.totp, 0);

  response = await Effect.runPromise(handleAuth(new Request("https://example.test/passkey/begin", {
    method: "POST", headers, body: JSON.stringify({ csrf: "csrf" }),
  }), ctx, { action: "passkey/begin" }));
  assert.equal(response.status, 429);
  assert.equal(calls.begin, 0);

  response = await Effect.runPromise(handleAuth(new Request("https://example.test/passkey/complete", {
    method: "POST", headers, body: JSON.stringify({ csrf: "csrf", token: "token", credential: {} }),
  }), ctx, { action: "passkey/complete" }));
  assert.equal(response.status, 429);
  assert.equal(calls.complete, 0);
  assert.equal((await Effect.runPromise(ctx.store.sessions.get(session.id)))?.pending2fa, true);
});

test("platform routes fail closed when the master key is not configured", async t => {
  t.mock.method(console, "error", () => {});
  const DB = openD1Shim();
  t.after(() => DB.close());
  const response = await worker.fetch(new Request("https://example.test/login"), {
    DB, ARTIFACTS: memoryBucket(), RATELIMIT: rateLimitBinding(),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
});

test("rate limiter failures return a generic server error", async t => {
  const ctx = openConsoleContext();
  t.after(() => ctx.db.close());
  ctx.auth = {
    ...ctx.auth,
    login: () => Effect.fail(Object.assign(new Error("RateLimit Durable Object unavailable: provider detail"), {
      code: "rate-limit-unavailable",
    })),
  };
  const response = await Effect.runPromise(handleAuth(new Request("https://example.test/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "owner@example.test", password: "password" }),
  }), ctx, { action: "login" }));
  const html = await response.text();
  assert.equal(response.status, 500);
  assert.doesNotMatch(html, /RateLimit Durable Object unavailable/);
});

test("direct auth lockout reports retry time when the window is exhausted", async t => {
  const { DB, auth } = services();
  t.after(() => DB.close());
  const email = "fallback-lockout@example.test";
  await Effect.runPromise(auth.loginFail(email));
  await Effect.runPromise(auth.loginFail(email));
  const third = await Effect.runPromise(auth.loginFail(email));
  assert.equal(third.locked, true);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfterSec > 0 && third.retryAfterSec <= 300);
});

test("auth workflows are lazy, failed password changes do not mutate, and suspension revokes every session", async t => {
  const { DB, store, auth } = services();
  t.after(() => DB.close());
  const registration = auth.registerOwner({
    email: "owner@example.test", password: "first secure pass", confirm: "first secure pass",
  });
  assert.equal(await Effect.runPromise(auth.userCount()), 0);
  const owner = await Effect.runPromise(registration);
  const before = owner.user.passwordHash;
  const rejected = await Effect.runPromise(Effect.catch(
    Effect.as(auth.changePassword(owner.user, "incorrect password", "another secure pass", "another secure pass"), "unexpected success"),
    error => Effect.succeed(error.code)));
  assert.equal(rejected, "invalid-current-password");
  assert.equal((await Effect.runPromise(store.users.byId(owner.user.id)))?.passwordHash, before);
  assert.equal((await Effect.runPromise(store.audit.recent())).some(row => row.action === "user.password_change"), false);

  const change = auth.changePassword(owner.user, "first secure pass", "another secure pass", "another secure pass");
  assert.equal((await Effect.runPromise(store.users.byId(owner.user.id)))?.passwordHash, before);
  await Effect.runPromise(change);
  assert.notEqual((await Effect.runPromise(store.users.byId(owner.user.id)))?.passwordHash, before);
  assert.ok(await Effect.runPromise(auth.currentSession(owner.session.id)));
  const outdated = await Effect.runPromise(Effect.catch(
    Effect.as(auth.login({ email: owner.user.email, password: "first secure pass" }), "unexpected success"),
    error => Effect.succeed(error.code)));
  assert.equal(outdated, "invalid-credentials");
  const login = await Effect.runPromise(auth.login({ email: owner.user.email, password: "another secure pass" }));
  await Effect.runPromise(store.users.setStatus(owner.user.id, "suspended"));
  assert.equal(await Effect.runPromise(auth.currentSession(owner.session.id)), null);
  assert.equal(await Effect.runPromise(store.sessions.get(login.session.id)), null);
  const suspended = await Effect.runPromise(Effect.catch(
    Effect.as(auth.login({ email: owner.user.email, password: "another secure pass" }), "unexpected success"),
    error => Effect.succeed(error.code)));
  assert.equal(suspended, "suspended");
});
