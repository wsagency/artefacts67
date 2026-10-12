# 23. The owner's key may opt into a weak password, and retired paths are an API operation

Date: 2026-09-15
Status: Accepted
Amends: [11](0011-weak-passwords-are-a-valid-choice.md) (the floor's scope),
[16](0016-public-artefact-paths.md) (aliases)

## Context

Importing legacy links needed two things no surface could do. An imported protected artefact may
carry a short password, and the write API refuses anything under eight characters — a rule ADR 0011
put there for *unattended agents*, while explicitly exempting the owner's own console path. And a
link handed out in the past could only be recorded in the console, because the API had no operation
for it — so nothing scripted could ever preserve a legacy link, even though the console could.

Both gaps left "the owner clicks in the console" as the only answer. That does not scale: the
console and the API had drifted apart in capability, and the only way to automate an import was to
work around the platform.

## Decision

- **The floor stays the default.** `validate.mjs` is untouched: a password under eight characters
  is still `weak-password` on publish and `invalid-password` on rotate, and a request that says
  nothing keeps behaving exactly as before.
- **A master key may opt in, explicitly, per request.** `allow_weak_password: true` on
  `POST /_api/artifacts` or `POST /_api/artifacts/rotate` drops that one issue — every other
  validation still applies, the document is still checked, and the write's audit detail records
  `weakPassword: true` so the accepted exception is visible afterwards. A **scoped** artifact key
  that sends the flag is refused (403): delegation never widens, and a client integration must
  never be able to publish a guessable password.
- **Retired paths become an API operation.** `POST /_api/artifacts/alias` and
  `POST /_api/folders/alias` record one or more paths against an artefact or folder the caller is
  allowed to touch (the existing `keys.may` spine; folder aliases are master-key only, matching
  folder listing). Paths are normalised by `paths.mjs`, so a malformed one is a validation error
  and a path somebody else already holds is a conflict — the uniqueness rule of ADR 0016 is not
  weakened by having a second door to it.

## Consequences

- **Good:** an import (or a rename, or a migration) is now expressible as an API call instead of a
  console session, and the console and the API finally offer the same two operations.
- **Good:** the floor keeps protecting the case it was written for. An unattended agent publishing
  to a client still cannot choose `ws` by accident: it has to say, in the request, that it means it.
- **Accepted risk:** a leaked **master** key plus a weak artefact password is content exposure —
  but a leaked master key already means control of that user's whole estate, so the opt-in adds no
  new class of risk. A leaked *scoped* key still cannot reach a weak password at all.
- **Not decided here:** whether the console should surface the opt-in at all (it does not need to —
  its own path has no floor), and whether a future *class* of artefacts should demand a strong
  password through artefact metadata rather than through a platform-wide floor.