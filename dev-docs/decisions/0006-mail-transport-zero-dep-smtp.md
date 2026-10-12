# 6. Mail transport: zero-dependency SMTP client

Date: 2026-08-28
Status: Accepted

## Context

Share email is the first requirement that pushes against the repo's stated zero-runtime-
dependency property. The research (dev-docs/research/zero-dep-smtp-feasibility.md) prices both
sides: a correct single-purpose submission client is ~200–280 lines, fully pinned to numbered
RFC sections; **nodemailer 9.x has zero transitive runtime dependencies of its own** (MIT-0) —
so the choice is NOT "dependency cascade vs clean repo" but "vendored general machinery vs
~250 lines of protocol code we own". nodemailer's value concentrates in DKIM signing, general
MIME composition, connection pooling, and a hardened ~2000-line state machine — none of which
the share-email use (one message, HTML+text, one or few recipients, WS-owned MSA) needs,
except DKIM if the MSA does not sign outbound mail itself.

## Decision

**Hand-rolled, zero-dependency** submission client (`lib/mail.mjs`) on `node:tls`/`node:net`/
`node:crypto`, implementing: implicit TLS on 465 as the primary path (RFC 8314); 587 STARTTLS
(RFC 3207) as fallback — upgrade only if `STARTTLS` is advertised, otherwise continue in plain
with a logged warning; `EHLO` capability parsing with mandatory re-`EHLO` after upgrade; AUTH
`PLAIN` with initial response (RFC 4954) and `LOGIN` fallback; `multipart/alternative` with
base64 text parts (RFC 2045/2046), RFC 2047 B-encoded subjects (Croatian diacritics), CRLF
normalisation and dot-stuffing (RFC 5321 §4.5.2), full RFC 5322 header set with a random
`Message-ID`.

- **DKIM assumed server-side** (the WS MSA signs outbound mail). This is an assumption, not a
  verified fact: if the MSA is found not to sign, DKIM becomes a real requirement, hand-rolling
  it is materially harder than sending, and that is the stated **reversal trigger** — reopen
  this decision and likely take nodemailer for its DKIM module alone.
- **Retry split follows the RFC 5321 severity digit:** `4yz` (and socket errors/EOF) are
  transient — a share retries **once after 5 s**, then surfaces to the superadmin; `5yz` is
  permanent — no retry, surfaced immediately. Never blanket-retry: a permanently-failing send
  retried forever is worse than a surfaced failure, because the sender believes it sent.
- **Dry-run:** `SMTP_HOST` unset ⇒ the message is rendered and recorded but never sent. That is
  the testability answer — the full pipeline is exercisable without mailing a real client.

## Consequences

- **Good:** the zero-dependency property survives its first real test, with the reasoning
  priced rather than asserted; dry-run makes share testable end to end.
- **Cost:** this repo now owns ~250 lines of protocol code for the next decade — CRLF
  handling, dot-stuffing, and encoded-word splitting are all places a future edit can silently
  corrupt mail. The RFC pins in the research file are the maintenance map.
- **Assumption risk:** if the DKIM assumption breaks, the decision reverses (see trigger) and
  the repo takes its first dependency — deliberately, in a new ADR, not by drift.
