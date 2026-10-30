# Artefacts67

Publishing private-by-default versioned HTML artefacts into folders. Ordinary paths require current signed-in read authority; external readers use deliberately created visitor shares with optional independent password barriers. An artefact can be an interactive application with separate personal and shared application data. Publishing alone grants no visitor access (ADR 0031).

## Language

### Publishing

**Artefact**:
A versioned `site` document or `page` fragment published into one folder. A site is a complete HTML document; a page uses the constrained fragment grammar and checked page runtime. It owns its presentation; application data is separate from its published source. Existing and omitted publication `type` values remain `site`.
_Avoid_: document, file, asset, deliverable
**Page artefact**:
An opt-in artefact published as `type: "page"`: validated HTML/SVG/CSS fragment content with an
optional `ThemeRef` to a checked platform theme or a theme in its top-level project, composed in
the isolated page viewer. Its fragment is not a standalone complete document.
_Avoid_: site, asset, subpage

**Project theme**:
A validated presentation definition scoped to one top-level folder. Editors may define, revise,
delete, and choose its project default; Managers and Owners may also lock reader theme switching.
Fonts are captured when a definition is saved, revisions are immutable, and page reads resolve
the current revision. Nested folders inherit their top-level project's theme context. A move to
another project keeps the page's reference; if unavailable there, the destination default and
then platform `report` are used and reported as a fallback.
_Avoid_: global theme, page version

**Folder**:
The container an artefact is published into. A member may use one for a client, a project, or anything else — the platform takes no view on which (ADR 0021).
_Avoid_: client, group, directory

**Folder index**:
The page listing every artefact belonging to one folder. It is the thing a recipient is usually given, rather than a single artefact link.
_Avoid_: dashboard, landing page, home

**Agent**:
A program — normally an AI agent — that authors artefacts and publishes them through the write API. The counterpart to a human running the CLI.
_Avoid_: client, bot, integration

**Project**:
An artefact's top-level folder, seen as the owner of application data shared by every artefact anywhere in its subtree. Not a separate entity; unfiled artefacts have none (ADR 0032).
_Avoid_: workspace, app, database

**Collection**:
A named, declaratively typed set of records in a project: `records` (shared data an agent or editor maintains) or `responses` (reader submissions). Never SQL.
_Avoid_: table, model, schema, form

**Response**:
A record a reader submitted to a `responses` collection through the viewer, sealed with who, when and against which artefact version. Append-only for clients; a submitted required confirmation is an acknowledgement, not a signature.
_Avoid_: submission (for the stored record), signature, answer sheet

**Project file**:
The bytes stored for a `file` field of a record, reachable only through that record and its project; sealed per part with a per-file key, name and type sealed too (ADR 0035).
_Avoid_: asset, attachment (for the stored file), upload

**File field**:
A collection field of type `file`; its value is a descriptor `{ id, name, type, size }` (an array with `multiple`).
_Avoid_: file column, blob field

**Upload session**:
One resumable transfer of a file, with the same id as the file, open for at most 24 h and bound to its uploader.
_Avoid_: upload job, multipart upload (R2's term)

**Part**:
An 8 MiB slice of a file, the last one shorter; the unit of transfer, sealing and resume.
_Avoid_: chunk, block

### Access

**Ordinary link**:
The stable address of an artefact or folder index, including its id, friendly path and retired aliases. It requires a current active account with completed second-factor authentication and current resource read authority. Knowing or guessing the address grants no access; a visitor needs an independently authorized active share.
_Avoid_: secret link, public link, magic link

**Artefact token**:
The opaque identifier of one artefact. Permanent once minted; it identifies the resource but is not a reading credential. Friendly and retired paths resolve to the same resource under current authorization.
_Avoid_: id, slug, hash, key

**Folder token**:
The opaque identifier of one folder index. Distinct from an artefact token and never interchangeable with it; it grants no access on its own.
_Avoid_: id, slug, folder key

**API token**:
The credential an agent presents to the write API, carrying a scope. Never shortened to "token" — three unrelated kinds of token exist in this system and collapsing them has security consequences.
_Avoid_: token, key, secret, bearer

**Gate**:
An additional password barrier on an already-authorized ordinary artefact link, or the independent password barrier on a visitor share. Ordinary sign-in/read authority or a live share must be established before document keys can be released. A password alone never makes an ordinary link visitor-accessible.
_Avoid_: lock, paywall, auth

**Stumble protection**:
What a visitor-share password is bought for on a low-stakes artefact: keeping someone from
landing on content through a forwarded share, a search result or a glance at a shared screen.
Not resistance to a motivated attacker. Ordinary links are already private; this names the
additional share-password barrier rather than implying passwordless publication is public.
A short password on unimportant content can be a deliberate choice (ADR 0011); strength
is judged by whoever grants that share. It is not a substitute for current authorization.
_Avoid_: weak password, insecure password, placeholder password

**Gate page**:
What an authorized reader sees when their access path additionally requires a password. It contains no ciphertext, so the password cannot be attacked offline. Unauthorized ordinary paths disclose neither content nor a named gate.
_Avoid_: login page, splash

**Blob**:
The AES-GCM ciphertext of a protected artefact, held server-side and released to the browser only after the password verifies.
_Avoid_: payload, ciphertext, encrypted file

**Verifier**:
The PBKDF2 hash the server checks a submitted password against. Deliberately separate from the key that decrypts the blob, so the server can authorise without being able to decrypt.
_Avoid_: hash, password hash, digest

### Backend

**Owner**:
The platform's top role: user management, role assignment, and the platform-wide settings (mail
identity, version retention). The first registered account bootstraps as Owner; there can be more
than one (ADR 0012).
_Avoid_: superadmin, root, operator

**Admin**:
Platform staff below Owner: invites, suspension, role changes below Owner, and platform-wide
*metadata* (who exists, what is published, the audit log). Never another user's artefact content.
_Avoid_: superadmin, manager

**Member**:
A signed-in user who publishes and manages their own estate, and accesses another estate only through an explicit colleague grant.
_Avoid_: client, customer

**Visitor**:
A recipient who receives a deliberately created visitor-share link and needs no account.
They type that share's password when required; an ordinary artefact URL is not a visitor
credential. Shares retain live scope, expiry and revocation independently of ordinary access.
_Avoid_: user, client, customer, reader

**Share**:
One named invitation to one artefact or one top-level folder and its current subtree, with its
own URL, expiry and optional independent password. The sender names it for a person, a group
or an intended use; an email address is optional and only required for email delivery. It
creates no account. A newly created share may deliberately grant access without a password,
including to otherwise gated contents: anyone holding that share link can use it. This does
not remove the artefact's own gate or expand older shares' access. Everyone using the same
share URL contributes to its observations, not evidence of which person opened it.
For an authorized passwordless share, the Worker decrypts through its master-key wrap and
serves HTML; this visitor path is not password-derived (ADR 0027).
_Avoid_: send, invite, distribute

**Colleague grant**:
An owner's explicit permission for another platform user to access a folder and its descendants.
A viewer reads; an editor also changes and publishes; a manager also manages visitor shares and
sees their observations. The grant does not transfer ownership.
_Avoid_: invitation (creates an account), share (visitor access)

**Observation**:
An opening of an artefact through a share, together with estimated active reading time and
maximum scroll depth. It describes use of an invitation, not the identity of a reader.
_Avoid_: visitor profile, read receipt, tracking identity

**Notification**:
An automatic email triggered by a platform event rather than by a person. Never used for a share,
which is always deliberate.
_Avoid_: alert, message, email

**Console**:
The signed-in web surface, split by job: `/app` shows owned and explicitly shared folders and
artefacts, `/settings` is the account's own security and API keys, and `/admin` is platform
administration. Platform staff status does not itself grant access to another estate.
_Avoid_: admin panel (the whole console is not admin), backend

**Viewer**:
The trusted surface around an artefact. It presents the content and the actions available to the current reader without granting the artefact itself the reader's account authority.
_Avoid_: preview (a preview is one authorized use of the viewer), application shell

**Application data**:
Values a running artefact reads or changes independently of its published source. They survive source updates but are not copied by duplication or rolled back by restoring a source version.
_Avoid_: artefact content, platform state, version

**Personal application data**:
Application data belonging to one artefact and one reader identity. A signed-in reader uses their account identity; a visitor uses a browser identity. Other readers cannot access it.
_Avoid_: profile, visitor tracking, private version

**Shared application data**:
Application data belonging to the artefact rather than one reader. Current readers can read it; current editors, managers and the owner can change it. A visitor share grants no shared-data editing authority.
_Avoid_: shared document, colleague grant, public database

**Estate**:
Everything one user owns: their folders and the artefacts in them. A colleague may be granted
access to part of an estate without becoming its owner.
_Avoid_: workspace, account content

**Front door**:
`/` sends visitors to sign-in and signed-in users to `/app`, the private console. The
documentation for people and agents is at `/instructions`. The public landing is the operator's
own website, outside the core (ADR 0037).
Unknown and unauthorized ordinary artefact paths answer the same neutral landing at 200
(ADRs 0016, 0031), revealing no private title, listing or document. They are not a public catalogue.
_Avoid_: public artefact index, 404 page

**Design template**:
An optional per-deployment design template URL (`DESIGN_TEMPLATE_URL`). The documentation and
`/llms.txt` name it only when it is set. Agents use it only when no user/client design is
specified, replacing illustrative facts and diagram descriptions with task-specific evidence.
It is a sample, not a visitor share or an exception to private artefact access.
_Avoid_: mandatory brand, public estate template

**Subfolder**:
A folder nested inside another of the same owner's folders. Nesting determines inherited
colleague access and folder-share scope, but every folder keeps its own flat ordinary path.
Moving a folder changes containment without changing its handed-out path.
_Avoid_: nested path, directory tree (paths are flat)

### Platform

**Publish**:
One write through the API that is live when the request returns: the sealed object in R2 and the
version row in D1 both land inside it. Publication stays private; it does not create a visitor
share or grant anonymous reading. There is no publish record to poll (ADRs 0015, 0031).
_Avoid_: upload, submission, deployment

**Duplicate**:
Create a new private artefact from source the caller may read, in a destination the caller may write. Identity, additional gate choice and access are independent; shares, grants, API keys and application data are not copied. Choosing no document password does not grant visitor access.
_Avoid_: alias, move, restore

**Restore**:
Publish a retained source version as a new current version. History is not rewound, and application data is not rolled back.
_Avoid_: rollback (which could imply application data or history is rewound)

**Delete**:
Withdraw an artefact and remove its content and application data. Its paths remain reserved as tombstones rather than becoming available for another artefact. Only its owner deletes a folder, together with everything in it (subfolders, artefacts, project data), after typing its name; its visitor shares are revoked, its paths stay reserved the same way, and the daily cleanup removes the bytes (ADR 0038).
_Avoid_: rename, revoke share, unpublish

**State**:
The platform's rows in D1 — users, API keys, sessions, folders, artefacts and their versions,
retired paths, audit. Small, queryable, and never artefact bytes: content lives in R2 (ADR 0013).
_Avoid_: database, db, runtime store

**Secret store**:
The AES-256-GCM-sealed rows inside D1 — artefact passwords' verifiers, the wrapped content keys,
the users' TOTP secrets. Sealed under the master key; entry ids are not secret (ADR 0014).
_Avoid_: vault, keystore, password store

**Master key**:
The 32-byte key from `ARTEFACTS_MASTER_KEY` that seals the metadata tier and wraps every artefact's
content key. Together with D1 and R2 it is the platform's trust boundary — whoever holds it holds
every password (ADR 0014).
_Avoid_: encryption key, passphrase

**Reveal**:
The deliberate, audit-logged act of showing one artefact's stored password to its owner. Never
available to any API scope (ADR 0015).
_Avoid_: decrypt, show password

**Rotate**:
Replacing an artefact's additional password while its private ordinary link stays the same:
one wrapped key is re-sealed, the document is never re-encrypted (ADR 0014). Ordinary access
still requires current authorized sign-in. Revoke a leaked visitor share separately; document
password rotation does not close an independently authorized passwordless share (ADR 0027).
_Avoid_: reset, re-mint

**Dry-run**:
Mail mode when `SMTP_HOST` is unset: the message is rendered and recorded but never sent.
_Avoid_: test mode, mock

**Passkey**:
A WebAuthn credential a user enrolls; multiple named passkeys may exist per user. A discoverable,
user-verified passkey is a complete **passkey sign-in** on its own (both factors: the device plus
its PIN/biometric); any passkey also serves as the second login factor after the password. TOTP
remains the mandatory recovery factor (ADRs 0010, 0012, 0034).
_Avoid_: passwordless (say passkey sign-in), MFA (say second factor)
