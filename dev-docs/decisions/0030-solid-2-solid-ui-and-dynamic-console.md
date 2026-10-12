# 30. Solid 2, owned SolidUI components, and dynamic console navigation

Date: 2026-10-05
Status: Accepted; production deployment remains a separate action

## Context and problem statement

After the TypeScript and Effect v4 migration, the owner explicitly selected Solid 2.0 RC, SolidUI, and Tailwind for the console and trusted viewer. This partially supersedes [ADR 0029](0029-typescript-effect-v4-and-radix-ui.md) for the frontend framework and component implementation only. Its strict TypeScript, lazy Effect v4 backend, Cloudflare architecture, and unchanged consumer contracts remain in force.

SolidUI is a copy-and-own component collection, not an installable framework-independent runtime. Its upstream Kobalte primitives currently depend on Solid 1: installing `@kobalte/core@0.13.7` with Solid 2 RC fails peer resolution because Kobalte requires `solid-js ^1.8.15`. A successful forced installation would not establish runtime compatibility.

## Decision drivers

- Keep the owner's explicit Solid 2 RC choice, without silently downgrading to Solid 1.
- Remove React, HeroUI, React Aria, and Radix rather than maintaining two frontend stacks.
- Preserve authentication, authorization, CSRF, native form validation, accessible controls, and existing public URLs.
- Keep authored documents running during source-mode switches, reader metadata changes, and sidebar mutations.
- Reuse the existing authorized HTML bootstrap rather than creating duplicate JSON route policies.

## Considered options

1. Solid 1 with upstream SolidUI/Kobalte unchanged.
2. Solid 2 with forced Solid 1 peer dependencies or compatibility shims.
3. Solid 2 with owned, compatibility-ported SolidUI components and native browser primitives.

## Decision outcome

Choose option 3. Pin `solid-js` and `@solidjs/web` to `2.0.0-rc.13`, with `@solidjs/vite-plugin@3.0.0-next.35`, Vite 8, and Tailwind 4.3.3. Use Node.js 22.12 or newer. No incompatible peer installation, Solid 1 runtime, or React compatibility layer is retained.

### Components and rendering

- Keep copied SolidUI button/dialog designs and their upstream MIT notice in `frontend/src/ui.tsx`. Own their Solid 2 implementation locally; this is not a claim that upstream Kobalte supports Solid 2.
- Use native buttons, inputs, selects, checkboxes, modal `dialog`, and top-layer popovers. Implement menu/tab keyboard movement and return focus to the opener. Top-layer controls remain available in fullscreen.
- Import DOM rendering and JSX types from `@solidjs/web`. Use Solid 2 compute/effect phases, staged signal writes, and lifecycle cleanup rather than Solid 1 hooks.
- Preserve the console themes and compact toolbar. Tailwind utilities/theme are enabled without a preflight reset of existing product styles.

### Navigation and document lifetime

- Fetch existing console/auth HTML routes, parse only their bootstrap data, update the current screen, and maintain browser history. The Worker still owns every access check, redirect, validation result, and one-time credential.
- Submit native forms with their CSRF fields and actual submitter. Never retry a POST automatically. Preserve the active section and a refreshable GET URL after a rendered mutation response; honor server redirects. Ignore stale GET results and ordinary POST responses after the user has navigated away. An accepted successful submission closes only its originating dialog; validation failures keep it open.
- Public guides, files, external links, downloads, and new-tab links retain native browser navigation; they are not console bootstrap routes.
- Keep one console shell per authenticated account across console screens, keyed by the live user id. Recreate ordinary screen contents after each response so form defaults and one-time secrets are current. Keep console and standalone reader owners stable while their reader remains active.
- Account and API-key GET navigation may omit the estate only when the client explicitly supplies its existing user id and the Worker verifies the same live authenticated identity. Merge only that same-user omission response. Native bootstrap, explicit refresh, mutation responses and mutation redirects return fresh estate data. Load all authorized estate artefacts in one bound query instead of one query per folder; access checks remain live.
- Compare the viewer's actual source identity before reopening. Rename, subfolder creation, sidebar moves, menus, and Preview/Code do not replace the running frame. Intentional refresh, a different document, or a source-version change may reopen it.
- Keep the opaque `sandbox="allow-scripts"` boundary and existing Promise-based author SDK. No API, encrypted-object format, database schema, or authored-document migration is introduced.

### Verification

The strict frontend typecheck and production asset build pass. The existing Worker suite passes 289 tests, including same-user estate omission, fresh mutation responses, large authorized estates and revoked-grant exclusion. Actual local workerd/browser scenarios cover publication, reader focus and keyboard controls, fullscreen, source-copy fallback, dynamic rename, subfolder creation and drag moves, section continuity, gated visitor access, account/admin navigation, one-time scoped API-key creation and revocation, and personal/shared SDK storage with visitor shared-write denial. Local health reports D1, R2, and the RateLimit Durable Object healthy.

`frontend/scripts/smoke-reader.mjs` leaves a runnable actual-Chrome check for focus restoration, source-mode state preservation, metadata updates, opaque isolation, validation/tab/GET-URL continuity, and sidebar identity across account/API-key navigation. It requires an explicitly supplied local session and dedicated artefact whose title contains `Solid 2 smoke`; it never targets production.

## Consequences

- Good: one typed frontend, no duplicate route-policy API, and no iframe remount for incidental reader updates.
- Good: browser primitives provide native form validation, modal focus containment, and fullscreen top-layer behavior without incompatible dependencies.
- Bad: the project owns the compatibility ports and their keyboard behavior; an upstream SolidUI update is not automatically safe to copy.
- Bad: Solid 2 and its compiler are coordinated prereleases. Upgrade them together and repeat actual build/browser verification.
- Neutral: published HTML, encrypted storage, the public API/SDK contract, and Cloudflare deployment topology are unchanged. This work does not authorize a production deployment.

## Sources

- [Solid 2 migration and package boundaries](https://v2.solidjs.com/migration/from-solid-1)
- [SolidUI copy-and-own component model](https://www.solid-ui.com/)
- [SolidUI Button source](https://github.com/stefan-karger/solid-ui/blob/main/apps/docs/src/registry/ui/button.tsx)
- [SolidUI Dialog source](https://github.com/stefan-karger/solid-ui/blob/main/apps/docs/src/registry/ui/dialog.tsx)
- [Kobalte 0.13.7 package metadata](https://registry.npmjs.org/@kobalte/core/0.13.7)
