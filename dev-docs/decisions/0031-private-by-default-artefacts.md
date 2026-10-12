# 31. Private-by-default artefacts with deliberate visitor shares

Date: 2026-10-06
Status: Accepted
Partially supersedes the anonymous ordinary-link access in [14](0014-crypto-tiering.md), [16](0016-public-artefact-paths.md), [17](0017-folders-and-the-folder-index.md), [26](0026-collaboration-shares-and-observations.md), and [27](0027-optional-share-passwords-and-bearer-access.md). Their storage encryption, stable identities, explicit colleague grants, independent visitor-share passwords and live share authorization remain in force.

## Context

An ordinary artefact URL previously granted anonymous reading when no artefact password was configured. Not creating a visitor share did not make the artefact private. The product owner requires artefacts to be private by default, readable by their signed-in owner, and externally accessible only through deliberately created visitor shares. The web console and public human/AI instructions must state that boundary plainly.

## Decision

- Apply private access to every existing and newly published artefact and folder index, including canonical paths, ids and retired aliases. There is no legacy-public exception or visibility setting.
- An ordinary URL requires a current active account with completed second-factor authentication and current resource read authority. Ownership grants access; existing explicit inherited colleague grants continue to grant their documented roles. Platform Owner/Admin status alone grants no access to another estate.
- Denied ordinary pages return the same neutral response as unknown paths, without titles, folder contents, viewer descriptors or document material. Knowing or guessing an ordinary URL is not authorization.
- The ordinary runtime source rechecks the same session and read authority when loading content and using existing runtime grants. Earlier anonymous ordinary grants cannot retain access after this cutover. Source inspection, HTML copying/downloads and application data share this boundary.
- An ordinary artefact password is an additional gate for an already-authorized ordinary link, never an alternative to sign-in or a visitor share. Its gate endpoint must establish current read authority before verifying a password or releasing wrapped keys. Owners and authorized colleagues retain the existing authenticated console preview without retyping artefact passwords. Clearing a password or duplicating without one never publishes public access.
- Anonymous visitors can read only through an active visitor share. Resolve current token identity, target and containment, expiry, revocation and password policy at each access. Password-bearing share key chains and the persisted `allow_protected` policy for older passwordless shares remain unchanged; do not silently broaden older grants.
- Copying an ordinary link does not create a visitor share. The console labels it as a private link and directs authorized managers to deliberate share creation. A share holder may copy the existing scoped bearer link, with the forwarding and password/expiry boundary stated explicitly.
- The public product guide and illustrative design template remain public; they contain no private estate content and grant no access to artefacts.

## Consequences

- Existing ordinary links preserve their identity but stop granting anonymous access. Send an active visitor-share link instead when external reading is intended.
- Existing visitor-share links retain their independently granted access until revoked, expired, out of scope or blocked by their existing password policy.
- No D1 migration, new visibility field, second authorization system or new sharing API is required. Existing session and resource-access checks remain authoritative.
- Revocation cannot recall source or keys already downloaded before access ended. Encryption remains server-managed protection at rest, not a claim that the Worker cannot decrypt content.
- README, domain vocabulary, console copy, public guide, AI briefing and canonical publication contract must consistently distinguish publication from granting visitor access.
