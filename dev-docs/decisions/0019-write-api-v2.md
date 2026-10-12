# 19. The 2.0 write API: two key tiers, synchronous publish, one path namespace

Date: 2026-09-14
Status: Accepted
Implements: [15](0015-api-key-hierarchy.md) (key tiers), [13](0013-cloudflare-storage-layout.md)
(content in R2), [14](0014-crypto-tiering.md) (sealing)
Carries forward: [9](0009-compatibility-enforcement.md) (validator codes reject a publish)

## Context

ADR 0015 fixed the key model and ruled that publishing is synchronous, but left the wire contract
open: 1.x's `/_api/artefacts` (British spelling), its `(client, name)` upsert identity, its
`202`+poll flow and its `wsa_` org tokens all described a git-backed platform. 2.0 has no git, no
CI, no deploy latency, and no org tokens — each user holds their own keys. The contract had to be
restated rather than patched, while the parts that are *not* about git — the document rules, the
validator findings, the error envelope — had to survive unchanged, because agents are told to
trust them.

## Decision

- **`/_api/artifacts`** (schema spelling; the 1.x `artefacts` path is retired — there is no 1.x
  API consumer to keep, and ADR 0015 refuses a dual flow). Publish is `POST` → **201 on create,
  200 on update**, live inside the request. No `publishes` endpoint, no polling.
- **Identity is `(client slug, artefact slug)`.** An unknown client slug is auto-created (the
  `add.mjs`/ADR 0005 precedent), `clientName` optional; a client slug owned by another user is a
  403, and a slug already claimed by another artefact is a 409 — never a silent second artefact.
  Re-publishing updates in place; the path (the link) never moves.
- **Two key tiers on the wire** (ADR 0015): `wak_` + 40 hex master, `waa_` + 40 hex artifact,
  both sha256-hashed at rest with a visible prefix, both revocable, both labelled (≤120 chars,
  restored from 1.x). A master key mints/rotates/revokes artifact keys for *its own* user; **a
  master key never mints another master key**, and a scoped key never widens its own authority.
  The user's own master key is minted in the console (`/_admin/keys`), never through an API key.
- **Rate limits are per key, in the Durable Object** (ADR 0013): 120 requests/min general, 30
  publishes/min (1.x values). A limiter that cannot be reached is a **503 `unavailable`** — never
  an open door — and that is the one code 1.x's envelope did not have.
- **`lang` is part of the API** (BCP-47, `en` default; `hr` is the usual client-facing tag). The
  artefact document carries its own `<html lang>`; the column is metadata for listings and the UI.
- **Metadata in, metadata out.** A write is attributed to its actor (`artifact_versions`): a
  master key writes as the user, an artifact key as the delegated integration. No endpoint of any
  scope returns content or a password — the link is the content path (ADR 0015), and the API
  layer enforces that for itself rather than trusting callers.
- **Rotation is gate-and-document only**: `POST /_api/artifacts/rotate` takes
  `{artifact, html?, password?}` where an omitted password leaves the gate untouched, `null`
  clears it, and a string (≥ 8 chars, ADR 0011's floor on this surface) sets or rotates it.
  Metadata changes ride publish, not rotate.

## Consequences

- **Good:** an agent's publish is complete when its HTTP call returns, and the contract it reads
  (`GET /_api/contract`) is generated from the same repository document the validator is written
  against — a drift test keeps them byte-identical.
- **Good:** the blast radius of a leaked key is one artefact (artifact tier) or one user's own
  artefacts (master tier), and every lifecycle action is audited.
- **Accepted cost:** two key tiers mean two mint paths in the console (`/_admin/keys` mints the
  master key; the API mints the scoped ones), which is one more thing to explain in `/instructions`.
- **Not decided here:** whether an artifact key may *create* its artefact (today it cannot — it is
  bound to one that already exists), and whether shares become a third key tier (ADR 0020 covers
  visitor access; this ADR leaves the API open to it by keeping authorization in `keys.may`).