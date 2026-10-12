# 3. API token model and scope semantics

Date: 2026-08-28
Status: Superseded by [15](0015-api-key-hierarchy.md)

## Context

Agents need a credential for the write API (`/_api`). The mechanical shape is routine; the
security decision is what `read` means in a system where every artefact URL is already an
unguessable token and some artefacts are additionally password-gated. A `read` token that could
fetch gated content would be a master key bypassing every client's gate at once — categorically
worse than one leaked artefact link. The ticket asked for the model AND an explicit semantics
table, because "read" left undefined is where accidents live.

## Decision

Token format `wsa_` + 40 hex (160 random bits) — recognisable at a glance and scannable in
logs. **SHA-256 at rest, not PBKDF2**: the repo's PBKDF2 verifier exists for low-entropy
passwords; a 160-bit random token needs no stretching, and a plain hash keeps authentication
cheap. Plaintext is shown exactly once at creation and never stored. Records live in the
runtime store (scope `apitokens`) with label, scope, `createdAt`, `createdBy: superadmin`,
`lastUsedAt` (fire-and-forget update), optional `expiresAt` — **no default expiry**; an agent
that outlives its token asks the superadmin — and `revokedAt`: **revocation is a flag, not a
delete**, keeping the audit trail; it takes effect on the next request. Rate limits are
in-memory fixed windows, 120/min general and 30/min publishes per token; restart-reset is
accepted (same posture as the gate lockout).

### Scope semantics (normative)

| Capability | `read` token | `read-write` token | Superadmin session |
|---|---|---|---|
| Client & artefact metadata | yes | yes | yes |
| Enumerate secret URLs | yes | yes | yes |
| Artefact content (ungated) | **no** | **no** | yes |
| Gated content / blob | **no** | **no** | yes |
| Artefact passwords | **no** | **no** | yes — reveal, audit-logged |
| Publish / rotate | no | yes | yes |

There is deliberately **no content endpoint at any API scope**: the API hands out metadata and
the unguessable URLs — the link itself remains the content access path. `read` may enumerate
URLs (an agent must be able to tell its caller where the artefact lives) but may never bypass a
gate; no API token of any scope ever sees a password — that is the superadmin session's
privilege alone.

## Consequences

- **Good:** a compromised `read` token leaks a directory listing of unguessable links — bad,
  but bounded; it is not a gate bypass and it is not every client's content.
- **Good:** revocation keeps an audit trail; authentication stays one SHA-256 + scan.
- **Accepted:** URL enumeration by `read` converts "unguessable" into "listed" for token
  holders — deliberate, recorded here so it is not rediscovered as a bug.
- **Accepted:** rate limits reset on restart; the restart-attack window is tolerated.
- **Cost:** `lastUsedAt` writes make the store warm; fire-and-forget keeps them off the
  request path, at the price of a possibly-stale timestamp.
