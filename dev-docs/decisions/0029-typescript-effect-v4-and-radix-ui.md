# 29. TypeScript, Effect v4, and Radix UI

Date: 2026-10-05
Status: Accepted for the TypeScript/Effect v4 backend; frontend portions superseded by [ADR 0030](0030-solid-2-solid-ui-and-dynamic-console.md)

## Context and problem statement

The owner requests that Artefacts67 move from JavaScript and HeroUI to TypeScript, Effect v4, and Radix UI. This is a platform implementation migration, not a conversion of published HTML artefacts or their application data. Existing URLs, encryption, authorization, browser isolation, and Cloudflare bindings must continue to work.

This decision partially supersedes [ADR 0028](0028-opaque-artifact-applications-and-heroui-console.md) only for the implementation language and console component library. Its opaque-origin runtime, DTO projection, encrypted storage, publication, font capture, and permission rules remain in force. No database or encryption-format migration is authorized by this decision.

## Decision drivers

- Deliver the explicitly selected TypeScript, Effect v4, and Radix stack.
- Preserve every public API, HTML bootstrap, storage SDK, and published-link contract.
- Make effectful server workflows and their failure channels explicit and type-checked.
- Keep the existing React interface, themes, and native authored-document lifecycle.
- Avoid a parallel legacy implementation, compatibility facades, or a production cutover before verification.

## Considered options

1. Retain JavaScript, Promise-based business workflows, and HeroUI.
2. Adopt TypeScript and Radix while leaving the backend's business workflows unchanged.
3. Adopt strict TypeScript throughout the platform, compose backend workflows with Effect v4, and replace HeroUI with Radix primitives.

## Decision outcome

Choose option 3. Pin the stable `effect@4.0.1` and `radix-ui@1.6.7` releases and commit package locks. Keep React 19, Vite, the existing hostname, D1, R2, and the RateLimit Durable Object.

### Server implementation

- Effectful model and controller operations are lazy Effects, composed inside the backend rather than implemented as an Effect wrapper around the old Promise-based application.
- Lift genuinely fallible D1, R2, WebCrypto, stream, and network operations at their I/O seams. Pure helpers remain pure.
- Expected failures retain their existing codes, messages, status codes, and response envelopes. Recover through Effect's failure APIs; JavaScript `try/catch` around a yielded failed Effect is not recovery.
- Execute Effects at genuine Worker, Durable Object, scheduled-task, and test boundaries. Keep Cloudflare's standard Request/Response and lifecycle interfaces.
- Preserve atomic SQL predicates, cryptographic framing and parameters, live access checks, audit propagation, body limits, resource cleanup, and existing timeout policy. This migration does not add retries, detached work, or a new cancellation policy.
- Convert production modules, build scripts, and their callers to TypeScript. Remove obsolete JavaScript module paths rather than retaining re-exports. Domain URL aliases and permanent redirects remain supported product behavior, not language-migration shims.

### Frontend implementation

- Use Radix Dialog, DropdownMenu, Select, Checkbox, Tabs, and Label where those behaviors are required. Use native semantic controls for buttons, text inputs, textareas, and panel structure.
- Reimplement the existing meaningful UI modules against Radix/native semantics and migrate every caller. Remove HeroUI, React Aria, their compatibility props, and unused styling.
- Preserve native form values and validation, CSRF fields, keyboard navigation, accessible names, dialog focus handling, and fullscreen portal placement.
- Keep the console's Original, Light, and Calm themes and the shared compact viewer toolbar. Preview/Code switches must not recreate the running frame.
- Keep the browser-facing storage SDK asynchronous and Promise-based. Authored artefacts remain complete HTML documents; generated child JavaScript executes natively in an opaque `sandbox="allow-scripts"` frame. Effect is not exposed to or required of authors.

### Verification and release

Develop on `feat/effect-v4-typescript-radix`, without automatically deploying the migration. Root commands build both assets and the embedded contract, type-check both packages, and run the existing behavior suite. CI performs those checks on branches; remote migrations and deployment remain gated on `main` and configured credentials.

Before cutover, run the platform under local workerd against existing encrypted fixtures and exercise the actual console and both viewer surfaces. Verify empty-folder creation, publishing and version continuity, authenticated actions, visitor shares, storage permissions, native fragment navigation, source-mode state preservation, and Radix dialogs/menus/selects in fullscreen. Verification claims belong in the delivery report, not in this decision before they are observed.

## Consequences

- Good: one typed platform implementation and one console component library; no legacy migration facade remains.
- Good: backend workflows expose expected failures and resource handling without changing consumer contracts.
- Good: existing artefacts and encrypted state require no re-publication or database cutover.
- Bad: Effect changes internal async composition and test callers; a filename-only conversion would not satisfy this decision.
- Bad: Radix primitives do not provide HeroUI's styling. The project must own its existing control CSS and verify accessibility and portal behavior.
- Neutral: published HTML, browser SDK consumers, and Cloudflare deployment architecture remain unchanged.

## Pros and cons of the options

### Retain the current stack

- Good: no implementation migration or new dependencies.
- Bad: does not meet the requested technology choice.

### TypeScript and Radix only

- Good: preserves the backend's existing Promise composition with a smaller internal change.
- Bad: does not deliver the requested Effect migration and would leave the work incomplete.

### Complete typed Effect and Radix migration

- Good: meets the selected stack while concentrating runtime execution at platform edges.
- Good: preserves existing product contracts rather than redesigning routes, storage, or rendering.
- Bad: requires broad consumer migration and behavioral verification; both the server and UI cutovers are substantial.

## More information

- [Effect v4 / Cloudflare compatibility research](../research/effect-v4-cloudflare.md)
- [Published Effect 4.0.1](https://registry.npmjs.org/effect/4.0.1)
- [Radix primitives](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Artefact contract](../artefact-contract.md)
