# 28. HeroUI console and opaque-origin artefact applications

Date: 2026-09-30
Status: Accepted for the opaque-origin runtime and application-data model; console framework superseded by [ADR 0030](0030-solid-2-solid-ui-and-dynamic-console.md)

## Context and problem

The product now includes interactive HTML applications, a Claude-inspired viewer and personal/shared application data. The owner selected real HeroUI for the entire console and explicitly rejected adding domains. Authored documents must retain their native HTML/script lifecycle and presentation without acquiring the console's cookies, browser storage or authority.

This decision partially supersedes [ADR 0013](0013-cloudflare-storage-layout.md) (zero runtime dependencies, deterministic R2 object names and metadata-only D1 rows), [ADR 0020](0020-visitor-shares-and-analytics.md) (pre-sealing network instrumentation), and [ADR 0026](0026-collaboration-shares-and-observations.md) (the iframe's `/preview` transport and observation injection). Their ownership, encryption, live authorization and observation-privacy rules remain in force. It preserves [ADR 0027](0027-optional-share-passwords-and-bearer-access.md): existing shares do not gain access and new share passwords remain optional.

## Decision drivers

- Keep the existing hostname, links, gates, collaboration and deployment bindings.
- Use accessible, maintained UI components rather than styling native controls to resemble a library.
- Execute complete authored documents without extracting or manually replaying scripts.
- Persist JSON application data without granting untrusted code access to console credentials.
- Capture supported fonts once at publication; viewing must not contact font providers.
- Bound anonymous storage and make deletion and concurrent publication reliable.

## Considered options

1. Retain server-rendered screens and directly executed documents.
2. Introduce separate per-artefact origins and native browser storage.
3. Build the trusted console with HeroUI and broker application data into opaque-origin frames on the existing hostname.

## Decision outcome

Choose option 3. React 19, HeroUI 3 and Tailwind 4 build static console assets served by the same Worker. Server controllers retain authentication, permissions and CSRF; HTML bootstraps contain explicit DTO projections, not models or stored secret material.

Every document view, including public/share links and authenticated previews opened in new tabs, uses a trusted viewer around a native `srcdoc` iframe. Its sandbox permits scripts but not same-origin privilege. A restrictive child CSP blocks direct network, forms, nested frames and workers; inline/data/blob resources and the two documented platform images remain available. The trusted page also restricts frame navigation to its own origin. Console theme and sidebar typography do not restyle the document.

The parent loads authorized content, performs gated browser decryption and keeps runtime grants and observation proofs private. A fresh nonce, exact iframe WindowProxy and opaque sender origin bind a private MessageChannel. Native iframe reloads receive fresh channels; old channels and requests are discarded. `window.artefacts.storage` exposes only asynchronous JSON operations on server-selected personal or shared namespaces. It is not a localStorage compatibility layer and provides no AI/MCP authority.

Personal data is separated by artefact and active user or anonymous browser identity. Shared data is readable through current content access and writable only through independent editing authority; a visitor-share grant never grants shared writes. Every request rechecks live access. Suspending a reader revokes their authenticated authority; suspending the content owner does not newly withdraw otherwise-valid public/share links.

D1 stores sealed JSON state, bounded to 64 KiB per value and 128 keys per namespace.
Aggregate limits are 4096 keys and 32 MiB of sealed key/value storage per artefact,
including independent anonymous-personal ceilings of 2048 keys and 8 MiB.
Anonymous entries expire after 365 days without a successful read/write; registered-user
personal and shared entries do not expire. Atomic predicates enforce quotas and prevent
writes onto deleted artefacts. This is a bounded application-state exception to ADR 0013,
not permission to store HTML/media blobs in D1.

Publishing uses parse5 and css-tree runtime dependencies to capture supported Google Fonts CSS and font bytes into the encrypted document. Provider responses are strictly constrained; unrelated author CSS/JS is preserved. Retained historical content is restored or duplicated without reapplying new-publication shape rules or fetching resources again. Publication attempts use unique R2 object names; D1's version/liveness constraints determine which attempt becomes live, so orphaned objects cannot permanently block the next version.

Restore appends a version without rewinding application data. Duplicate creates a fresh identity/key and copies no grants, shares, keys, history or application data. Confirmed owner-only deletion records an audit outcome, withdraws access before physical purge, removes content/version/state rows and reserves old paths permanently. Failed purges remain withdrawn and can be retried.

Share-only observations travel through the parent broker to the existing same-origin endpoint. No `Origin: null` exception is introduced. Ordinary links and console previews remain unobserved; persistent application identity is not added to observation records.

## Consequences

- Complete HTML applications retain native DOMContentLoaded/load behavior and their own typography/themes.
- No DNS cutover or new origin provisioning is required. Existing password and share key-wrapping behavior remains intact.
- The console now requires a frontend build and JavaScript. Dependency updates and browser-level verification are operational obligations.
- Applications must use the asynchronous SDK; direct browser storage, arbitrary network calls and native-origin APIs are intentionally unavailable.
- Anonymous persistence has explicit lifetime/capacity limits. Exhaustion returns errors rather than silently discarding writes; it cannot consume the reserved non-anonymous byte capacity.
- Font capture adds bounded publish latency and document size. Unsupported providers or failed captures reject publication rather than introducing view-time dependencies.
- Authorization cannot retract content already downloaded, and observation numbers remain usage estimates rather than security evidence.

## Pros and cons of the options

### Retain the old rendering model

- Good: smallest build/dependency footprint.
- Bad: does not deliver the requested HeroUI console or a safe persistent application runtime; manually replayed scripts cannot reproduce native document lifecycle reliably.

### Separate per-artefact origins

- Good: native origin-scoped storage and additional browser APIs become possible.
- Bad: violates the explicit no-new-domains decision and adds origin provisioning, routing and credential-boundary operations.

### Opaque frames with a trusted broker

- Good: enforces the trust boundary on the existing hostname and centralizes revocation, quotas and persistence.
- Bad: requires a small platform SDK and careful channel lifecycle handling; some otherwise-valid browser applications require adaptation.

## Confirmation

Verify the Worker suites and real Chromium flows: font publication, native lifecycle, denied parent/browser-storage access, cross-reader persistence, shared-write restrictions, revocation, frame reloads, viewer actions and destructive confirmation. Apply migrations before deploying code; local verification is not production deployment. Revisit separate origins only if native-origin browser APIs become an explicit product requirement.
