// GENERATED FILE — worker/scripts/sync-contract.ts wrote this from
// dev-docs/artefact-contract.md. Do not edit by hand: change the markdown, then re-run the
// script. A Worker cannot read files at runtime, so the contract markdown travels inlined as
// CONTRACT_MD.

/** The agent-facing contract, byte-identical to dev-docs/artefact-contract.md. */
export const CONTRACT_MD = `# Artefact contract (for agents)

This is the canonical contract for artefacts published through the Artefacts67 write API. It
is served publicly at \`GET /_api/contract\` and enforced by the publish validator: every ERROR
rule below rejects a publish; WARNING rules pass through and are reported in the API response.

## 1. Document requirements

An artefact is **one HTML document**, with its presentation and optional application data kept separate:

- A complete HTML document: begins with \`<!doctype html>\`, exactly one root \`<html>\` element.
- **All JavaScript inline** (\`<script>\`). CSS is inline (\`<style>\`), apart from the supported
  font declarations captured below. Images are inline SVG or \`data:\` URIs.
- **No external network references at view time** — no CDN scripts, arbitrary remote stylesheets,
  remote images or direct API fetches. Supported remote font declarations are captured at publish
  time and embedded in the stored document; they do not cause requests to the font provider when viewed.
- The document's presentation is self-contained. Optional persistent application data uses the
  platform SDK (§7), not direct network access or browser storage.
- Internal fragment links (\`href="#section"\`) navigate inside the hosted document, preserving
  running JavaScript and form state. Native \`hashchange\` behavior remains available; these links
  do not load the console URL inside the isolated frame.
- \`<head>\` stays minimal: \`charset\`, \`viewport\`, \`title\`, \`<meta name="color-scheme" content="light dark">\`
  unless the design is explicitly single-scheme (§6 Light and dark), plus supported font declarations.
  Do NOT add your own \`robots\`, \`favicon\`, or other platform boilerplate. The robots meta tag
  and favicon belong to the viewer page; nothing is injected into the authored document's
  \`<head>\`. The one-\`</head>\` requirement describes a complete, unambiguous document.
- The only permitted absolute paths are \`/assets/favicon.ico\` and \`/assets/ws-logo.svg\`
  (platform-provided; a deployment that does not ship \`/assets/ws-logo.svg\` answers 404 for it).
  No other absolute paths.
- **No cross-linking between artefacts.** Ordinary artefact URLs are private addresses, not
  bearer capabilities; one artefact must never embed or reference another artefact's URL.
- \`slug\` (with \`folder\`, the artefact identity in the API — §4) is a lowercase path segment,
  1–63 characters: \`^[a-z0-9][a-z0-9-]{0,62}$\` (plain kebab-case is the house style).
- \`lang\` is a **BCP-47 language tag**; the default is \`en\`. Client-facing artefacts are
  typically \`hr\` (house style, matching existing client artefacts — ADR 0009), while \`en\`
  marks internal and explained artefacts.
- Authored HTML source (complete document for \`site\`, fragment for \`page\`) ≤ 1,500,000 JavaScript
  string characters. A composed page document is also capped at 1,500,000 characters.

The platform adds its own isolated execution and observation support. Share observations are
relayed through the trusted viewer to the same-origin \`/_ev\` endpoint; ordinary links and
authenticated previews are not observed. This support is not permission for authored HTML to
make network requests. Version size and content hashes describe the authored bytes, not the
captured fonts or platform support.

### Font capture at publication

The API and console accept these publication-time declarations:

- A stylesheet \`<link>\` to \`https://fonts.googleapis.com/css\` or \`/css2\`.
- A CSS \`@import\` from those endpoints, optionally with a media query. \`layer()\` and
  \`supports()\` import qualifiers are not supported.
- An \`@font-face\` \`src\` URL or \`<link rel="preload" as="font">\` URL under
  \`https://fonts.gstatic.com/s/\`.

Google Fonts \`preconnect\` and \`dns-prefetch\` links are removed after capture. Arbitrary font
hosts, nested provider imports, non-font provider styles, credentials in URLs and redirects
outside the approved provider paths are rejected. This is font ingestion, not a network proxy.

\`\`\`html
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&amp;display=swap">
<style>
  h1 { font-family: "Fredoka", system-ui, sans-serif; }
</style>
\`\`\`

The publisher verifies the response type and font signature, downloads WOFF2, WOFF, TTF or OTF
bytes, and replaces the remote declarations with embedded CSS/data URLs. Captured bytes are
sealed with the document. Existing embedded fonts do not cause another provider request.
The published document does not contact Google Fonts when a visitor opens it.

| Capture limit | Maximum |
|---|---|
| Distinct provider stylesheets / font files | 8 / 32 |
| One stylesheet / one font file | 256 KiB / 2 MiB |
| Combined downloaded bytes | 8 MiB |
| Expanded stored HTML | 12 MiB |
| One resource / whole capture | 10 seconds / 30 seconds |
| Redirects per resource | 3 |

Capture failure rejects publication; it does not silently publish fallback typography.
The API returns \`validation\` with an HTML-field detail such as \`font-provider\`, \`font-fetch\`,
\`font-format\`, \`font-css\`, \`font-limit\` or \`font-timeout\`. The ordinary authored-document and
HTTP request limits still apply before expansion. Keep the authored source when editing;
an expanded download can exceed those input limits, while in-platform duplication and restore
work directly with retained stored content.

## 2. Execution and password gates

Publication is **private immediately**, including passwordless documents and historical aliases.
Ordinary artefact and folder URLs require a current active account session with completed
second factor and current resource read authority. Neither knowing the URL nor supplying a
document password grants access; platform staff have no blanket content-reading authority.
Unknown and unauthorized ordinary pages disclose no title, listing, ciphertext, or bootstrap
and use the same neutral response. Explicitly granted colleagues retain their current authority.

Anonymous content access is available **only through a deliberately created active visitor share**,
subject to its live scope, expiry, revocation, and independent password policy. Password-bearing
share cryptography and legacy passwordless exclusions of protected content remain applicable.
Creating no shares, removing a document password, or duplicating without one never makes an
artefact public. Owner/authorized console preview remains available without retyping the
ordinary document password; that password is additional protection on an authorized ordinary link.

Every artefact runs as a complete document in an opaque sandboxed iframe. The viewer's controls,
account session and styles remain outside it. Authored CSS cannot style the viewer, and authored
scripts cannot access its DOM, cookies or storage. \`localStorage\`, \`sessionStorage\` and direct
network access are not the application persistence interface; use the SDK in §7.

All artefact viewers, including authenticated previews, can inspect and copy the published HTML. Code view,
Copy HTML and Download HTML use the captured document, without the injected runtime bridge.
Switching between Preview and Code keeps the running iframe alive. Password gates and
live access checks also govern opening the code view and copying source.
The shared toolbar keeps compact Preview/Code, Share, Download, and Fullscreen controls and, for
opted-in artefacts, the light/dark switch (§6) visible,
including on narrow screens; grouped actions remain in the title menu. Share distinguishes the
private ordinary address from scoped visitor links and does not itself grant access.
Visitor-share management, version history, rename and deletion require resource permissions.
Claude's chat, comments, pinning and Markdown conversion are not platform capabilities.

For an ordinary gated link, the server first requires the current authorized account session,
then accepts the additional document password before releasing decryption material. A password
alone never works. The browser loads decrypted HTML as a fresh iframe document; inline scripts
can run at parse time or use normal \`DOMContentLoaded\` and \`load\` events.

- Passwords must be **≥ 8 characters**. A document password is an additional gate, not a
  replacement for account authority or a visitor share. A master key with current editing
  authority may deliberately opt out per request (\`allow_weak_password\`, §4); a scoped key never may.
- The server seals a gated artefact at publish time; neither the plaintext document nor the
  password is ever stored (ADR 0014).

## 3. Validator findings

**ERROR — publish rejected:**

| Code | Meaning |
|---|---|
| \`not-utf8\` | The document is not valid UTF-8 (contains U+FFFD replacement characters). |
| \`incomplete-document\` | Missing \`<!doctype html>\` or not a complete \`<html>\` document. |
| \`external-reference\` | Unsupported external reference; supported font declarations are the only publish-time exception. |
| \`too-large\` | Authored HTML source exceeds 1,500,000 characters (≈ 1.5 MiB); HTTP request-body overflow remains top-level \`too-large\` (413). |
| \`composed-too-large\` | Page shell, kit, CSP, compiled theme and fragment together exceed 1,500,000 characters; returned as a \`validation\` detail issue on \`html\` (422). |
| \`invalid-payload\` | The request body is not a JSON object. |
| \`missing-html\` | \`html\` is absent, not a string, or empty (in rotate: an empty \`html\` string). |
| \`invalid-html\` | Rotate only: \`html\` is present but not a string. |
| \`invalid-title\` | \`title\` is absent, not a string, empty, or longer than 200 characters. |
| \`invalid-slug\` | \`folder\` or \`slug\` is not a valid path segment (\`^[a-z0-9][a-z0-9-]{0,62}$\`); the finding's \`field\` says which. |
| \`invalid-folder-name\` | \`folderName\` is not a string or is longer than 120 characters. |
| \`invalid-lang\` | \`lang\` is not a BCP-47 language tag (\`en\`, \`hr\`, \`en-US\`…; \`null\` defaults to \`en\`). |
| \`invalid-password\` | Rotate: \`password\` is neither omitted, \`null\`, nor a string of ≥ 8 characters. |
| \`weak-password\` | Publish: \`password\` is provided but is not a string or is under 8 characters. |
| \`invalid-note\` | \`note\` is not a string or is longer than 200 characters. |

**WARNING — publish proceeds, reported in the response:**

| Code | Meaning |
|---|---|
| \`template-braces\` | \`{{…}}\` sequences found — an unrendered template was probably left in. |
| \`multiple-head\` | More than one \`</head>\`; the authored document's head boundary is ambiguous. |

## 4. Write API

Everything lives under \`/_api\`, JSON in and out. Authentication is
\`Authorization: Bearer <key>\` — a master key or a scoped artifact key (§5). JSON request
bodies are capped at **2 MiB** (beyond that: \`413 too-large\`); a file part is raw bytes of exactly
its part size (§8 Files).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| \`POST\` | \`/_api/artifacts\` | master, or artifact key with \`write\` | upsert + synchronous publish → \`200\`/\`201\`; optional \`ifVersion\` guards updates |
| \`GET\` | \`/_api/artifacts\` | master, or artifact key with \`read\` | list currently readable artefacts (an artifact key lists only its one) |
| \`GET\` | \`/_api/artifacts/<ref>/content\` | master, or artifact key with \`read\` and \`can_read_content\` | explicitly authorized content read; optional \`?version=\` selects a retained version |
| \`GET\` | \`/_api/folders\` | master | list owned and explicitly shared readable folders |
| \`POST\` | \`/_api/artifacts/rotate\` | master, or artifact key with \`write\` | set/clear the password gate, optionally a new version; \`ifVersion\` applies with \`html\` |
| \`POST\` | \`/_api/artifacts/alias\` | master, or artifact key with \`write\` | record retired paths on one artefact |
| \`POST\` | \`/_api/folders/alias\` | master | record retired paths on one folder |
| \`POST\` | \`/_api/keys\` | master | mint an artifact key bound to one artefact |
| \`GET\` | \`/_api/keys\` | master | list keys (prefix only, never the hash) |
| \`DELETE\` | \`/_api/keys/<id>\` | master | revoke a key (the audit trail survives) |
| \`POST\` | \`/_api/keys/rotate\` | master | rotate a key (new plaintext returned once) |
| \`GET\` | \`/_api/projects/<folder>/collections\` | master (\`read\`) | list a project's collections (§8) |
| \`PUT\`, \`DELETE\` | \`/_api/projects/<folder>/collections/<name>\` | master (\`write\`; deleting a \`responses\` collection needs \`manage\`) | define or replace / delete a collection and all its records (§8) |
| \`GET\`, \`POST\` | \`/_api/projects/<folder>/collections/<name>/records\` | master (\`read\`, or \`manage\` for responses; \`POST\` \`write\`, records only) | list / create records (§8) |
| \`GET\`, \`PUT\`, \`DELETE\` | \`/_api/projects/<folder>/collections/<name>/records/<id>\` | master (as above; \`PUT\` records only) | read / replace / delete one record (§8) |
| \`POST\` | \`/_api/projects/<folder>/collections/<name>/uploads\` | master (\`write\`, records only) | start or resume a file upload (§8 Files) |
| \`GET\`, \`DELETE\` | \`/_api/projects/<folder>/collections/<name>/uploads/<id>\` | master (\`write\`, records only) | upload state / cancel (§8 Files) |
| \`PUT\` | \`/_api/projects/<folder>/collections/<name>/uploads/<id>/parts/<n>\` | master (\`write\`, records only) | send one raw part (§8 Files) |
| \`POST\` | \`/_api/projects/<folder>/collections/<name>/uploads/<id>/complete\` | master (\`write\`, records only) | finish an upload (§8 Files) |
| \`GET\` | \`/_api/projects/<folder>/collections/<name>/files/<fileId>\` | master (\`read\`, or \`manage\` for responses) | attached file metadata (§8 Files) |
| \`GET\` | \`/_api/projects/<folder>/collections/<name>/records/<id>/files/<fileId>\` | master (\`read\`, or \`manage\` for responses) | download file bytes (§8 Files) |
| \`POST\` | \`/_mcp\` | master, or artifact key authorized for \`get_artifact\` | MCP over Streamable HTTP (§8) |
| \`GET\` | \`/_api/contract\` | public | this document |

**Publish** — \`POST /_api/artifacts\`, JSON body:

\`\`\`json
{
  "folder": "jadran",
  "folderName": "Jadran",
  "slug": "upute-za-pristup",
  "title": "Upute za pristup",
  "lang": "hr",
  "html": "<!doctype html><html lang=\\"hr\\">…</html>",
  "password": "optional-strong-password",
  "note": "optional version note",
  "ifVersion": 5
}
\`\`\`

\`ifVersion\` is optional and must be a positive integer. On an update, the write succeeds only
if the current version matches; otherwise the API returns \`409 conflict\` with \`currentVersion\`
and leaves the current version unchanged. A conditional publish cannot create a new artefact
(it returns \`409 conflict\`, \`currentVersion: 0\`). Omitting \`ifVersion\` preserves the existing
unconditional publish behavior.

- Upsert: the identity key is \`(folder, slug)\`. Re-posting the same pair **updates** the
  artefact — a new version under the same private ordinary address.
- An unknown \`folder\` slug is created on first publish (\`folderName\` is its optional display
  name). A new folder belongs to the acting user. Publishing into an existing folder requires
  current editing authority; a new artefact belongs to that folder's owner, with the acting user
  recorded as its author. A folder may represent a client, a project or another container.
- \`allow_weak_password: true\` (optional, master key only) accepts a password below the floor
  for that one write: a master key with editing authority may deliberately publish a weak
  password, matching the interactive console's exemption (ADRs 0011, 0023 and 0026).
  A scoped artifact key that sends it gets \`403 forbidden\`, and a
  request that omits it keeps the floor unchanged. The write's audit row records
  \`weakPassword: true\` whenever the opt-in let a below-floor password through.
- Publishing is **synchronous**: the new version is written and live before the response
  returns — \`201 Created\` for a new artefact, \`200 OK\` for an update. There is no publish
  job and nothing to poll. Do not probe the ordinary URL to check liveness: unknown and
  unauthorized ordinary paths serve the same neutral page at HTTP 200, without disclosing
  metadata or content — trust the API response. Returned URLs require authorized sign-in.
- Response: \`{ "artifact": { "id", "slug", "lang", "path", "url", "gated", "version",
  "folder": { "id", "slug", "path", "indexUrl" } }, "warnings": [ …the validator's WARNING
  findings (§3)… ] }\` — \`warnings\` is always present, possibly empty. The JSON spelling is
  \`artifact\` (the schema spelling); the metadata never includes content or a password.


Ordinary \`site\` publishes remain complete-document writes and are unchanged. M2 \`page\` artefacts
are opt-in; existing and omitted \`type\` values remain \`site\`, with the established source bytes
and analytics instrumentation.

### Page artefacts

Page artefacts use \`type: "page"\` in \`POST /_api/artifacts\`. Existing and omitted \`type\` values
remain \`site\`.
Page HTML is a fragment, not a complete document: it supplies body content, so do not include a
doctype or document roots.

The 1,500,000-character authored-source limit applies before composition. Publication also checks
the complete hosted document produced from the page fragment against the same JavaScript string
length limit, including the platform shell, runtime bridge, kit/runtime, CSP and every selectable
M2 platform theme plus a compiled theme override. If composition would exceed the cap, publish
returns HTTP 422 with top-level \`validation\` and a detail issue \`{ "code": "composed-too-large",
"field": "html", "message": "…" }\`. The hosted viewer applies the same exact bridge-inclusive
guard before creating its document; standalone downloads apply the cap to the bridge-free
document. The HTTP JSON request-body cap remains 2 MiB and continues to answer top-level
\`too-large\` with HTTP 413 (§4).
Page grammar permits only these semantic HTML elements: \`body\`, \`header\`, \`footer\`, \`main\`, \`nav\`,
\`section\`, \`article\`, \`aside\`, \`h1\`–\`h6\`, \`p\`, \`span\`, \`strong\`, \`em\`, \`b\`, \`i\`, \`small\`, \`mark\`,
\`del\`, \`ins\`, \`sub\`, \`sup\`, \`br\`, \`hr\`, \`div\`, \`ul\`, \`ol\`, \`li\`, \`dl\`, \`dt\`, \`dd\`, \`figure\`,
\`figcaption\`, \`img\`, \`blockquote\`, \`q\`, \`cite\`, \`time\`, \`abbr\`, \`code\`, \`pre\`, \`kbd\`, \`samp\`,
\`var\`, \`table\`, \`caption\`, \`colgroup\`, \`col\`, \`thead\`, \`tbody\`, \`tfoot\`, \`tr\`, \`th\`, \`td\`, \`a\`,
\`button\`, \`label\`, \`input\`, \`select\`, \`option\`, \`optgroup\`, \`fieldset\`, \`legend\`, \`details\`,
\`summary\`, \`progress\`, \`output\`, and \`meter\`; static scriptless SVG elements: \`svg\`, \`g\`, \`path\`,
\`circle\`, \`rect\`, \`line\`, \`polyline\`, \`polygon\`, \`ellipse\`, \`text\`, \`title\`, \`desc\`, \`defs\`, and
\`marker\`. Its P1 kit components are \`a67-toc\`, \`a67-kpi\`, \`a67-chart\`, \`a67-tabs\`, \`a67-form\`,
\`a67-checklist\`, \`a67-logo\`, and \`a67-records\`; \`a67-custom\` is deferred.
Page attributes are allowlisted per element; these lists are exhaustive. Common attributes, only
where meaningful: \`id\`, \`lang\`, \`dir\`, \`role\`, \`tabindex\`, \`title\`, \`hidden\`; \`open\` is only for
\`details\`.

| Element(s) | Allowed attributes |
|---|---|
| \`a\` | \`href\` only for same-document fragments |
| \`img\` | Required \`src\` only as strict-base64 \`data:image/{png,jpeg,webp,gif,avif};base64,…\` with matching MIME/signature and decoded bytes ≤1 MiB; required \`alt\`; positive-integer intrinsic \`width\` and \`height\`; optional \`loading="lazy"\` and \`decoding="async"\` only |
| \`button\` | \`type="button"\` only; \`disabled\`; a valid accessible label may use \`aria-label\`; cannot submit or navigate |
| \`input\` | \`name\`, \`value\`, \`type\`, \`min\`, \`max\`, \`step\`, \`required\`, \`disabled\`, \`checked\`, \`placeholder\`, \`autocomplete\`, \`maxlength\`, \`minlength\`, \`pattern\`, \`accept\`; only where valid for generated/native controls |
| \`select\`, \`option\`, \`optgroup\` | \`name\`, \`value\`, \`required\`, \`disabled\`, \`selected\`, \`multiple\`, \`label\` where applicable |
| \`label\` | \`for\` |
| \`fieldset\`, \`legend\` | Common, ARIA, registered data/style attributes; supported native semantics only |
| \`table\`, \`colgroup\`, \`col\` | \`span\` where valid |
| \`th\`, \`td\` | \`scope\`, \`colspan\`, \`rowspan\`, \`headers\`; \`aria-sort\` only on sortable \`th\` |
| \`a67-toc\` | \`label\` |
| \`a67-kpi\` | \`label\`, \`value\`, \`delta\`, \`trend\`, \`data-style\`; record binding adds \`collection\`, \`field\`, \`aggregate\` |
| \`a67-chart\` | \`id\`, \`for\`, \`type\`, \`title\`, \`label-column\`, \`value-column\` |
| \`a67-tabs\` | No component attributes; child tab/panel uses the ARIA attributes below |
| \`a67-form\` | \`collection\`, \`submit-label\`; direct field descriptors use \`data-field\`, \`label\` |
| \`a67-checklist\` | \`storage-key\`, \`storage-scope\`; direct items use \`data-item\` |
| \`a67-logo\` | \`label\` |
| \`a67-records\` | \`id\`, \`collection\`, \`fields\`, \`sort\`, boolean \`editable\`, accessible \`label\` |
| SVG root | \`viewBox\`, \`width\`, \`height\`, fixed \`xmlns\` only |
| SVG shapes/text | \`d\`, \`fill\`, \`stroke\`, \`stroke-width\`, \`stroke-linecap\`, \`stroke-linejoin\`, \`cx\`, \`cy\`, \`r\`, \`x\`, \`y\`, \`x1\`, \`x2\`, \`y1\`, \`y2\`, \`points\`, \`font-size\`, \`text-anchor\`, \`marker-end\`, \`refX\`, \`refY\`, \`markerWidth\`, \`markerHeight\`, \`orient\` — \`fill\`/\`stroke\` values are only \`none\`, \`currentColor\`, or \`var(--a67-<registered colour token>)\`; literal colours are rejected. \`stop-color\` is not an allowed attribute. |

Authoring excludes the \`class\` attribute, \`<script>\` and \`<style>\` elements, authored \`<form>\` and
\`<textarea>\` elements, \`on*\` event attributes, and external resources. Fragment-only links stay
within the document.

\`textarea\` and authored \`form\` are not allowed; \`textarea\` may be generated for a schema field.
Allowed ARIA names are \`aria-label\`, \`aria-labelledby\`, \`aria-describedby\`, \`aria-controls\`,
\`aria-selected\`, \`aria-sort\`, \`aria-live\`, and \`aria-current\`; target role/element semantics and
all ID references must be valid. \`aria-label\`/\`aria-labelledby\` require native naming semantics or
an explicit role. Unknown attributes and unrecognized \`data-*\` names are rejected.

The accepted \`data-*\` vocabulary is: \`data-variant\` = \`hero|band|split|feature|grid|full-bleed|timeline|steps\`;
\`data-tone\` = \`accent|muted|inverse|info|ok|warn|crit\`; inverse may not be nested within another inverse region or applied on/inside \`table\`, \`thead\`, \`th\`, \`pre\`, or \`code\`; \`data-style\` = registered \`aurora|glow\`;
\`data-severity\` = \`ok|warn|crit\`; \`data-trend\` = \`up|down\`; \`data-status\` = \`ok|info|warn|crit\`;
\`data-role\` = \`eyebrow\`; \`data-layout\` = \`hero|hero-copy|hero-metrics|kpis\`; \`data-scroll\` = \`table\`;
\`data-badge\` and \`data-finding\` are boolean-presence flags; \`data-item\` is a unique 1–64 ASCII
letter/digit/\`_\`/\`-\` key; \`data-field\` must match the selected collection schema. \`data-kpi-value\`,
\`data-kpi-label\`, \`data-kpi-delta\`, \`data-mark\`, and \`data-value\` are reserved for kit output.

Inline \`style\` is the only object override. It accepts declarations of exactly one registered
custom property per declaration, \`--a67-<token>: <value>\`, with a lowercase token name from these
sets:

| Token class | Exact names |
|---|---|
| Color | \`bg\`, \`surface\`, \`ink\`, \`muted\`, \`line\`, \`accent\`, \`accent-ink\`, \`on-accent\`, \`ok\`, \`warn\`, \`crit\`, \`focus\`, \`c1\`, \`c2\`, \`c3\`, \`c4\`, \`c5\`, \`c6\` |
| Font stack | \`font-heading\`, \`font-body\`, \`font-mono\` |
| Dimension | \`radius\`, \`space\`, \`section-gap\`, \`card-pad\` |
| Density | \`density\` |
| Heading weight | \`heading-weight\` |
| Shadow | \`shadow\` |
| Border | \`card-border\`, \`section-rule\` |
| Table head color | \`table-head-bg\` |
| Table stripe color | \`table-stripe\` |

Every token value may instead be a whole-value \`var(--a67-name)\` reference to a different
registered token in the same domain: color references among color, table-head, and table-stripe
tokens; font-stack references among font tokens; or references within the dimension, density,
heading-weight, shadow, or border class. A token cannot reference itself. References cannot be
combined with any other value text. \`var\` is case-insensitive, the \`(\` immediately follows its
name, whitespace inside the parentheses is optional, and the referenced token name is lowercase.
In color components described below, \`var()\` may reference only one of the 18 Color tokens (not
\`table-head-bg\` or \`table-stripe\`).

The exact literal value grammars are:

- Color tokens and \`table-head-bg\`: a case-insensitive hexadecimal \`#rgb\` or \`#rrggbb\`.
- Font tokens: one of these four stacks, case-insensitively: \`system-ui, sans-serif\`;
  \`ui-monospace, monospace\`; \`"manrope"\` or \`'manrope'\` followed by \`, sans-serif\`; or
  \`"ibm plex mono"\` or \`'ibm plex mono'\` followed by \`, monospace\`. The quoted family names
  are parsed and serialized by css-tree before \`checkStyle\` compares the value, so either quote
  delimiter is accepted; family-name case is ignored. Whitespace around each comma is ignored
  and internal whitespace is collapsed. CSS backslash escapes are rejected before parsing.
- Density: a nonnegative decimal number with no sign or exponent, written as digits with an
  optional decimal fraction or as \`.digits\`; its numeric value is inclusive from \`0.75\` to \`1.25\`.
- Heading weight: any integer from \`100\` through \`900\`, inclusive.
- Dimension tokens: \`0\` (unitless) or a nonnegative decimal number followed by exactly one of
  \`px\`, \`rem\`, \`em\`, \`vw\`, \`vh\`, or \`%\`. A number is digits with an optional decimal fraction,
  or \`.digits\`; signs and exponents are not accepted. The same dimension form is used in
  \`calc(<dimension> + <dimension>)\`, \`calc(<dimension> - <dimension>)\`, and
  \`clamp(<dimension>, <dimension>, <dimension>)\`; whitespace around the operators and commas
  is optional, as is whitespace just inside function parentheses. Each function argument is one
  dimension only; nested math, multiplication, division, and other units are not accepted.
- Shadow: \`none\`, or three or four dimensions followed by a color. A shadow dimension is the
  dimension form above; the color is case-insensitive \`#rgb\`, \`#rrggbb\`, or \`#rrggbbaa\`, or a
  \`var()\` reference to one of the 18 Color tokens.
- Border (\`card-border\`, \`section-rule\`): one dimension, one of \`solid\`, \`dashed\`, \`dotted\`,
  \`double\`, and a color. The color is \`#rgb\` or \`#rrggbb\`, or a \`var()\` reference to one of the
  18 Color tokens.
- Table stripe: the same \`#rgb\`/\`#rrggbb\` or Color-token reference as a border, or
  \`color-mix(in srgb, <color> <percentage>, <color>)\`. Its name and syntax are case-insensitive;
  there is no whitespace before \`(\`, optional CSS whitespace is accepted just inside parentheses
  and around commas, \`in srgb\` has one space, and at least one whitespace separates the first
  color and percentage. Each \`<color>\` is a border color. The first color's percentage uses
  \`(?:100(?:\\.0+)?|\\d{1,2}(?:\\.\\d+)?|\\.\\d+)%\` and has a numeric value from \`0\` through \`100\`
  inclusive; the second color has no percentage.

Only \`var()\` is allowed in color, font, density, heading-weight, shadow, border, and table-head
values. Dimension values alone may use \`calc()\`, \`clamp()\`, and \`var()\`; table-stripe values alone
may use \`color-mix()\` and \`var()\`. Function names are case-insensitive. The validator rejects
every \`url()\` function, including \`data:\` URLs. It also rejects any non-\`--a67-*\` property,
unknown token, selector, at-rule, \`!important\`, backslash escape, CSS parser \`Url\`, \`Atrule\`, or
\`Raw\` node, and every function not permitted for that token class.

The inline style must parse as a CSS declaration list. Declarations must use a registered
\`--a67-<token>\` property and a nonempty value; braces and semicolons in a value are rejected.

Source attributes must be double-quoted and unique; malformed nesting, implied repair/error
recovery, raw-text/RCDATA elements, and invalid SVG namespaces are rejected. The validator rejects
parse errors and any tree requiring implied nodes. Character references decode exactly once; accept
valid named and decimal/hex references to Unicode scalar values, and reject malformed, null,
surrogate, disallowed-control, or double-encoded URL/CSS payloads. Escape literal \`&\`, \`<\` in text,
and quote delimiters in attributes. Comments may appear between nodes as \`<!-- text -->\`, but may
not be unclosed, contain \`--\`, or hide source tokens.
External SVG/resource references are rejected.

Theme references use \`ThemeRef\`, an object with exactly two properties, \`scope\` (\`platform\` or
\`project\`) and \`slug\`, matching \`^[a-z][a-z0-9-]{0,47}$\`; malformed shapes, additional properties,
and invalid slug syntax are rejected. A \`platform\` reference must not be confused with an
unregistered but syntactically valid platform slug, which follows the fallback behavior below.
Platform themes are \`report\`, \`editorial\`, and \`launch\`; they are currently registered and shown
together at \`/themes\`. A syntactically valid platform slug that is not registered is retained in
metadata; viewer rendering falls back to \`report\`. Optional \`themeOverrides\` can customize only
supported \`tokens\` and \`recipes\` within the contract's size and value constraints; they do not
admit arbitrary CSS or a project-scoped theme. The checked compiler validates contrast,
composition and logo data before scoped CSS or a resolved logo token reaches the page runtime.

M3 project themes extend the page \`ThemeRef\` union without changing the registered platform themes:
the wire object has exactly \`scope\` (\`"platform"\` or \`"project"\`) and \`slug\` properties. A project
reference names a theme defined in the page's top-level project folder. Project defaults accept
only a registered platform theme or a project theme from that same project. The default's stored
tuple comprises its scope and slug, plus the project theme identity for project scope; \`null\`
selects the platform \`report\` theme. A default is presentation context, not an authored page
reference.


Theme definitions may include \`extends\`, which must be a \`ThemeRef\` with exactly \`scope\`
(\`platform\` or \`project\`) and \`slug\`. A project theme's \`extends\` parent must be a registered
platform theme or an existing project theme in its defining project. Children inherit resolved
color tokens, font stacks, scales, and recipes; child-supplied values override inherited values.
Project parent chains resolve within that same project.
Project theme definitions are validated and compiled when defined or revised. Supported Google
Fonts are captured at definition time, embedded in sealed theme data, and resolved with the
theme; readers do not contact the provider. Revisions append immutable, audited history. Pages
refer to the theme identity, not a pinned revision: reads and publication composition resolve its
current revision. The API/MCP permission table below describes live authority: Editors may list,
read, define, revise, and delete project themes and set defaults; Managers and Owners may also
change the project brand lock. Changing the lock controls reader theme switching and does not
change the theme reference.

Theme context is inherited from an artefact's current top-level project, including when it is
stored in a nested folder. A move does not create an artefact version or rewrite its ThemeRef.
If a page's project-scoped theme is not available in its destination project, the reader resolves
the destination project's default, then platform \`report\`. Content reads return and audit
\`themeResolution\` as \`explicit\` or \`fallback\`, so callers can distinguish that resolution from
the page's saved reference.

The trusted inline page kit supplies registered semantic components and CSS tokens inside the
opaque sandbox; authored source cannot load an external kit. The composed viewer and gallery Content
Security Policy sets \`default-src 'none'\`; it allows inline, \`data:\`, and \`blob:\` scripts (including
\`unsafe-eval\`), inline styles, \`data:\`/\`blob:\` images, fonts and media, and same-origin \`/assets/favicon.ico\`
and \`/assets/ws-logo.svg\` images. \`connect-src 'none'\` blocks network connections; form actions,
base URLs, objects, frames, and workers are denied. No arbitrary external resource origins are
allowed. Copy HTML returns the authored source exactly, which is a fragment for \`page\` artefacts
and a complete document for \`site\` artefacts. For a page
with a registered theme, Download HTML wraps that fragment in a standalone document with the
trusted kit, selected compiled theme, runtime, and CSP, including the platform shell,
\`PAGE_KIT_CSS\`, and \`PAGE_KIT_RUNTIME\`. If a valid but unregistered theme slug is stored, viewer
rendering falls back to \`report\`, while Download HTML returns the authored fragment because no
compiled theme is available. Download HTML preserves authored complete-document source for \`site\`.
Composed page downloads exclude the hosted SDK, live persistence, and application data; they
therefore do not provide hosted persistence when opened standalone.

The M2 WCAG 2.2 A/AA axe gate exercises shipped page experiences across the checked platform
themes, light/dark schemes and desktop/mobile viewports. The automated gate reports violations
and incomplete checks separately; it does not certify arbitrary author content or replace human
assistive-technology review. \`/instructions\` and \`/llms.txt\` continue to recommend \`site\` as the
default publication type; Decision 9(a) reserves changing that guidance for M4 after human AT
sign-off.
**Rotate** — \`POST /_api/artifacts/rotate\`, body \`{ "artifact": "<slug-or-id>", "password":
<omitted> | null | "≥ 8 characters", "html": "<optional new document>", "ifVersion": 5 }\`. An ordinary path is
globally unique, so rotate addresses the artefact directly — there is no \`folder\` field.
\`password\` omitted leaves the additional gate exactly as it is; \`null\` **clears only that gate**
without changing private access or independent visitor-share passwords; a string sets
or rotates it — ≥ 8 characters, the content key re-wrapped, the document and link unchanged. The same
\`allow_weak_password: true\` opt-in as publish applies (master key only, \`403 forbidden\` for
a scoped key): without it a short password is \`invalid-password\`, with it the floor is
waived for that one write and the audit row records \`weakPassword: true\`. \`html\`, when
present, publishes a new version under the same link. Metadata (\`title\`, \`lang\`, …) belongs
to publish, never to rotate.

\`ifVersion\` is optional and applies when \`html\` is supplied. A stale version returns
\`409 conflict\` with \`currentVersion\`; the rejected write does not replace the newer version,
and a losing concurrent write's stored object is removed. Without \`ifVersion\`, rotate keeps
its existing unconditional behavior. Conditional tokens are not part of console forms in M1.

**Retired paths** — \`POST /_api/artifacts/alias\`, body
\`{ "artifact": "<slug-or-id>", "paths": ["<path>", …] }\` →
\`200 { "artifact": { "slug", "path" }, "aliases": [ …the recorded paths… ] }\`;
\`POST /_api/folders/alias\`, body \`{ "folder": "<slug-or-id>", "paths": [ … ] }\` →
\`200 { "folder": { "slug", "path" }, "aliases": [ … ] }\` (master keys only — a scoped key
sees no folders, so it records none). A path is one or two lowercase segments: a retired
single slug, or the 1.x \`<folderToken>/<artToken>/\` link. Recording it keeps a link handed
out in the past resolving to its target (an artefact link is permanent); re-recording the
same path on the same target is an idempotent no-op. Errors: a missing, empty, or malformed
\`paths\` entry is \`422 validation\` (field \`paths\`), an unknown target is \`404 not-found\`,
an unreadable or non-editable target is \`403 forbidden\`, and a path some other artefact or folder already
answers to is \`409 conflict\` — the single path namespace is not weakened by a second door
to it.

**Read** — \`GET /_api/folders\` → \`{ "folders": […] }\`; \`GET /_api/artifacts\` →
\`{ "artifacts": [ …the same metadata view publish returns… ] }\` (an artifact key gets the
one artefact it is bound to). These lists expose metadata only. Content is returned only by
\`GET /_api/artifacts/<ref>/content[?version=<positive integer>]\`, which returns
\`{ "artifact": { "id", "slug", "version" }, "version", "type": "text/html", "title",
"language", "html" }\`. Omit \`version\` for the current version. This explicit read requires
\`can_read_content\` plus the key's current read authority; artifact keys must also have \`read\`
scope and the requested artefact must be their bound artefact. Password-gated content needs no
password for an authorized key. A password or visitor share alone never authorizes this route.
Missing artefacts or retained versions return \`404 not-found\`; missing capability, scope or
authority returns \`403 forbidden\`. Each attempt is audited with its outcome and version where
available; audit details never include source content.

Content reads require this capability and the key's current authority; password and visitor
shares never authorize the API or MCP read. Every content read is audited with its outcome and
without source content.

**Keys** — master-key only on every \`/_api/keys\` path (an artifact key gets \`403 forbidden\`
there), and \`POST /_api/keys\` mints **artifact** keys only (ADR 0015: a master key never
mints another master key — the console owns that). Mint body:
\`{ "artifact": "<slug-or-id>", "scopes": "read" | "write" | "read_write", "label"?,
"can_read_content"? }\` (label ≤ 120 characters; \`can_read_content\` is boolean) → \`{ "key":
{ "id", "kind", "artifactId", "prefix", "scopes", "label", "can_read_content", "createdAt" },
"token": "waa_…" }\`. \`can_read_content\` is an explicit opt-in on key creation; absent and
unchecked values are false, including for existing keys. \`POST /_api/keys/rotate\`, body
\`{ "id": "<key id>" }\` → the same \`{ "key", "token" }\` shape with the new plaintext and the
existing capability unchanged. \`GET /_api/keys\` returns keys with the same capability boolean
and prefixes only, never the hash. \`DELETE /_api/keys/<id>\` revokes → \`{ "ok": true, "id": "…" }\`
(\`404 not-found\` for a missing, foreign, or already revoked key). The plaintext \`token\` appears
exactly once, in the mint or rotate response; it is never re-readable.

**Errors** — one envelope everywhere:

\`\`\`json
{ "error": { "code": "validation", "message": "document rejected", "details": [ { "code": "external-reference", "path": "html" } ] } }
\`\`\`

Codes: \`unauthorized\` 401 (missing, malformed, or unknown key), \`forbidden\` 403 (wrong tier
or scope), \`validation\` 422, \`too-large\` 413, \`not-found\` 404, \`conflict\` 409 (e.g. a \`slug\`
whose public path another artefact or folder already answers to), \`rate-limited\` 429 (with
\`Retry-After\`), \`unavailable\` 503 (the rate-limiter Durable Object could not be reached — a
transient infrastructure failure, deliberately distinct from \`internal\`), \`internal\` 500.

**Contract** — \`GET /_api/contract\` (no auth): this document, always current with the
validator.
**Product guide** — \`GET /instructions\` (no auth): all supported features, human workflows,
resource permissions, AI instructions, API examples, and troubleshooting.
**AI briefing** — \`GET /llms.txt\` (no auth): the same copyable agent instructions, including
console-only operations and secure, separate API-key provisioning.

## 5. Key tiers

Two API key tiers (ADR 0015). A key is \`wak_\` + 40 lowercase hex (master) or \`waa_\` + 40
lowercase hex (artifact). Only the sha256 hash is stored, next to a display prefix
(\`wak_1a2b3c4d\`); the plaintext appears exactly once, in the mint or rotation response.
Revocation is a flag, never a delete — the audit trail survives. Artifact keys are minted,
rotated and revoked through this API, by a master key; a master key is minted only in the
owner console at \`/settings/keys\`.

- **Master key (\`wak_…\`)** — one per user, scope \`master\`. Acts on owned and explicitly shared
  folders/artefacts using the user's current authority. Viewer grants permit reads; editor or
  manager grants permit writes. Only this tier can mint, rotate and revoke artifact keys.
- **Artifact key (\`waa_…\`)** — bound to exactly one artefact, with scope \`read\`, \`write\` or
  \`read_write\`. It requires both its declared scope and its user's current folder authority.
  Revocation, suspension or a move out of a granted subtree removes reach on subsequent requests;
  issuing a key never snapshots a grant. A leaked key's maximum scope is one artefact.

Platform-wide listing is an Owner/Admin console view, never an API-key capability. The M1
\`can_read_content\` capability is an explicit key-creation opt-in (unchecked by default and false
for existing keys); key rotation preserves it. API and MCP content reads require that capability
and current read authority, and artifact keys additionally require \`read\` scope and their bound
artefact. Authorized keys can read password-gated content without its password; a password or
visitor share alone never authorizes API/MCP content reads. Every read is audited with its
outcome but without source content. The console's isolated preview and authorized ordinary links
remain separate from this API capability. Password changes require resource editing authority.

## 6. Visual styleguide

There is no shared CSS — **every artefact carries its own styles inline**. The user's specified
design, style, template, and client brand always take priority over any platform fallback.

**ONLY when no design is specified**, use the design template that this platform's documentation
and \`/llms.txt\` name, if they name one, and adapt its full layout. Replace every sample name,
date, number, heading, finding, table row, diagram label, accessible description and conclusion
with real content; never invent evidence. Keep any design attribution the template carries. If no
template is named, use a clean, readable layout of your own. Keep one portable HTML document;
supported font imports are captured at publication (§1). Never embed toolbars, iframe runtimes,
CDN scripts or other external runtime dependencies. A template and the documentation are
illustrative assets, not exceptions granting private access.

For documents without a design of their own, this optional neutral palette is available:

\`\`\`css
:root{
  --bg:#F5F6F8; --ink:#191C22; --muted:#606774; --line:#E6E8EC; --card:#fff;
  --chrome:#15171C; --accent:#2A54F0; --accent-ink:#1E3ECC;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
}
\`\`\`

- Artefacts own their typography and support light and dark by default (below).
  Use readable contrast and fonts embedded at publication; console themes do not restyle artefacts.
- Choose a responsive content width appropriate to the artefact. Wide data tables should scroll
  inside their own container rather than make the whole mobile page overflow.
- **Print-friendly**: a sensible \`@media print\` (page breaks, no background dependence).
- A folder-specific accent palette is welcome as long as the document stays readable and its
  presentation does not depend on an external service at view time.

### Light and dark

Declare \`<meta name="color-scheme" content="light dark">\` in \`<head>\`: that standard
declaration is the opt-in. For an opted-in artefact the viewer (console, new tab and visitor
shares) shows a light/dark switch. It starts from the reader's system preference; an explicit
choice is remembered in that browser for every artefact. Before the first paint and live on
every switch, without reloading the artefact, the viewer sets on \`<html>\` the attribute
\`data-theme="light"\` or \`data-theme="dark"\` and the matching inline \`color-scheme\`, and
exposes the current value as read-only \`window.artefacts.theme\` (\`null\` without the opt-in).
Read \`window.artefacts.theme\` or \`data-theme\` at startup; each later switch dispatches an
\`artefacts:theme\` event on \`window\` (\`event.detail.theme\`). The initial scheme fires no event. An artefact without the
declaration gets no switch and is never recoloured.

Write each palette once per scheme with this pattern. \`data-theme\` is the viewer's guaranteed
hook; the media query serves downloaded HTML, which follows the system preference:

\`\`\`css
:root{ --bg:#f6f7f9; --ink:#14181d; --line:#e1e6ea; }
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){ --bg:#13161a; --ink:#e8ecf0; --line:#2c3238; }
}
:root[data-theme="dark"]{ --bg:#13161a; --ink:#e8ecf0; --line:#2c3238; }
\`\`\`

Colour everything through these variables, including inline SVG \`fill\`/\`stroke\`
(\`var(--ink)\` or \`currentColor\`), tables and code blocks, and check contrast in both schemes.
Do not rely on \`prefers-color-scheme\` alone: inside the viewer it follows the switch only
after the document has loaded.

### Diagrams

**Mermaid is the recommended source format — never the runtime.** Author the diagram in
mermaid syntax, render it to SVG at authoring time, and inline the resulting SVG:

\`\`\`bash
npx @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.svg   # then paste the SVG inline
\`\`\`

An artefact must never reference the mermaid library or any other JS at view time — the
validator rejects every external reference (\`external-reference\`).

### Charts

Build charts as **inline SVG**, generated while authoring (a few rectangles and text nodes
cover most bars/donuts). No chart libraries. Give each chart a \`<title>\`/\`<desc>\` for
accessibility, use the palette, and keep it legible when printed.

## 7. Application data SDK

The viewer injects \`window.artefacts.storage\` into the sandbox before authored scripts run.
The SDK carries asynchronous JSON requests through a private channel to the trusted viewer;
the artefact receives no account cookie, CSRF credential or master key.

| Method | Result |
|---|---|
| \`get(key, { scope = "personal" } = {})\` | Promise of the stored JSON value, or \`null\` if absent |
| \`set(key, value, { scope = "personal" } = {})\` | Promise that resolves when the value is saved |
| \`delete(key, { scope = "personal" } = {})\` | Promise that resolves when the key is removed |
| \`list({ prefix = "", scope = "personal" } = {})\` | Promise of the matching keys |

### Scopes and authority

- **Personal:** values belong to this artefact and the current reader. Signed-in readers use
  their account identity; visitors use a browser identity maintained by the trusted viewer.
  Another reader's personal values cannot be selected or read by supplying an identifier.
- **Shared:** current readers can read the artefact's shared values. Only a current editor,
  manager or owner can write or delete them. Holding a visitor share is not shared-write authority.
- Access is rechecked on requests. An expired or revoked share, revoked colleague grant,
  suspended reader account or deleted artefact cannot keep using an old viewer's authority.
- Ordinary runtime loads (including the descriptor's legacy \`source.kind = "public"\`) require
  a current authorized signed-in session; missing or denied authority returns 403. Runtime
  grants and every action recheck live read authority. Only \`source.kind = "share"\` permits
  anonymous reads under the existing share policy. A non-share \`publicUrl\` is an ordinary
  private address, not a bearer capability; descriptor fields are unchanged.
- Values are sealed at rest. Source-version updates preserve application data; duplication
  creates a separate namespace, and restoring a source version does not restore older data.
- Deleting an artefact withdraws its content and its own \`personal\`/\`shared\` application data.
  Project data (§8) belongs to the project, not the artefact, and is untouched. Its old paths
  stay reserved.

The SDK may reject requests because access expired, a write is forbidden, a limit was exceeded
or storage is unavailable. Show a failure instead of claiming the value was saved. Do not silently
fall back to another reader's data or a different scope.

\`\`\`js
const storage = window.artefacts.storage;
const preferences = (await storage.get("calculator/preferences")) ?? { currency: "EUR" };
await storage.set("calculator/preferences", { ...preferences, currency: "EUR" });

// Reading shared settings does not grant permission to change them.
const shared = await storage.get("calculator/defaults", { scope: "shared" });
\`\`\`

### Limits

- Keys contain 1–128 printable characters; \`list\` may use an empty prefix.
- A JSON-serialized value is at most 64 KiB.
- Each personal namespace and the shared namespace can hold at most 128 keys.
  Existing keys remain writable at the key limit; delete a key before adding another.
- Each artefact holds at most 4096 stored keys and 32 MiB of sealed key/value state across
  all namespaces. Anonymous personal state has its own ceilings of 2048 keys and 8 MiB,
  leaving capacity for registered users and shared state. Quota failures reject the operation without changing
  the existing value.
- Anonymous personal entries expire after 365 days without a successful read or write.
  Registered-user personal entries and shared entries do not expire. Anonymous identity belongs
  to that browser's cookie; clearing cookies or signing in selects a different personal namespace.
- Runtime grants expire after one hour and are bound to the current reader/session. Reopen the viewer
  after expiry or an access change; a grant is not a replacement for a password.
- Runtime operations, including collection-schema reads, are limited to 180 requests per minute per
  reader/artefact. Anonymous requests also share IP-derived limits of 180 requests and 30 new grants
  per minute, so changing reader cookies does not reset the window. Reports are limited to 10 per
  hour per IP-derived key. Counters use purpose-specific keyed hashes rather than saving IP
  addresses and expire after their windows.

### Portability

A downloaded HTML document retains its presentation and captured fonts, but a standalone file
does not have the hosting viewer or its SDK authority. Detect a missing SDK and clearly disable
server-backed persistence; do not treat a local export as connected to the published artefact.

## 8. Project data, responses and MCP

A **project** is an artefact's top-level folder: the root of its folder chain, resolved live on
every request (ADR 0032). A project holds declarative **collections** of sealed **records**,
shared by every artefact placed anywhere in that folder's subtree. Unfiled artefacts have no
project. There is no SQL and no query language.

- A \`records\` collection holds shared data an agent or a current editor maintains.
- A \`responses\` collection holds client submissions: readers submit through the viewer SDK,
  agents with \`manage\` read them back. Neither agents nor clients can edit a response.

### Collections and fields

A collection is \`{ "kind": "records" | "responses", "fields": { … }, "visitors"?: boolean }\`.
Its name matches \`^[a-z][a-z0-9_-]{0,63}$\`; field names match \`^[A-Za-z][A-Za-z0-9_-]{0,63}$\`
(usually the HTML control names). A collection has 1–64 fields; \`visitors\` defaults to \`false\`.
\`kind\` cannot change after creation (redefining with another kind is \`409 conflict\`). \`PUT\`
replaces \`fields\` and \`visitors\` (an omitted \`visitors\` resets it to \`false\`); existing records are
not rewritten — validation applies to writes only, so read records written under older
definitions tolerantly.

| Type | Options | Accepts |
|---|---|---|
| \`text\` | \`maxLength\` 1–10000 (default 2000) | a string of at most \`maxLength\` characters |
| \`email\` | — | a string of at most 254 characters shaped like \`a@b.c\` |
| \`number\` | \`min\`, \`max\`, \`integer\` | a finite number, or a numeric string (coerced) |
| \`boolean\` | — | \`true\`/\`false\`, or the strings \`"on"\`, \`"true"\`, \`"false"\` |
| \`date\` | — | a real calendar date \`YYYY-MM-DD\` |
| \`choice\` | \`options\` (1–100 unique strings of 1–200 characters), \`multiple\` | one listed option; with \`multiple\`, an array of listed options or a single string |
| \`file\` | \`maxBytes\` 1–104857600 (default 26214400), \`accept\` (1–50 unique lowercase entries: \`type/subtype\`, \`type/*\` or \`.ext\`, where an extension is \`.\` plus 1–16 characters of \`[a-z0-9.+-]\`, the first a letter or digit), \`multiple\` (≤10 files) | a file id (32 lowercase hex) or \`{ "id" }\` from a completed upload (other keys ignored); with \`multiple\`, an array of those or a single one; stored and returned as \`{ "id", "name", "type", "size" }\` (an array with \`multiple\`) — §8 Files |

Every field may be \`required\`. A **required boolean must be \`true\`** — that is the explicit
confirmation. An empty string, \`null\`, a missing value or an empty array is *absent*: an
optional absent field is omitted (an optional absent boolean is stored as \`false\`), a required
one fails. Unknown fields are rejected. A failed write returns \`validation\` with
\`[{ "field", "message" }]\` issues (the API's \`details\`, the SDK error's \`issues\`).

### Records

\`\`\`json
{ "id": "…", "collection": "rsvp", "version": 1, "data": { … },
  "createdAt": "…", "updatedAt": "…", "submission": { … } }
\`\`\`

\`version\` starts at 1 and increments on every update. Update and delete accept an optional
\`ifVersion\` (a positive integer); a mismatch is \`409 conflict\` and changes nothing. Without it
the last write wins. \`submission\` is present on responses only. Through the API it is
\`{ "submittedAt", "artifactId", "artifactVersion", "submittedBy" }\`, with \`submittedBy\`
\`{ "type": "user", "userId", "email", "name" }\` or \`{ "type": "share", "shareId", "shareName" }\`
(\`shareName\` is the share's display name, or its recipient when unnamed). Through the SDK a
reader sees only \`{ "submittedAt", "artifactVersion" }\`. Lists are oldest first:
\`{ "records": [ … ], "cursor": "…" | null }\` — pass \`cursor\` back for the next page. File fields
hold descriptors inside the record's 64 KiB; writing a read record back unchanged keeps its
files (an object with an \`id\` is accepted). A file id listed twice in one write is a
\`validation\` issue.

### Quotas

- 50 collections per project; 1–64 fields per collection.
- A record serializes to at most 64 KiB (\`413 too-large\`).
- 20,000 records and 64 MiB sealed bytes per project. A full project refuses the write
  (\`409 conflict\` through the API).
- Pages hold 100 records by default, \`limit\` 1–500.
- SDK submissions: 30 per hour per reader per project, on top of the general runtime limits (§7).
  Signed-out submissions also share 120 per hour per client IP per project, because a
  signed-out reader is identified only by a cookie the client can drop.
- Project files: per project 10 GiB plaintext and 10,000 live files (open uploads, unattached
  completed uploads and attached files); 5 open uploads per uploader across the platform (an API
  uploader is the key's user). Exhaustion is \`quota-exceeded\` (\`409 conflict\` through the API).
- SDK file transfers: 20 upload starts (new and resumed) and 128 parts (1 GiB) per hour per
  reader per project; signed-out readers also share 60 starts and 256 parts per hour per client
  IP per project. A part refused by a busy Worker isolate (§8 Files) costs no hourly hit. API and
  MCP file requests count toward the key's general limit (§4).

### Authority

The API and MCP accept **master keys only**; an artifact key (\`waa_\`) gets \`403 forbidden\`.
Authority is the key user's current role on the project's top-level folder:

| Operation | API tier |
|---|---|
| List collections; list/get records in a \`records\` collection | \`read\` (Viewer) |
| List project themes; read a project theme | \`read\` (Viewer) |
| Define a collection; create/update/delete records; delete a \`records\` collection | \`write\` (Editor) |
| List/get/delete records in a \`responses\` collection; delete a \`responses\` collection | \`manage\` (Manager) |
| Define/revise/delete project themes; set project default | \`write\` (Editor) |
| Change project brand lock | \`manage\` (Manager) |
| Create or update a response | never (\`403 forbidden\`) |

Through the viewer SDK:

| Reader | \`records\` | \`responses\` |
|---|---|---|
| Signed-in reader with read authority | \`list\`, \`get\` | \`submit\`, \`mine\` |
| Signed-in reader with live write authority on the artefact | also \`create\`, \`update\`, \`delete\` | \`submit\`, \`mine\` |
| Visitor through a share (even when the browser is signed in) | \`list\`, \`get\` only if \`visitors\` is true | \`submit\`, \`mine\` only if \`visitors\` is true |

\`mine\` returns only the caller's own responses in that collection — never other submitters'.
Any reader of any artefact in a project reaches every collection there that their role permits;
the binding is the folder, not the artefact's code, so place artefacts accordingly.

Files (§8 Files) follow the record they belong to:

| | \`records\` | \`responses\` |
|---|---|---|
| SDK upload (start, part, complete, cancel) | live write authority (signed in, never via a share) | submit authority: signed-in readers with read authority; share visitors only if \`visitors\` is true |
| API/MCP upload | \`write\` | never (\`403 forbidden\`) |
| SDK \`file\`/\`download\` | whoever may read the record (share visitors only if \`visitors\` is true) | only the response's submitter (anyone else gets \`not-found\`) |
| API/MCP file metadata and download | \`read\` | \`manage\` |

The **file actor** — the uploader — is the reader identity for the SDK and the key's user for
API/MCP (any master key of the same user continues the upload). Status, parts, complete and
cancel need the same actor; a completed upload attaches only through a write by that actor.
Authority is rechecked live on every part, status, complete, cancel and download.

### Endpoints

\`<folder>\` is the top-level folder's slug or id; a subfolder is \`422 validation\` (field
\`folder\`). Errors use the §4 envelope.

| Method | Path | Body | Result |
|---|---|---|---|
| \`GET\` | \`/_api/projects/<folder>/collections\` | — | \`{ "collections": [ { "name", "kind", "fields", "visitors", "createdAt", "updatedAt" } ] }\` |
| \`PUT\` | \`/_api/projects/<folder>/collections/<name>\` | \`{ "kind", "fields", "visitors"? }\` | \`201\`/\`200 { "collection" }\` |
| \`DELETE\` | \`/_api/projects/<folder>/collections/<name>\` | — | \`{ "ok": true, "name" }\` (its records go too) |
| \`GET\` | \`…/collections/<name>/records?limit=&cursor=\` | — | \`{ "records", "cursor" }\` |
| \`GET\` | \`/_api/projects/<folder>/themes\` | — | \`{ "themes": [ { "scope": "project", "slug", "revision", "id", "createdAt", "updatedAt" } ] }\` (metadata only) |
| \`GET\` | \`/_api/projects/<folder>/themes/<slug>\` | — | \`{ "theme": { "scope": "project", "slug", "revision", "definition" } }\` |
| \`PUT\` | \`/_api/projects/<folder>/themes/<slug>\` | definition object; optional \`If-Revision: <integer>\` | \`201\`/\`200 { "theme": { "scope", "slug", "revision", "currentRevision" } }\` |
| \`DELETE\` | \`/_api/projects/<folder>/themes/<slug>\` | — | \`{ "ok": true, "slug" }\` (only when unreferenced) |
| \`PUT\` | \`/_api/projects/<folder>/theme-default\` | \`{ "theme": ThemeRef | null }\` | \`{ "ok": true }\` |
| \`PUT\` | \`/_api/projects/<folder>/theme-brand-lock\` | \`{ "brandLock": boolean }\` | \`{ "ok": true, "brandLock" }\` (Manager) |
| \`POST\` | \`…/collections/<name>/records\` | \`{ "data" }\` | \`201 { "record" }\` (\`records\` only) |
| \`GET\` | \`…/collections/<name>/records/<id>\` | — | \`{ "record" }\` |
| \`PUT\` | \`…/collections/<name>/records/<id>\` | \`{ "data", "ifVersion"? }\` | \`{ "record" }\` (\`records\` only) |
| \`DELETE\` | \`…/collections/<name>/records/<id>?ifVersion=\` | — | \`{ "ok": true, "id" }\` |
| \`POST\` | \`…/collections/<name>/uploads\` | \`{ "field", "name", "type"?, "size", "lastModified"? }\` | \`201 { "upload" }\`, or \`200 { "upload" }\` when an open upload of the same file was resumed |
| \`GET\` | \`…/collections/<name>/uploads/<id>\` | — | \`{ "upload" }\` (open or completed, unexpired) |
| \`PUT\` | \`…/collections/<name>/uploads/<id>/parts/<n>\` | raw bytes, \`Content-Type: application/octet-stream\` | \`{ "part": { "number", "size", "sha256" } }\` |
| \`POST\` | \`…/collections/<name>/uploads/<id>/complete\` | — | \`{ "file": { "id", "name", "type", "size" } }\` |
| \`DELETE\` | \`…/collections/<name>/uploads/<id>\` | — | \`{ "ok": true, "id" }\` |
| \`GET\` | \`…/collections/<name>/files/<fileId>\` | — | \`{ "file": { "id", "name", "type", "size", "recordId", "createdAt", "downloadPath" } }\` (attached files only) |
| \`GET\` | \`…/collections/<name>/records/<id>/files/<fileId>\` | — | the file bytes (§8 Files) |

\`upload\` is \`{ "id", "collection", "field", "name", "type", "size", "lastModified", "partBytes",
"parts", "received": [ { "number", "size", "sha256" } ], "status": "uploading" | "ready",
"expiresAt", "partPath" }\`; \`partPath\` is
\`/_api/projects/<folderId>/collections/<name>/uploads/<id>/parts/\` (append the part number).
\`downloadPath\` is \`/_api/projects/<folderId>/collections/<name>/records/<recordId>/files/<fileId>\`.
\`<n>\` is canonical decimal (\`1\`, never \`01\`); anything else is not a route (\`404\`). A part
without \`Content-Type: application/octet-stream\` is \`422 validation\` (field \`part\`); its
\`Content-Length\` must equal the part's size (a missing or smaller one is \`422 validation\`, field
\`part\`; a larger one \`413 too-large\`). Upload routes on a \`responses\` collection are
\`403 forbidden\`. Errors: \`quota-exceeded\` → \`409 conflict\`, \`too-large\` → \`413\`, \`wrong-kind\` →
\`403\`, a busy isolate → \`429 rate-limited\` with \`Retry-After\`; an expired or unknown upload is
\`404 not-found\` ("Upload expired or unknown.").

### MCP

\`POST /_mcp\` speaks the Model Context Protocol over Streamable HTTP, stateless: one JSON-RPC
2.0 message per request (no batches), a JSON response, no sessions or SSE. Send a master key,
or an artifact key with \`can_read_content\`, \`read\` scope and current authority when calling
\`get_artifact\`; other operations still require a master key. Other methods get \`405\` with
\`Allow: POST\`. A request carrying an \`Origin\` other than the platform's own is refused (\`403\`).
An unsupported \`MCP-Protocol-Version\` header is \`400\`; \`2025-06-18\` and \`2025-03-26\` are
supported. A body over the API limit is \`413 too-large\`. A notification (no \`id\`) gets \`202\`
with no body.

Methods: \`initialize\`, \`ping\`, \`tools/list\`, \`tools/call\`. Tools: \`list_folders\`,
\`list_artifacts\`, \`publish_artifact\`, \`get_artifact\`, \`list_collections\`, \`define_collection\`,
\`delete_collection\`, \`list_records\`, \`get_record\`, \`create_record\`, \`update_record\`,
\`delete_record\`, \`start_upload\` \`{ folder, collection, field, name, type?, size, lastModified? }\`,
\`get_upload\`, \`complete_upload\`, \`cancel_upload\` \`{ folder, collection, uploadId }\`, and
\`get_file\` \`{ folder, collection, fileId }\` (17 tools). \`publish_artifact\` accepts optional
\`ifVersion\`; a stale value returns \`409 conflict\` with the current version, and omission retains
unconditional publication. \`get_artifact({artifact,version?})\` returns content only through an
explicitly authorized read. Its result has the same metadata and HTML fields as the HTTP content
route. Each tool runs the matching \`/_api\` request with the caller's key, so authority, rate
limits and audit are identical. A tool result is
\`{ "content": [ { "type": "text", "text": "<JSON>" } ], "structuredContent": <the API body>,
"isError": <API status ≥ 400> }\`.

**Bytes never travel through MCP**: PUT each part to \`<origin><upload.partPath><n>\` and GET
\`<origin><file.downloadPath>\` over HTTP with the same \`Authorization: Bearer\` key.

### SDK: \`window.artefacts.data\`

| Method | Result |
|---|---|
| \`list(collection, { limit, cursor } = {})\` | \`records\`: promise of \`{ records, cursor }\` |
| \`schema(collection)\` | \`window.artefacts.data.schema(collection)\`: \`records\` or submit-authorized \`responses\`; promise of \`{ name, kind, fields, visitors }\`, the public collection definition without record or submitter data |
| \`get(collection, id)\` | \`records\`: promise of the record, or \`null\` |
| \`create(collection, data, { onProgress } = {})\` | \`records\`: promise of the new record (write authority) |
| \`update(collection, id, data, { ifVersion, onProgress } = {})\` | \`records\`: promise of the updated record (write authority) |
| \`delete(collection, id, { ifVersion } = {})\` | \`records\`: resolves when deleted; a missing record rejects \`not-found\` |
| \`submit(collection, eventOrFormOrObject, { onProgress } = {})\` | \`responses\`: promise of the stored response |
| \`mine(collection, { limit, cursor } = {})\` | \`responses\`: promise of \`{ records, cursor }\` with only the caller's responses |
| \`upload(collection, field, file, { onProgress, signal } = {})\` | promise of \`{ id, name, type, size }\` for a \`File\` (§8 Files) |
| \`file(collection, recordId, fileId)\` | promise of a \`File\` typed with the declared type, for in-frame display |
| \`download(collection, recordId, fileId)\` | resolves once the viewer started saving the file (always saved as \`application/octet-stream\`) |
\`schema(collection)\` uses the same live runtime grant and project-read authority as other collection
reads. For \`responses\`, a visitor share may read the definition only when \`visitors\` is true;
the result contains only the public definition and field names/types/constraints (including
\`required\`, \`options\`, \`multiple\`, \`min\`, \`max\`, \`integer\`, \`maxLength\`, \`maxBytes\`, and \`accept\`),
never record values, submitter values, identities or other record data. An unfiled artefact gets
\`no-project\`. Schema reads count toward the existing runtime request limit.

A rejection is an \`Error\` with \`code\` and, for validation, \`issues\`. Codes: \`no-project\` (the
artefact is unfiled), \`wrong-kind\` (\`list\`/\`get\`/\`create\`/\`update\`/\`delete\` on a \`responses\`
collection, or \`submit\`/\`mine\` on \`records\`), \`not-found\`, \`forbidden\`, \`validation\`, \`conflict\`,
\`quota-exceeded\`, \`too-large\`, \`rate-limited\`, and \`aborted\` (an \`upload\` waiting on an identical
upload that was cancelled). An \`upload\` whose own \`signal\` aborts rejects with an \`AbortError\`.

\`submit\` accepts a plain object, a \`<form>\`, or the form's \`SubmitEvent\`: form controls serialize
by name, a repeated name becomes an array, an unchecked checkbox is absent, and a selected file
input becomes a \`File\` value that is uploaded first (an \`<input type="file" multiple>\` is always
an array; an empty file input is absent). Passing the event also
includes the clicked submit button's \`name\`/\`value\`, so several named buttons can share one
form. The viewer restores native submission inside the sandbox: a submit-button click, Enter
implicit submission and \`requestSubmit()\` run the form's constraint validation
(\`reportValidity\`, skipped for \`novalidate\`/\`formnovalidate\`) and then dispatch a \`submit\` event;
a form whose own \`method="dialog"\` then closes its \`<dialog>\` with the button's value (a submitter's \`formmethod\` is not emulated). The click submits
after the page's own click handlers, so calling \`preventDefault()\` on the click or the \`submit\`
event cancels it. Nothing ever navigates, and \`form.submit()\` is a no-op.

\`\`\`html
<form id="rsvp">
  <label>Name <input name="name" required></label>
  <fieldset><legend>Attending</legend>
    <label><input type="radio" name="attending" value="yes" required> Yes</label>
    <label><input type="radio" name="attending" value="no"> No</label>
  </fieldset>
  <label>Menu <select name="menu"><option value="">—</option><option>fish</option><option>vegetarian</option></select></label>
  <label><input type="checkbox" name="confirmed" required> I confirm these details</label>
  <button>Send</button>
  <p role="status" id="rsvp-status"></p>
</form>
<script>
  const form = document.getElementById("rsvp");
  const status = document.getElementById("rsvp-status");
  if (!window.artefacts?.data) {
    form.querySelector("button").disabled = true;
    status.textContent = "Responses can only be sent from the hosted artefact.";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await window.artefacts.data.submit("rsvp", event);
      status.textContent = "Thank you — your response was recorded.";
    } catch (error) {
      status.textContent = "Not sent: " + error.message;
    }
  });
</script>
\`\`\`

Matching collection: \`{ "kind": "responses", "visitors": true, "fields": { "name": { "type":
"text", "required": true }, "attending": { "type": "choice", "options": ["yes", "no"],
"required": true }, "menu": { "type": "choice", "options": ["fish", "vegetarian"] },
"confirmed": { "type": "boolean", "required": true } } }\`.

A standalone downloaded file has no \`window.artefacts.data\`; detect it with
\`if (!window.artefacts?.data)\` and disable submission rather than pretending to send.

**Confirmation is not a signature.** A submitted required boolean is a product acknowledgement
recorded through an authority path. It is not an e-signature and not identity proof — a share
link can be forwarded. Opening a link, visits and observations are never confirmation. Revoking
access later does not delete earlier submissions.

### Files

A \`file\` field holds files stored for that record: sealed per part with a per-file key, private,
reachable only through the record (and its project) they belong to. Files are 1 byte–100 MiB,
sent in parts of \`partBytes\` (8 MiB, 8,388,608 bytes; the last part is the remainder), at most 13.

**Agent flow (API or MCP).**

1. \`POST …/uploads\` (or \`start_upload\`) with \`{ field, name, type, size, lastModified }\` →
   \`upload\`. \`size\` must not exceed the field's \`maxBytes\` (\`413 too-large\`).
2. \`PUT\` each part \`n\` = 1…\`upload.parts\` to \`<origin><upload.partPath><n>\` as raw bytes with
   \`Content-Type: application/octet-stream\` and the same Bearer key. Re-sending a part replaces it.
3. \`POST …/uploads/<id>/complete\` (or \`complete_upload\`) → \`file\`. A missing part is
   \`422 validation\` (field \`part\`); completing twice returns the same file.
4. Put \`file.id\` into the field in \`create_record\`/\`update_record\` **within 24 h**; afterwards the
   upload expires and the write fails \`validation\` ("File is not available. Upload it again.").

Resume: a start with the same field, name, size and \`lastModified\` by the same uploader returns
the open upload (\`200\`) with its \`received\` parts; send only the parts that are missing or whose
\`size\`/\`sha256\` (hex SHA-256 of the plaintext part) differ.

**SDK flow.** \`create\`, \`update\` and \`submit\` upload every \`File\` value (top-level, or inside a
top-level array) first, one after another in field order, then write the record with their ids;
\`onProgress({ field, loaded, total })\` reports bytes across all files. \`upload\` alone returns the
descriptor to put in a later write; its \`onProgress({ loaded, total })\` fires after each part and
once with \`loaded = total\` before resolving. If the record write fails, retrying the call uploads
the files again; the earlier uploads expire unused.

\`\`\`html
<form id="claim">
  <label>Receipt <input type="file" name="attachment" accept="application/pdf" required></label>
  <button>Send</button>
  <progress id="claim-progress" max="1" value="0"></progress>
</form>
<script>
  const progress = document.getElementById("claim-progress");
  document.getElementById("claim").addEventListener("submit", async (event) => {
    event.preventDefault();
    await window.artefacts.data.submit("claims", event, {
      onProgress: ({ loaded, total }) => { progress.value = loaded / total; },
    });
  });
</script>
\`\`\`

Display a stored image, audio or video file inside the artefact:

\`\`\`js
const ref = record.data.photo;   // { id, name, type, size }
img.src = URL.createObjectURL(await window.artefacts.data.file("gallery", record.id, ref.id));
\`\`\`

PDF and HTML preview are not supported by the sandbox CSP; use \`download(collection, recordId,
fileId)\` to save the file instead.

- \`accept\` checks only the declared MIME type and the file-name extension, at upload start. The
  content is never inspected; a renamed file passes.
- **Resume** = call \`upload\` (or submit) again with the same file; after a reload, the reader
  re-picks it. Only missing or changed parts are sent; a second call for the same file while the
  first runs awaits the first. Files are never kept in browser storage. A failed part is retried
  three times (1 s, 2 s, 4 s, or a \`Retry-After\` of up to 30 s). An \`AbortSignal\` cancels the
  upload and discards it.
- Uploads need a live runtime grant (1 h from opening); after "Runtime access expired", reopen the
  artefact and re-pick the file to resume.
- A Worker isolate runs at most 3 file transfers (parts or downloads) at once; above that a
  request is \`429 rate-limited\` with \`Retry-After: 1\`.
- Downloads are always \`Content-Disposition: attachment\` (the real name in \`filename*\`),
  \`Content-Type: application/octet-stream\`, \`X-Content-Type-Options: nosniff\`,
  \`Content-Security-Policy: sandbox\`, \`Cache-Control: no-store\`, with \`Content-Length\` and the
  declared type in \`X-Artefacts-File-Type\` (when not empty). A body shorter than \`Content-Length\`
  is a failed download. There is no \`Range\` support.
- **Files are not malware-scanned.** Treat every downloaded file as untrusted.
- **Gated artefacts protect project files by authorization, not by the document password**: the
  Worker can open every file, as it can open artefact content.
- File names, types and \`lastModified\` are sealed; audit (\`project.file.upload\`,
  \`project.file.complete\`, \`project.file.cancel\`) carries ids and sizes only.

### Lifecycle

- Moving an artefact to another project rebinds it; data stays with the project it was written to.
- A top-level folder that owns collections cannot be nested under another folder (\`409\`, code
  \`project-data\`); delete its collections first. Moving a folder without collections, any
  subfolder, or a folder to the top level stays allowed (the latter starts an empty project).
- Project data lives as long as its folder. Only the folder's owner can delete it, in the
  console, together with everything in it (subfolders, artefacts, their collections and
  records), atomically; at most 200 artefacts and 100 folders per deletion. There is no API or MCP
  folder deletion (ADR 0038).
- Deleting a record, a collection or a folder deletes its files (a collection or folder also its
  open uploads); the bytes are removed by the next daily sweep. An update that drops a file from a
  field deletes it. Unattached uploads expire 24 h after their start (open) or completion
  (completed).
- Deleting an artefact does not touch project data or files; a response keeps its \`artifactId\` as
  provenance. Duplicate, restore and publish do not copy, rewind or reset project data; a
  duplicate binds to the project of its destination folder.
`;

/** Serve the contract (GET /_api/contract, public): markdown under the repo's response
 *  hygiene — never cached, never indexed, no referrers (respond.ts discipline). */
export function contract(): Response {
  return new Response(CONTRACT_MD, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
