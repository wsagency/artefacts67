# 24. The console's information architecture, and the reserved public names

- **Status:** accepted (2026-09-16)
- **Date:** 2026-09-16
- **Supersedes:** — (complements ADR 0016 on public paths)

## Context

M1 shipped the platform surface under `/_admin` and `/_auth` — machine-readable namespaces that
made the multi-user rework possible, but mixed three different jobs into one screen stack: managing
one's own artefacts, managing one's own account, and running the platform. The URL prefix read as
machinery, there was no homepage (a signed-out visitor met a placeholder), and the screens grew as a
flat list of cards under one top bar. Now that the platform has real users, it needs the shape of a
product: a front door, an estate view built around the owner's folders and artefacts, and clearly
separated personal and platform settings.

## Decision

**The human surface moves to plain public paths; the machine surface keeps its `_` namespaces.**

1. **`/` is the homepage.** A signed-out visitor gets the front door (what this is, and the sign-in
   button); a signed-in user is forwarded to their estate. Unknown artefact paths still answer the
   neutral page at 200 (ADR 0016), and that page is now the same front door rather than a bare
   string.
   *Superseded in part by [ADR 0037](0037-app-root-is-sign-in.md): `/` now redirects to sign-in or
   the console, and the public landing lives outside the core.*
2. **`/app` is the artefact console** — the default after sign-in. The estate is a **tree on the
   left** (folders, each with its artefacts, badges for the gate), and the main pane shows the
   selected folder or artefact: its public paths (including retired ones), its gate, its versions,
   and the actions that belong to it (rename the path, record retired paths, set or clear the
   password, publish a new version). Publishing a new artefact starts at `/app/new`.
3. **`/settings` is personal.** Password, the second factor (TOTP and passkeys), and the account's
   API keys (`/settings/keys`) — everything that belongs to the signed-in user and to no one else.
4. **`/admin` is the platform area**, visible to the owner and admins only: the platform overview
   (counts and the recent audit trail), user management with invitations (`/admin/users`), and —
   the owner's alone, as ADR 0018 ruled — platform settings (`/admin/settings`).
5. **The auth pages are plain paths:** `/login`, `/register` (bootstrap only), `/invite/<token>`,
   `/2fa`, `/enroll`, `/logout`, and the JSON ceremonies `/passkey/begin|complete`.
6. **The first path segments the console owns are reserved forever:** `app`, `admin`, `settings`,
   `login`, `logout`, `register`, `invite`, `enroll`, `2fa`, `passkey`, `instructions`, `assets`,
   `api`, `health`. `pathTaken` (paths.mjs) answers "taken" for all of them, so no folder, artefact
   or alias can ever squat a system path — the same mechanism ADR 0016 already uses for uniqueness
   across namespaces. The `_`-prefixed names (`_api`, `_auth`, `_admin`, `_gate`, `_health`) remain
   un-mintable by construction, because the slug charset excludes `_`.
7. **Old console URLs redirect (301) and keep working:** `/_auth/login` → `/login`,
   `/_auth/accept/<token>` → `/invite/<token>` (invitation mails sent before this change must not
   die), `/_admin` → `/app`, `/_admin/users` → `/admin/users`, and so on. POSTs to the old paths
   are not redirected: every form was rendered by this same console, days old, so nothing in the
   wild posts there.
8. **The visual shell changes with the IA.** Signed-in pages are a dark sidebar (brand, section
   navigation, the estate tree, the signed-in user) with a light content pane; the public pages are
   a centred card on the same dark field. One accent colour, system typefaces, no framework — the
   zero-dependency rule is untouched.

## Alternatives considered

- **Keep `/_admin` and only reskin it.** Rejected: the prefix is not the problem — the three jobs
  in one namespace are. A reskin would have kept settings, user management and artefact work one
  click too close to each other.
- **A console subdomain** (`app.<your-domain>`). Rejected for now: it needs DNS, a second
  cookie domain story and a WebAuthn rpId decision, and buys nothing the reserved-name rule does
  not. Nothing here precludes it later.
- **No redirects, clean break.** Rejected for exactly one case: invitation links already mailed.
  Everything else would have survived, but a mailed link dying is the failure this platform exists
  to prevent.

## Consequences

- **Good:** the homepage finally exists; a member lands on their estate, the owner finds the
  platform under `/admin`, and nobody's account settings sit next to user management. The tree
  makes the estate legible at a glance, which is what the artefact screen's flat folder cards never
  did.
- **Good:** reserved names are enforced in one place (`pathTaken`), so the API, the console and any
  future surface inherit the rule without each re-checking it.
- **Accepted cost:** fourteen English words are permanently removed from the folder/artefact
  namespace. They are generic (`app`, `admin`, `settings`…), and a client folder would plausibly
  have wanted one — the redirect-from-`_` history shows why they can never be given back.
- **Rule of thumb from here:** anything a human bookmarks is a plain reserved path; anything a
  machine calls keeps its `_` namespace.
