# Zero-dependency SMTP submission: protocol floor and what nodemailer buys

## Summary

A correct authenticated SMTP submission client — implicit-TLS 465, `EHLO`,
`AUTH PLAIN`, `MAIL`/`RCPT`/`DATA`, with an HTML+text body and a non-ASCII
subject — is a small, fully specified protocol. Every rule the client must
follow is pinned to a numbered RFC section, and Node's `node:tls` + `node:net`
+ `node:crypto` (all already used by this repo's gate) provide every primitive
the protocol needs: implicit-TLS sockets, in-place STARTTLS upgrade of an
existing socket, PBKDF2/Base64 already in `node:crypto`. The two things naive
implementations get wrong — CRLF line terminators and dot-stuffing — are each a
single RFC subsection. A hand-rolled client covering **exactly** the share-email
use is realistically **~200–280 lines**.

The decisive finding for the dependency decision: **nodemailer 9.x has zero
runtime dependencies itself** (its `package.json` has only `devDependencies`).
So adding it does not cascade — it would be the repo's *one* dependency, and it
is transitively clean. What it buys over the hand-rolled floor is the
general-purpose machinery the floor deliberately omits: DKIM signing, MIME
composition, RFC 5322 address parsing, connection pooling, OAuth2, and hardened
error/timeout normalisation. Those are real, but none of them is needed for the
share-email use that frames this question.

---

## Submission transport: implicit TLS on 465 vs STARTTLS on 587

**The two ports and what governs each.**

- **Port 587 (submission, STARTTLS).** Reserved for message submission by
  **RFC 6409 §3.1** ("Port 587 is reserved for email message submission as
  specified in this document … The protocol used is ESMTP"). The STARTTLS
  upgrade mechanism itself is **RFC 3207**: the server advertises `STARTTLS` as
  an EHLO keyword (RFC 3207 §2–§3), the client issues the bare `STARTTLS`
  command, the server replies `220 Ready to start TLS` (or `454` for a
  transient refusal), and the TLS handshake runs over the *already-established*
  cleartext TCP connection (RFC 3207 §4).

- **Port 465 (submission, implicit TLS).** Standardised by **RFC 8314 §3.3**
  ("Implicit TLS for SMTP Submission"): "When a TCP connection is established
  for the `submissions` service (default port 465), a TLS handshake begins
  immediately." Once TLS is up, RFC 6409 submission protocol runs as TLS
  application data for the rest of the connection.

**Current recommendation.** RFC 8314 §3 (its top-level recommendation) says
MUAs and MSPs "SHOULD" prefer Implicit TLS over the STARTTLS-on-cleartext-port
pattern, and §3.3 explicitly urges supporting **both** 465 and 587 during a
multi-year transition. The de-facto industry default for new submission
clients is implicit TLS on 465 when available, with 587/STARTTLS as the
universal fallback. (WS runs its own MSA, so the choice is whatever that MSA
exposes — a configuration fact, not a protocol one.)

**What `node:tls` / `node:net` give for each.**

- **465 / implicit TLS** is a single call: `tls.connect({ host, port: 465,
  servername })`. Per the Node `tls` docs, `tls.connect(options[, callback])`
  returns a `TLSSocket`, the handshake runs before any application bytes flow,
  the `callback` is added as a listener for the `'secureConnect'` event (emitted
  once the handshake completes), and the client is responsible for checking
  `socket.authorized`. `servername` MUST be set to enable SNI — `tls.connect()`
  does not enable SNI by default, and omitting it can yield the wrong cert or a
  rejection (Node `tls` docs, `tls.connect()` description). `rejectUnauthorized`
  defaults to `true`, giving chain validation against the system CA store for
  free.

- **587 / STARTTLS** uses the documented socket-upgrade path: open a cleartext
  socket with `net.createConnection({ host, port: 587 })`, read the `220`
  greeting and do the `EHLO`/`STARTTLS`/`220` exchange in cleartext, then call
  `tls.connect({ socket: existingSocket, servername, … })`. The Node `tls`
  docs specify a `socket` option: "Establish secure connection on a given socket
  rather than creating a new socket … Usually, a socket is already connected
  when passed to `tls.connect()` … Connection/disconnection/destruction of
  `socket` is the user's responsibility." After the handshake the *same*
  TLSSocket object replaces the plaintext one — no reconnection. (RFC 3207 §4.2
  requires the client to discard pre-TLS server state and re-issue `EHLO` as the
  first post-handshake command; the code change is trivial because the new
  TLSSocket reads/writes the same stream API.)

Both paths need only `node:net`, `node:tls`, and the `'secureConnect'` event —
no third-party TLS code.

---

## The protocol floor: command sequence, EHLO parsing, CRLF, dot-stuffing

**Command sequence for an authenticated single-recipient send** (RFC 5321 §3,
§4.1, §4.3.2; RFC 4954 §4). Every client line ends with `<CRLF>` (RFC 5321
§2.3.8 "Lines"; §4.1.1 commands are "character strings terminated by `<CRLF>`").

```
<-  220 <server> Service ready                              RFC 5321 §3.1, §4.3.2
 -> EHLO <client-fqdn>                                       RFC 5321 §4.1.1.1, §3.2
<-  250-<server> greeting
    250-SIZE <n>
    250-AUTH PLAIN LOGIN                                     RFC 4954 §3 (EHLO keyword)
    250 STARTTLS                                             RFC 3207 §2
 -> STARTTLS                                                 (only on 587; skip on 465)
<-  220 Ready to start TLS                                   RFC 3207 §4
    <TLS handshake on the existing socket>                   node:tls socket option
 -> EHLO <client-fqdn>                                       RFC 3207 §4.2 (MUST re-EHLO)
<-  250-AUTH PLAIN LOGIN                                     capabilities may differ now
 -> AUTH PLAIN <base64(\0user\0pass)>                        RFC 4954 §4, §4.1
<-  235 2.7.0 Authentication succeeded                       RFC 4954 §6
 -> MAIL FROM:<sender@example.com>                           RFC 5321 §4.1.1.2
<-  250 OK
 -> RCPT TO:<recipient@example.com>                          RFC 5321 §4.1.1.3
<-  250 OK
 -> DATA                                                     RFC 5321 §4.1.1.4
<-  354 Start mail input; end with <CRLF>.<CRLF>             RFC 5321 §4.2.3
 -> <message bytes, dot-stuffed, CRLF-terminated>
 -> <CRLF>.<CRLF>                                            end-of-data indicator
<-  250 OK (queued)                                          RFC 5321 §4.2.5
 -> QUIT                                                     RFC 5321 §4.1.1.10, §3.8
<-  221 <server> closing
```

Order-of-commands is normative: the session MUST begin with `EHLO` (or `HELO`),
a transaction is `MAIL` → one-or-more `RCPT` → `DATA` in that order, and `QUIT`
is the last command (RFC 5321 §4.1.4, §3.8). Unless pipelining is negotiated,
"the sender MUST wait for this response before sending further commands"
(RFC 5321 §4.3.1) — a one-command/one-reply lockstep, which is trivial to
implement with a promise per command.

**EHLO capability parsing.** The `EHLO` reply is a multiline `250` reply (RFC
5321 §4.1.1.1, ABNF `ehlo-ok-rsp`): every continuation line is `250-` followed
by an `ehlo-keyword` and optional `ehlo-params`, and the last line is `250 `.
Keywords are case-insensitive (RFC 5321 §4.1.1.1, §2.4). The minimum a client
must extract for this use: whether `STARTTLS` is advertised (RFC 3207 §3), the
space-separated SASL mechanism list on the `AUTH` keyword (RFC 4954 §3: "The
AUTH EHLO keyword contains as a parameter a space-separated list of the names
of available SASL mechanisms"), and optionally `SIZE` to avoid sending an
oversized message (RFC 1870). A flat `Map<keyword, params>` built from the
continuation lines is sufficient. `AUTH` mechanisms MAY change after a
successful `STARTTLS` (RFC 4954 §3, RFC 3207 §4.2), so capabilities are parsed
off the *post-TLS* `EHLO`.

**Encoding rule 1 — CRLF line terminators.** SMTP lines are `<CRLF>`-terminated
(RFC 5321 §2.3.8 "Lines"; §4.1.1.4 explicitly forbids treating bare `<LF>` as a
line end: "the sequence `<LF>.<LF>` … MUST NOT be treated as equivalent to
`<CRLF>.<CRLF>`"). RFC 2045 §2.1 fixes the same definition for message bodies.
The concrete failure mode: `data.toString()`/template strings in Node carry
`\n`, which MUST be normalised to `\r\n` before writing to the socket — both
for SMTP commands and for every line of the DATA payload.

**Encoding rule 2 — dot-stuffing** (RFC 5321 §4.5.2 "Transparency"). Two
sentences do all the work: "Before sending a line of mail text, the SMTP client
checks the first character of the line. If it is a period, one additional
period is inserted at the beginning of the line." The receiver strips a leading
dot from non-terminal lines and treats a line that is *exactly* one dot as the
end-of-data indicator (`<CRLF>.<CRLF>`, RFC 5321 §4.1.1.4). So a body line of
literally `.` becomes `..` on the wire; a body line beginning `.` (e.g. `...foo`)
becomes `...foo`. The terminator is then a separate `<CRLF>.<CRLF>` after the
last body line. A correct implementation is ~3 lines: `body.replace(/(^|\r\n)\./g,
'$1..')` plus the terminator — but it MUST operate on CRLF-normalised text or it
silently corrupts messages whose body happens to contain a dot-led line.

**Minimum SMTP implementation.** RFC 5321 §4.5.1 lists the commands a server
MUST support (`EHLO HELO MAIL RCPT DATA RSET NOOP QUIT VRFY`); a *client* needs
only `EHLO`, `MAIL`, `RCPT`, `DATA`, `QUIT` (plus `AUTH` from RFC 4954 and
optionally `STARTTLS` from RFC 3207) for this use. `RSET` is the cheap way to
abort a transaction without dropping the connection (RFC 5321 §4.1.1.5).

---

## AUTH: PLAIN and LOGIN on the wire, and capability discovery

**Discovery.** The client learns offered mechanisms from the `AUTH` EHLO keyword
(RFC 4954 §3 — a space-separated SASL mechanism list). It picks the strongest it
implements that the server offers. Interoperability baseline: "client and server
implementations of this extension MUST implement the PLAIN SASL mechanism
running over TLS" (RFC 4954 §4), and §14 adds requirements for PLAIN-over-TLS.
PLAIN-without-TLS is forbidden by §4 ("MUST implement a configuration in which
it does NOT permit any plaintext password mechanisms, unless … STARTTLS … has
been negotiated") — so on 465 (TLS from byte zero) and on 587-after-STARTTLS,
PLAIN is always safe.

**AUTH PLAIN** (RFC 4954 §4; SASL PLAIN, RFC 4616). The PLAIN payload is three
NUL-separated fields, `authzid \0 authcid \0 passwd`, base64-encoded per RFC
2045 §6.8 / RFC 4616. Two wire forms (RFC 4954 §4, examples §4.1):

- *Initial response* (one round-trip): `AUTH PLAIN <base64>` → `235`.
  Example from RFC 4954 §4.1: `AUTH PLAIN dGVzdAB0ZXN0ADEyMzQ=` (`\0test\01234`
  base64) → `235 2.7.0 Authentication successful`.
- *Two-step*: `AUTH PLAIN` → `334` (empty challenge, "334 " with a trailing
  space, §4) → client sends `<base64>` → `235`.

A zero-length initial response is encoded as a single `=` (RFC 4954 §4). A
client cancels with `*` (RFC 4954 §4 → `501`). The success code is **235**,
credentials-invalid is **535** (permanent), and a transient server-side failure
is **454** (RFC 4954 §6).

**AUTH LOGIN** is *not* specified by any RFC. It is a de-facto mechanism from
an expired Internet-Draft (`draft-murchison-sasl-login`) that virtually every
MSA still accepts as a fallback. The wire form is a fixed two-challenge
exchange (verified against nodemailer's implementation,
`lib/smtp-connection/index.js`, which expects exactly these prompts):

```
 -> AUTH LOGIN
<-  334 VXNlcm5hbWU6          (base64 of "Username:")
 -> <base64(username)>
<-  334 UGFzc3dvcmQ6          (base64 of "Password:")
 -> <base64(password)>
<-  235 2.7.0
```

`VXNlcm5hbWU6` = `Buffer.from('Username:').toString('base64')`; `UGFzc3dvcmQ6`
= `Buffer.from('Password:').toString('base64')`. Because it is not RFC-tracked,
a hand-rolled client should implement PLAIN (mandatory, RFC 4954 §4) and treat
LOGIN as an optional fallback only for MSAs that advertise `LOGIN` but not
`PLAIN` — rare in practice. Node's `Buffer.from(s).toString('base64')` covers
all the base64 needed; no dependency is required.

---

## Message construction: minimum headers, multipart/alternative, CTE, encoded-word subject

**Minimum header set** (RFC 5322 §3.6, occurrence table). The only two fields
with minimum count 1 are **`Date:`** (exactly one, RFC 5322 §3.6.1) and
**`From:`** (exactly one; `Sender:` becomes mandatory only if `From:` holds
multiple mailboxes — §3.6.2). **`Message-ID:`** is "SHOULD be present"
(§3.6.4) and is treated as effectively required by spam filters; it MUST be a
globally unique `<id-left@id-right>` (§3.6.4 msg-id grammar). Add `To:` and
`Subject:` and you have a header set no reasonable receiver will flag as
malformed. `MIME-Version: 1.0` is required once the body is multipart or
non-ASCII (RFC 2045 §4).

- **`Date:`** must be an RFC 5322 §3.3 `date-time` (e.g.
  `Tue, 05 Aug 2026 12:34:56 +0200`). `new Date().toUTCString()` is close but
  emits `GMT` and the wrong weekday-only-if-locale; the robust one-liner is
  formatting manually or using `Date` getters with a fixed offset — a few lines.
- **`Message-ID:`** uniqueness is trivially satisfied with
  `crypto.randomBytes(16).toString('hex')` for `id-left` and the sending domain
  for `id-right` (`node:crypto` is already a repo dependency in `build.mjs`).

**HTML body with a plain-text alternative: `multipart/alternative`.**

- Structure is RFC 2046 §5.1.4: alternatives are ordered "increasing
  faithfulness to the original content" — **plain text first, richest (HTML)
  last**. The receiver picks the last one it can render.
- Boundary rules are RFC 2046 §5.1.1. The `Content-Type: multipart/alternative;
  boundary=…` parameter value is 1–70 chars from `bcharsnospace`
  (`DIGIT/ALPHA/'()+_,-./:=?`), must NOT end in whitespace, and must not appear
  at the start of any body line. Each part is preceded by a line `--<boundary>`;
  the closing delimiter is `--<boundary>--`. The CRLF before a delimiter
  "belongs" to the delimiter, so a part that should end in a line break needs
  two CRLFs before the next `--<boundary>` (RFC 2046 §5.1.1). Choose the
  boundary with `crypto.randomBytes` so collision with body content is
  impossible.
- Each part carries its own `Content-Type: text/plain; charset=UTF-8` (or
  `text/html; charset=UTF-8`). The **composite** `multipart/alternative` entity
  itself may only use `Content-Transfer-Encoding: 7bit/8bit/binary` — never
  base64/QP at the multipart level (RFC 2045 §6.4, RFC 2046 §5.1.1); encoding
  is applied per inner part.

**`Content-Transfer-Encoding` choice** (RFC 2045 §6). The legal mechanism tokens
are `7bit / 8bit / binary / quoted-printable / base64` (§6.1). `7bit` is the
default if the header is absent (§6.1). For UTF-8 text over a 7-bit-constrained
SMTP path, each text part needs a transformation into the 7-bit domain:
`base64` (RFC 2045 §6.8, dense, opaque) or `quoted-printable` (§6.7, readable,
mostly-ASCII). Modern HTML email overwhelmingly uses `base64` for the text
parts or, when the SMTP path advertises `8BITMIME` (RFC 6152), skips
transformation and labels the part `8bit`. `Buffer.from(text, 'utf8')
.toString('base64')` is the whole base64 encoder — no dependency.

**Non-ASCII subject (Croatian diacritics in scope).** Header fields are US-ASCII
(RFC 5322 §2.1); non-ASCII in an unstructured field like `Subject:` (§3.6.5)
MUST be encoded as an **encoded-word** per RFC 2047 §2:

```
encoded-word = "=?" charset "?" encoding "?" encoded-text "?="
```

For Croatian (`č, ć, š, ž, đ`) over UTF-8, use the **`B` encoding** (base64,
RFC 2047 §4.1 — "identical to the BASE64 encoding defined by RFC 2045"), which
is the safe default when the text is mostly non-ASCII:

```
Subject: =?UTF-8?B?<base64(utf-8 bytes of "Vaš dokument")>?=
```

For mostly-ASCII subjects, the **`Q` encoding** (RFC 2047 §4.2) is more
readable: `=?UTF-8?Q?Va=C5=A1_dokument?=` (space → `_`, each non-ASCII byte →
`=XX` uppercase). Hard rules that bite (RFC 2047 §2, §5):

- No whitespace *inside* an encoded-word (it would split into separate atoms);
  encode spaces too (as `_` in Q).
- A single encoded-word is limited to **75 chars total**, and each line of a
  header containing encoded-words to **76 chars** (RFC 2047 §2). Long subjects
  are split into multiple encoded-words separated by `<CRLF SP>`; each must
  encode an integral number of *characters* (§5 — never split a multi-byte UTF-8
  sequence across two encoded-words).
- Encoded-words are allowed in `Subject`/`Comments` (treated as `*text`,
  RFC 2047 §5 rule 1) and in the `phrase` part of `From`/`To`/`Cc` addresses
  (§5 rule 3), but MUST NOT appear inside an `addr-spec` (the address itself),
  a `quoted-string`, a `Received`, or a MIME parameter (§5).

`Buffer.from(s, 'utf8').toString('base64')` wrapped in `=?UTF-8?B?…?=` is the
whole encoder for typical short subjects; splitting long ones to 75/76 chars
with byte-boundary awareness is ~15 lines.

---

## Error semantics: permanent vs transient (the retry decision's factual basis)

RFC 5321 §4.2.1 fixes the three-digit reply-code severity by the **first digit**
only:

- **`2yz` — positive completion.** Action done; start the next.
- **`3yz` — positive intermediate.** Only `354` (start mail input) is relevant
  here — the reply to `DATA`.
- **`4yz` — transient negative.** "The error condition is temporary, and the
  action may be requested again … the SMTP client SHOULD try again" (§4.2.1).
  **Retry.**
- **`5yz` — permanent negative.** "The SMTP client SHOULD NOT repeat the exact
  request" (§4.2.1). **Do not retry** (the same way).

Specific codes that a Mail-transport retry decision will actually see
(RFC 5321 §4.2.3; RFC 4954 §6):

| Code | Class | Meaning | Retry? |
|------|-------|---------|--------|
| 235  | 2yz   | AUTH succeeded (RFC 4954 §6) | — |
| 250  | 2yz   | Requested mail action OK | — |
| 354  | 3yz   | Start mail input; end with `<CRLF>.<CRLF>` | — |
| 421  | 4yz   | Service not available, closing connection (may come to *any* command) | yes |
| 450  | 4yz   | Mailbox unavailable (busy / temp policy) | yes |
| 451  | 4yz   | Local error in processing | yes |
| 452  | 4yz   | Insufficient system storage | yes |
| 454  | 4yz   | STARTTLS / AUTH temporary failure (RFC 3207 §4, RFC 4954 §6) | yes |
| 500  | 5yz   | Syntax error / command unrecognized | no |
| 501  | 5yz   | Syntax error in parameters | no |
| 503  | 5yz   | Bad sequence of commands | no |
| 535  | 5yz   | Authentication credentials invalid (RFC 4954 §6) | no |
| 550  | 5yz   | Mailbox unavailable / not found / policy | no |
| 551  | 5yz   | User not local; try `<forward-path>` | no |
| 552  | 5yz   | Exceeded storage allocation | no |
| 553  | 5yz   | Mailbox name not allowed | no |
| 554  | 5yz   | Transaction failed | no |

The retry rule of thumb from §4.2.1: "replies are 4yz if they can be successful
if repeated without any change." A connection drop or reset mid-session is to be
treated as if a `451` had been received (RFC 5321 §3.8). So a correct retry
policy is: `code >= 500` → permanent (surface to user, do not retry); `code
>= 400 && code < 500` → transient (requeue with backoff); socket error / EOF →
treat as transient. Post-`DATA` semantics are special: a `250` after the final
`.` transfers responsibility to the server, which then owns redelivery and
bounce generation (RFC 5321 §4.2.5); a `4yz` after `.` means the client retains
the message and may requeue, a `5yz` after `.` means do not retry to the same
server without review (§4.2.5).

---

## What nodemailer adds beyond the floor

Verified against nodemailer's repository at v9.0.4 (`package.json`) and its
`lib/` tree.

**First, the dependency-cost surprise.** nodemailer's `package.json` (v9.0.4,
license **MIT-0**) declares **no `dependencies` field at all** — only
`devDependencies` (`@aws-sdk/client-sesv2`, `bunyan`, `c8`, `eslint`,
`libbase64`, `libmime`, `libqp`, `proxy`, `smtp-server`, etc., all dev/test).
So installing it pulls in **zero transitive runtime packages**. The repo's
documented property at `README.md:18` / `build.mjs:17` ("bez ovisnosti — samo
Node ugrađeni moduli" / "Zero runtime dependencies — Node built-ins only") is
about *this repo's* `package.json`; adding nodemailer changes it from zero to
exactly one runtime dependency, and that one is itself a leaf. The trade-off is
therefore "vendored general-purpose code I didn't write" vs "a hand-rolled
~200-line client I did", not "dependency cascade risk".

**What that one dependency would buy** (each tied to a `lib/` module):

- **Connection pooling** (`lib/smtp-pool/index.js`, `lib/smtp-pool/pool-resource.js`).
  Reuses warm TLS connections across many sends. Irrelevant for the artefact
  share-email use (one message per share, low rate) but load-bearing for bulk.
- **DKIM signing** (`lib/dkim/index.js`, `lib/dkim/sign.js`,
  `lib/dkim/relaxed-body.js`, `lib/dkim/message-parser.js`). Canonicalises
  headers/body (relaxed/simple per RFC 6376) and signs with RSA/Ed25519. This is
  the single feature most likely to matter for deliverability, and it is
  genuinely fiddly to hand-roll — relaxed canonicalisation, header selection,
  `bh=`/`b=` computation, `node:crypto` `sign()`. If the MSA does not sign
  outbound mail itself, DKIM is the main reason to reach for nodemailer.
- **Full MIME composition** (`lib/mime-node/`, `lib/mime-funcs/`,
  `lib/mail-composer/`, `lib/qp/`, `lib/base64/`). Builds arbitrary trees
  (mixed/alternative/related), attachments with auto-detected types, inline
  images, `Content-Disposition`, streaming encoders. The share-email use needs
  exactly one `multipart/alternative` with two text parts — a slice of this.
- **RFC 5322 / RFC 5321 address parsing** (`lib/addressparser/index.js`).
  `"Name, With Comma" <a@b>, c@d` → structured envelope. For an artefact share
  the recipient set is one address the server already knows; for real address
  books this parser is non-trivial.
- **OAuth2 / XOAUTH2** (`lib/xoauth2/index.js`; `AUTH XOAUTH2` handling in
  `lib/smtp-connection/index.js`). Needed only for Gmail/Microsoft OAuth
  flows — out of scope when the MSA is WS-owned and takes username/password.
- **Hardened SMTP state machine** (`lib/smtp-connection/index.js`,
  ~2000 lines). Implements the full reply-classification, timeout, multiline,
  STARTTLS-upgrade, pipelining, `8BITMIME`/`SMTPUTF8` extension, proxy
  (`lib/smtp-connection/http-proxy-client.js`), and normalised error codes
  (`lib/errors.js`) — i.e. all the edge cases the floor covers minimally.
  Defaults (`port 465 ⇒ secure`, else 587; secure auto-detected from port) are
  visible in the constructor.
- **Provider presets & alt transports** (`lib/well-known/services.json`;
  `lib/ses-transport/`, `lib/sendmail-transport/`, `lib/stream-transport/`,
  `lib/json-transport/`). Convenience, not correctness.

**Judgement, not a decision.** For the artefact share-email use (one message,
HTML+text, one or a few recipients, authenticated submission to a WS-owned
MSA), the floor covers everything except DKIM, and DKIM only matters if the MSA
doesn't sign outbound itself. nodemailer's value is concentrated in DKIM,
general MIME composition, and battle-tested edge-case handling — paid for by
~several thousand lines of vendored code (the `lib/smtp-connection/index.js`
state machine alone is ~2023 lines). Resolving "hand-roll vs depend" is a map
decision; the facts are: hand-roll is ~200–280 LOC and fully specified,
nodemailer is a zero-transitive-dep leaf that buys DKIM + general MIME + pooled
connections + hardening.

---

## Size estimate for the hand-rolled client

Target use: an authenticated artefact share-email with an HTML and a plain-text
body, one or a few recipients, submitted over implicit-TLS 465 (with optional
STARTTLS/587). Node ESM, zero runtime deps, using only `node:tls`, `node:net`,
`node:crypto`.

| Piece | Est. LOC | Source of the rules |
|-------|----------|---------------------|
| Socket connect (465 implicit TLS) + `'secureConnect'` + (optional) 587 `net`→`tls.connect({socket})` STARTTLS upgrade | 25–35 | node:tls docs; RFC 3207 §4, RFC 8314 §3.3 |
| Byte-buffered line reader + multiline reply reassembly (`NNN-` → `NNN `) | 20–30 | RFC 5321 §4.2.1 |
| `send(line)` (append `\r\n`) + `expect(code)` promise gate | 10 | RFC 5321 §2.3.8, §4.3.1 |
| `EHLO`, capability `Map` parse, re-EHLO after STARTTLS | 15–20 | RFC 5321 §4.1.1.1; RFC 3207 §4.2 |
| `AUTH PLAIN` (initial-response) + `AUTH LOGIN` fallback | 15–25 | RFC 4954 §4, §4.1 |
| `MAIL FROM` / `RCPT TO` / `DATA` envelope | 10–15 | RFC 5321 §4.1.1.2–4, §4.3.2 |
| Message assembly: `Date`/`From`/`To`/`Subject`/`Message-ID`/`MIME-Version` | 15–20 | RFC 5322 §3.6; RFC 2045 §4 |
| `multipart/alternative` boundary mint + two parts + per-part CTE/base64 | 25–35 | RFC 2046 §5.1.1, §5.1.4; RFC 2045 §6 |
| Encoded-word `Subject` (B-encoding, 75/76-char split) | 10–15 | RFC 2047 §2, §4.1, §5 |
| CRLF-normalise + dot-stuff + `<CRLF>.<CRLF>` terminator | 8–12 | RFC 5321 §4.5.2; §4.1.1.4 |
| Reply classification (2/3/4/5yz) → `{ok,retry,fatal}` + error normalisation | 15–20 | RFC 5321 §4.2.1, §4.2.5 |
| `QUIT`, socket teardown, timeout guards | 10–15 | RFC 5321 §3.8, §4.5.3.2 |

**Realistic total: ≈ 200–280 lines** for a clean, correct, single-purpose
client (towards the low end if only implicit-TLS 465 + `AUTH PLAIN` + B-encoded
subject; towards the high end with STARTTLS/587, `AUTH LOGIN` fallback,
Q-encoding, and full timeout/retry classification). This is consistent with the
scope: nodemailer's general-purpose `lib/smtp-connection/index.js` state machine
alone is ~2023 lines precisely because it covers every extension, transport,
and edge case this use does not need.

`node:crypto` (already imported by `build.mjs`) supplies `randomBytes` for
boundary/Message-ID, `Buffer.toString('base64')` for AUTH and CTE, and `sign()`
should DKIM later become a requirement. No additional Node module and no
runtime dependency is required to hit the floor.

## Sources

- **RFC 5321** Simple Mail Transfer Protocol — §2.3.8, §2.4, §3.1, §3.2, §3.3,
  §3.8, §4.1.1.1–§4.1.1.4, §4.1.1.10, §4.1.4, §4.2.1, §4.2.3, §4.2.5, §4.3.1,
  §4.3.2, §4.5.1, §4.5.2, §4.5.3.2. <https://www.rfc-editor.org/rfc/rfc5321>
- **RFC 6409** Message Submission for Mail — §3.1, §4.3.
  <https://www.rfc-editor.org/rfc/rfc6409>
- **RFC 8314** Cleartext Considered Obsolete (Implicit TLS) — §3, §3.3.
  <https://www.rfc-editor.org/rfc/rfc8314>
- **RFC 3207** SMTP Service Extension for STARTTLS — §2, §3, §4, §4.2.
  <https://www.rfc-editor.org/rfc/rfc3207>
- **RFC 4954** SMTP Service Extension for Authentication — §3, §4, §4.1, §6,
  §14. <https://www.rfc-editor.org/rfc/rfc4954>
- **RFC 5322** Internet Message Format — §2.1, §3.3, §3.6, §3.6.1, §3.6.2,
  §3.6.4, §3.6.5. <https://www.rfc-editor.org/rfc/rfc5322>
- **RFC 2045** MIME Part One — §2.1, §4, §6, §6.1, §6.7, §6.8.
  <https://www.rfc-editor.org/rfc/rfc2045>
- **RFC 2046** MIME Part Two — §5.1, §5.1.1, §5.1.4.
  <https://www.rfc-editor.org/rfc/rfc2046>
- **RFC 2047** MIME Part Three (encoded-words) — §2, §4, §4.1, §4.2, §5.
  <https://www.rfc-editor.org/rfc/rfc2047>
- **Node.js `node:tls` docs** (v26) — `tls.connect(options[, callback])`, the
  `socket` option (STARTTLS upgrade), `'secureConnect'` event, `servername`
  (SNI), `rejectUnauthorized`. <https://nodejs.org/api/tls.html>
- **nodemailer** v9.0.4 — `package.json` (no `dependencies`; MIT-0),
  `lib/` tree (`smtp-connection/`, `smtp-pool/`, `dkim/`, `addressparser/`,
  `mime-node/`, `mime-funcs/`, `mail-composer/`, `qp/`, `base64/`, `xoauth2/`,
  `well-known/`, `ses-transport/`, `sendmail-transport/`, `errors.js`),
  `lib/smtp-connection/index.js` (AUTH PLAIN/LOGIN/XOAUTH2, 465/587 defaults,
  ~2023 LOC). <https://github.com/nodemailer/nodemailer>
- **Repo context** — `README.md:18`, `build.mjs:17` of the 1.x tree
  (zero-runtime-dependency property); `node:crypto` already in use.
