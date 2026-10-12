# 5. Write API contract: asynchronous publishes under /_api

Date: 2026-08-28
Status: Superseded by [15](0015-api-key-hierarchy.md)

## Context

The whole map exists so an agent can publish an artefact end to end without a human touching
git. ADR 0001 routes writes through git + CI, so an artefact is NOT live when the create call
returns — and the server answers unknown paths with the neutral root page at HTTP 200, so a
"just return the URL" design hands an agent an empty-looking page for a minute with no error
anywhere. The contract must be honest about that latency and settle identity, size caps,
unknown clients, passwords, and one error envelope for a programmatic consumer.

## Decision

JSON API under `/_api`, auth `Authorization: Bearer wsa_…` (ADR 0003):

| Endpoint | Scope | Behaviour |
|---|---|---|
| `POST /_api/artefacts` | read-write | Upsert; identity key = (client slug, kebab-case `name`); re-posting updates, token survives. Body `{client, clientName?, name, title, date?, description?, html, password?}`. Returns **`202 {publishId, …}`** with the minted artefact and client-index URLs. |
| `GET /_api/publishes` | read | Publish history. |
| `GET /_api/publishes/<id>` | read | Poll: `pending → deployed \| failed \| timeout`. |
| `GET /_api/clients` | read | Client list. |
| `GET /_api/artefacts` | read | Metadata + URLs only. **No content endpoint exists at any scope.** |
| `POST /_api/artefacts/rotate` | read-write | `{clientToken, artToken, html, newPassword?}`; link/token unchanged. |
| `GET /_api/contract` | public | The agent contract as markdown (ADR 0009). |

- **Why 202 + polling:** publish takes 60–120 s (commit → CI → deploy). Blocking is
  unacceptable; returning only a URL is worse — unknown paths serve the neutral root at 200, so
  a not-yet-live artefact looks like an empty page, not an error (the "neutral-200 problem").
  An explicit publish record with states is the only honest answer.
- **Unknown client is auto-created** (slug + `clientName` or a name derived from the slug),
  matching the `add.mjs` precedent: first publish for a client bootstraps it.
- **Body cap 2 MiB** (`API_BODY_LIMIT`); exceeded → `413` with the JSON error envelope —
  never silent truncation of a document.
- **Password on create:** allowed, minimum 8 characters (enforced — a decorative password is
  worse than none against link leakage); it flows to the secret store (ADR 0002).
- **Error envelope, every error:** `{error: {code, message, details?}}` with codes
  `unauthorized | forbidden | validation | too-large | unknown-artefact | conflict |
  rate-limited | internal`.

## Consequences

- **Good:** agents get a deterministic, pollable lifecycle and machine-parseable errors.
- **Good:** upsert on (client, name) keeps links stable, matching the CLI flow's keying.
- **Accepted:** end-to-end latency is a fact of the git pipeline; the API exposes it rather
  than hiding it. A direct-to-disk fast path would be a new ADR, not a silent change.
- **Cost:** auto-created clients mean a typo'd slug mints a phantom client; tolerated (visible
  and cleanable in the admin) because failing closed would break every first-publish flow.
