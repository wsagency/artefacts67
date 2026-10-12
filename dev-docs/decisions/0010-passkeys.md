# 10. Superadmin passkeys: WebAuthn as an additional second factor

Date: 2026-09-07
Status: Accepted; "login never becomes passwordless" superseded by [34](0034-passkey-first-sign-in.md)

## Context

After a forgotten-password incident, the superadmin asked to sign in with passkeys — Face ID
instead of a typed code. The request is sound but has a trap: ADR 4's invariant is **two
factors**, and a passkey must not quietly turn the login passwordless. It also tests the
repo's zero-dependency rule: the usual WebAuthn path pulls in CBOR and attestation libraries,
and a synced passkey (iCloud Keychain, Google Password Manager) changes what "possession"
means in the threat model.

## Decision

- **Additional factor, not a replacement.** A passkey satisfies the second-factor step of the
  existing login; TOTP stays enrolled as the recovery factor and can still be used any time.
  The password step is untouched — login never becomes passwordless.
- **WebAuthn Level 2**, spoken to directly: `attestation: "none"` (platform authenticators; no
  attestation statement is verified), `rpId` = host of `PUBLIC_ORIGIN` (localhost in dev —
  WebAuthn works there), `origin` checked exactly against `PUBLIC_ORIGIN`,
  `userVerification: "preferred"`, `residentKey: "preferred"`.
- **Multiple named passkeys** for the single superadmin (laptop, phone, a spare) — enrolled
  only from a fully authenticated session, named and revocable from the Account screen.
- **Storage:** public keys live unsealed in the runtime store (scope `passkeys`) — a WebAuthn
  public key is public, and sealing it under the master key would imply a secrecy it does not
  have. Pending challenges (scope `webauthn-pending`) are 16-hex tokens with a 5-minute TTL,
  deleted on use.
- **Verification:** ES256 and Ed25519 signatures via `node:crypto`; the CBOR decode of
  `attestationObject` is hand-rolled (~100 lines, definite-length only, major types 0–5) so
  the zero-dependency rule survives. `signCount` clone detection keeps the synced-passkey
  exemption: iCloud/Google-synced passkeys legitimately report 0 forever, so 0→0 passes; only
  a non-zero counter that fails to increase rejects (coded error `sign-count`).

## Consequences

- **Good:** the second factor becomes something the operator cannot forget, phish, or type
  wrong; a lost device revokes one named credential without disturbing the others, and TOTP
  remains the deliberate fallback.
- **Accepted risk (no attestation):** we verify the browser's ceremony — challenge, origin,
  RP hash, signature — but not which hardware performed it. We trust the authenticator
  because the browser vouches for it, not because we attested it. For a single-operator
  system that is the right trade: attestation chains would add dependency surface, not
  security.
- **Accepted risk (synced passkeys):** an iCloud/Google-synced passkey is as strong as the
  operator's Apple/Google account — takeover of the sync account defeats this factor. TOTP
  (device-bound, its secret sealed in the secret store) is the unaffected compensating
  factor, which is why it stays rather than being retired.
- **Cost:** a hand-rolled CBOR decoder is a maintenance liability bought in exchange for zero
  dependencies; it is deliberately minimal — indefinite lengths and anything beyond the types
  WebAuthn emits are rejected — so the surface stays small.
- **Unchanged:** the recovery story is still env bootstrap + TOTP; nothing here weakens ADR
  4's session, CSRF, or lockout machinery.
