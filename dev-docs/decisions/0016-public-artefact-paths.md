# 16. Public artefact paths: one slug, and every 1.x link preserved as an alias

Date: 2026-09-14
Status: Accepted; anonymous ordinary-link access is superseded by [ADR 0031](0031-private-by-default-artefacts.md). Slugs, ids and aliases retain their identity but require current authorized sign-in; knowing a path is no longer access control.
Carries forward: [13](0013-cloudflare-storage-layout.md) (`slug_redirects`, sealed rows),
[14](0014-crypto-tiering.md) (the visitor path)

## Context

1.x links were two segments — `/<clientToken>/<artToken>/` — minted at build time and promised
permanent: "a link that breaks on redeploy defeats the point" (`CONTEXT.md`, *Artefact token*).
2.0 keeps that promise with different machinery (ADR 13): `artifacts.slug` is one unique path
segment ("friendly path; NULL until named") beside `slug_redirects`, which maps a retired path
to the artefact it belonged to. The M0 skeleton had already routed a single `/<slug>` and
pinned `/<a>/<b>` as unroutable — which would 404 every imported artefact's live link at
cutover.

## Decision

- **One segment is the canonical public path:** `/<slug>/`, and `/<id>/` while an artefact is
  still unnamed — its id, 20 hex chars (~80 bits, the width 1.x minted artefact tokens with),
  because for an ungated artefact that path is the entire access control (`CONTEXT.md`, *Secret
  link*) and must not be narrower than it was. A trailing slash is tolerated on every form,
  because 1.x printed one.
- **The two-segment form stays routable**, resolving through `slug_redirects`. Importing a 1.x
  artefact records its old `<clientToken>/<artToken>` path as that artefact's alias, and
  renaming a slug aliases the path it answered to before. Nothing already handed out goes dark.
- **A path is unique across every namespace** — artefact and client slugs, their live ids, and
  both alias tables (ADR 0017 added clients to this list). A slug equal to another artefact's id
  would hijack that artefact's link, so minting and naming both check. `paths.mjs` is the single
  place that knows them all, and both models ask it.
- **Unknown paths answer the neutral landing page at 200**, as 1.x did. A 404 for an unknown
  token would turn the URL space into an oracle for guessing tokens.
- **The gate endpoint is the same path:** `POST /_gate/<path>`. One gate page therefore serves
  every shape — it derives the endpoint from `location.pathname`.

## Consequences

- **Good:** the secret-link promise survives the rework by construction, and the import step
  has one explicit, tested place to put a legacy path.
- **Accepted cost:** three namespaces to keep unique means naming can now fail
  (`slug-taken`) where 1.x could not; the alternative was silent link theft.
- **Resolved by [17](0017-folders-and-the-folder-index.md):** 2.0 has no `clients` table *in this
  ADR's scope* — but ADR 0017 adds one, makes a client a stored grouping, and renders its index
  at `/<slug>/` under exactly the path rules above. The 1.x `/<clientToken>/` index link is
  therefore preserved as an alias like any other retired path, and client and artefact paths
  share one uniqueness namespace. Nothing about this ADR's rules changed; they simply gained a
  second kind of thing to name.