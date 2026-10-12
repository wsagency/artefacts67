# 34. Passkey-first sign-in

Date: 2026-10-11
Status: Accepted; implemented
Supersedes: [10](0010-passkeys.md) — only its "login never becomes passwordless" bullet
Extends: [12](0012-multi-user-roles.md)

## Context

A passkey could only be the second step: the person typed email and password, then chose TOTP
or "Sign in with a passkey". The owner ruled that this order makes no sense — anyone holding a
passkey should use it first, not after typing the secrets it is meant to replace. ADR 10 forbade
exactly that ("login never becomes passwordless") because a passkey asserted only *presence*:
it proved possession, one factor.

WebAuthn can prove two factors at once. A discoverable credential lives on the authenticator
with its user handle, so the browser can offer it without being told an account; a
user-verified assertion (the `UV` flag) means the authenticator itself checked a PIN or
biometric before signing. Possession plus that local knowledge/inherence check is the two-factor
invariant ADR 4/12 protect.

## Decision

- **The login page leads with "Sign in with a passkey"** (primary). Email + password stays
  below as the fallback ("or sign in with email and password"), followed by the unchanged
  TOTP / passkey second step.
- **Ceremony:** `POST /passkey/login/begin` issues a `login` challenge with empty
  `allowCredentials` and `userVerification: "required"`; `POST /passkey/login/complete`
  verifies it. Both are unauthenticated JSON endpoints with no session, so no CSRF token. The
  one-shot challenge proves freshness, not which browser posted it: an attacker's own valid
  assertion posted cross-site would sign the victim into the attacker's account (login CSRF).
  So both endpoints require `Origin` equal to the request origin and a `Content-Type` of
  `application/json` (the viewer's same-origin guard), else 403; and `clientData.crossOrigin:
  true` (a ceremony run in a cross-origin frame) is refused. A successful sign-in destroys the
  browser's existing session, as the second-factor step does, and a challenge is consumed by
  one atomic `DELETE … RETURNING`, so concurrent completes cannot both pass.
- **Flags:** the server rejects the assertion unless authenticator data has **both `UP` and
  `UV`** set (missing UV → `webauthn-uv`, missing UP → `webauthn-format`). Only then does the
  passkey count as both factors and yield the same full session password + second factor yields.
- **Identity:** the response's `userHandle` (the user id enrolled as `user.id`) names the
  account; the credential id must be one of *that* user's enrolled passkeys, and the signature
  and sign-count checks are the second-factor path's own (`verifyAssertion` is shared). Unknown
  handles or credentials → `webauthn-unknown-credential`.
- **Same gates as password login, same session issuance:** the per-email lockout refuses a
  locked account (429), a non-active (suspended) account is refused (403), and success resets
  the lockout and goes through the one session-issuing path (`signIn`) that already records
  `lastLoginAt` and the `user.login` audit row.
- **Bounded unauthenticated state:** begin is limited to **20 per client address per 5 minutes**
  through the existing RateLimit Durable Object (`rate-limited`, 429). Each staged challenge
  first deletes expired pending rows, so storage holds at most the challenges of the last five
  minutes. `webauthn_pending.user_id` becomes nullable exactly for `login` (migration 0015).
- **Enrollment** now requests `residentKey: "required"` (`requireResidentKey: true`) so new
  passkeys are discoverable; `userVerification` stays `"preferred"` so the second-factor path is
  unchanged. Passkeys enrolled earlier may not be discoverable: they keep working as the second
  factor (which still accepts a UV-less assertion), and the Account screen says so.
- **Conditional mediation:** the email field is `autocomplete="username webauthn"` and, when
  `PublicKeyCredential.isConditionalMediationAvailable()` is true, the login page starts a
  `mediation: "conditional"` request against the **same** begin/complete endpoints, so autofill
  needs no second server path. The button aborts it before its own modal request.
- **Scope unchanged:** passkeys are per user for every role (ADR 12); passkey-first applies to
  everyone who has one.

## Consequences

- **Good:** a person with a passkey signs in with one gesture and never types a password that
  could be phished; the password + TOTP path stays for new devices and recovery.
- **Accepted risk (synced passkeys):** an iCloud/Google-synced passkey is now a full sign-in,
  so its strength is the sync account's plus the device's local verification. ADR 10 accepted
  the sync risk for one factor; this decision accepts it for sign-in because UV still requires
  the person on the device. TOTP remains enrolled and mandatory as the recovery factor.
- **Accepted risk (no attestation):** unchanged from ADR 10 — `UV` is the authenticator's
  claim, vouched for by the browser, not attested.
- **Cost:** begin writes a D1 row per request from anyone; the per-address limit and the sweep
  bound it, and a deploy discards in-flight challenges (the table is recreated in 0015).
