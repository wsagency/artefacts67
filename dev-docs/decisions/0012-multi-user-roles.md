# 12. Multi-user platform: Owner, Admin, Member, per-user logins

Date: 2026-09-14
Status: Accepted
Supersedes: [4](0004-superadmin-auth.md) (single-superadmin model)

## Context

The 1.x platform served one operator: a single superadmin (ADR 4) published on behalf of the
agency, and every artefact belonged to the platform, not to a person. Product direction for 2.0
changes that: the platform becomes a workspace with its own users — people who log in, publish
their own artefacts, manage them through API keys, and invite colleagues. A single-role model
cannot express "my artefacts" versus "the platform's artefacts".

## Decision

**Three roles, in descending power: Owner, Admin, Member.**

- The **first registered account bootstraps as Owner**. Owners may promote other users to
  Owner — there can be more than one, by explicit product ruling ("it does not have to be one
  superadmin, but he can add another owner").
- **Owner**: full control — user management, role assignment, everything below.
- **Admin**: user management (invite, suspend, role changes below Owner); platform-wide
  metadata (all users, all artefacts' listing and audit), but never other users' artefact
  content (ADR 14).
- **Member**: their own artefacts only.
- **Anyone signed in can invite**; an invitee lands as Member. Role changes and Owner
  promotion are Owner/Admin actions.
- Login is per user: email + password (PBKDF2 600k, as today), **WebAuthn passkeys as second
  factor per user** (ADR 10's mechanics, multiplied), TOTP remains the recovery factor. ADR
  11's password leniency is about *artefact* passwords; platform login passwords keep a floor.

## Consequences

- **Good:** "my artefacts" becomes expressible; invites grow the workspace without an operator
  bottleneck; passkeys and TOTP survive the rework mechanically.
- **Good:** blast radius shrinks — a compromised Member exposes one user's artefacts, not the
  platform.
- **Accepted cost:** reveal/rotate/sealed-store machinery (ADR 2) becomes per-user scoped;
  cross-user inspection is an Admin/Owner metadata view, never a content view.
- **Rejected:** keeping a superadmin alongside roles — two account models make every future
  feature pay the tax twice.

## Correction — 2026-09-15 (deploy-forced)

"PBKDF2 600k, as today" is reduced to **PBKDF2 100k**: production workerd caps WebCrypto
PBKDF2 at 100,000 iterations, and the first real `POST /_auth/register` on the deployed
Worker failed with "iteration counts above 100000 are not supported (requested 600000)"
while local dev (which does not enforce the cap) passed everything. `PBKDF2_ITER` in
`worker/src/crypto.mjs` is the single knob; verifier and password-wrap rows carry their own
`viter`/`iter`, so the stored shapes are unchanged. The platform-login brute-force story is
unchanged in substance: per-email DO lockout (three attempts, five minutes) plus the 8-char
password floor carry the load that the extra iterations cannot.
