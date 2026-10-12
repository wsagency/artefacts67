# 18. Version retention: the platform owner's setting, 100 versions by default

Date: 2026-09-14
Status: Accepted
Carries forward: [13](0013-cloudflare-storage-layout.md) (`max_versions`, "NULL = platform
default retention")

## Context

Every publish writes one R2 object and one version row, and nothing removed either: the platform
would keep — and pay for — every draft ever published. ADR 0013 left `max_versions` on the
artefact and named a "platform default retention" without deciding it. What makes old versions
nearly worthless is that an artefact's promise is its **link**, and rotation is the remedy for a
leaked one (ADR 0014); what makes them not worthless is diagnosis — a bad publish should be
inspectable afterwards. So the number matters, and the platform owner asked for a dial rather
than a code change.

## Decision

- **Retention is one platform setting, owned by the platform owner**: `/_admin/settings`, Owner
  role only — an Admin does not inherit it, because it is a platform-wide ruling rather than a
  capability (ADR 0012).
- **The shipped default is 100 versions per artefact.** The value is a version count, minimum 1;
  a missing or nonsense row falls back to the default rather than to unbounded growth.
- **Pruning runs on publish**: keep the newest N versions, drop the rest — version rows first,
  then the R2 objects. It never touches the live version, and a pruning failure is swallowed: an
  over-retained version costs storage, a failed publish costs a publish.
- **`artifacts.max_versions` stays unused** — reserved for a per-artefact override if one is ever
  wanted. One platform dial covers every artefact published today.

## Consequences

- **Good:** storage is bounded by policy, and the policy is a field an owner edits, not a deploy.
- **Accepted cost:** retention is destructive. A pruned version is gone — there is no rollback
  feature (ADR 0013 retired the release directories that implied one). Accepted because the link,
  not the version, is what the platform promises, and the default keeps a hundred of them.
- **Rejected:** keeping everything (unbounded growth for a near-zero recovery value) and a
  per-artefact-only cap (every publish flow would have to ask for it, and the owner loses the one
  dial they asked for).