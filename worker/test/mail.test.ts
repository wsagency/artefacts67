import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";

import { openMailer, connectTransport, SmtpSession } from "../src/mail.js";
import type { SocketLike, CloudSocket } from "../src/mail.js";

const CRLF = "\r\n";

function scriptedTransport({ startTls = false, rcptCode = 250 }: { startTls?: boolean; rcptCode?: number } = {}) {
  const state = { commands: [] as string[], data: "", tls: false, closed: 0 };
  let onData: ((data: Uint8Array<ArrayBuffer>) => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;
  let onEnd: (() => void) | undefined;
  let inData = false;
  const send = (line: string) => queueMicrotask(() => onData?.(new TextEncoder().encode(line)));
  const socket: SocketLike = {
    onData(cb) { onData = cb; send("220 fake.test ESMTP ready" + CRLF); },
    onError(cb) { onError = cb; },
    onEnd(cb) { onEnd = cb; },
    write(text) {
      if (inData) {
        state.data += text;
        if (state.data.endsWith(`${CRLF}.${CRLF}`)) {
          inData = false;
          send("250 queued" + CRLF);
        }
        return;
      }
      for (const line of text.split(CRLF).filter(Boolean)) {
        state.commands.push(line);
        const verb = line.split(" ", 1)[0].toUpperCase();
        if (verb === "EHLO") {
          send(state.tls ? "250-fake.test" + CRLF + "250 AUTH PLAIN" + CRLF
            : (startTls ? "250-fake.test" + CRLF + "250-STARTTLS" + CRLF + "250 AUTH PLAIN" + CRLF
              : "250-fake.test" + CRLF + "250 AUTH PLAIN" + CRLF));
        } else if (verb === "STARTTLS") send("220 ready for TLS" + CRLF);
        else if (verb === "AUTH") send("235 authenticated" + CRLF);
        else if (verb === "MAIL") send("250 accepted" + CRLF);
        else if (verb === "RCPT") send(`${rcptCode} recipient` + CRLF);
        else if (verb === "DATA") { inData = true; send("354 send data" + CRLF); }
        else if (verb === "QUIT") send("221 bye" + CRLF);
        else if (verb === "RSET") send("250 reset" + CRLF);
        else onError?.(new Error(`unexpected command ${line}`));
      }
    },
    startTls() { state.tls = true; return socket; },
    close() { state.closed += 1; onEnd?.(); },
  };
  return { transport: async () => socket, state };
}

test("SMTP 587 uses STARTTLS, re-EHLO, AUTH PLAIN and sends MIME data lazily", async () => {
  const fake = scriptedTransport({ startTls: true });
  const mailer = openMailer({
    host: "smtp.example.test", port: 587, user: "sender@example.test", pass: "secret", from: "sender@example.test",
    _transport: fake.transport,
  });
  const subject = "Poziv žću";
  const delivery = mailer.send({ to: "recipient@example.test", subject, text: "hello" });
  assert.equal(fake.state.commands.length, 0);
  const result = await Effect.runPromise(delivery);
  assert.equal(result.ok, true, `${JSON.stringify(result)} ${JSON.stringify(fake.state)}`);
  assert.equal(fake.state.tls, true);
  assert.deepEqual(fake.state.commands.map(line => line.split(" ", 1)[0]), [
    "EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT",
  ]);
  assert.match(fake.state.data, /Content-Type: text\/plain; charset=UTF-8/);
  const encodedSubject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(fake.state.data);
  assert.ok(encodedSubject);
  assert.equal(Buffer.from(encodedSubject[1], "base64").toString("utf8"), subject);
  assert.ok(fake.state.data.endsWith(`${CRLF}.${CRLF}`));
  assert.equal(fake.state.closed, 1);
});

test("Cloudflare socket adapter writes bytes, forwards reads and releases both stream locks", async () => {
  const writes: Uint8Array<ArrayBuffer>[] = [];
  let closed = 0;
  const cloudSocket: CloudSocket = {
    readable: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new TextEncoder().encode("220 ready\r\n")); } }),
    writable: new WritableStream<Uint8Array<ArrayBuffer>>({ write(chunk) { writes.push(chunk); } }),
    close() { closed += 1; },
  };
  const adapter = connectTransport.ensureSocketLike(cloudSocket);
  const received = new Promise<string>(resolve => adapter.onData(chunk => resolve(new TextDecoder().decode(chunk))));
  await adapter.write("EHLO test\r\n");
  assert.equal(new TextDecoder().decode(writes[0]), "EHLO test\r\n");
  assert.equal(await received, "220 ready\r\n");
  await adapter.close();
  assert.equal(closed, 1);
  assert.equal(cloudSocket.readable.locked, false);
  assert.equal(cloudSocket.writable.locked, false);
});

test("SMTP recipient rejection preserves retry classification and aborts before closing", async () => {
  for (const smtpCode of [450, 550]) {
    const fake = scriptedTransport({ rcptCode: smtpCode });
    const mailer = openMailer({ host: "smtp.example.test", from: "sender@example.test", _transport: fake.transport });
    const result = await Effect.runPromise(mailer.send({ to: "recipient@example.test", text: "hello" }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.permanent, smtpCode >= 500);
    assert.equal(result.error.code, "smtp-rejected");
    assert.equal(result.error.smtpCode, smtpCode);
    assert.deepEqual(fake.state.commands.slice(-2), ["RSET", "QUIT"]);
    assert.equal(fake.state.closed, 1);
  }
});

test("SMTP reply deadlines fail through the typed channel and finalize the socket", async () => {
  let closed = 0;
  const socket: CloudSocket = {
    readable: new ReadableStream<Uint8Array<ArrayBuffer>>(),
    writable: new WritableStream<Uint8Array<ArrayBuffer>>(),
    close() { closed += 1; },
  };
  const session = new SmtpSession({ host: "silent.example.test", port: 465, timeoutMs: 5,
    transport: async () => connectTransport.ensureSocketLike(socket) });
  const greeting = Effect.ensuring(Effect.gen(function* () {
    yield* session.connect();
    return yield* session.readReply();
  }), session.destroy());
  const code = await Effect.runPromise(Effect.catch(Effect.as(greeting, "unexpected success"), error => Effect.succeed(error.code)));
  assert.equal(code, "smtp-timeout");
  assert.equal(closed, 1);
  assert.equal(socket.readable.locked, false);
  assert.equal(socket.writable.locked, false);
});

test("interrupting a pending SMTP command cancels its waiter and closes the socket", async () => {
  let written!: () => void;
  const started = new Promise<void>(resolve => { written = resolve; });
  let closed = 0;
  const socket: CloudSocket = {
    readable: new ReadableStream<Uint8Array<ArrayBuffer>>(),
    writable: new WritableStream<Uint8Array<ArrayBuffer>>({ write() { written(); } }),
    close() { closed += 1; },
  };
  const session = new SmtpSession({ host: "silent.example.test", port: 465,
    transport: async () => connectTransport.ensureSocketLike(socket) });
  const controller = new AbortController();
  const result = Effect.runPromiseExit(Effect.ensuring(Effect.gen(function* () {
    yield* session.connect();
    return yield* session.command("NOOP");
  }), session.destroy()), { signal: controller.signal });
  await started;
  controller.abort();
  assert.equal((await result)._tag, "Failure");
  assert.equal(closed, 1);
  assert.equal(socket.readable.locked, false);
  assert.equal(socket.writable.locked, false);
});
