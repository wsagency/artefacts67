# 11. Weak passwords are a deliberate, supported choice for low-stakes artefacts

Date: 2026-09-08
Status: Accepted

## Context

An artefact password was rotated to `ws` — two characters. Reviewing the incident, this was
read as a mistake and a minimum length was proposed for the admin rotate form (the write API
already rejects anything under 8 characters). The owner corrected that reading: the short
password was **intentional**, and the asymmetry between the two entry points is not a bug to
be closed by force.

The threat the gate is bought to defeat, for most artefacts, is **accidental discovery** — a
crawler, a Google result, a forwarded link opened by the wrong colleague, someone glancing at
a shared screen. It is not a motivated attacker. For an e-mail forwarding table or a set of
onboarding notes, a password the client can be told over the phone and type without a manager
is worth more than one nobody can use. A gate that annoys the intended reader into asking us
to remove it protects nothing.

Strong passwords remain the right choice where the content is genuinely sensitive. That is a
per-artefact judgement made by the person publishing it, who knows the content — it is not
something the platform can infer from the HTML.

## Decision

**Password strength is the publisher's call, per artefact. The platform does not impose a
minimum on the admin path.**

- The **admin UI** (`lib/admin.mjs`, `rotateAction`) accepts any non-empty password, including
  very short ones. This is deliberate and MUST NOT be "fixed" by adding a length check.
- The **write API** (`lib/api.mjs`, `weak-password`) keeps its 8-character floor. Agents publish
  unattended and cannot weigh stakes; a machine that has to guess should guess conservatively.
  A human who wants a weak password uses the admin form and takes responsibility for it.
- Defence-in-depth carries the weak cases and is what makes them acceptable:
  secret-link URLs (20 hex characters per token), `noindex` + `no-referrer`, the withheld blob
  (no ciphertext reaches the browser before the server verifies), and the lockout — 4 wrong
  passwords lock `(IP, artefact)` for an hour. A two-character password behind a lockout is
  still not brute-forceable at scale from one address, and the artefact URL is unguessable.

## Consequences

- The gate's promise is stated honestly: it stops people from *stumbling onto* content. It is
  not an access-control system, and a weak password does not pretend to be one.
- Publishers must judge stakes themselves. When content genuinely warrants it (bank details,
  contracts, credentials that unlock money), pick a strong password — the platform will not
  remind you.
- Reviewers and agents: a short artefact password is not a finding. The two different floors on
  the two entry points are intentional; a PR that unifies them is a regression against this ADR.
- If a *class* of artefacts ever needs enforced strength, it belongs on the artefact metadata
  (an explicit `sensitive: true` that demands a strong password), not on a global minimum.
