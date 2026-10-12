# 21. Folders are the container

Date: 2026-09-14
Status: Accepted
Supersedes: [17](0017-folders-and-the-folder-index.md) (naming)

## Context

ADR 0017 named the container a **client** — "the organisation an artefact is published for" — and
modelled it as `clients`, `client_redirects` and `artifacts.client_id`. The product direction then
arrived speaking of **folders**, and the question was whether that is one container wearing two
names or two containers (`folder-or-client-what-is-the-container`). The owner ruled: it is one
container, renamed. A folder is the same thing a client was, and that is the point — a member may
use a folder for a client, a project, or anything else, and the platform takes no view on which.

The timing is not sentimental. Migration 0003, which creates the container's tables, has never
been applied to the remote database, so the rename is free: the migration is edited in place
(`0003_add_folders.sql`) and no data moves. After the first deploy the same rename would be a real
migration on live rows. That is why it is done now, before anything is deployed.

## Decision

- **The container is a folder.** `clients` becomes `folders`, `client_redirects` becomes
  `folder_redirects`, and `artifacts.client_id` becomes `artifacts.folder_id` — same columns, same
  rules, new names. The module is `folders.mjs` (`openFolders`), reached by everything through
  `ctx.folders`.
- **The API follows the noun.** `GET /_api/folders` (was `/_api/clients`); the publish body takes
  `folder` and `folderName` (was `client`/`clientName`); responses carry `artifact.folder`; the
  issue code is `invalid-folder-name`; the page an index resolves to is the **folder index**.
- **Nothing else changes.** Every rule of ADR 0017 survives verbatim: the path shape (`/<slug>/`,
  the 80-bit id until it is named), the aliases for retired paths including the 1.x
  `/<clientToken>/` index link, the one uniqueness namespace shared with artefact paths, and the
  per-request index rendering. ADR 0020's shares and ADR 0019's API shape keep their rules
  unchanged — only the container's name moves underneath them.
- **"Client" stops being a container name.** It survives only as the adjective *client-facing*,
  describing an artefact's audience (Croatian, client-facing work) — never a table, a module, a
  field, a body key or a page.

## Consequences

- **Good:** the vocabulary stops pretending the platform knows what a folder is *for*. A member
  organising by project gets the same first-class container as one organising by client.
- **Good:** the rename is total and cheap — schema, Worker, API, console and docs move in one
  wave before deployment, so no surface keeps a half-old name.
- **Accepted cost:** every 2.0 use of *client* had to move at once. Done piecemeal it would have
  left two names for one thing — exactly the ambiguity the ruling removed.
- **Standing warning:** the freedom is spent. `folders` is now a deployed-shape name like any
  other; the next rename is a real migration.
