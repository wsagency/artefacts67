// Per-user WebAuthn passkeys (ADR 0012, 0034). Challenges retain their staged origin/RP,
// five-minute lifetime and one-shot consumption; attestation remains "none". A passkey is a
// second factor after the password, or — user-verified and discoverable — the whole sign-in.

import * as Effect from "effect/Effect";
import {
  sha256, b64ue, b64ud, randomBytes, randomHex, concatBytes, utf8,
  readUInt16BE, readUInt32BE, timingSafeEqual, subtle, type CryptoBytes,
} from "./crypto.js";
import { asCodeError, type CodeError } from "./types.js";
import type { Store, User, PasskeyKey, PasskeyRecord, PendingChallenge } from "./store.js";

const PENDING_MS = 5 * 60_000;
const TIMEOUT_MS = 300_000;
const FL_UP = 0x01;
const FL_UV = 0x04;
const FL_AT = 0x40;
const KTY_OKP = 1, KTY_EC2 = 2;
const CRV_P256 = 1, CRV_ED25519 = 6;
const ALG_ES256 = -7, ALG_ED25519 = -8;
const enc = new TextEncoder();
const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const fail = (why: string): never => { throw coded("webauthn-format", `malformed WebAuthn data: ${why}`); };

export type CborValue = number | string | Uint8Array<ArrayBuffer> | CborValue[] | Map<CborValue, CborValue>;

/** Definite-length RFC 8949 subset. Integer map keys retain their COSE meanings. */
function cborDecodeAt(buf: CryptoBytes, start: number): [CborValue, number] {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let pos = start;
  const need = (n: number) => { if (pos + n > b.length) fail("truncated CBOR item"); };
  const head = () => {
    need(1);
    const byte = b[pos++]!;
    const major = byte >> 5, ai = byte & 0x1f;
    let arg: number;
    if (ai < 24) arg = ai;
    else if (ai === 24) { need(1); arg = b[pos++]!; }
    else if (ai === 25) { need(2); arg = readUInt16BE(b, pos); pos += 2; }
    else if (ai === 26) { need(4); arg = readUInt32BE(b, pos); pos += 4; }
    else if (ai === 27) {
      need(8);
      let big = 0n;
      for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(b[pos + i]!);
      pos += 8;
      arg = Number(big);
    } else return fail(ai === 31 ? "indefinite-length CBOR items are not supported" : "reserved CBOR additional info");
    return { major, arg };
  };
  const item = (): CborValue => {
    const { major, arg } = head();
    if (major === 0) return arg;
    if (major === 1) return -1 - arg;
    if (major === 2 || major === 3) {
      need(arg);
      const raw = b.subarray(pos, pos + arg);
      pos += arg;
      return major === 2 ? raw : utf8(raw);
    }
    if (major === 4) {
      const out: CborValue[] = [];
      for (let i = 0; i < arg; i++) out.push(item());
      return out;
    }
    if (major === 5) {
      const out = new Map<CborValue, CborValue>();
      for (let i = 0; i < arg; i++) { const key = item(); out.set(key, item()); }
      return out;
    }
    if (major === 6) return item();
    return fail("CBOR floats and simple values (major type 7) are not supported");
  };
  return [item(), pos];
}

function cborDecode(buf: CryptoBytes): CborValue {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const [value, end] = cborDecodeAt(b, 0);
  if (end !== b.length) fail("trailing bytes after CBOR item");
  return value;
}
export const _cbor = { decode: cborDecode };

function derToP1363(signature: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const s = signature;
  if (s.length === 64) return s;
  let pos = 0;
  const byte = () => {
    if (pos >= s.length) fail("truncated ECDSA signature");
    return s[pos++]!;
  };
  const length = () => {
    const first = byte();
    if (first < 0x80) return first;
    const count = first & 0x7f;
    if (!count || count > 2 || pos + count > s.length) fail("invalid ECDSA length");
    let out = 0;
    for (let i = 0; i < count; i++) out = (out << 8) | byte();
    if (out < 0x80) fail("non-canonical ECDSA length");
    return out;
  };
  if (byte() !== 0x30) fail("ECDSA signature is not a SEQUENCE");
  const sequenceLength = length();
  if (sequenceLength !== s.length - pos) fail("ECDSA SEQUENCE length mismatch");
  const integer = () => {
    if (byte() !== 0x02) fail("ECDSA component is not an INTEGER");
    const n = length();
    if (!n || pos + n > s.length) fail("truncated ECDSA component");
    let value = s.subarray(pos, pos + n);
    pos += n;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) fail("ECDSA component exceeds P-256 width");
    return value;
  };
  const r = integer(), t = integer();
  if (pos !== s.length) fail("trailing ECDSA signature data");
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(t, 64 - t.length);
  return raw;
}

function verifySignature(rec: PasskeyRecord, signature: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>) {
  return Effect.gen(function* () {
    const jwk = rec.alg === ALG_ED25519
      ? { kty: "OKP", crv: "Ed25519", x: rec.x }
      : { kty: "EC", crv: "P-256", x: rec.x, y: rec.y };
    const algorithm = rec.alg === ALG_ED25519 ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
    const key = yield* Effect.tryPromise({ try: () => subtle.importKey("jwk", jwk, algorithm, true, ["verify"]), catch: asCodeError });
    const bytes = rec.alg === ALG_ES256
      ? yield* Effect.try({ try: () => derToP1363(signature), catch: asCodeError }) : signature;
    const verifyAlgorithm = rec.alg === ALG_ED25519 ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
    return yield* Effect.tryPromise({ try: () => subtle.verify(verifyAlgorithm, key, bytes, payload), catch: asCodeError });
  });
}

interface CredentialResponse {
  clientDataJSON?: unknown; attestationObject?: unknown; authenticatorData?: unknown; signature?: unknown; userHandle?: unknown;
}
interface Credential { id?: unknown; rawId?: unknown; response?: CredentialResponse }
function credentialOf(value: unknown): Credential {
  if (!value || typeof value !== "object") return {};
  const input = value as { id?: unknown; rawId?: unknown; response?: unknown };
  return { id: input.id, rawId: input.rawId,
    response: input.response && typeof input.response === "object" ? input.response as CredentialResponse : undefined };
}
function checkClientData(raw: unknown, challenge: string, type: string, origin: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(b64ud(raw))); } catch { fail("clientDataJSON is not valid JSON"); }
  const cd = parsed && typeof parsed === "object" ? parsed as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown } : {};
  if (cd.type !== type) throw coded("webauthn-type", `clientData.type is '${cd.type}', expected '${type}'`);
  if (String(cd.challenge ?? "").replace(/=+$/, "") !== challenge)
    throw coded("webauthn-challenge", "clientData.challenge does not match the issued challenge");
  if (cd.origin !== origin) throw coded("webauthn-origin", `clientData.origin is '${cd.origin}', expected '${origin}'`);
  if (cd.crossOrigin === true) throw coded("webauthn-origin", "clientData.crossOrigin: the ceremony ran in a cross-origin frame");
}
function canonicalId(credential: Credential): string {
  const fromRaw = credential.rawId != null ? b64ue(b64ud(credential.rawId)) : null;
  const fromId = credential.id != null ? b64ue(b64ud(credential.id)) : null;
  if (fromRaw && fromId && fromRaw !== fromId) fail("credential id and rawId disagree");
  const id = fromRaw || fromId;
  if (!id) return fail("credential id missing");
  return id;
}
function coseKey(cose: CborValue): PasskeyKey {
  if (!(cose instanceof Map)) return fail("COSE public key is not a CBOR map");
  const kty = cose.get(1), alg = cose.get(3), crv = cose.get(-1);
  const x = cose.get(-2), y = cose.get(-3);
  if (kty === KTY_EC2 && crv === CRV_P256 && alg === ALG_ES256) {
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32)
      return fail("P-256 coordinates must be 32-byte byte strings");
    return { alg, kty, crv, x: b64ue(x), y: b64ue(y) };
  }
  if (kty === KTY_OKP && crv === CRV_ED25519 && alg === ALG_ED25519) {
    if (!(x instanceof Uint8Array) || x.length !== 32) return fail("Ed25519 public key must be a 32-byte byte string");
    return { alg, kty, crv, x: b64ue(x) };
  }
  throw coded("webauthn-alg", `unsupported COSE key (alg ${alg}, kty ${kty}, crv ${crv})`);
}

export interface WebAuthnContext {
  userId: string; userName: string; displayName: string | null; rpId: string; origin: string; rpName: string;
}
export interface CeremonyInput { token?: unknown; credential?: unknown; rpId?: unknown; origin?: unknown }
export interface LoginContext { rpId: string; origin: string }
export interface CredentialDescriptor { type: "public-key"; id: string }
export interface RegistrationOptions {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string | null };
  pubKeyCredParams: Array<{ type: "public-key"; alg: -7 | -8 }>;
  timeout: number; attestation: "none";
  authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "preferred" };
  excludeCredentials: CredentialDescriptor[];
}
export interface AuthenticationOptions {
  challenge: string; rpId: string; allowCredentials: CredentialDescriptor[];
  timeout: number; userVerification: "preferred" | "required";
}
export interface PasskeySummary { id: string; name: string; createdAt: string; lastUsedAt: string | null }
export interface WebAuthn {
  beginRegistration(context: WebAuthnContext): Effect.Effect<{ token: string; options: RegistrationOptions }, CodeError>;
  completeRegistration(input?: CeremonyInput & { name?: unknown }): Effect.Effect<PasskeyRecord, CodeError>;
  beginAuthentication(context: WebAuthnContext): Effect.Effect<{ token: string; options: AuthenticationOptions }, CodeError>;
  completeAuthentication(input?: CeremonyInput): Effect.Effect<PasskeyRecord, CodeError>;
  /** Passkey-first (ADR 0034): any discoverable credential; the verified user is the result. */
  beginLogin(context: LoginContext): Effect.Effect<{ token: string; options: AuthenticationOptions }, CodeError>;
  completeLogin(input?: CeremonyInput): Effect.Effect<{ user: User; passkey: PasskeyRecord }, CodeError>;
  list(userId: string): Effect.Effect<PasskeySummary[], CodeError>;
  remove(userId: string, id: unknown): Effect.Effect<boolean, CodeError>;
}

export function openWebAuthn({ users, pending }: Pick<Store, "users" | "pending">): WebAuthn {
  type Scope = { kind: "reg" | "auth"; userId: string } | { kind: "login"; userId: null };
  const stage = (scope: Scope, rpId: string, origin: string) => Effect.gen(function* () {
    const challenge = b64ue(yield* randomBytes(32));
    const token = yield* randomHex(16);
    const now = Date.now();
    // Unauthenticated 'login' begins create rows too; expired ones go before each new one.
    yield* pending.sweep(new Date(now - PENDING_MS).toISOString());
    yield* pending.set(token, { ...scope, challenge, rpId, origin, createdAt: new Date(now).toISOString() });
    return { token, challenge };
  });
  const takePending = <K extends PendingChallenge["kind"]>(token: unknown, kind: K) => Effect.gen(function* () {
    // One DELETE … RETURNING: of two concurrent completes, only one gets the row.
    const rec = yield* pending.take(String(token ?? ""));
    if (!rec) return yield* Effect.fail(coded("webauthn-pending", "unknown or already-used WebAuthn challenge token"));
    if (Date.now() - new Date(rec.createdAt).getTime() > PENDING_MS)
      return yield* Effect.fail(coded("webauthn-pending", "WebAuthn challenge expired"));
    if (rec.kind !== kind) return yield* Effect.fail(coded("webauthn-pending", `WebAuthn token is not a '${kind}' challenge`));
    // The kind check above is the narrowing TypeScript cannot follow through a generic.
    return rec as Extract<PendingChallenge, { kind: K }>;
  });
  const beginRegistration: WebAuthn["beginRegistration"] = ctx => Effect.gen(function* () {
    const { token, challenge } = yield* stage({ kind: "reg", userId: ctx.userId }, ctx.rpId, ctx.origin);
    const u = yield* users.byId(ctx.userId);
    const options: RegistrationOptions = {
      challenge, rp: { name: ctx.rpName, id: ctx.rpId },
      user: { id: b64ue(enc.encode(ctx.userId)), name: ctx.userName, displayName: ctx.displayName },
      pubKeyCredParams: [{ type: "public-key", alg: ALG_ED25519 }, { type: "public-key", alg: ALG_ES256 }],
      timeout: TIMEOUT_MS, attestation: "none",
      // Discoverable, so the passkey can also start a sign-in (ADR 0034).
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      excludeCredentials: (u?.passkeys ?? []).map(p => ({ type: "public-key", id: p.id })),
    };
    return { token, options };
  });
  const completeRegistration: WebAuthn["completeRegistration"] = ({ token, credential: rawCredential, name = "Passkey" } = {}) => Effect.gen(function* () {
    const pendingRec = yield* takePending(token, "reg");
    const credential = credentialOf(rawCredential);
    yield* Effect.try({ try: () => checkClientData(credential.response?.clientDataJSON, pendingRec.challenge, "webauthn.create", pendingRec.origin), catch: asCodeError });
    const ad = yield* Effect.try({ try: () => {
      const att = cborDecode(b64ud(credential.response?.attestationObject));
      if (!(att instanceof Map)) return fail("attestationObject is not a CBOR map");
      const authData = att.get("authData");
      if (!(authData instanceof Uint8Array)) return fail("attestationObject is missing an authData byte string");
      if (authData.length < 37) fail("authData shorter than 37 bytes");
      return authData;
    }, catch: asCodeError });
    if (!timingSafeEqual(ad.subarray(0, 32), yield* sha256(enc.encode(pendingRec.rpId))))
      return yield* Effect.fail(coded("webauthn-rp", "authData rpIdHash does not match the configured rpId"));
    const record = yield* Effect.try({ try: (): PasskeyRecord => {
      const flags = ad[32]!;
      if (!(flags & FL_UP)) fail("user-present flag (0x01) not set");
      if (!(flags & FL_AT)) fail("attested credential data flag (0x40) not set");
      const signCount = readUInt32BE(ad, 33);
      const credIdLen = readUInt16BE(ad, 53);
      if (credIdLen === 0 || ad.length < 55 + credIdLen) fail("attested credential id length out of bounds");
      const credId = ad.subarray(55, 55 + credIdLen);
      const cose = cborDecodeAt(ad, 55 + credIdLen)[0];
      const id = canonicalId(credential);
      if (!timingSafeEqual(credId, b64ud(id))) fail("attested credential id does not match the response id");
      return { id, name: String(name ?? "Passkey"), ...coseKey(cose), signCount,
        createdAt: new Date().toISOString(), lastUsedAt: null };
    }, catch: asCodeError });
    yield* users.upsertPasskey(pendingRec.userId, record.id, record);
    return record;
  });
  /** Verify a get() assertion for `staged`. Second factor: the staged user's passkey, UP only.
   *  Passkey-first: the userHandle names the user, and the authenticator must have verified them. */
  const verifyAssertion = (staged: PendingChallenge, rawAssertion: unknown) => Effect.gen(function* () {
    const assertion = credentialOf(rawAssertion);
    const resp = assertion.response ?? {};
    yield* Effect.try({ try: () => checkClientData(resp.clientDataJSON, staged.challenge, "webauthn.get", staged.origin), catch: asCodeError });
    const authData = yield* Effect.try({ try: () => {
      const bytes = b64ud(resp.authenticatorData);
      if (bytes.length < 37) fail("authenticatorData shorter than 37 bytes");
      if (!(bytes[32]! & FL_UP)) fail("user-present flag (0x01) not set");
      if (staged.kind === "login" && !(bytes[32]! & FL_UV))
        throw coded("webauthn-uv", "This passkey did not verify you with a PIN or biometric. Use it with your password instead.");
      return bytes;
    }, catch: asCodeError });
    if (!timingSafeEqual(authData.subarray(0, 32), yield* sha256(enc.encode(staged.rpId))))
      return yield* Effect.fail(coded("webauthn-rp", "authenticatorData rpIdHash does not match the configured rpId"));
    const signCount = readUInt32BE(authData, 33);
    const id = yield* Effect.try({ try: () => canonicalId(assertion), catch: asCodeError });
    const handle = typeof resp.userHandle === "string" && resp.userHandle ? utf8(b64ud(resp.userHandle)) : null;
    const userId = staged.userId ?? handle;
    const user = userId ? yield* users.byId(userId) : null;
    const rec = (user?.passkeys ?? []).find(p => p.id === id);
    if (!user || !rec) return yield* Effect.fail(coded("webauthn-unknown-credential", `no passkey enrolled for credential ${id}`));
    const payload = concatBytes(authData, yield* sha256(b64ud(resp.clientDataJSON)));
    if (!(yield* verifySignature(rec, b64ud(resp.signature), payload)))
      return yield* Effect.fail(coded("webauthn-signature", "assertion signature verification failed"));
    // Synced credentials legitimately report zero forever; never downgrade a stored counter.
    if (rec.signCount > 0 && signCount > 0 && signCount <= rec.signCount)
      return yield* Effect.fail(coded("sign-count", `signCount did not advance (stored ${rec.signCount}, got ${signCount})`));
    const passkey: PasskeyRecord = { ...rec, signCount: signCount > 0 ? signCount : rec.signCount,
      lastUsedAt: new Date().toISOString() };
    yield* users.upsertPasskey(user.id, id, passkey);
    return { user, passkey };
  });
  const beginAuthentication: WebAuthn["beginAuthentication"] = ctx => Effect.gen(function* () {
    const { token, challenge } = yield* stage({ kind: "auth", userId: ctx.userId }, ctx.rpId, ctx.origin);
    const u = yield* users.byId(ctx.userId);
    return { token, options: {
      challenge, rpId: ctx.rpId,
      allowCredentials: (u?.passkeys ?? []).map(p => ({ type: "public-key" as const, id: p.id })),
      timeout: TIMEOUT_MS, userVerification: "preferred" as const,
    } };
  });
  const completeAuthentication: WebAuthn["completeAuthentication"] = ({ token, credential } = {}) =>
    Effect.map(Effect.flatMap(takePending(token, "auth"), staged => verifyAssertion(staged, credential)), ({ passkey }) => passkey);
  const beginLogin: WebAuthn["beginLogin"] = ctx => Effect.map(stage({ kind: "login", userId: null }, ctx.rpId, ctx.origin),
    ({ token, challenge }) => ({ token, options: {
      challenge, rpId: ctx.rpId, allowCredentials: [], timeout: TIMEOUT_MS, userVerification: "required" as const,
    } }));
  const completeLogin: WebAuthn["completeLogin"] = ({ token, credential } = {}) =>
    Effect.flatMap(takePending(token, "login"), staged => verifyAssertion(staged, credential));
  return {
    beginRegistration, completeRegistration, beginAuthentication, completeAuthentication, beginLogin, completeLogin,
    list: userId => Effect.map(users.byId(userId), u => (u?.passkeys ?? []).map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }))),
    remove: (userId, id) => users.removePasskey(userId, String(id)),
  };
}
