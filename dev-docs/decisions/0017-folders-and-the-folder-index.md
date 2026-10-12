# 17. Folders and the folder index

Date: 2026-09-14
Status: Superseded by [21](0021-folders-are-the-container.md) (naming only); anonymous folder-index access is superseded by [ADR 0031](0031-private-by-default-artefacts.md). Ordinary folder paths and aliases require current signed-in read authority.
Carries forward: [16](0016-public-artefact-paths.md) (path rules),
[13](0013-cloudflare-storage-layout.md) (state in D1)

## Context

ADR 0012 made artefacts user-owned, and the M0 schema dropped 1.x's `clients/` directories along
with it — leaving `artifacts.owner_id` as the only grouping. That broke a load-bearing domain
term: a **folder** is "the container an artefact is published into", and the **folder index** is
"the thing a recipient is usually given, rather than a single artefact link" (`CONTEXT.md`). A
person is not a folder. Worse, 1.x handed folders `/<clientToken>/` links, and ADR 0016 had to
record the consequence of leaving this open: those index links would have no landing page at
cutover.

## Decision

- **A folder is a plain grouping with its own public path.** `folders` holds an id, an optional
  slug, a sealed display name and the user who created it; `artifacts.folder_id` points at it
  (nullable — an artefact need not sit on any index). No content, no membership, no accounts: a
  folder never logs in.
- **The folder index is rendered per request** from that pointer: the folder's live artefacts,
  each linked at its own path, with the 🔒 badge on gated ones. Rendering from the same rows the
  artefacts are served from is what keeps an index from drifting away from what is published.
- **Its path follows ADR 0016 exactly** — `/<slug>/`, the folder's 80-bit id until it is named,
  and an alias for every retired path, including the 1.x `/<clientToken>/` index link at import.
  Folder paths and artefact paths share **one** uniqueness namespace, so neither can hijack the
  other's link.
- **Artefacts are put on a folder at publish time**, never by moving them afterwards; M3's API
  auto-creates a folder for an unknown folder slug, following the `add.mjs`/ADR 0005 precedent.

## Consequences

- **Good:** the domain keeps its vocabulary, and the link a recipient is actually handed keeps
  working across the cutover instead of becoming a 404.
- **Good:** ownership stays with the user (ADR 0012) — a folder is a label, not an account, so no
  second permission model appears.
- **Accepted cost:** a fourth path namespace to keep unique. That is why both models ask
  `paths.mjs` rather than their own table: one query knows every id that answers to a path.
- **Not decided here:** whether an artefact may move between folders, and whether the admin
  console gets a folder-management screen (until then folders are created by the publish flow).
