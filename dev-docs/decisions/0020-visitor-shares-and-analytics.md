# 20. Visitor access: per-artefact shares, expiry, and content-blind analytics

Date: 2026-09-14
Status: Accepted; mandatory share passwords and the no-server-key guarantee are partially superseded by [ADR 0027](0027-optional-share-passwords-and-bearer-access.md) for new passwordless shares. Existing links do not gain access.
Carries forward: [14](0014-crypto-tiering.md) (the visitor path), [16](0016-public-artefact-paths.md)
(paths), [17](0017-folders-and-the-folder-index.md) (folders), [7](0007-share-and-notification-semantics.md)
(share is a deliberate act, password excluded by default)

## Context

Platform invitations (ADR 0012) create *users* — colleagues who log in. The people an artefact is
actually published for are **visitors**: they never hold an account, they receive a link, and the
product now wants to know something about those visits — how many, how long, how far down the page
someone read. A single secret link per artefact cannot answer that: every visit looks identical.
The ruling is to invite visitors the way folders are shared — a link per person — and to make
shares the unit that analytics are attributed to.

## Decision

- **A share is one invitation to one artefact for one recipient.** It carries its own URL, its own
  expiration (**default 30 days**), its own audit trail, and — when the artefact is gated — its own
  password. One artefact therefore has many shares, and revoking or expiring one touches nothing
  else. The secret link itself keeps working exactly as today; a share is an additional, narrower
  door.
- **A share's URL is a prefixed path under the artefact** (`/<artefact path>/s/<shareToken>/`),
  because the artefact's own path must never move (ADR 0016) and the prefix makes a share
  recognisable in the address bar and in logs. Ungated artefacts are shared this way too: without a
  distinct path there is nothing to attribute a visit to.
- **The gate becomes share-aware.** ADR 0014's content key stays per artefact; each share adds one
  more wrap of that key under a KEK derived from *its* password, and `POST /_gate/<share path>`
  releases the wrap belonging to that share. A share without a password releases nothing that
  requires one: the visitor path stays end-to-end, and no server key is introduced.
- **Analytics are attributed to the share, never to the person.** The platform records *what
  happened to a document* — open, dwell time, scroll-depth buckets — against the share id and the
  artefact. It never records document text, and it never joins a share to a named human: the
  recipient list exists so the sender can see *who was invited* and *whether that invite was used*,
  not to build a profile.
- **Privacy is scoped by ownership, not by curiosity.** A user sees analytics for their own
  artefacts and folders; an Admin sees the platform's shape, never another user's visitor detail;
  a share's recipient sees nothing but the document. This is ADR 0014's trust boundary applied to
  measurement: the platform holds the data, so the platform decides who may look.
- **The measurement instrumentation is part of sealing, not of serving.** A gated artefact is
  decrypted in the browser, so a beacon cannot be injected at serve time; it is injected *before
  the document is sealed*, as inline JS posting to a same-origin `/_ev` endpoint. That keeps the
  document self-contained (no external reference, ADR 0009) and makes the beacon fail silently
  when offline.

## Consequences

- **Good:** the invite list, the per-share password and the share-level expiry fall out of one
  record, and analytics get an honest key to attribute visits to.
- **Good:** an expired share is a real revocation (the link stops resolving), which 1.x could not
  do — its only remedy was rotating the artefact password, which broke every recipient at once.
- **Accepted cost:** a gated artefact's ciphertext can no longer be lifted for a share by copying
  one row — password rotation now touches one wrap per share, which is why the content key is
  wrapped per share rather than the content re-encrypted.
- **Open — decides the shape of the analytics tables, not this ADR's ruling:** what exactly is
  recorded (event set, dwell buckets, scroll buckets), how long it is kept, and whether the
  recipient's own view shows "your invite was opened" — the last is a product call with a privacy
  edge, and it is the one place a share could leak back to a person.