// SMTP submission on the existing Cloudflare socket seam: implicit TLS on 465,
// STARTTLS elsewhere, lockstep commands, 15-second reply deadlines and RFC 5322 MIME.
// Only the socket adapter uses Promises; protocol and send orchestration are Effects.

import * as Effect from "effect/Effect";
import { randomHex, b64e, concatBytes } from "./crypto.js";
import { asCodeError, type Awaitable, type CodeError } from "./types.js";

const CRLF = "\r\n";
const REPLY_TIMEOUT_MS = 15000;
export const EHLO_NAME = "artefacts67";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const b64enc = (value: string) => b64e(new TextEncoder().encode(value));
let warnedCleartext = false;
const pad = (n: number) => String(n).padStart(2, "0");
const sanitize = (value: unknown) => String(value).replace(/[\r\n]+/g, " ");
const crlf = (value: unknown) => String(value).replace(/\r\n|\r|\n/g, CRLF);
const dotStuff = (value: string) => value.replace(/(^|\r\n)\./g, "$1..");
const terminate = (payload: string) => payload.endsWith(CRLF) ? payload + "." + CRLF : payload + CRLF + "." + CRLF;

function rfc5322Date(base: Date | string | number = new Date()) {
  const d = base instanceof Date ? base : new Date(base);
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** UTF-8 encoded words stay within 75 characters and never split a code point. */
function encodeSubject(subject: string) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  const words: string[] = [];
  let bufs: Uint8Array<ArrayBuffer>[] = [];
  let len = 0;
  const flush = () => {
    if (len) words.push(`=?UTF-8?B?${b64e(concatBytes(...bufs))}?=`);
    bufs = [];
    len = 0;
  };
  for (const ch of subject) {
    const b = new TextEncoder().encode(ch);
    if (len + b.length > 45) flush();
    bufs.push(b);
    len += b.length;
  }
  flush();
  return words.join(" ");
}

function parseAddress(input: unknown) {
  const s = sanitize(String(input || "").trim());
  const m = /<([^<>\r\n]+)>/.exec(s);
  const envelope = (m ? m[1]! : s).trim();
  const at = envelope.lastIndexOf("@");
  return { envelope, header: s, domain: at === -1 ? "localhost" : envelope.slice(at + 1).toLowerCase() };
}
export interface RenderMessage {
  date: string; fromHeader: string; toHeader: string; subject: string; text: string;
  html: string; boundary: string; messageId: string;
}
function buildMessage({ date, fromHeader, toHeader, subject, text, html, boundary, messageId }: RenderMessage) {
  const part = (ctype: string, body: string) =>
    `Content-Type: ${ctype}${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    (b64enc(crlf(body)).match(/.{1,76}/g) || []).join(CRLF);
  const textPart = part("text/plain; charset=UTF-8", text);
  const htmlPart = html ? part("text/html; charset=UTF-8", html) : null;
  const body = htmlPart
    ? `--${boundary}${CRLF}${textPart}${CRLF}--${boundary}${CRLF}${htmlPart}${CRLF}--${boundary}--`
    : textPart;
  const headers = [
    `Date: ${date}`, `From: ${fromHeader}`, `To: ${toHeader}`, `Subject: ${encodeSubject(subject)}`,
    `Message-ID: ${messageId}`, "MIME-Version: 1.0",
    htmlPart ? `Content-Type: multipart/alternative; boundary="${boundary}"` : "Content-Type: text/plain; charset=UTF-8",
  ];
  return headers.join(CRLF) + CRLF + CRLF + body;
}

export interface SocketLike {
  write(data: string): Awaitable<void>;
  close(): Awaitable<void>;
  startTls?(): Awaitable<unknown>;
  onData(callback: (data: Uint8Array<ArrayBuffer>) => void): void;
  onError(callback: (error: unknown) => void): void;
  onEnd(callback: () => void): void;
}
export interface CloudSocket {
  readable: ReadableStream<Uint8Array<ArrayBuffer>>;
  writable: WritableStream<Uint8Array<ArrayBuffer>>;
  startTls?(): Awaitable<CloudSocket>;
  close(): Awaitable<void>;
}
export interface SocketAdapter extends SocketLike { readonly _raw: CloudSocket; startTls(): Promise<void>; close(): Promise<void> }
export interface TransportOptions { host: string; port: number }
export type SmtpTransport = (options: TransportOptions) => Promise<SocketLike>;
export interface SmtpError extends CodeError { smtpCode?: number }
const smtpError = (error: unknown): SmtpError => {
  const failure = asCodeError(error) as SmtpError;
  return failure.code ? failure : Object.assign(new Error(failure.message), {
    code: "smtp-io", ...(failure.smtpCode !== undefined ? { smtpCode: failure.smtpCode } : {}),
  });
};

/** The genuine stream/socket I/O driver is intentionally a Promise interface. */
function ensureSocketLike(socket: CloudSocket): SocketAdapter {
  const enc = new TextEncoder();
  let current = socket;
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  let onRead: ((data: Uint8Array<ArrayBuffer>) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;
  let onEnd: (() => void) | null = null;
  let queuedChunks: Uint8Array<ArrayBuffer>[] = [];
  let closed = false;
  let generation = 0;
  const pump = (localReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>, localGeneration: number) => {
    (async () => {
      while (!closed && localGeneration === generation) {
        const { value, done } = await localReader.read();
        if (done) {
          if (!closed && localGeneration === generation) onEnd?.();
          break;
        }
        if (localGeneration === generation) {
          if (onRead) onRead(value); else queuedChunks.push(value);
        }
      }
    })().catch(error => { if (!closed && localGeneration === generation) onError?.(error); });
  };
  pump(reader, generation);
  return {
    get _raw() { return current; },
    write(data) {
      if (closed) return Promise.reject(new Error("socket is closed"));
      return writer.write(enc.encode(data));
    },
    async startTls() {
      if (!current.startTls) throw Object.assign(new Error("socket does not support STARTTLS"), { code: "smtp-starttls" });
      const oldReader = reader, oldWriter = writer;
      const next = await current.startTls();
      generation += 1;
      try { await oldReader.cancel(); } catch { /* replaced by the TLS stream */ }
      try { oldReader.releaseLock(); } catch { /* best-effort */ }
      try { oldWriter.releaseLock(); } catch { /* best-effort */ }
      current = next;
      reader = next.readable.getReader();
      writer = next.writable.getWriter();
      pump(reader, generation);
    },
    async close() {
      closed = true;
      generation += 1;
      try { await reader.cancel(); } catch { /* best-effort */ }
      try { reader.releaseLock(); } catch { /* best-effort */ }
      try { await writer.close(); } catch { /* best-effort */ }
      try { writer.releaseLock(); } catch { /* best-effort */ }
      try { await current.close(); } catch { /* best-effort */ }
    },
    onData(callback) {
      onRead = callback;
      const queued = queuedChunks;
      queuedChunks = [];
      for (const chunk of queued) callback(chunk);
    },
    onError(callback) { onError = callback; },
    onEnd(callback) { onEnd = callback; },
  };
}

const connectTransport = Object.assign(async ({ host, port }: TransportOptions): Promise<SocketLike> => {
  // cloudflare:sockets does not exist in Node; offline protocol tests inject SocketLike.
  const sockets = await import("cloudflare:sockets");
  let socket: CloudSocket | undefined;
  try {
    const raw = sockets.connect({ hostname: host, port }, { secureTransport: port === 465 ? "on" : "starttls", allowHalfOpen: false });
    socket = raw;
    await raw.opened;
    return ensureSocketLike(raw);
  } catch (error) {
    try { await socket?.close(); } catch { /* release failed acquisition */ }
    const detail = error instanceof Error ? error.message : "socket error";
    throw Object.assign(new Error(`connect ${host}:${port}: ${detail}`), { code: "smtp-io" });
  }
}, { ensureSocketLike });

export interface SmtpReply { code: number; lines: string[]; text: string }
interface ReplyWaiter {
  resolve(reply: SmtpReply): void;
  reject(error: SmtpError): void;
  cancelTimer(): void;
  lines: string[];
}
export interface SmtpSessionOptions {
  host: string; port: number; user?: string; pass?: string; timeoutMs?: number; transport?: SmtpTransport;
}

class SmtpSession {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly timeoutMs: number;
  readonly transport: SmtpTransport;
  socket: SocketLike | null = null;
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private waiter: ReplyWaiter | null = null;
  private replyQueue: SmtpReply[] = [];
  private earlyReply: { code: number; lines: string[] } | null = null;
  private dec = new TextDecoder();

  constructor({ host, port, user = "", pass = "", timeoutMs = REPLY_TIMEOUT_MS, transport = connectTransport }: SmtpSessionOptions) {
    this.host = host; this.port = port; this.user = user; this.pass = pass;
    this.timeoutMs = timeoutMs; this.transport = transport;
  }
  connect(): Effect.Effect<SocketLike, SmtpError> {
    // Acquisition must install the socket before interruption can trigger the finalizer.
    return Effect.uninterruptible(Effect.gen({ self: this }, function* () {
      const socket = yield* Effect.tryPromise({ try: () => this.transport({ host: this.host, port: this.port }), catch: smtpError });
      this.socket = socket;
      yield* Effect.try({ try: () => this.attach(socket), catch: smtpError });
      return socket;
    }));
  }
  attach(sock: SocketLike) {
    sock.onData(chunk => this.onData(chunk));
    sock.onError(error => this.fail(Object.assign(new Error(asCodeError(error).message), { code: "smtp-io" })));
    sock.onEnd(() => this.fail(Object.assign(new Error("connection closed unexpectedly"), { code: "smtp-io" })));
  }
  onData(chunk: Uint8Array<ArrayBuffer>) {
    this.buf = concatBytes(this.buf, chunk);
    let nl = 0;
    while ((nl = this.buf.findIndex(byte => byte === 0x0a)) !== -1) {
      const line = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      this.onLine(this.dec.decode(line).replace(/\r$/, ""));
    }
  }
  onLine(line: string) {
    const m = /^(\d{3})([- ])?(.*)$/.exec(line);
    if (!this.waiter) {
      if (!m) return;
      if (!this.earlyReply) this.earlyReply = { code: Number(m[1]), lines: [] };
      this.earlyReply.lines.push(m[3]!);
      if (m[2] !== "-") {
        const reply = this.earlyReply;
        this.earlyReply = null;
        this.replyQueue.push({ ...reply, text: reply.lines.join(" ") });
      }
      return;
    }
    if (!m) { this.waiter.lines.push(line); return; }
    this.waiter.lines.push(m[3]!);
    if (m[2] !== "-") {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.cancelTimer();
      waiter.resolve({ code: Number(m[1]), lines: waiter.lines, text: waiter.lines.join(" ") });
    }
  }

  /** Register the reply before a write; wait for both write completion and the reply. */
  private waitForReply(write?: string): Effect.Effect<SmtpReply, SmtpError> {
    const reply = Effect.callback<SmtpReply, SmtpError>(resume => {
      if (this.waiter) {
        resume(Effect.fail(Object.assign(new Error("lockstep violation: a reply is already pending"), { code: "smtp-error" })));
        return;
      }
      let received = this.replyQueue.shift();
      let written = write === undefined;
      let finished = false;
      let registered: ReplyWaiter | undefined;
      const complete = () => {
        if (!finished && written && received) { finished = true; resume(Effect.succeed(received)); }
      };
      const reject = (error: SmtpError) => {
        if (finished) return;
        finished = true;
        if (this.waiter === registered) this.waiter = null;
        registered?.cancelTimer();
        resume(Effect.fail(error));
      };
      if (!received) {
        const timer = setTimeout(() => reject(Object.assign(new Error(`no SMTP reply within ${this.timeoutMs}ms`), { code: "smtp-timeout" })), this.timeoutMs);
        registered = {
          resolve: reply => { received = reply; complete(); }, reject,
          cancelTimer: () => clearTimeout(timer), lines: [],
        };
        this.waiter = registered;
      }
      if (write !== undefined) {
        try {
          if (!this.socket) throw new Error("socket is not connected");
          Promise.resolve(this.socket.write(write)).then(() => { written = true; complete(); }, error => reject(smtpError(error)));
        } catch (error) { reject(smtpError(error)); }
      }
      complete();
      return Effect.sync(() => {
        finished = true;
        registered?.cancelTimer();
        if (this.waiter === registered) this.waiter = null;
      });
    });
    return Effect.catch(reply, error => error.code === "smtp-timeout"
      ? Effect.andThen(this.destroy(), Effect.fail(error))
      : Effect.fail(error));
  }
  readReply() { return this.waitForReply(); }
  command(line: string) { return this.waitForReply(sanitize(line) + CRLF); }
  rawWrite(data: string): Effect.Effect<void, SmtpError> {
    return Effect.tryPromise({ try: () => {
      if (!this.socket) throw new Error("socket is not connected");
      return Promise.resolve(this.socket.write(data));
    }, catch: smtpError });
  }
  expect(reply: SmtpReply, codes: readonly number[], what: string) {
    if (!codes.includes(reply.code)) throw Object.assign(
      new Error(`${what}: unexpected reply ${reply.code} ${reply.text}`), { code: "smtp-rejected", smtpCode: reply.code });
    return reply;
  }
  ehlo(): Effect.Effect<Map<string, string>, SmtpError> {
    return Effect.gen({ self: this }, function* () {
      const reply = yield* this.command(`EHLO ${EHLO_NAME}`);
      const r = yield* Effect.try({ try: () => this.expect(reply, [250], "EHLO"), catch: smtpError });
      const caps = new Map<string, string>();
      for (const line of r.lines) {
        const sp = line.indexOf(" ");
        const keyword = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
        if (!caps.has(keyword)) caps.set(keyword, sp === -1 ? "" : line.slice(sp + 1));
      }
      return caps;
    });
  }
  auth(caps: Map<string, string>): Effect.Effect<void, SmtpError> {
    return Effect.gen({ self: this }, function* () {
      const mechs = new Set((caps.get("AUTH") || "").toUpperCase().split(/\s+/));
      if (mechs.has("PLAIN")) {
        const reply = yield* this.command(`AUTH PLAIN ${b64enc(`\0${this.user}\0${this.pass}`)}`);
        yield* Effect.try({ try: () => this.expect(reply, [235], "AUTH PLAIN"), catch: smtpError });
        return;
      }
      if (mechs.has("LOGIN")) {
        const start = yield* this.command("AUTH LOGIN");
        yield* Effect.try({ try: () => this.expect(start, [334], "AUTH LOGIN"), catch: smtpError });
        const user = yield* this.command(b64enc(this.user));
        yield* Effect.try({ try: () => this.expect(user, [334], "AUTH LOGIN (username)"), catch: smtpError });
        const pass = yield* this.command(b64enc(this.pass));
        yield* Effect.try({ try: () => this.expect(pass, [235], "AUTH LOGIN (password)"), catch: smtpError });
        return;
      }
      yield* Effect.fail(Object.assign(new Error("server offers no AUTH mechanism this client speaks (PLAIN, LOGIN)"), { code: "smtp-no-auth" }));
    });
  }
  upgradeTls(): Effect.Effect<void, SmtpError> {
    return Effect.gen({ self: this }, function* () {
      const socket = this.socket;
      if (!socket?.startTls) return yield* Effect.fail(Object.assign(new Error("STARTTLS is not supported by the configured transport"), { code: "smtp-starttls" }));
      yield* Effect.tryPromise({ try: () => Promise.resolve(socket.startTls!()), catch: smtpError });
    });
  }
  alive() { return !!this.socket; }
  abort(reset: boolean): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (reset && this.alive()) yield* Effect.catch(Effect.asVoid(this.command("RSET")), () => Effect.void);
      if (this.alive()) yield* Effect.catch(Effect.asVoid(this.command("QUIT")), () => Effect.void);
    });
  }
  fail(error: SmtpError) {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter.cancelTimer();
    waiter.reject(smtpError(error));
  }
  destroy(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const socket = this.socket;
      this.socket = null;
      this.fail(Object.assign(new Error("connection closed unexpectedly"), { code: "smtp-io" }));
      if (socket) yield* Effect.catch(Effect.tryPromise({ try: () => Promise.resolve(socket.close()), catch: smtpError }), () => Effect.void);
    });
  }
}

export interface MailMessage { to?: string | string[]; subject?: string; text?: string; html?: string; from?: string }
export type SendResult =
  | { ok: true; id: string; dryRun?: true }
  | { ok: false; permanent: boolean; error: { code: string; message: string; smtpCode?: number } };
export interface Mailer {
  dryRun: boolean;
  send(message?: MailMessage): Effect.Effect<SendResult, CodeError>;
}
export interface MailerOptions { host?: string; port?: number; user?: string; pass?: string; from?: string; _transport?: SmtpTransport }

export function openMailer({ host = "", port = 465, user = "", pass = "", from = "", _transport }: MailerOptions = {}): Mailer {
  const dryRun = !host;
  const sender = parseAddress(from || "artefacts@localhost");
  const send: Mailer["send"] = ({ to, subject = "", text = "", html = "", from: fromOverride = "" } = {}) => Effect.gen(function* () {
    const recipients = (Array.isArray(to) ? to : [to]).map(address => parseAddress(address).envelope).filter(Boolean);
    const used = fromOverride ? parseAddress(fromOverride) : sender;
    const messageId = `<${yield* randomHex(16)}@${used.domain}>`;
    if (!recipients.length) return { ok: false, permanent: true,
      error: { code: "invalid-recipient", message: "mail: at least one recipient is required" } } as const;
    const message = buildMessage({
      date: rfc5322Date(), fromHeader: used.header, toHeader: recipients.join(", "),
      subject: sanitize(String(subject ?? "")), text: String(text ?? ""), html: String(html ?? ""),
      boundary: yield* randomHex(12), messageId,
    });
    if (dryRun) {
      console.log?.(`[mail:dry-run] to=${recipients.join(", ")} subject="${subject}"`);
      return { ok: true, dryRun: true, id: messageId } as const;
    }
    const session = new SmtpSession({ host, port, user, pass, transport: _transport });
    let inTxn = false;
    const delivery = Effect.gen(function* () {
      yield* session.connect();
      const greeting = yield* session.readReply();
      yield* Effect.try({ try: () => session.expect(greeting, [220], "greeting"), catch: smtpError });
      let caps = yield* session.ehlo();
      if (port !== 465 && caps.has("STARTTLS")) {
        const reply = yield* session.command("STARTTLS");
        yield* Effect.try({ try: () => session.expect(reply, [220], "STARTTLS"), catch: smtpError });
        yield* session.upgradeTls();
        caps = yield* session.ehlo();
      } else if (port !== 465 && !warnedCleartext) {
        console.warn(`!! smtp: ${host}:${port} advertises no STARTTLS — continuing in cleartext`);
        warnedCleartext = true;
      }
      if (user) yield* session.auth(caps);
      inTxn = true;
      const mail = yield* session.command(`MAIL FROM:<${sender.envelope}>`);
      yield* Effect.try({ try: () => session.expect(mail, [250], "MAIL FROM"), catch: smtpError });
      for (const rcpt of recipients) {
        const reply = yield* session.command(`RCPT TO:<${rcpt}>`);
        yield* Effect.try({ try: () => session.expect(reply, [250, 251], `RCPT TO <${rcpt}>`), catch: smtpError });
      }
      const data = yield* session.command("DATA");
      yield* Effect.try({ try: () => session.expect(data, [354], "DATA"), catch: smtpError });
      yield* session.rawWrite(terminate(dotStuff(crlf(message))));
      const accepted = yield* session.readReply();
      yield* Effect.try({ try: () => session.expect(accepted, [250], "end of DATA"), catch: smtpError });
      inTxn = false;
      yield* Effect.catch(Effect.asVoid(session.command("QUIT")), () => Effect.void);
      return { ok: true, id: messageId } as const;
    });
    return yield* Effect.ensuring(Effect.catch(delivery, error => Effect.gen(function* () {
      yield* session.abort(inTxn);
      return {
        ok: false, permanent: (error.smtpCode !== undefined && error.smtpCode >= 500) ||
          (error.smtpCode === undefined && !["smtp-timeout", "smtp-io", "smtp-starttls"].includes(error.code || "")),
        error: { code: error.code || "smtp-error", message: error.message,
          ...(error.smtpCode !== undefined ? { smtpCode: error.smtpCode } : {}) },
      } as const;
    })), session.destroy());
  });
  return { send, dryRun };
}

export { SmtpSession, connectTransport, rfc5322Date, encodeSubject, parseAddress, buildMessage };
