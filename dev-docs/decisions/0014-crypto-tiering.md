# 14. Crypto tiering: end-to-end artefact content, encrypted-at-rest metadata

Date: 2026-09-14
Status: Accepted; the visitor-path guarantee is partially superseded by [ADR 0027](0027-optional-share-passwords-and-bearer-access.md) for explicitly authorized passwordless shares. [ADR 0031](0031-private-by-default-artefacts.md) additionally requires current signed-in read authority on ordinary paths, before their optional document-password gate. The cryptographic wrapping rules remain in force.
Carries forward: [11](0011-weak-passwords-are-a-valid-choice.md) (weak artefact passwords are
valid); refines [2](0002-runtime-secret-store.md) (secret store)

## Context

Two product rulings fix the crypto: every artefact must be encrypted on the server — content,
settings, nothing plaintext in the database — and a short artefact password must actually
**decrypt** the artefact (ADR 11 stands: `ws`-class passwords are valid). Owners must still be
able to preview their own artefacts without retyping each password.

## Decision

**Two tiers.**

1. **Artefact content — end-to-end from the storage layer.** Each version is sealed with a
   random 256-bit content key (AES-256-GCM) in R2. The content key is wrapped twice, both
   wraps stored in D1:
   - under a **PBKDF2 key derived from the artefact password** (100k iterations — see the
     amendment) — the visitor
     path. After the gate verifies (a separate PBKDF2 *verifier*, distinct salt), the browser
     receives the wrapped key, derives, unwraps, decrypts. A short password genuinely
     decrypts; no server-held key sits on that path;
   - under the **platform master key** (`ARTEFACTS_MASTER_KEY`, a Worker secret) — the owner
     path: preview, export, and password rotation (re-wrap only; content untouched).
2. **Metadata and user settings — encrypted at rest.** Titles, sealed secrets (artefact
   passwords, TOTP, wrapped bundles), and per-user settings are AES-GCM rows under the
   platform master key. A D1/R2 dump alone is inert.

**Stated honestly:** the running Worker holds the master key and can decrypt anything.
Encryption protects storage at rest and the visitor path — not against the platform itself.
That trust boundary is unchanged from 1.x and is deliberate: full server-blindness would break
owner preview, listing, and rotation.

Gate mechanics carry forward: server verifies, ciphertext withheld until auth, 4 wrong
passwords lock `(IP, artefact)` for an hour — the counter moves to the Durable Object
(ADR 13), because per-isolate memory would make lockouts cosmetic across Cloudflare's colos.

## Consequences

- **Good:** every artefact encrypted becomes structural, not a build step — there is no plain
  artefact class anymore.
- **Good:** password rotation re-wraps one small key bundle; multi-megabyte content is never
  re-encrypted.
- **Accepted cost:** a forgotten artefact password is recoverable only via the master-key wrap
  (admin reveal/rotate semantics, ADR 2).
- **Rejected:** encrypting settings under a password-derived key — it would break server-side
  session and lookup paths for no real threat reduction.

## Amendment (2026-09-15): the cost is 100k, not 600k

Both PBKDF2 uses this ADR names — the gate verifier and the password-derived KEK that wraps a
content key — are set to **100,000 iterations**, not 1.x's 600,000. Production workerd rejects
anything above its cap outright (`PBKDF2: iteration counts above 100000 are not supported
(requested 600000)`); the first owner registration on the deployed host 500'd on exactly that,
while `wrangler dev` enforced no cap and so the whole local suite passed. The decision itself is
unchanged — the same two derivations, the same distinct salts, the same "the verifier is stored
openly, the KEK is never stored" split — only the cost parameter moved, and it is one constant
(`PBKDF2_ITER` in `worker/src/crypto.mjs`). Every stored row carries its own `viter`/`iter`
(verifier rows and password-key wraps respectively), so a row written at 600k still verifies and
still unwraps; the cap applies to new derivations only, and the production database was empty
when this landed. The honest trade: 100k iterations of PBKDF2-SHA256 is a weaker stretch against
an attacker who holds a stolen wrap than 600k would be, and it is the strongest cost this runtime
allows without moving the visitor path onto a different KDF.
