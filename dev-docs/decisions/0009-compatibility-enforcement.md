# 9. Compatibility enforcement: validate on publish, one canonical contract

Date: 2026-08-28
Status: Accepted

## Context

The requested deliverable was "instructions for AI agents on how to create a 100% compatible
artefact" — and a document alone cannot deliver 100%, because nothing checks. The research
separates rules that are mechanically
decidable from ones that are judgement (palette adherence, print-friendliness); a validator
that guesses is worse than none. Two divergent copies of the contract (platform doc vs an
agent skill) was named the failure mode to avoid.

## Decision

- **Enforce, don't just document.** The write API validates every submitted document before
  committing: ERROR findings reject the publish; WARNING findings pass through and are
  reported in the API response — an agent that will not read prose still reads its response
  body.
- **ERRORs — mechanically decidable, blocking:** `not-utf8` (not valid UTF-8);
  `incomplete-document` (no `<!doctype html>` / not a complete `<html>` document);
  `external-reference` (any view-time network reference: `src`/`href` with an `http(s)` host,
  `@import`, `url(http…)`, remote fonts/CDN); `too-large` (over 1.5 MiB); `invalid-name`
  (name not kebab-case); `invalid-slug` (malformed client slug); `weak-password`
  (password under 8 characters).
- **WARNINGs — advisory, non-blocking:** `template-braces` (`{{…}}` sequences — an unrendered template left in);
  `deferred-scripts` (inline scripts on `DOMContentLoaded`/`load` — gated pages decrypt and
  inject after those events have fired, so such scripts may never run);
  `multiple-head` (more than one `</head>` — the authored document's head boundary is ambiguous).
- **Contract home:** the repo file `dev-docs/artefact-contract.md` is the single canonical
  contract, served publicly at `GET /_api/contract` — fetchable without an auth dance,
  versioned with the code that enforces it, one HTTP hop for any agent.
- **Language:** agent-authored **client** artefacts are `lang="hr"` (house style, matching
  every existing client artefact); **explained/internal** artefacts are `lang="en"`. Stated so
  agents stop guessing.

## Consequences

- **Good:** "100% compatible" becomes enforceable for every decidable rule; agents get
  structured feedback instead of a human noticing a broken page later.
- **Good:** one named home for the contract, reachable by the thing that needs it most.
- **Accepted:** advisory qualities (palette, print-friendliness) remain unenforced — honestly
  documented, not half-guessed by a validator.
- **Cost:** the validator is now a published contract; loosening or tightening a rule is an
  API-visible change and deserves a recorded note, not a drive-by edit.
