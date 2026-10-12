# 2. Runtime secret store: encrypt at publish, reveal and rotate from the server

Date: 2026-08-28
Status: Accepted

## Context

Superadmin reveal and rotate require artefact passwords to exist somewhere recoverable, but the
repo's two provenances are incoherent about that: build-time artefacts keep the plaintext
password in `meta.json` in git; pre-encrypted artefacts keep it nowhere (by design). Meanwhile
the README promises "the server never sees plaintext or the AES key" — a claim that cannot
survive a reveal feature, and which must be replaced honestly rather than silently. This ADR
records the reversal, its reasoning, and the residual guarantee (the ticket demanded exactly
that, and that the README be corrected in the same change).

## Decision

New gated artefacts are **encrypted at publish time** by the server (`makeGate` from
`lib/gate.mjs`) and committed to git already in the pre-encrypted shape: gate page
`<name>.html` + sidecar `<name>.json`, `meta.json` with `raw: true, locked: true`. Plaintext
content and passwords **never enter git** for platform artefacts.

The recoverable material lives in a **runtime secret store** (`lib/secrets.mjs`): values sealed
with AES-256-GCM under a 32-byte **master key** from the container env `ARTEFACTS_MASTER_KEY`,
persisted as `{v, iv, ct, tag}` entries in the `state/` volume. Stored per gated artefact: the
password and the gated HTML (rotate needs the plaintext content to re-encrypt). Entry ids are
not secret (`art/<clientToken>/<artToken>`); compromise requires both the store and the key.
Legacy handling: build-time artefacts (plaintext password in `meta.json`) keep working;
pre-encrypted legacy (`credentials.enc.html`) is permanently unrecoverable and the admin shows
it as such. `scripts/rekey.mjs` re-seals the store under a new master key. The README security
claim was corrected in the same change that shipped this decision.

## Consequences

- **Good:** plaintext passwords and gated content stop entering git for every new artefact —
  a repo leak alone no longer exposes them.
- **Good:** rotate works with a stable link (re-encrypt server-side, artefact token unchanged)
  — re-supplying content for the legacy pre-encrypted artefact was rejected because that would
  mean having its plaintext again.
- **Reversed claim, stated plainly:** for platform artefacts the server *does* see plaintext at
  publish/rotate time and holds password + content (encrypted) in the secret store. The trust
  boundary is now the `state/` volume plus the master key; whoever holds both holds every
  platform artefact's password.
- **Residual guarantee:** the gate still withholds the blob from anyone holding only the link —
  guessing must still go through the server, offline brute-force remains impossible, and a
  leaked link alone still reads nothing without the password.
- **Cost:** master-key management becomes an operational duty (rotate via `scripts/rekey.mjs`;
  never commit it; a deterministic dev fallback key exists but warns loudly on use).
- **Cost:** legacy artefacts are second-class forever — build-time ones keep a plaintext
  password in git until rotated; `credentials.enc.html` can never be revealed.
