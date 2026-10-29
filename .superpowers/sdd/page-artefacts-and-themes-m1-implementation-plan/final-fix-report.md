# M1 final-fix report

## Delivered

- Added a failure-propagating `Audit.writeRequired` path backed by the same production D1 audit INSERT used by best-effort writes. Content-read outcomes use the required path; unrelated audit callers retain best-effort behavior. A failed content-read audit now fails the shared handler before it returns source HTML.
- Added an integration regression using the real SQLite-backed Worker D1 test store and a `BEFORE INSERT` trigger that aborts `artifact.content.read` audit rows. It exercises both HTTP and MCP `get_artifact`; neither returns source content when the actual audit INSERT fails.
- The Chromium smoke now tracks the Settings-minted opted-in master token and revokes its key through the authenticated keys API in the outer `finally`, including when the smoke fails after minting. The original collaborator-with-no-master test still asserts the master checkbox is initially unchecked. No-read smoke input accepts either a master token or a fixture-scoped artifact token; README setup instructions now describe both valid forms.
- Updated the MCP operation refusal message and AI instructions to state that only master keys get project data/full MCP tools, while an opted-in artifact key with read scope and live read authority may call `get_artifact`. MCP setup accepts either key type. No M4 page-default guidance or restore/rotation endpoints were added.

## TDD and focused verification

- **P1 RED:** Added the D1-trigger regression first, then ran `mise exec node@24.22.0 -- npm --prefix worker exec -- tsx --test worker/test/api.test.ts`. It failed as expected: `content reads fail closed when the production audit insert fails over HTTP and MCP` observed HTTP `200 !== 500` while the production-backed audit sink swallowed the trigger failure.
- **P1 GREEN:** After wiring `writeRequired` through `openAudit` and all content-read outcomes, the same test passed for HTTP and MCP. The trigger caused real SQLite INSERT failures; the shared API handler returned no content.
- **P3 RED:** Added instruction assertions before changing shipped instructions. `mise exec node@24.22.0 -- npm --prefix worker exec -- tsx --test worker/test/contract.test.ts` failed on the missing scoped-MCP capability statement; the existing two contract tests passed.
- **P1/P3 GREEN and focused integration:** `mise exec node@24.22.0 -- npm --prefix worker exec -- tsx --test worker/test/api.test.ts worker/test/mcp.test.ts worker/test/contract.test.ts` — 42 passed, 0 failed.
- `mise exec node@24.22.0 -- node --check frontend/scripts/smoke-reader.mjs` — passed (run with the focused tests).
- Expected test logging includes simulated internal failures (audit trigger, missing encrypted object, and the existing `boom` test); test totals remained green.

## Real local Chromium smoke

- Created a fresh Wrangler-local D1/R2 persistence directory under `/tmp/wsartefacts67-final-fix-smoke`, applied migrations through `0017_content_read_capability.sql`, and used only a generated local `ARTEFACTS_MASTER_KEY`. No production credentials or port 8787 were used; Wrangler ran on 8788. Both 8788 and 8789 were free before start, and no listener remained after shutdown.
- Registered User A and completed TOTP enrollment; invited User B through local Admin, activated the invitation, completed User B TOTP enrollment, and granted B manager access to the owner fixture and smoke-created project. The fixture had retained versions. The content-read master key and separate no-read artifact key belonged to User A; the harness ran with B's session and A's owner cleanup session.
- One initial harness attempt reached HTTP/MCP content checks, then failed opening the smoke-created `smoke-project/smoke-rsvp` artefact because B did not yet have access to that newly created project. It printed `settings master key revoked: success` in `finally`. After granting B manager access to `smoke-project`, an attempt against the already-mutated fixture stopped at the rename dialog; resetting the local fixture title to its initial smoke title allowed the repeat run to proceed. These were local fixture/setup issues, not failures in the audit regression.
- Successful repeat command: `set -a; . /tmp/wsartefacts67-final-fix-smoke.env; set +a; mise exec node@24.22.0 -- node frontend/scripts/smoke-reader.mjs`.
- Successful smoke output included:
  - `content read (HTTP): solid-2-smoke version=4 capability=allowed`
  - `content read (HTTP): solid-2-smoke version=4 capability=allowed (Settings key)`
  - `content read (HTTP): capability=denied (403)`
  - native validation, Enter, `requestSubmit`, lone form, offer, and stored response checks passed;
  - API/MCP file upload, image display, viewer download, multipart resume, full byte/hash round-trip, abort, and signed-out visitor upload checks passed;
  - `Solid reader smoke passed: ...`
  - `settings master key revoked: success`
- The smoke key was revoked on both a failed attempt and the successful run, so the dedicated User B fixture could create the opted-in key again after cleanup. The fresh server was stopped and only this run's `/tmp` persistence, config, and environment file were removed.

## Remaining limits

- The controller will run the final full repository gate after review, as assigned. No full-suite/build gate is claimed here.
- `.smoke-local-state/` was already untracked in the worktree when I started; it was not read, modified, or removed.
