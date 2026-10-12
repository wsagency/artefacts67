# 15. Two-tier API keys: per-user master key, per-artifact scoped keys

Date: 2026-09-14
Status: Accepted
Supersedes: [3](0003-api-token-model.md) (org-level token model),
[5](0005-write-api-contract.md) (asynchronous publish contract)

## Context

1.x had one kind of API credential — an org token with scopes — and an async publish flow
(`202` + `publishId`). The multi-user platform (ADR 12) needs each user to automate over
*their own* artefacts, and needs delegation: an integration that touches one artefact must not
hold the keys to the kingdom. The owner also ruled that publishing is instant; the async flow
is gone.

## Decision

**Two key tiers, both stored sha256-hashed with a visible prefix, both revocable, every
lifecycle action audited.**

- **Master key** — one per user, rotatable. Grants: list/read/update the user's own artefacts,
  read the audit log for them, and **mint / rotate / revoke per-artifact keys**.
- **Artifact key** — bound to exactly one artefact, scopes `read`, `write`, `read+write`,
  rotatable through the master key. It can list only artefacts it can already access — its own
  one. Platform-wide listing is an Owner/Admin console capability, never an API-key
  capability.
- **Publish is synchronous**: a write through either tier is live in the same request — the
  object in R2 and the version row in D1 before the response. The 202/poll contract and the
  `publishes` endpoint retire.

Rate limits apply per key via the DO; a leaked artifact key's blast radius is one artefact.

## Consequences

- **Good:** delegation stops being all-or-nothing; `/instructions` gets an honest agent story:
  master key in your own agent, artifact key in a client's integration.
- **Good:** the audit log has a first-class consumer from day one (master-key read access).
- **Accepted cost:** two key kinds mean two mint/rotate surfaces and two instruction paths.
- **Rejected:** per-artifact keys that list everything — a registry leak through a scoped
  credential; and keeping the async contract "for compatibility" — there is no 1.x API
  consumer worth a dual flow.
