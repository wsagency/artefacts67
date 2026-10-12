# 37. The app root is the sign-in screen; the landing lives outside the core

Date: 2026-10-12
Status: Accepted
Refines: [24](0024-console-information-architecture.md) (decision 1, `/` as the front door)

## Context

`/` and `/instructions` both rendered the product guide, a marketing homepage with a benefits
slider and a motion walkthrough, and the tests pinned "the public homepage never redirects". Once
the platform is published as open source, every operator runs their own instance: a marketing page
for one hosted service does not belong in the core, and each operator's public landing is their
own website.

## Decision

- **`/` answers `302` to `/login`.** `/login` already sends a signed-in user to `/app` and, while
  the platform has no users, everyone to `/register`. Signed-out visitors get the sign-in screen;
  signed-in users get the console. The redirect is `Cache-Control: no-store`.
- **`/instructions` is the plain documentation page** for people and agents. `/llms.txt` and
  `/_api/contract` are unchanged routes.
- **Every existing link keeps working.** Links to `/` (the auth brand, the documentation header and
  footer, the viewer) now land on sign-in or the console; links to `/instructions` are unchanged.
- **The public landing lives outside the core**, on the operator's own website.
- **The neutral landing for unknown artefact paths is unchanged** (ADRs 0016, 0031): unknown and
  unauthorized ordinary paths still answer the same neutral page at 200.

## Consequences

- The core carries no marketing content; forks need not remove any.
- An operator who wants a public homepage hosts it separately and links to `/login` or
  `/instructions`.
- ADR 0024 decision 1 is superseded in part: `/` is no longer a page of its own.
