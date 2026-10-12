# 7. Share and notification semantics

Date: 2026-08-28
Status: Accepted

## Context

"Share" and "notification" arrived in the brief as one word each and are different features:
share is an act a human takes; notification is a reaction to an event. Both carried open
security questions — a secret link in an email is exactly the leak vector the README already
warns about, the password-in-email question has a default that will actually be used, and link
revocation collides with the system's core promise of permanent, stable tokens.

## Decision

**Share** (`lib/share.mjs`):

- A **deliberate superadmin action** from the admin UI. There is deliberately **no API
  endpoint** for share — a share is a human judgement, not an agent capability.
- Recipients: 1..n addresses, recorded in a per-artefact **share history** (who, when, to
  whom, whether the password was included).
- The email is client-facing and in **Croatian**, carries title/link/from, and states plainly
  that the link is semi-secret: forwarding the mail hands over the artefact.
- **Password not included by default.** Opt-in checkbox with a plain warning. Reason, stated
  plainly: link + password in one mail means **one intercepted mail carries both** — the
  password becomes decoration. The default is what will actually be used, so the default is
  the safe one.
- **Separate-email option CUT** as theater: the second mail lands in the *same inbox* as the
  first — the separation protects nothing; it performs protection.
- **Link revocation RULED OUT.** Tokens are permanent by design; revocation means re-minting,
  which breaks every prior share and every printed link. Rotate (new password, same link,
  ADR 0002) is the recovery lever when a link is believed leaked.

**Notifications** (`lib/mail.mjs`): automatic emails to a **fixed internal `NOTIFY_TO`**,
never to a client: API publish committed, gate lockout triggered, share failed to send. A
notification failure **never fails a publish** — the publish is committed; the failure is
visible in the admin and gets its own best-effort notification.

**View analytics stays in the map's fog** — deliberately not built, not promised, not designed
for. "Artefact was opened" is a client-privacy question, not a free feature; if it is ever
wanted, it graduates explicitly.

## Consequences

- **Good:** the default share cannot leak both halves of the gate; share history answers "who
  did we send this to in March".
- **Good:** publish robustness is never hostage to the mail server.
- **Accepted:** a leaked link cannot be un-leaked — rotate is the only remedy, and it requires
  the artefact to have (or gain) a password.
- **Accepted:** recipient addresses accumulate in platform state — a small privacy surface,
  bounded by the confidentiality of the `state/` volume and its nightly backup.
