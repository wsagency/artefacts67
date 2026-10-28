# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial open-source release of Artefacts67.
- Source code link on the documentation page and the sign-in screens.
- Withdrawn artefacts' stored versions and application data are removed at the first daily
  cleanup at least an hour after their deletion, at most 100 artefacts per cleanup (ADR 0038).

### Changed
- Pinned dependencies refreshed to current stable releases and Solid 2 RC.19, including TypeScript 7,
  Vite 8.3.5, and Wrangler 4.154.0. CI now uses Node 24. Worker `allowScripts` pins permit the
  esbuild and workerd install scripts required for clean npm 11 installs; `frontend/src/vite-env.d.ts`
  declares CSS side-effect imports required by TypeScript 7.
- WS Agency design kit, Artefacts67 logo and favicon.
- The Cloudflare Web Analytics beacon loads only when `WEB_ANALYTICS_TOKEN` is set.
- The owner deletes a folder with everything in it (subfolders, artefacts, project data) by
  typing its name; at most 200 artefacts and 100 folders per deletion (ADR 0038). The console
  error `folder-not-empty` is removed; `folder-changed` (409, the folder changed since the counts
  were shown) and `folder-too-large` (409, over the cap) are new.
- `LICENSE` is the plain MIT text; the exclusions moved to `TRADEMARKS.md` ("Licence scope").
- The shared reader and visitor-share viewer bar is shallower, and its home link shows the Artefacts67 logo mark instead of a house icon.
