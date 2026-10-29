# CI-fix report

- PR CI run `9537` failed in the rendered form test while initializing `solid({ ssr: true, hot: false })`: the locked Solid Vite plugin reports that `hot` was removed and HMR is enabled by default. The supported opt-out is `refresh: false`.
- Updated only the test plugin config to `solid({ ssr: true, refresh: false })`; production code and dependency manifests/lockfiles are unchanged.
- Installed frontend dependencies from the committed lockfile with `mise x node@24 -- npm ci --prefix frontend` (no lockfile edits).
- Focused verification under Node 24: `mise x node@24 -- npm --prefix worker exec -- tsx --test worker/test/keys-screen.test.ts` — 12 passed, 0 failed, including the rendered API-key form test.
- The controller owns the full build/typecheck/test gate; it was not run for this focused CI fix.
