import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import type { TestContext } from "node:test";
import * as Effect from "effect/Effect";

import { openD1Shim } from "./db.js";
import { openConsoleContext, type TestConsoleContext } from "./doubles.js";
import { openStore, type User } from "../src/store.js";
import { openWebAuthn, _cbor, type WebAuthn } from "../src/webauthn.js";
import { handleAuth } from "../src/console.js";
import { asCodeError, type CodeError } from "../src/types.js";

const RP_ID = "example.test";
const ORIGIN = "https://example.test";

type TestCborValue = string | number | Uint8Array<ArrayBuffer> | Map<string | number, TestCborValue>;
const cborLength = (n: number, major: number) => {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  throw new Error("test CBOR value too large");
};
const cborBytes = (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array([...cborLength(bytes.length, 2), ...bytes]);
const cborText = (value: string) => {
  const b = new TextEncoder().encode(value);
  return new Uint8Array([...cborLength(b.length, 3), ...b]);
};
const cborInt = (value: number) => value >= 0
  ? cborLength(value, 0)
  : cborLength(-1 - value, 1);
const cborMap = (entries: Array<readonly [string | number, TestCborValue]>): Uint8Array<ArrayBuffer> => {
  const out = [...cborLength(entries.length, 5)];
  for (const [key, value] of entries) {
    out.push(...(typeof key === "string" ? cborText(key) : cborInt(key)));
    out.push(...(typeof value === "string" ? cborText(value)
      : typeof value === "number" ? cborInt(value)
        : value instanceof Map ? cborMap([...value.entries()]) : cborBytes(value)));
  }
  return new Uint8Array(out);
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
const clientData = (type: string, challenge: string) => b64(new TextEncoder().encode(JSON.stringify({
  type, challenge, origin: ORIGIN, crossOrigin: false,
})));
const rpHash = () => createHash("sha256").update(RP_ID).digest();

/** A software authenticator: its key pair, credential id and authenticator-data builders. */
interface Fixture {
  privateKey: KeyObject; credentialId: Uint8Array<ArrayBuffer>;
  authData(flags: number, count: number): Uint8Array<ArrayBuffer>;
  attestation(ad: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}
function credentialFixture(): Fixture {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  assert.ok(jwk.x);
  const rawKey = Buffer.from(jwk.x, "base64url");
  const credentialId = Buffer.from("credential-ed25519");
  const cose = cborMap([[1, 1], [3, -8], [-1, 6], [-2, rawKey]]);
  const authData = (flags: number, count: number) => Buffer.concat([
    rpHash(), Buffer.from([flags]), Buffer.from([0, 0, 0, count]), Buffer.alloc(16),
    Buffer.from([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]), credentialId, cose,
  ]);
  const attestation = (ad: Uint8Array<ArrayBuffer>) => cborMap([
    ["fmt", "none"], ["attStmt", new Map<string | number, TestCborValue>()], ["authData", ad],
  ]);
  return { privateKey, credentialId, authData, attestation };
}

function ecCredentialFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  assert.ok(jwk.x);
  assert.ok(jwk.y);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const credentialId = Buffer.from("credential-es256");
  const cose = cborMap([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);
  const authData = (flags: number, count: number) => Buffer.concat([
    rpHash(), Buffer.from([flags]), Buffer.from([0, 0, 0, count]), Buffer.alloc(16),
    Buffer.from([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]), credentialId, cose,
  ]);
  const attestation = (ad: Uint8Array<ArrayBuffer>) => cborMap([
    ["fmt", "none"], ["attStmt", new Map<string | number, TestCborValue>()], ["authData", ad],
  ]);
  return { privateKey, credentialId, authData, attestation };
}

async function userServices(t: TestContext) {
  const DB = openD1Shim();
  t.after(() => DB.close());
  const store = openStore(DB);
  const user = await Effect.runPromise(store.users.create({
    id: "user-1", email: "user@example.test", name: "User", role: "member", passwordHash: "{}",
  }));
  return { store, user, webauthn: openWebAuthn(store) };
}

test("CBOR decoder accepts the needed subset and rejects trailing data", () => {
  const decoded = _cbor.decode(Uint8Array.of(0xa1, 0x01, 0x01));
  assert.ok(decoded instanceof Map);
  assert.equal(decoded.get(1), 1);
  assert.throws(() => _cbor.decode(Uint8Array.of(0x01, 0x00)), /trailing/);
  assert.throws(() => _cbor.decode(Uint8Array.of(0x9f, 0xff)), /indefinite/);
});

test("Ed25519 registration and assertion verify, consume challenges once, and detect clones", async t => {
  const { store, user, webauthn } = await userServices(t);
  const fixture = credentialFixture();
  const beginReg = await Effect.runPromise(webauthn.beginRegistration({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  const rawId = b64(fixture.credentialId);
  const registrationCredential = {
    id: rawId,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON: clientData("webauthn.create", beginReg.options.challenge),
      attestationObject: b64(fixture.attestation(fixture.authData(0x41, 0))),
    },
  };
  const registered = await Effect.runPromise(webauthn.completeRegistration({
    token: beginReg.token, credential: registrationCredential, name: "Laptop",
  }));
  assert.equal(registered.name, "Laptop");
  assert.equal((await Effect.runPromise(webauthn.list(user.id))).length, 1);

  const beginAuth = await Effect.runPromise(webauthn.beginAuthentication({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  const authData = fixture.authData(0x01, 1);
  const rawClientData = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: beginAuth.options.challenge, origin: ORIGIN, crossOrigin: false,
  }));
  const assertion = {
    id: rawId,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON: b64(rawClientData),
      authenticatorData: b64(authData),
      signature: b64(sign(null, Buffer.concat([authData, createHash("sha256").update(rawClientData).digest()]), fixture.privateKey)),
    },
  };
  const used = await Effect.runPromise(webauthn.completeAuthentication({ token: beginAuth.token, credential: assertion }));
  assert.equal(used.signCount, 1);
  assert.ok((await Effect.runPromise(webauthn.list(user.id)))[0].lastUsedAt);
  await assert.rejects(() => Effect.runPromise(webauthn.completeAuthentication({ token: beginAuth.token, credential: assertion })), (error: unknown) => asCodeError(error).code === "webauthn-pending");

  const cloneBegin = await Effect.runPromise(webauthn.beginAuthentication({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  const cloneAuthData = fixture.authData(0x01, 1);
  const cloneClient = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: cloneBegin.options.challenge, origin: ORIGIN, crossOrigin: false,
  }));
  const cloneAssertion = {
    ...assertion,
    response: {
      clientDataJSON: b64(cloneClient),
      authenticatorData: b64(cloneAuthData),
      signature: b64(sign(null, Buffer.concat([cloneAuthData, createHash("sha256").update(cloneClient).digest()]), fixture.privateKey)),
    },
  };
  await assert.rejects(() => Effect.runPromise(webauthn.completeAuthentication({ token: cloneBegin.token, credential: cloneAssertion })), (error: unknown) => asCodeError(error).code === "sign-count");
  const storedUser = await Effect.runPromise(store.users.byId(user.id));
  assert.ok(storedUser);
  assert.equal(storedUser.passkeys[0].signCount, 1);
  assert.equal(await Effect.runPromise(webauthn.remove(user.id, rawId)), true);
  assert.equal((await Effect.runPromise(webauthn.list(user.id))).length, 0);
});

test("ES256 DER signatures are converted for WebCrypto verification", async t => {
  const { user, webauthn } = await userServices(t);
  const fixture = ecCredentialFixture();
  const beginReg = await Effect.runPromise(webauthn.beginRegistration({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  const rawId = b64(fixture.credentialId);
  await Effect.runPromise(webauthn.completeRegistration({
    token: beginReg.token,
    credential: {
      id: rawId,
      rawId,
      response: {
        clientDataJSON: clientData("webauthn.create", beginReg.options.challenge),
        attestationObject: b64(fixture.attestation(fixture.authData(0x41, 0))),
      },
    },
    name: "Phone",
  }));

  const beginAuth = await Effect.runPromise(webauthn.beginAuthentication({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  const authData = fixture.authData(0x01, 1);
  const rawClientData = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: beginAuth.options.challenge, origin: ORIGIN, crossOrigin: false,
  }));
  const derSignature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(rawClientData).digest()]),
    fixture.privateKey,
  );
  await Effect.runPromise(webauthn.completeAuthentication({
    token: beginAuth.token,
    credential: {
      id: rawId,
      rawId,
      response: {
        clientDataJSON: b64(rawClientData),
        authenticatorData: b64(authData),
        signature: b64(derSignature),
      },
    },
  }));
  assert.equal((await Effect.runPromise(webauthn.list(user.id)))[0].lastUsedAt !== null, true);
});

test("challenge failures stay typed and consume expired, wrong-kind and invalid proofs", async t => {
  const { store, user, webauthn } = await userServices(t);
  const context = { userId: user.id, userName: user.email, displayName: user.name,
    rpId: RP_ID, origin: ORIGIN, rpName: "WS" };
  const expired = await Effect.runPromise(webauthn.beginRegistration(context));
  const pending = await Effect.runPromise(store.pending.get(expired.token));
  assert.ok(pending);
  await Effect.runPromise(store.pending.overwrite(expired.token, {
    ...pending, createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  }));
  const expiredCode = await Effect.runPromise(Effect.catch(
    Effect.as(webauthn.completeRegistration({ token: expired.token }), "unexpected success"),
    error => Effect.succeed(error.code)));
  assert.equal(expiredCode, "webauthn-pending");
  assert.equal(await Effect.runPromise(store.pending.get(expired.token)), null);

  const wrongKind = await Effect.runPromise(webauthn.beginAuthentication(context));
  const kindCode = await Effect.runPromise(Effect.catch(
    Effect.as(webauthn.completeRegistration({ token: wrongKind.token }), "unexpected success"),
    error => Effect.succeed(error.code)));
  assert.equal(kindCode, "webauthn-pending");
  assert.equal(await Effect.runPromise(store.pending.get(wrongKind.token)), null);

  const proof = await Effect.runPromise(webauthn.beginRegistration(context));
  const credential = { response: { clientDataJSON: clientData("webauthn.create", "different-challenge") } };
  const proofCode = await Effect.runPromise(Effect.catch(
    Effect.as(webauthn.completeRegistration({ token: proof.token, credential }), "unexpected success"),
    error => Effect.succeed(error.code)));
  assert.equal(proofCode, "webauthn-challenge");
  assert.equal(await Effect.runPromise(store.pending.get(proof.token)), null);
});

// ---- passkey-first sign-in (ADR 0034) --------------------------------------------------

const handleOf = (userId: string) => b64(new TextEncoder().encode(userId));
const codeOf = <A>(effect: Effect.Effect<A, CodeError>) => Effect.runPromise(Effect.catch(
  Effect.as(effect, "unexpected success"), error => Effect.succeed(error.code)));

/** A get() assertion signed over `challenge` with explicit flags, counter and user handle. */
function assertionFor(fixture: Fixture, challenge: string, flags: number, count: number,
  userHandle?: string, credentialId: Uint8Array = fixture.credentialId) {
  const authData = Buffer.concat([rpHash(), Buffer.from([flags]), Buffer.from([0, 0, 0, count])]);
  const rawClientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }));
  const id = b64(credentialId);
  return { id, rawId: id, type: "public-key", response: {
    clientDataJSON: b64(rawClientData), authenticatorData: b64(authData),
    signature: b64(sign(null, Buffer.concat([authData, createHash("sha256").update(rawClientData).digest()]), fixture.privateKey)),
    ...(userHandle === undefined ? {} : { userHandle }),
  } };
}

async function enroll(webauthn: WebAuthn, user: User, fixture: Fixture = credentialFixture()) {
  const begun = await Effect.runPromise(webauthn.beginRegistration({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  const rawId = b64(fixture.credentialId);
  await Effect.runPromise(webauthn.completeRegistration({ token: begun.token, credential: { id: rawId, rawId, type: "public-key", response: {
    clientDataJSON: clientData("webauthn.create", begun.options.challenge),
    attestationObject: b64(fixture.attestation(fixture.authData(0x45, 0))),
  } } }));
  return { fixture, begun };
}

test("enrollment asks for a discoverable credential", async t => {
  const { user, webauthn } = await userServices(t);
  const { begun } = await enroll(webauthn, user);
  assert.deepEqual(begun.options.authenticatorSelection,
    { residentKey: "required", requireResidentKey: true, userVerification: "preferred" });
});

test("passkey-first: a user-verified discoverable assertion identifies its user, once", async t => {
  const { user, webauthn } = await userServices(t);
  const { fixture } = await enroll(webauthn, user);
  const begun = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  assert.deepEqual(begun.options.allowCredentials, []);
  assert.equal(begun.options.userVerification, "required");
  const assertion = assertionFor(fixture, begun.options.challenge, 0x05, 1, handleOf(user.id));
  const verified = await Effect.runPromise(webauthn.completeLogin({ token: begun.token, credential: assertion }));
  assert.equal(verified.user.id, user.id);
  assert.equal(verified.passkey.signCount, 1);
  assert.ok(verified.passkey.lastUsedAt);
  assert.equal(await codeOf(webauthn.completeLogin({ token: begun.token, credential: assertion })), "webauthn-pending");
});

test("passkey-first refuses a missing UV or UP flag and unknown credentials", async t => {
  const { store, user, webauthn } = await userServices(t);
  const { fixture } = await enroll(webauthn, user);
  const attempt = async (flags: number, userHandle?: string, credentialId?: Uint8Array) => {
    const begun = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
    return codeOf(webauthn.completeLogin({ token: begun.token,
      credential: assertionFor(fixture, begun.options.challenge, flags, 1, userHandle, credentialId) }));
  };
  assert.equal(await attempt(0x01, handleOf(user.id)), "webauthn-uv");
  assert.equal(await attempt(0x04, handleOf(user.id)), "webauthn-format");
  assert.equal(await attempt(0x05, handleOf(user.id), Buffer.from("credential-unknown")), "webauthn-unknown-credential");
  assert.equal(await attempt(0x05, handleOf("nobody")), "webauthn-unknown-credential");
  assert.equal(await attempt(0x05), "webauthn-unknown-credential");
  assert.equal((await Effect.runPromise(store.users.byId(user.id)))?.passkeys[0]?.signCount, 0);
});

test("passkey-first refuses a cross-origin (iframed) ceremony", async t => {
  const { user, webauthn } = await userServices(t);
  const { fixture } = await enroll(webauthn, user);
  const begun = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  const assertion = assertionFor(fixture, begun.options.challenge, 0x05, 1, handleOf(user.id));
  assertion.response.clientDataJSON = b64(Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: begun.options.challenge, origin: ORIGIN, crossOrigin: true,
  })));
  assert.equal(await codeOf(webauthn.completeLogin({ token: begun.token, credential: assertion })), "webauthn-origin");
});

test("two concurrent completes of one challenge cannot both pass", async t => {
  const { user, webauthn } = await userServices(t);
  const { fixture } = await enroll(webauthn, user);
  const begun = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  const assertion = assertionFor(fixture, begun.options.challenge, 0x05, 1, handleOf(user.id));
  const codes = await Promise.all([1, 2].map(() => codeOf(webauthn.completeLogin({ token: begun.token, credential: assertion }))));
  assert.deepEqual(codes.sort(), ["unexpected success", "webauthn-pending"]);
});

test("passkey-first challenges expire, stay kind-bound, and stale challenges are swept", async t => {
  const { store, user, webauthn } = await userServices(t);
  const { fixture } = await enroll(webauthn, user);
  const age = async (token: string) => {
    const row = await Effect.runPromise(store.pending.get(token));
    assert.ok(row);
    await Effect.runPromise(store.pending.overwrite(token, { ...row, createdAt: new Date(Date.now() - 6 * 60_000).toISOString() }));
  };
  const expired = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  assert.equal((await Effect.runPromise(store.pending.get(expired.token)))?.userId, null);
  await age(expired.token);
  assert.equal(await codeOf(webauthn.completeLogin({ token: expired.token,
    credential: assertionFor(fixture, expired.options.challenge, 0x05, 1, handleOf(user.id)) })), "webauthn-pending");

  const secondFactor = await Effect.runPromise(webauthn.beginAuthentication({
    userId: user.id, userName: user.email, displayName: user.name, rpId: RP_ID, origin: ORIGIN, rpName: "WS",
  }));
  assert.equal(await codeOf(webauthn.completeLogin({ token: secondFactor.token,
    credential: assertionFor(fixture, secondFactor.options.challenge, 0x05, 1, handleOf(user.id)) })), "webauthn-pending");
  const first = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  assert.equal(await codeOf(webauthn.completeAuthentication({ token: first.token,
    credential: assertionFor(fixture, first.options.challenge, 0x05, 1) })), "webauthn-pending");

  const stale = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  await age(stale.token);
  const fresh = await Effect.runPromise(webauthn.beginLogin({ rpId: RP_ID, origin: ORIGIN }));
  assert.equal(await Effect.runPromise(store.pending.get(stale.token)), null);
  assert.ok(await Effect.runPromise(store.pending.get(fresh.token)));
});

// ---- the HTTP ceremonies ----

async function passkeyPlatform(t: TestContext) {
  const ctx = openConsoleContext();
  t.after(() => ctx.db.close());
  const user = await Effect.runPromise(ctx.store.users.create({
    id: "owner-1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
  }));
  await Effect.runPromise(ctx.store.users.setTotpSecret(user.id, "sealed"));
  const { fixture } = await enroll(ctx.webauthn, user);
  return { ctx, user, fixture };
}
const SAME_ORIGIN = "https://example.test";
const post = (ctx: TestConsoleContext, op: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.runPromise(handleAuth(new Request(`${SAME_ORIGIN}/passkey/${op}`, {
    method: "POST", headers: { "content-type": "application/json", origin: SAME_ORIGIN, ...headers }, body: JSON.stringify(body),
  }), ctx, { op }));
interface Begun { token: string; options: { challenge: string; userVerification: string; allowCredentials: Array<{ id: string }> } }
/** The browser's side of passkey-first: begin, then sign with `flags` (synced-style zero counter). */
async function passkeyFirst(ctx: TestConsoleContext, fixture: Fixture, userId: string, flags = 0x05,
  completeHeaders: Record<string, string> = {}) {
  const begun = await post(ctx, "login/begin", {});
  assert.equal(begun.status, 200);
  const { token, options } = await begun.json() as Begun;
  return post(ctx, "login/complete", { token, credential: assertionFor(fixture, options.challenge, flags, 0, handleOf(userId)) }, completeHeaders);
}
/** The session id a response's Set-Cookie carries ("" when none). */
const sessionOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";", 1)[0].split("=")[1] ?? "";

test("passkey-first over HTTP yields the full session the password + second-factor path yields", async t => {
  const { ctx, user, fixture } = await passkeyPlatform(t);
  const response = await passkeyFirst(ctx, fixture, user.id);
  assert.equal(response.status, 200);
  const current = await Effect.runPromise(ctx.auth.currentSession(sessionOf(response)));
  assert.equal(current?.user.id, user.id);
  assert.equal(current?.session.pending2fa, false);
  assert.ok((await Effect.runPromise(ctx.store.users.byId(user.id)))?.lastLoginAt);
  assert.ok((await Effect.runPromise(ctx.store.audit.recent())).some(row => row.action === "user.login" && row.actor_id === user.id));
});

test("passkey-first replaces the browser's existing session", async t => {
  const { ctx, user, fixture } = await passkeyPlatform(t);
  const previous = await Effect.runPromise(ctx.auth.pendingSession(user.id));
  const response = await passkeyFirst(ctx, fixture, user.id, 0x05, { cookie: `wsa_session=${previous.id}` });
  assert.equal(response.status, 200);
  assert.equal(await Effect.runPromise(ctx.auth.currentSession(previous.id)), null);
});

test("passkey-first refuses cross-site and Origin-less requests (login CSRF)", async t => {
  const { ctx, user, fixture } = await passkeyPlatform(t);
  // An attacker's page posts its own valid assertion as a text/plain form whose body is JSON.
  const crossSite = await passkeyFirst(ctx, fixture, user.id, 0x05, { origin: "https://attacker.example", "content-type": "text/plain" });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get("set-cookie"), null);
  const textPlain = await passkeyFirst(ctx, fixture, user.id, 0x05, { "content-type": "text/plain" });
  assert.equal(textPlain.status, 403);
  const noOrigin = await Effect.runPromise(handleAuth(new Request(`${SAME_ORIGIN}/passkey/login/complete`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), ctx, { op: "login/complete" }));
  assert.equal(noOrigin.status, 403);
  const beginCrossSite = await post(ctx, "login/begin", {}, { origin: "https://attacker.example" });
  assert.equal(beginCrossSite.status, 403);
  const beginNoOrigin = await Effect.runPromise(handleAuth(new Request(`${SAME_ORIGIN}/passkey/login/begin`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), ctx, { op: "login/begin" }));
  assert.equal(beginNoOrigin.status, 403);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()?.n, 0);
});

test("passkey-first refuses a missing UV flag, a locked or suspended account, and creates no session", async t => {
  const { ctx, user, fixture } = await passkeyPlatform(t);
  let response = await passkeyFirst(ctx, fixture, user.id, 0x01);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("set-cookie"), null);
  for (let i = 0; i < 3; i += 1) await Effect.runPromise(ctx.auth.loginFail(user.email));
  response = await passkeyFirst(ctx, fixture, user.id);
  assert.equal(response.status, 429);
  await Effect.runPromise(ctx.auth.loginReset(user.email));
  await Effect.runPromise(ctx.store.users.setStatus(user.id, "suspended"));
  response = await passkeyFirst(ctx, fixture, user.id);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()?.n, 0);
});

test("passkey-first begin is rate-limited per client address", async t => {
  const { ctx } = await passkeyPlatform(t);
  const begin = (ip: string) => post(ctx, "login/begin", {}, { "CF-Connecting-IP": ip });
  for (let i = 0; i < 20; i += 1) assert.equal((await begin("203.0.113.7")).status, 200);
  assert.equal((await begin("203.0.113.7")).status, 429);
  assert.equal((await begin("198.51.100.9")).status, 200);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM webauthn_pending WHERE kind = 'login'").first<{ n: number }>()?.n, 21);
});

test("the password + passkey second factor still accepts an assertion without UV", async t => {
  const { ctx, user, fixture } = await passkeyPlatform(t);
  const pending = await Effect.runPromise(ctx.auth.pendingSession(user.id));
  const headers = { cookie: `wsa_session=${pending.id}` };
  const begun = await post(ctx, "begin", { csrf: pending.csrf }, headers);
  const { token, options } = await begun.json() as Begun;
  assert.equal(options.userVerification, "preferred");
  assert.deepEqual(options.allowCredentials.map(credential => credential.id), [b64(fixture.credentialId)]);
  const response = await post(ctx, "complete", { csrf: pending.csrf, token,
    credential: assertionFor(fixture, options.challenge, 0x01, 0) }, headers);
  assert.equal(response.status, 200);
  assert.equal((await Effect.runPromise(ctx.auth.currentSession(sessionOf(response))))?.session.pending2fa, false);
});
