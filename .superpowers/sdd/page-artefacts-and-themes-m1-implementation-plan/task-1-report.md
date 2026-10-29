# Task 1 report — explicit content-read key capability

## Changes

- Added migration `0017_content_read_capability.sql` with `can_read_content INTEGER NOT NULL DEFAULT 0 CHECK (can_read_content IN (0,1))`; the migration listing confirmed `0016_project_files.sql` was latest on `origin/main`, and the folder-purge merge `742d3ec` introduced no later migration.
- Added persisted `can_read_content` to key rows and returned key records; omitted mint values default to false, explicit true persists as `1`, and rotation returns/preserves the stored value.
- Passed optional `can_read_content` from `POST /_api/keys` and the console master-key creation form; the checkbox is unchecked by default and console input opts in only for master keys. No publish/restore behavior or other console forms changed.
- Added model, API and console route tests. Extended `smoke-reader.mjs` to assert the dedicated no-master user sees the unchecked checkbox, mints with it checked, and still gets the one-time token notice.

## Verification

- Focused worker tests: `npm --prefix worker exec -- tsx --test worker/test/keys.test.ts worker/test/keys-screen.test.ts worker/test/api.test.ts` — 42 passed, 0 failed.
- Required gate: `npm run build && npm run typecheck && npm test` — build and both typechecks succeeded; full suite 452 passed, 0 failed.
- The brief's focused command using `test/...` paths from repository root could not resolve those paths. Running the same selected tests from the root using their `worker/test/...` paths succeeded (command above).
- Browser smoke was not run: the environment did not provide `WS_SMOKE_VIEWER`, `WS_SMOKE_SESSION`, `WS_SMOKE_CHROME`, or `WS_SMOKE_API_KEY`; no production credentials were substituted. Chromium is installed. `ss` found no listeners on either prescribed local port (`8788`, `8789`), so both were free.
- Runtime used Node `v26.8.2`; Node 24 was not needed for the successful checks.

## Self-review

The migration is additive and leaves existing rows false by default. The focused tests cover omitted/false mint, explicit true persistence and returned records, a legacy insert omitting the new column, rotation preservation, console opt-in forwarding, and API opt-in/default behavior. The implementation does not touch the site publish/validate/store/serve path, CSP image whitelist, dependencies, or existing artifact bytes. No unrelated references were introduced.

## Follow-up review fixes

- Restricted the checkbox to the master-key selection when the user has no active master key. The key-kind selector now drives this conditional; selecting an artefact key leaves the previous artefact-key form unchanged. The browser smoke assertions now verify no checkbox for artefact-key selection, switch to master-key selection, verify an unchecked checkbox, opt in, and confirm the unchanged one-time-token notice.
- Added an explicit `can_read_content: false` mint assertion and a key-screen test for the kind/master-state visibility policy plus the console form submission reaching `keys.mint`.
- TDD RED evidence: before implementing the policy helper, Node 24 focused tests failed at module load with `SyntaxError: The requested module '../../frontend/src/settings.js' does not provide an export named 'shouldShowContentReadCheck'`. This was the intended missing-implementation failure. After adding the helper and wiring it into `Keys`, focused tests passed.
- Focused Node 24 command: `mise exec node@24.22.0 -- npm --prefix worker exec -- tsx --test worker/test/keys.test.ts worker/test/keys-screen.test.ts worker/test/api.test.ts` — 43 passed, 0 failed.
- Required Node 24 gate: `mise exec node@24.22.0 -- npm run build && mise exec node@24.22.0 -- npm run typecheck && mise exec node@24.22.0 -- npm test` — build and both typechecks passed; full suite 453 passed, 0 failed.
- Local browser smoke was rechecked and remains unavailable: no `WS_SMOKE_*` environment variables and no project `.env*` files were present. Chromium is installed, and both `8788` and `8789` are free. No production inputs were used.
- This Node 24 verification supersedes the initial Node 26 verification recorded above; the initial report's statement that Node 24 was unnecessary is no longer current.
- Smoke script syntax check: `mise exec node@24.22.0 -- node --check frontend/scripts/smoke-reader.mjs` — passed.

## Form-render regression follow-up

- Extracted the key-creation form used by the Settings screen into `frontend/src/key-creation-form.tsx`, so the checked-by-default state is tested against the actual rendered form component rather than only its visibility helper. The SSR render test verifies the master-key checkbox exists and is unchecked by default, then verifies the artefact-key form omits it. The adjacent route test submits the checked master-key option and verifies it reaches `keys.mint`.
- Covering test: `mise exec node@24.22.0 -- npm --prefix worker exec -- tsx --test worker/test/keys-screen.test.ts` — 12 passed, 0 failed.
- Focused M1 suite: `mise exec node@24.22.0 -- npm --prefix worker exec -- tsx --test worker/test/keys.test.ts worker/test/keys-screen.test.ts worker/test/api.test.ts` — 44 passed, 0 failed.
- Required gate: `mise exec node@24.22.0 -- npm run build && mise exec node@24.22.0 -- npm run typecheck && mise exec node@24.22.0 -- npm test` — build and both typechecks passed; full suite 454 passed, 0 failed.
- Smoke recheck: all required `WS_SMOKE_*` variables are unset, no root `.env*` files exist, and `8788`/`8789` have no listeners. Local browser smoke remains unavailable; no production credentials were used.
