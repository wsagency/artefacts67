# 27. Optional share passwords with explicit bearer access to protected content

Date: 2026-09-22

## Status

Accepted. Records the policy shipped in `3e181c4` (`2.0.0-m6.3`). Partially supersedes the visitor-path claims in [ADR 0014](0014-crypto-tiering.md), the mandatory password and per-share-wrap rules in [ADR 0020](0020-visitor-shares-and-analytics.md), and the new-share password rules in [ADR 0026](0026-collaboration-shares-and-observations.md). Their ordinary artefact gates, password-bearing share paths, collaboration and observation rules remain in force.

[ADR 0031](0031-private-by-default-artefacts.md) additionally requires current signed-in read authority for every ordinary artefact and folder path, before any document-password gate. This decision's live visitor-share capabilities, independent share passwords and legacy exclusions remain in force.

## Context and Problem Statement

The product owner requested optional share passwords with a warning that anyone receiving the link can read the page. The former rule rejected passwordless sharing of protected content and excluded descendants protected after a folder share was created. Removing that exclusion globally would silently expand existing grants, while claiming that all visitor access remains password-derived would misrepresent the new server-decryption path.

## Decision Drivers

- A manager deliberately chooses whether a new share requires a password, independently of the ordinary artefact gate.
- Existing tokens must gain no additional access through an upgrade.
- Live containment, expiry, revocation and neutral failure responses remain authoritative.
- State the platform's use of its master key plainly, following ADR 0002 and ADR 0014.

## Considered Options

1. Keep requiring a share password for protected content.
2. Allow all passwordless shares to read protected content, including existing links.
3. Persist an explicit access choice for new passwordless shares and decrypt authorized documents in the Worker.
4. Put a decryption capability in the URL fragment and introduce a browser-side passwordless key protocol.

## Decision Outcome

Choose option 3. It satisfies the requested access choice without changing prior consent or adding a second passwordless cryptographic protocol.

### Persisted authorization and migration

Migration `0009_optional_share_passwords.sql` adds `shares.allow_protected`, constrained to 0 or 1 and defaulting to **0 for every existing row**. Only new passwordless creation writes 1. Authorization requires the value to equal 1; it is not inferred from a creation timestamp or the absence of a password. Existing passwordless links retain their exclusion of protected content; granting broader access requires creating a new link.

A new passwordless folder share includes its current and future live descendants, including protected ones. Moving a document outside that subtree removes access. Adding or rotating an ordinary artefact password does **not** close an independently authorized passwordless share; revoke that share to stop subsequent access.

### Visitor paths and the honest trust boundary

For an authorized passwordless share, possession of the bearer URL is sufficient. After resolving the token, target identity, current scope, expiry, revocation and access policy, the Worker uses the **master-key wrap to decrypt the document and serves plaintext HTML**. No password-derived visitor key or per-share content-key wrap protects this path. This explicitly replaces ADR 0014's universal visitor-path wording and ADR 0020's assertion that a passwordless share never releases protected content or introduces a server key.

Password-bearing shares retain their existing verifier and browser-side share-key/content-key unwrap chain. A missing prepared wrap fails closed; it never falls back to master-key decryption. Ordinary password-gated artefact URLs also retain their existing gate. Storage stays encrypted: the running Worker already held the ability to decrypt through its master key, but it now deliberately exercises that ability for this additional class of visitor request.

`syncShare` therefore continues deleting unnecessary wraps for passwordless shares. Both direct resolution and `contents` apply the same persisted access policy. A passwordless folder index marks its permitted children as ungated **on this share path** and uses scoped child URLs, not ordinary artefact URLs or password-gate links. Legacy exclusions, out-of-scope children and inactive links retain neutral responses rather than revealing a hidden document or its gate.

The creation form warns that the link can be forwarded and anyone holding it can read, including future folder contents. It is not publicly listed. There is no additional confirmation checkbox. Email remains an explicit action and never contains a password.

### Consequences

- Good: users can share protected material without another password while preserving the original artefact gate.
- Good: migration preserves existing grants; no old URL acquires new authority.
- Bad: a leaked or forwarded passwordless share grants immediate access. Password rotation alone is not remediation, and revocation cannot recall downloaded content.
- Bad: protected content is decrypted in the Worker on this visitor path; it must not be described as password-derived or server-blind access.
- Accepted cost: maintain two explicit passwordless access policies until older links expire or are revoked. Scope checks and legacy neutral responses must remain aligned across direct and folder access.

## Pros and Cons of the Options

### 1. Keep mandatory share passwords

- Good: preserves the former cryptographic path and policy without migration.
- Bad: contradicts the requested password-optional workflow.

### 2. Broaden all passwordless shares

- Good: requires less persistent state.
- Bad: exposes protected descendants through previously issued tokens without a new authorization decision; rejected on security grounds.

### 3. Persist new-share bearer authorization

- Good: explicit migration-safe consent, existing live-scope enforcement and no new key transport protocol.
- Bad: URL possession replaces the password barrier and the Worker serves decrypted protected content.

### 4. Deliver a key through a URL fragment

- Good: permits browser-side decryption without asking the recipient to type a password.
- Bad: adds key distribution and changing-folder key maintenance while copied URLs still confer access. It does not make the platform server-blind because the existing master-key wrap remains. Revisit only if a stronger cryptographic trust boundary is explicitly required.

## More Information

Implementation: [share authorization](../../worker/src/shares.mjs), [visitor rendering](../../worker/src/share-viewer.mjs), [migration](../../worker/migrations/0009_optional_share_passwords.sql), and [regression coverage](../../worker/test/shares.test.mjs).

Verification exercised a protected artefact through a new passwordless share, the unchanged ordinary password gate, password-bearing browser unlock, revocation, current/future protected folder descendants, moved-out content, legacy exclusions and the migration's default for an existing row. The worker suite passed 210 tests; the production health endpoint reported `2.0.0-m6.3`. Revisit this decision if password rotation must revoke all visitor capabilities or passwordless protected content must no longer be decrypted by the Worker.
