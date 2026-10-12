import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { Buffer } from "node:buffer";
import { Effect, Exit } from "effect";

import { fileResponse, readBytes, readForm, readJson } from "../src/http.js";
import {
  b32encode, makeVerifier, openBlob, randomBytes, randomHex, scalarSeal, scalarUnseal, sealAES, sealBlob,
  totpCode, totpMatch, unsealAES, verifyVerifier, wrapUnderPassword,
} from "../src/crypto.js";
import type { SealRecord } from "../src/crypto.js";
import type { CodeError } from "../src/types.js";

function streamedRequest(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  return new Request("https://example.test/submit", init);
}

test("form and JSON readers cap streamed bodies without Content-Length", async () => {
  const limit = 32;
  const small = await Effect.runPromise(readForm(streamedRequest("email=a%40example.test"), limit));
  assert.equal(small.get("email"), "a@example.test");
  await assert.rejects(
    () => Effect.runPromise(readJson(streamedRequest(JSON.stringify({ payload: "x".repeat(limit) })), limit)),
    { code: "too-large" },
  );
});

test("body effects are lazy and invalid JSON remains a typed failure", async () => {
  const request = streamedRequest('{"answer":42}');
  const body = readJson<{ answer: number }>(request);
  assert.equal(request.bodyUsed, false);
  assert.equal(request.body?.locked, false);
  assert.deepEqual(await Effect.runPromise(body), { answer: 42 });
  assert.equal(request.body?.locked, false);
  const malformed = streamedRequest("{");
  await assert.rejects(Effect.runPromise(readJson(malformed)), { code: "bad-json" });
  assert.equal(malformed.body?.locked, false);
});

test("overflow cancels the reader and releases the request body lock", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(33)); },
    cancel() { cancelled = true; },
  });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  const request = new Request("https://example.test/submit", init);
  await assert.rejects(Effect.runPromise(readForm(request, 32)), { code: "too-large" });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("interruption cancels pending body reads and releases their lock", async () => {
  let readStarted!: () => void;
  const reading = new Promise<void>((resolve) => { readStarted = resolve; });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { readStarted(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  const request = new Request("https://example.test/submit", init);
  const controller = new AbortController();
  const result = Effect.runPromiseExit(readForm(request), { signal: controller.signal });
  await reading;
  controller.abort();
  assert.equal(Exit.isFailure(await result), true);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

// Independent Node crypto reference for the metadata and gate-wire formats predating Effect.
const nativeEncoding = (bytes: Uint8Array, encoding: "base64" | "hex") =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);

function nativeSeal(keyHex: string, value: unknown): SealRecord {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: nativeEncoding(cipher.getAuthTag(), "base64") };
}

function nativeOpen(keyHex: string, record: SealRecord): string {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.ct, "base64")), decipher.final()]).toString("utf8");
}

test("sealed metadata, scalar envelopes and blob framing interoperate with existing AES-GCM state", async () => {
  const key = "12".repeat(32), value = { secret: "legacy-secret" };
  const legacy = nativeSeal(key, value);
  assert.deepEqual(await Effect.runPromise(unsealAES<typeof value>(key, legacy)), value);
  const scalar = Buffer.from(JSON.stringify(legacy)).toString("base64");
  assert.deepEqual(await Effect.runPromise(scalarUnseal<typeof value>(key, scalar)), value);
  const sealed = await Effect.runPromise(sealAES(key, value));
  assert.deepEqual(JSON.parse(nativeOpen(key, sealed)), value);
  const scalarRecord: SealRecord = JSON.parse(Buffer.from(await Effect.runPromise(scalarSeal(key, value)), "base64").toString("utf8"));
  assert.deepEqual(JSON.parse(nativeOpen(key, scalarRecord)), value);
  assert.equal(Buffer.from(sealed.iv, "base64").length, 12);
  assert.equal(Buffer.from(sealed.tag, "base64").length, 16);

  const plaintext = new TextEncoder().encode("<!doctype html><html>native content</html>");
  const iv = Buffer.alloc(12, 9), cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const legacyBlob = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(await Effect.runPromise(openBlob(key, legacyBlob)), plaintext);
  const blob = await Effect.runPromise(sealBlob(key, plaintext));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  assert.deepEqual(new Uint8Array(Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()])), plaintext);
  await assert.rejects(Effect.runPromise(unsealAES(key, { ...legacy, tag: Buffer.alloc(16).toString("base64") })), { code: "secrets-auth" });
  await assert.rejects(Effect.runPromise(sealAES("invalid", value)), { code: "invalid-master-key" });
  await assert.rejects(Effect.runPromise(scalarUnseal(key, "not-json")), SyntaxError);
});

test("blob seals bind optional additional data", async () => {
  const key = "34".repeat(32), plain = new TextEncoder().encode("part bytes");
  const aad = new TextEncoder().encode("file:" + "a".repeat(32) + ":1:last");
  const sealed = await Effect.runPromise(sealBlob(key, plain, aad));
  assert.equal(sealed.byteLength, plain.byteLength + 28);
  assert.deepEqual(await Effect.runPromise(openBlob(key, sealed, aad)), plain);
  await assert.rejects(Effect.runPromise(openBlob(key, sealed, new TextEncoder().encode("file:" + "a".repeat(32) + ":1:more"))));
  await assert.rejects(Effect.runPromise(openBlob(key, sealed)));            // AAD omitted
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), sealed.subarray(0, 12));
  decipher.setAAD(aad); decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  assert.deepEqual(new Uint8Array(Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()])), plain);
});

test("readBytes reads exactly the declared part length", async () => {
  const put = (body: Uint8Array<ArrayBuffer>, length: string | null = String(body.byteLength)) =>
    new Request("https://example.test/p", { method: "PUT", body, headers: length === null ? {} : { "Content-Length": length } });
  const part = (error: CodeError) => error.code === "validation" && error.issues?.[0]?.field === "part";
  assert.deepEqual(await Effect.runPromise(readBytes(put(new Uint8Array([0, 255, 1])), 3)), new Uint8Array([0, 255, 1]));
  await assert.rejects(Effect.runPromise(readBytes(put(new Uint8Array(3), null), 3)), part);            // no Content-Length
  await assert.rejects(Effect.runPromise(readBytes(put(new Uint8Array(2)), 3)), part);                  // declared shorter
  await assert.rejects(Effect.runPromise(readBytes(put(new Uint8Array(4)), 3)), { code: "too-large" }); // declared longer
  await assert.rejects(Effect.runPromise(readBytes(put(new Uint8Array(4), "3"), 3)), { code: "too-large" }); // body exceeds its header
  await assert.rejects(Effect.runPromise(readBytes(put(new Uint8Array(2), "3"), 3)), part);             // body ends early
});

test("fileResponse keeps hostile names safe", () => {
  // CR/LF names never reach storage (start rejects control characters), but the header must stay one line regardless.
  for (const name of ['a"b.txt', "..\\x", "Angebot – März.pdf", "😀 clip.wav", "a;b, c'(1)*.txt", "x\r\nSet-Cookie: y"]) {
    const disposition = fileResponse({ name, type: "", size: 1 }, new Response("x").body!).headers.get("content-disposition")!;
    const [, fallback, encoded] = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(\S+)$/u.exec(disposition)!;
    assert.match(fallback!, /^[\x20-\x7e]*$/u);
    assert.doesNotMatch(fallback!, /["\\/]/u);
    assert.doesNotMatch(encoded!, /['()*]/u);
    assert.equal(decodeURIComponent(encoded!), name);
  }
});

test("password verifiers, password wraps and RFC TOTP codes retain their stored parameters", async () => {
  const password = "stored password", salt = Buffer.alloc(16, 3), iterations = 1000;
  const legacy = { vsalt: salt.toString("base64"), viter: iterations,
    vhash: nativeEncoding(pbkdf2Sync(password, salt, iterations, 32, "sha256"), "base64") };
  assert.equal(await Effect.runPromise(verifyVerifier(password, legacy)), true);
  assert.equal(await Effect.runPromise(verifyVerifier("wrong", legacy)), false);
  const verifier = await Effect.runPromise(makeVerifier(password));
  assert.equal(verifier.vhash, nativeEncoding(pbkdf2Sync(password, Buffer.from(verifier.vsalt, "base64"), verifier.viter, 32, "sha256"), "base64"));
  const wrap = await Effect.runPromise(wrapUnderPassword(password, { k: "ab".repeat(32) }, iterations));
  const kek = pbkdf2Sync(password, Buffer.from(wrap.ksalt, "base64"), wrap.iter, 32, "sha256");
  assert.deepEqual(JSON.parse(nativeOpen(nativeEncoding(kek, "hex"), wrap)), { k: "ab".repeat(32) });
  const secret = b32encode(Buffer.from("12345678901234567890"));
  assert.equal(await Effect.runPromise(totpCode(secret, 30_000)), "287082");
  assert.equal(await Effect.runPromise(totpMatch(secret, "287082", 60_000)), true);
  assert.equal(await Effect.runPromise(totpMatch(secret, "287082", 90_000)), false);
  const failed = await Effect.runPromiseExit(totpCode("!", 30_000));
  assert.equal(Exit.isFailure(failed), true);
  if (Exit.isFailure(failed)) assert.equal(failed.cause.reasons.some((reason) => reason._tag === "Fail"), true);
});

test("synchronous crypto entropy is lazy and acquisition errors are typed failures", async () => {
  const bytes = randomBytes(10);
  assert.ok(Effect.isEffect(bytes));
  assert.equal((await Effect.runPromise(bytes)).byteLength, 10);
  const token = randomHex(10);
  assert.ok(Effect.isEffect(token));
  assert.match(await Effect.runPromise(token), /^[0-9a-f]{20}$/);
  const invalid = randomBytes(-1);
  assert.ok(Effect.isEffect(invalid));
  const failed = await Effect.runPromiseExit(invalid);
  assert.ok(Exit.isFailure(failed));
  assert.equal(failed.cause.reasons.some((reason) => reason._tag === "Fail"), true);
  await assert.rejects(Effect.runPromise(randomHex(-1)), RangeError);
});
