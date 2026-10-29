# 40. Page artefacts and viewer-applied themes

Date: 2026-10-20
Status: Accepted. The owner approved the accompanying spec on 2026-10-28.
Extends: [13](0013-cloudflare-storage-layout.md), [14](0014-crypto-tiering.md),
[21](0021-folders-are-the-container.md), [28](0028-opaque-artifact-applications-and-heroui-console.md),
[32](0032-project-data-responses-and-mcp.md), [36](0036-open-source-core-and-private-deployment.md)
Amends: [15](0015-api-key-hierarchy.md), [32](0032-project-data-responses-and-mcp.md)

## Context

Artefacts67 currently publishes a complete, self-contained HTML document as each artefact version.
That model is valuable for authored sites and interactive applications, but leaves agents
responsible for layout, styles, responsive behavior and accessibility. Reports and other
document-like deliverables benefit from semantic platform vocabulary, reusable themes and
platform-owned accessible components. The platform also needs authorized content reads and
optimistic concurrency for writes.

## Decision

1. Every **version** has type `site` or `page`. Existing artefacts and versions become `site`
   without content changes. Omitted publish type means `site`. Restore appends a version carrying
   the selected source version's bytes and type; duplicate copies the current version's type, theme
   and overrides.
2. A `site` remains today's free, self-contained HTML document and may use
   `window.artefacts.storage` and `.data`. A `page` is semantic HTML constrained to fixed
   allowlisted vocabulary, custom elements and `data-*` values. It has no `class`, script, style
   element, event handler or external resource. Inline `style` is limited to validated `--a67-*`
   token declarations. The validator uses existing `parse5.parseFragment` with
   `sourceCodeLocationInfo` and `onParseError`, rejects every reported parse error and AST node
   without a source location (including implied nodes), checks source-quoted attributes and the AST
   allowlists/IDs/references, and validates `--a67-*` values with existing `css-tree`. Accepted
   syntax must parse identically in any conforming HTML5 parser.
   Ruling: OPEN-4 changed to existing parse5 + css-tree — the 'no new dependency' rationale holds and a conforming parser is safer than a custom tokenizer — cost if wrong: parse5 accepting a construct that browsers parse differently; mitigated by rejecting all parse errors and a hostile corpus test.
3. Pages use platform-injected CSS and vanilla-JavaScript custom elements, never Tailwind, Solid or
   Radix. Cascade order is `kit, theme, recipes, artefact, object`; budgets are 6 kB gzip CSS and
   15 kB gzip JS.
4. Themes are validated JSON: light/dark tokens (including chart series c1–c6, fonts, radius,
   density, shadow and data-URI logo), bounded inheritance, and parameterized recipes whose
   selectors/CSS are written only by the platform compiler. There is no free theme CSS. Platform
   themes ship with code; P1 includes `report`, `editorial` and `launch`, with `report` derived
   from the current report template (`DESIGN_TEMPLATE_URL`). Project themes belong to a top-level
   folder/project and are defined through API/MCP. Per-version token and recipe overrides are
   stored with the version; its theme reference is `{scope:"platform"|"project",slug:"…"}`, not a
   revision. Scope is explicit because platform themes grow over time and may collide by slug with
   project themes; plain-string shorthand is rejected. Project defaults may select platform or
   same-project themes. Platform references removed from code fall back to `report`; project themes
   resolve only when they belong to the page's current project, otherwise use that project's
   default, then platform `report`. Viewers resolve the theme's current revision at view time.
   A moved page cannot render a theme owned by its former project.
5. Apply themes in the viewer, not at publish. Theme changes take effect immediately on pages
   using that theme; project revisions are immutable and audited. Reconstruct appearance at time T
   from immutable project revision rows (`created_at`) and the audit log, not from a
   version-pinned revision. A `page` download is composed standalone HTML with content, kit and
   theme inline, without the SDK. Pages offer theme, S/M/L text size and light/dark reader controls;
   preferences persist per browser. Brand lock on page/project disables theme switching; color
   overrides imply a brand lock. Sites retain today's opt-in light/dark control.
6. Project theme fonts use the existing Google Fonts CSS2 capture flow at theme definition,
   retaining separate `latin` and `latin-ext` WOFF2 faces and declared weights (the Worker does
   not subset fonts). Platform themes ship pre-subset WOFF2 with provenance/licence. Fonts are
   `data:` URIs. Target ≤150 KB/theme; hard resolved-theme ceiling 256 KiB.
7. Every page must meet WCAG 2.2 AA; this is a release gate, not a warning. Token checks enforce
   text contrast ≥4.5:1 and UI/chart/focus ≥3:1 in both schemes at theme definition and publish.
   Recipes are bounded and contrast-computed; object overrides are checked in context. Automated
   kit/theme checks and a human manual screen-reader audit are required. `site` has no platform AA
   guarantee; its author is responsible. The custom HTML block is deferred (Decision 1).
8. Add API/MCP theme list/get/define/delete and project-default operations; expose platform theme
   metadata and preview links and a public `/themes` gallery. Publish accepts `type`, `theme` and
   `themeOverrides`.
9. Authorized API agents may read content: a master key requires viewer authority; an artefact
   key requires `read` scope and live folder authority. Password gates do not block an authorized
   read; passwords alone never grant access. Visitor shares are never API credentials. Audit
   every content read. Add `get_artifact` MCP tool and HTTP route. This explicitly reverses
   contract §4 and §5's no-content-read rule and amends ADR 0015.
10. Add optional `ifVersion` to HTTP/MCP publish, rotate-with-HTML, console publish and restore.
    Check it in the model against the same current-version snapshot used to allocate the new
    version. Mismatch is 409 `conflict` with current version. `writeVersion` receives
    `expectedVersion`; the `(artifact_id, version)` primary key protects the check/batch race, and
    a losing R2 upload is cleaned up. Two writers reading v5 must result in one v6 and a 409 for
    the other conditional writer; v6's content remains authoritative.
11. Future types `presentation` and `contract` may be considered; this ADR does not design them.
    Digital-signing levels (eIDAS SES/AdES/QES) remain a future decision.

## Alternatives considered

- **Content model B, JSON blocks:** rejected for P1; it constrains authored semantics and makes
  expressive content harder than a small HTML vocabulary.
- **Content model C, Markdown with directives:** rejected for P1; platform compilation would
  still need a custom component language and Markdown does not cover required data/forms cleanly.
- **Theme baked at publish:** rejected; every theme change would require republishing and cause
  content/theme staleness. Viewer-applied themes update consistently and preserve truthful history.
- **Radix/Solid inside artefacts:** rejected; artefacts are opaque sandboxed documents and must
  not depend on the console framework/component tree.
- **Tailwind:** rejected; classes violate the content contract and allow an arbitrary styling
  surface. Fixed kit rules and parameterized recipes are smaller and auditable.

## Consequences

- Pages become structured, portable documents while sites remain backward compatible. Existing
  content is not rewritten.
- Theme definition, resolution and version audit add schema/API/console work; theme and kit
  changes require regression and AA gates.
- Content-read access increases API exposure by deliberate owner choice; key capability, live
  authority and audit requirements are mandatory.
- Version-checked writes avoid lost updates when callers provide `ifVersion`; omission remains
  compatible and unconditional.
- Project movement preserves explicit platform themes. A project theme resolves only in its
  owning current project; after a cross-project move, fallback order is destination default then
  platform `report`. Historical appearance is reconstructed from revision timestamps and audit.
- This is a proposed design only; implementation follows owner review of the accompanying spec.

## Relations

- **ADR 0013** continues to govern D1 state and R2 content placement; theme definitions and
  captured fonts use the existing sealed-content boundary.
- **ADR 0014** continues to govern per-version content-key wrapping and the master-key trust
  boundary; themes and captured fonts require equivalent at-rest protection.
- **ADR 0015 is amended:** the no-API-content-read rule is reversed for authorized master and
  artifact keys under live authority, capability and auditing.
- **ADR 0021** defines folders as the container; themes belong to the top-level-folder project.
- **ADR 0028** governs the opaque sandbox, SDK and application boundary; conditional writes extend
  its version/error behavior.
- **ADR 0032 is amended:** its no-source-read API floor (`0032:13-14`) is explicitly reversed by
  decision 9. Its project boundary, data SDK and folder-move rules otherwise remain; project
  themes follow that same top-level folder.
- **ADR 0036** defines the open-source core/private deployment boundary; platform themes and kit
  ship in distributable code without changing that boundary.
