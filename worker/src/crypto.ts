// Crypto primitives for the 2.0 Worker, all on WebCrypto (`globalThis.crypto.subtle`)
// so the same code runs under workerd and under `node --test`. Nothing here depends on
// `node:crypto`; the 1.x `node:crypto` call sites (lib/adminauth.js, lib/gate.js,
// lib/secrets.js) are ported onto the same primitives.
//
// Runtime note: Node and workerd expose the WebCrypto primitives used here, including
// Ed25519 and P-256 verification. PBKDF2, HMAC (SHA-1 for TOTP), and AES-256-GCM are
// likewise runtime-agnostic; no node:crypto dependency crosses the Worker boundary.
import { Effect } from "effect";
import { asCodeError } from "./types.js";
import type { CodeError } from "./types.js";

export type CryptoBytes = ArrayBuffer | Uint8Array<ArrayBuffer>;
export interface Verifier { vsalt: string; viter: number; vhash: string }
export interface SealRecord { v: 1; iv: string; ct: string; tag: string }
export interface PasswordWrap extends SealRecord { ksalt: string; iter: number }

const enc = new TextEncoder();
const dec = new TextDecoder();
export const subtle = globalThis.crypto.subtle;

// ---- byte/base64/base64url helpers (Buffer is avoided: not a workerd global) ----

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToB64(bytes: CryptoBytes, alphabet = B64): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    out += i + 1 < b.length ? alphabet[(n >> 6) & 63] : (alphabet === B64 ? "=" : "");
    out += i + 2 < b.length ? alphabet[n & 63] : (alphabet === B64 ? "=" : "");
  }
  return out;
}

function b64ToBytes(s: unknown, alphabet = B64): Uint8Array<ArrayBuffer> {
  const T = alphabet === B64U ? B64U : B64;
  const bytes: number[] = [];
  let bits = 0, val = 0;
  for (const ch of String(s)) {
    const idx = T.indexOf(ch);
    if (idx < 0) continue;                              // skips padding '='
    val = (val << 6) | idx; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((val >>> bits) & 0xff); }
  }
  return new Uint8Array(bytes);
}

/** std base64 (seal/verifier rows keep the 1.x shape) and base64url (WebAuthn ids). */
export const b64e = (bytes: CryptoBytes): string => bytesToB64(bytes, B64);
export const b64d = (s: unknown): Uint8Array<ArrayBuffer> => b64ToBytes(s, B64);
export const b64ue = (bytes: CryptoBytes): string => bytesToB64(bytes, B64U);
export const b64ud = (s: unknown): Uint8Array<ArrayBuffer> => b64ToBytes(s, B64U);

export const b64urlHex = (s: unknown): string => hex(b64ud(s));

// ---- random ----

export function randomBytes(n: number): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  return Effect.try({
    try: () => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    catch: asCodeError,
  });
}
export function randomHex(n: number): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    return hex(yield* randomBytes(n));
  });
}
export const hex = (bytes: CryptoBytes): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

const hexToBytes = (h: unknown): Uint8Array<ArrayBuffer> => {
  const value = String(h);
  if (value.length % 2 || !/^[0-9a-f]*$/i.test(value)) {
    throw new TypeError("hex input must contain an even number of hexadecimal characters");
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Byte primitives for the WebAuthn port (workerd has no Buffer). */
export const utf8 = (bytes: CryptoBytes): string => dec.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
export const concatBytes = (...arrs: CryptoBytes[]): Uint8Array<ArrayBuffer> => {
  const us = arrs.map((a) => (a instanceof Uint8Array ? a : new Uint8Array(a)));
  const n = us.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of us) { out.set(a, o); o += a.length; }
  return out;
};
export const readUInt16BE = (bytes: Uint8Array, off = 0): number => (bytes[off] << 8) | bytes[off + 1];
export const readUInt32BE = (bytes: Uint8Array, off = 0): number =>
  (((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0);

/** Constant-time equal for same-length byte strings (HMAC-SHA1 digests, 32-byte hashes). */
export function timingSafeEqual(a: CryptoBytes, b: CryptoBytes): boolean {
  const A = a instanceof Uint8Array ? a : new Uint8Array(a);
  const B = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (A.length !== B.length) return false;
  let x = 0;
  for (let i = 0; i < A.length; i++) x |= A[i] ^ B[i];
  return x === 0;
}

// ---- hash (WebCrypto) ----

export function sha256(bytes: CryptoBytes): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  return Effect.gen(function* () {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new Uint8Array(yield* Effect.tryPromise({ try: () => subtle.digest("SHA-256", b), catch: asCodeError }));
  });
}

/** sha256 of a UTF-8 string, e.g. an invite token hash (one-way, high-entropy tokens). */
export function sha256hex(s: unknown): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    return hex(yield* sha256(enc.encode(String(s))));
  });
}

// ---- PBKDF2 password verifier (1.x lib/gate.js::makeVerifier row shape) ----
// { vsalt: std-b64(16 random bytes), viter: 100000, vhash: std-b64(32) }.
// Cost is 100k, not 1.x's 600k: the production workerd caps PBKDF2 iterations at 100,000
// ("iteration counts above 100000 are not supported"), and local dev does not enforce the
// cap — which is how 600k passed locally and 500'd every registration on the deployed host.
// Verifiers and password wraps read the stored `viter`/`iter` at check time, so this stays
// a single knob. Distinct salt + cost from any content key — the verifier is stored openly
// in D1, the master secret is not (ADR 0014); brute-force is answered by the RateLimit DO
// lockout, not by iteration count alone.

export const PBKDF2_ITER = 100000;

export function makeVerifier(password: unknown): Effect.Effect<Verifier, CodeError> {
  return Effect.gen(function* () {
    const vsalt = yield* randomBytes(16);
    const km = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]), catch: asCodeError,
    });
    const bits = yield* Effect.tryPromise({
      try: () => subtle.deriveBits({ name: "PBKDF2", salt: vsalt, iterations: PBKDF2_ITER, hash: "SHA-256" }, km, 256), catch: asCodeError,
    });
    return { vsalt: b64e(vsalt), viter: PBKDF2_ITER, vhash: b64e(bits) };
  });
}

/** Constant-time check of a password against a stored verifier. */
export function verifyVerifier(password: unknown, ver: unknown): Effect.Effect<boolean, CodeError> {
  return Effect.gen(function* () {
    if (!ver || typeof ver !== "object" || !("viter" in ver) || typeof ver.viter !== "number" ||
        !("vsalt" in ver) || !ver.vsalt || !("vhash" in ver) || !ver.vhash) return false;
    const { viter, vsalt, vhash } = ver;
    const km = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]), catch: asCodeError,
    });
    const bits = yield* Effect.tryPromise({
      try: () => subtle.deriveBits({ name: "PBKDF2", salt: b64d(vsalt), iterations: viter, hash: "SHA-256" }, km, 256), catch: asCodeError,
    });
    return yield* Effect.try({ try: () => timingSafeEqual(bits, b64d(vhash)), catch: asCodeError });
  });
}

// ---- AES-256-GCM seal (1.x lib/secrets.js row shape, preserved byte-for-byte) ----
// Sealed row: { v:1, iv: b64(12), ct: b64(n), tag: b64(16) } — std base64 throughout.
// WebCrypto appends the 16-byte GCM tag to the ciphertext; split it back out so the row
// shape (and M4's import from the 1.x host's secret store) stays exactly the 1.x format.

/** Any 256-bit key as raw bytes: the platform master key, or a password-derived content key. */
const keyBytesHex = (keyHex: unknown): Uint8Array<ArrayBuffer> => {
  const value = String(keyHex ?? "");
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw Object.assign(new Error("key must be 64 hex chars (32 bytes)"), { code: "invalid-master-key" });
  }
  return hexToBytes(value);
};

export function sealAES(masterKeyHex: unknown, obj: unknown): Effect.Effect<SealRecord, CodeError> {
  return Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", keyBytesHex(masterKeyHex), { name: "AES-GCM" }, false, ["encrypt"]), catch: asCodeError,
    });
    const iv = yield* randomBytes(12);
    const ct = new Uint8Array(yield* Effect.tryPromise({
      try: () => subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))), catch: asCodeError,
    }));
    return { v: 1, iv: b64e(iv), ct: b64e(ct.subarray(0, ct.length - 16)), tag: b64e(ct.subarray(ct.length - 16)) };
  });
}

export function unsealAES<A = unknown>(masterKeyHex: unknown, rec: unknown): Effect.Effect<A | undefined, CodeError> {
  return Effect.gen(function* () {
    if (!rec) return undefined;
    const key = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", keyBytesHex(masterKeyHex), { name: "AES-GCM" }, false, ["decrypt"]), catch: asCodeError,
    });
    const decoded = yield* Effect.try({ try: () => {
      if (typeof rec !== "object") throw new TypeError("sealed record must be an object");
      return { iv: b64d("iv" in rec ? rec.iv : undefined),
        body: concatBytes(b64d("ct" in rec ? rec.ct : undefined), b64d("tag" in rec ? rec.tag : undefined)) };
    }, catch: asCodeError });
    const pt = yield* Effect.tryPromise({
      try: () => subtle.decrypt({ name: "AES-GCM", iv: decoded.iv }, key, decoded.body), catch: asCodeError,
    });
    return yield* Effect.try({ try: () => JSON.parse(dec.decode(pt)) as A, catch: asCodeError });
  }).pipe(Effect.catch(() => Effect.fail(Object.assign(
    new Error("record failed authentication (wrong master key or tampered record)"), { code: "secrets-auth" },
  ))));
}

/** Compact "sealed" scalar envelope for D1 TEXT columns that hold one sealed object
 *  (e.g. users.totp_secret_sealed): base64(JSON(sealAES(master, obj))). */
export function scalarSeal(masterKeyHex: unknown, obj: unknown): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    const rec = yield* sealAES(masterKeyHex, obj);
    return b64e(enc.encode(JSON.stringify(rec)));
  });
}

export function scalarUnseal<A = unknown>(masterKeyHex: unknown, s: unknown): Effect.Effect<A | undefined, CodeError> {
  return Effect.gen(function* () {
    if (!s) return undefined;
    const rec = yield* Effect.try({ try: () => JSON.parse(dec.decode(b64d(s))) as unknown, catch: asCodeError });
    return yield* unsealAES<A>(masterKeyHex, rec);
  });
}

// ---- content key material (ADR 0014) ----
// An artefact's content key is wrapped under a password-derived KEK for the visitor path. The
// visitor re-derives that KEK in the browser, so the wrap row carries the salt and the cost
// next to the ciphertext (the 1.x gate blob shape, plus `ksalt`).

/** PBKDF2(password) → 32 raw bytes, hex. The KEK that wraps an artefact content key. */
export function kekHex(password: unknown, saltB64: unknown, iterations = PBKDF2_ITER): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    const km = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]), catch: asCodeError,
    });
    const bits = yield* Effect.tryPromise({
      try: () => subtle.deriveBits({ name: "PBKDF2", salt: b64d(saltB64), iterations, hash: "SHA-256" }, km, 256), catch: asCodeError,
    });
    return hex(bits);
  });
}

/** Wrap one object under a fresh password-derived KEK: { v, iter, ksalt, iv, ct, tag }. */
export function wrapUnderPassword(password: unknown, obj: unknown, iterations = PBKDF2_ITER): Effect.Effect<PasswordWrap, CodeError> {
  return Effect.gen(function* () {
    const ksalt = b64e(yield* randomBytes(16));
    const kek = yield* kekHex(password, ksalt, iterations);
    return { ...(yield* sealAES(kek, obj)), ksalt, iter: iterations };
  });
}

// ---- raw-bytes seal (artefact content in R2, ADR 0013) ----
// Binary framing: the object IS the ciphertext, iv(12) || ct || tag(16). An ungated artefact
// is then served by decrypting straight from R2 — no base64 round trip in the hot path.

const IV_BYTES = 12;

export function sealBlob(keyHex: unknown, bytes: CryptoBytes, aad?: CryptoBytes): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  return Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", keyBytesHex(keyHex), { name: "AES-GCM" }, false, ["encrypt"]), catch: asCodeError,
    });
    const iv = yield* randomBytes(IV_BYTES);
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ct = yield* Effect.tryPromise({
      try: () => subtle.encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: aad } : {}) }, key, body), catch: asCodeError,
    });
    return concatBytes(iv, ct);
  });
}

export function openBlob(keyHex: unknown, blob: CryptoBytes, aad?: CryptoBytes): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  return Effect.gen(function* () {
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const key = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", keyBytesHex(keyHex), { name: "AES-GCM" }, false, ["decrypt"]), catch: asCodeError,
    });
    return new Uint8Array(yield* Effect.tryPromise({
      try: () => subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), ...(aad ? { additionalData: aad } : {}) }, key, bytes.subarray(IV_BYTES)),
      catch: asCodeError,
    }));
  });
}

/** One blob on the gate's wire: iv plus the ciphertext with its tag appended (WebCrypto-ready). */
export const splitBlob = (blob: CryptoBytes): { v: 1; iv: string; ct: string } => {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  return { v: 1, iv: b64e(bytes.subarray(0, IV_BYTES)), ct: b64e(bytes.subarray(IV_BYTES)) };
};

// ---- base32 (RFC 4648, NO padding) — TOTP secrets only (1.x lib/adminauth.js, verbatim) ----

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function b32encode(buf: CryptoBytes): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bits = 0, value = 0, out = "";
  for (const byte of b) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];   // flush the tail (20B -> 32 chars)
  return out;
}

export function b32decode(s: unknown): Uint8Array<ArrayBuffer> {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, "")) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("'invalid base32'");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

// ---- RFC 4226 HOTP -> RFC 6238 TOTP (HMAC-SHA1 via WebCrypto; same math as node:crypto) ----

const STEP_MS = 30_000;                     // RFC 6238 time step
const DIGITS = 6;                           // code length

function hotp(secret: Uint8Array<ArrayBuffer>, counter: number): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    // Counter is a Number (Math.floor(now/30000) ≈ 2e8 today); plain Number arithmetic is
    // exact to 2^53, so this covers every realistic TOTP window.
    const msg = new Uint8Array(8);
    let c = counter >>> 0;
    for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
    const key = yield* Effect.tryPromise({
      try: () => subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]), catch: asCodeError,
    });
    const mac = new Uint8Array(yield* Effect.tryPromise({ try: () => subtle.sign("HMAC", key, msg), catch: asCodeError }));
    const off = mac[mac.length - 1] & 0x0f;
    const bin = (((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]) >>> 0;
    return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
  });
}

/** Constant-time compare of `code` against the secret's current ±1 step window. */
export function totpMatch(secretBase32: unknown, code: string, now?: number): Effect.Effect<boolean, CodeError> {
  return Effect.gen(function* () {
    const counter = Math.floor((now ?? Date.now()) / STEP_MS);
    const secret = yield* Effect.try({ try: () => b32decode(secretBase32), catch: asCodeError });
    const submitted = enc.encode(code);
    for (const c of [counter - 1, counter, counter + 1]) {
      const want = yield* hotp(secret, c);
      if (timingSafeEqual(enc.encode(want), submitted)) return true;
    }
    return false;
  });
}

/** One live code (for tests): the secret's current-step TOTP. */
export function totpCode(secretBase32: unknown, now?: number): Effect.Effect<string, CodeError> {
  return Effect.gen(function* () {
    const secret = yield* Effect.try({ try: () => b32decode(secretBase32), catch: asCodeError });
    return yield* hotp(secret, Math.floor((now ?? Date.now()) / STEP_MS));
  });
}

/** Normalize a user-entered code: strip whitespace; the caller must then require 6 digits. */
export const normCode = (code: unknown): string => String(code ?? "").replace(/\s/g, "");

// ---- sha1 (test helpers only: independent RFC 4226 reference, mirrors 1.x test harness) ----
export function sha1(bytes: CryptoBytes): Effect.Effect<Uint8Array<ArrayBuffer>, CodeError> {
  return Effect.gen(function* () {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new Uint8Array(yield* Effect.tryPromise({ try: () => subtle.digest("SHA-1", b), catch: asCodeError }));
  });
}
