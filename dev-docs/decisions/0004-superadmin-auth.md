# 4. Superadmin auth: PBKDF2 + mandatory TOTP, stored sessions

Date: 2026-08-28
Status: Superseded by [12](0012-multi-user-roles.md)

## Context

One superadmin account guards the most privileged surface in the system: the session that can
reveal every client's artefact password. A single password there is not proportionate — the
gate's lockout machinery exists, but artefact gates have a second barrier (the withheld blob)
that the admin login lacks. The ticket also forced choices on credential storage (env vs
store — env means every password change needs root on the host), session mechanism (stateless
cookie vs revocable stored session), CSRF, routing, and exposure.

## Decision

- **Credential:** PBKDF2-SHA256 verifier (reusing `makeVerifier` from `lib/gate.mjs`) in the
  runtime store. Bootstrapped **once** from `ARTEFACTS_ADMIN_PASSWORD` env on first start;
  after that the env value is ignored and the password is changeable from the admin UI — no
  root action needed to rotate it. The record is a credentials entry, not a user table, so
  nothing forecloses adding users later.
- **Second factor:** TOTP (RFC 6238, HMAC-SHA1, 30 s step, ±1 step window) is **mandatory**,
  zero-dependency via `node:crypto` with a locally implemented base32 encoder. Enrollment is
  forced on first login: the session carries `pending2fa` until a code is confirmed, and until
  then it can do nothing else.
- **Sessions:** stored server-side (scope `sessions`), 32-byte-hex ids, 12 h absolute expiry,
  cookie `wsa_admin` with `HttpOnly`, `Secure`, `SameSite=Lax`. Stored sessions are
  individually revocable and survive a container restart.
- **CSRF:** synchronizer token on every POST; no mutating request is accepted without it.
- **Lockout:** the gate's lockout semantics reused in-memory, keyed `(ip, 'admin')`. Stated
  weakness: the map is in-memory and resets on restart, and unlike artefact gates there is no
  withheld blob behind the admin login — TOTP is the compensating barrier.
- **Routing & exposure:** admin lives under `/_admin`, routed before static serving, on the
  same public hostname as the artefacts. Trade-off recorded below.

## Consequences

- **Good:** password compromise alone is no longer sufficient (TOTP); sessions are revocable
  and restart-surviving; CSRF is covered; the superadmin self-serves password changes.
- **Accepted risk (same hostname):** the platform hostname is unlisted but public, and now
  carries the admin login at `/_admin`. Rejected alternatives (separate hostname, VPN, an
  authenticating proxy in front) add TLS/certificate or operational surface for a
  single-operator system; the mitigation is TOTP + lockout + noindex. Recorded here because a
  future reader will question it.
- **Accepted weakness:** the in-memory lockout resets on restart; an attacker who can force
  restarts gets fresh password tries. TOTP bounds the blast radius of that window.
- **Cost:** first login is deliberately awkward — enroll a TOTP app before anything works.
  That friction is the price of the reveal surface being one factor stronger than a password.
