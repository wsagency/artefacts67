# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial open-source release of Artefacts67.
- Explicit per-key content-read opt-in for HTTP and MCP reads, with read auditing and optional
  `ifVersion` guards for publish and rotate-with-HTML writes; default `site` publication is unchanged.
- Source code link on the documentation page and the sign-in screens.
- Withdrawn artefacts' stored versions and application data are removed at the first daily
  cleanup at least an hour after their deletion, at most 100 artefacts per cleanup (ADR 0038).
- AI instructions include a native-dialog recipe for recording acknowledgement before an in-artefact download.
- Console sidebar footer can copy the AI instructions to the clipboard.

- Page artefacts use strict fragment validation, registered inline design tokens, local references, and complete supported image signatures while complete-document site output retains its established analytics instrumentation and source bytes. The page viewer uses the trusted inline kit and embedded assets under its restrictive CSP. Registered-theme page downloads are standalone documents with the platform shell, inline kit/runtime, compiled theme and CSP; they exclude the hosted SDK, live persistence and application data.
- Code-shipped `report`, `editorial`, and `launch` page themes pass a checked contrast/compositing compiler before scoped CSS or a resolved logo token is exposed; `/themes` previews the three themes against one shared sample. The M2 automated accessibility gate exercises shipped page experiences against WCAG 2.2 A/AA rules and reports axe incomplete checks separately, not as a certification of arbitrary authored content.
- Page publication sizes the exact hosted document including its runtime bridge across platform themes and compiled overrides; standalone composition enforces the same 1,500,000-character cap without the hosted bridge.

### Fixed
- Theme compiler rejects malformed font stacks and unsafe or over-512px logos, contains wrapped aurora content on opaque surfaces, preserves inverse-header foreground pairing without overriding nested inverse tones, preserves explicit SVG text `fill`, and targets generated KPI surfaces; page validation rejects unwrapped direct text in aurora hero figures.
- Inverse tones cannot nest or appear on/inside table and code surfaces; paired opaque-surface colors and inverse-section headings remain contrast-safe.
- Page sizing uses the effective stored language when an update omits `lang`; hosted preview/download composition uses the canonical deployment origin without changing copied public links.
- Gated folder shares ignore individually withdrawn artefacts during key synchronization.

### Changed
- `HEAD` follows `GET` routes with matching status and headers and no response body, including static assets.
- Pinned dependencies refreshed to current stable releases and Solid 2 RC.20 with
  `@solidjs/vite-plugin` 3.0.0-next.53, Effect 4.1.0, and Wrangler 4.156.0. CI uses Node 24.
  Worker `allowScripts` pins permit the esbuild and workerd install scripts required for clean
  npm 11 installs; `frontend/src/vite-env.d.ts` declares CSS side-effect imports required by TypeScript 7.
- WS Agency design kit, Artefacts67 logo and favicon.
- The Cloudflare Web Analytics beacon loads only when `WEB_ANALYTICS_TOKEN` is set.
- The owner deletes a folder with everything in it (subfolders, artefacts, project data) by
  typing its name; at most 200 artefacts and 100 folders per deletion (ADR 0038). The console
  error `folder-not-empty` is removed; `folder-changed` (409, the folder changed since the counts
  were shown) and `folder-too-large` (409, over the cap) are new.
- `LICENSE` is the plain MIT text; the exclusions moved to `TRADEMARKS.md` ("Licence scope").
- The shared reader and visitor-share viewer bar is shallower, and its home link shows the Artefacts67 logo mark instead of a house icon.
