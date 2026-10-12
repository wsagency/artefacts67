# 26. Inherited colleague access, subtree visitor shares, and bounded observations

Date: 2026-09-19
Status: Accepted; new-share password requirements are partially superseded by [ADR 0027](0027-optional-share-passwords-and-bearer-access.md). [ADR 0031](0031-private-by-default-artefacts.md) supersedes anonymous ordinary-link access. Legacy share restrictions, explicit inherited collaboration and observation rules remain unchanged.
Extends: [12](0012-multi-user-roles.md), [19](0019-write-api-v2.md), [20](0020-visitor-shares-and-analytics.md), [25](0025-subfolders-and-moving.md)

## Context and problem

The owner requested both visitor sharing and full internal collaboration, with analytics delivered together. Ownership-only authorization cannot support colleagues, and a folder visitor share must include its changing subtree without exposing the ordinary secret links. ADR 0020 left measurement retention and events open; these choices determine durable state and privacy boundaries.

## Decision drivers

- An explicit grant, not a platform staff role, permits entry to another estate.
- Console and API must enforce the same current authority, including after revocation.
- A visitor link has its own expiry, password and revocation without changing existing links.
- Observations must not become visitor profiles or expose one estate to another.

## Considered options

1. Read-only internal links, independent artefact visitor links, unbounded raw events.
2. Copy permissions to every descendant and snapshot folder contents when shared.
3. Inherit colleague grants and resolve visitor scope live, with bounded cumulative observations.

## Decision outcome

Choose option 3. The user explicitly selected full collaboration and bundled analytics; inherited access avoids stale descendant grants, while live containment makes revocation and moves meaningful.

### Colleagues

A folder grant names an existing active platform user and one role: **viewer** reads and previews; **editor** also publishes, changes metadata, passwords and paths, and creates artefacts and subfolders; **manager** also creates/revokes visitor shares and reads detailed analytics. Grants apply to descendants; the strongest applicable grant wins. Only the resource owner changes colleague grants or moves a folder. Artefact moves require editing authority at both ends and remain within one owner's estate.

A newly created child belongs to its folder's owner; authorship records the acting user. Platform Owner/Admin status alone never grants content or visitor-detail access. Master API keys inherit their user's current access; artefact-scoped keys additionally remain constrained to one artefact and their scope. Revocation or suspension is checked on subsequent requests, not cached in a key or session. Internal viewing is an authenticated, no-store preview, not disclosure of a gate password. Its sandbox gives authored scripts an opaque origin and prevents network/form access to the console.

The console's default reading surface is `/app/a/<ref>/view`: the shared shell embeds the authenticated `/preview` endpoint in an iframe with `sandbox="allow-scripts"` and no same-origin privilege. The frame scrolls independently of the sidebar. A separate external-link action opens the same isolated preview in a new tab with no opener; the gear continues to open the management pane. Both shell and content requests check current read access.

### Visitor shares

A share is created for one artefact or one **top-level folder**, whose current descendants are included. A subfolder cannot be separately visitor-shared. New descendants enter the scope; moved-out artefacts leave it. A subsequently nested target keeps its own subtree, never gaining access to its new parent's other contents. Existing ordinary links continue to work independently and are not disclosed by a folder share's index.

The default expiry is 30 days and the maximum is 365 days. Each link is independently revocable. A gated artefact needs its share's own password; a folder share may not silently bypass a gated descendant. A passwordless folder share excludes protected artefacts introduced after creation; it must be replaced with a password-bearing share to include them. Passwords retain the console's deliberate any-nonempty-length policy. Wrapped content keys are prepared at mutation time and released only after gate verification; the browser decrypts gated content. Missing preparation fails closed. A share does not retroactively erase a document or key already downloaded.

The sender can copy a link or explicitly select email delivery; an unchecked mail control never sends. Mail excludes the password. Recipient contact data is sealed at rest and displayed only within the sharing management scope. A share records invitation usage, not proof of which human opened a forwarded link.

### Observations and retention

A successful content access issues a four-hour encrypted/authenticated measurement proof binding a share, artefact, random opening id and issue time. The browser reports cumulative active seconds and maximum scroll bucket; retries update the same opening rather than incrementing counts. A new authorized page load issues a new opening id. No event is recorded for a gate failure or folder-index view.

Each retained row contains only `visit_id`, `share_id`, `artifact_id`, server-derived `opened_at` and `updated_at`, `active_seconds` (0–14,400), and `scroll_bucket` (0/25/50/75/100). Active time counts visible, focused reading with recent activity; it is an estimate, not proof of reading. Scroll measures the deepest visible portion of the page. A proof cannot claim more dwell than elapsed server time. The endpoint rechecks the share's current expiry, revocation and containment.

No IP address, user agent, document text, typed input, password, recipient identity, referrer or cross-page visitor identifier enters observation storage. Measurements use no persistent browser storage. Aggregate queries never join recipient contact data. The UI may match share ids to its already-authorized invitation list, but the system does not build a person profile.

The platform owner sets retention from 1 to 365 days; default **90 days**. A daily scheduled deletion physically removes expired observations; reducing retention immediately prunes. Queries apply the cutoff even if a scheduled run was missed. There is no indefinite aggregate archive.

| Audience | Detail | Platform trends |
|---|---|---|
| Resource owner or granted manager | Own authorized scope, per share and per day | Only with platform Owner/Admin role |
| Granted editor/viewer | None | Only with platform Owner/Admin role |
| Platform Owner/Admin without resource access | None | Counts and daily trends only, no recipients or content |
| Visitor/share recipient | None | None |

Instrumentation is inserted before sealing for new versions. Legacy versions receive identical instrumentation only after authorized decryption/viewing, so no republish is required. Ordinary links and authenticated previews do not collect observations. This extends ADR 0020's pre-sealing decision for already-published content without weakening its gate.

The browser script is maintained as standalone source text, not serialized with `Function.toString()`: Wrangler's bundler adds helper references to function bodies that do not exist in the destination browser document.

## Consequences and alternatives

- Inherited grants and current containment centralize revocation; moving a folder remains owner-only because it changes inherited access.
- Folder shares require prepared key wraps to be maintained when their contents change; failure must not open another access path.
- Current containment determines analytics visibility after a move, rather than historical folder membership.
- Copied permissions and snapshot shares would be simpler to query but violate the expected behavior of a shared folder.
- Client-side observations can be blocked or fabricated by a holder of a valid access proof; they are product usage estimates, not security audit evidence.
- Revisit the retention policy or introduce consent controls if the deployment's legal requirements or measurement purpose changes. No additional personal fields are implied by this decision.
