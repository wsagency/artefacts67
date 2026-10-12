# 13. Cloudflare storage: content in R2, state in D1, counters in a Durable Object

Date: 2026-09-14
Status: Accepted
Supersedes: ADRs 1 and 8 (not published): git as source of truth, atomic deploy releases

## Context

Product ruling: no git for content anymore — all content and all state move to Cloudflare. What remained open was
*where* each kind of data lives among D1 (SQLite), R2 (objects), and Durable Objects
(strongly-consistent singletons with storage).

## Decision

- **Artefact content — R2.** Every version's AES-256-GCM ciphertext is one object,
  `art/<artifactId>/<version>.enc`. R2 takes unbounded blob sizes at the lowest cost, is never
  publicly listable, and is served only through the Worker after auth.
- **State — D1.** `users`, `invites`, `sessions`, `api_keys`, `artifacts`,
  `artifact_versions`, slug redirects, `audit_log`, and the sealed-secret rows (wrapped key
  bundles, verifiers, TOTP secrets). Small rows, unique constraints for slugs, append-only
  audit.
- **Durable Object — coordination only.** One `RateLimit` DO holds gate lockout and API rate
  counters plus the per-artefact publish CAS lock. DO storage exists for exactly this
  strongly-consistent state; artefact content never enters a DO.
- **Git becomes code + deploy pipeline.** The repo holds Worker source, templates, docs; CI runs `wrangler deploy` on push to `main` (Workers Builds cannot watch our git host; no new
  vendor). Wrangler is a dev-time dependency only; the runtime stays zero-dependency.

## Consequences

- **Good:** publish is synchronous — a write is live in the same request; the 202/poll flow
  (ADR 5) and the release-pointer model (ADR 8) both retire.
- **Good:** no artefact content in git means rotation of sealed content can never leak through
  history, and `clients/` stops being a deploy input.
- **Accepted cost:** git stops being the backup. Backups become D1 Time Travel (PITR) plus a
  scheduled R2 export — must exist before cutover, not after.
- **Accepted cost:** atomicity moves from ADR 8's release directories into the platform: one
  request writes version row + object transactionally enough that a partial write serves 404,
  never half a document.
- **Rejected:** DO storage for content (per-DO caps, per-request billing, no listable
  namespace); D1 for blobs (row limits, cost at size).
