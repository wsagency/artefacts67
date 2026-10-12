// Pure validators for the Artefacts67 2.0 write API. No I/O, no imports — the same module
// runs under workerd and `node --test`. Ported from lib/validate.js (1.x): the artefact-HTML
// ERROR/WARNING codes and their meanings are the public contract documented in
// dev-docs/artefact-contract.md §3 and served at GET /_api/contract — keep them in sync.
// The body validators carry the 2.0 field set: one slug namespace instead of name+slug (no
// separate artefact name), lang and note, and the 8-character password floor (ADR 0011).

const SLUG_RE  = /^[a-z0-9][a-z0-9-]{0,62}$/;   // folder slugs AND artefact slugs, 1-63 chars
const LANG_RE  = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;  // BCP-47-shaped: en, hr, en-US, zh-Hant

const MAX_HTML_CHARS  = 1_500_000;   // 1.5 MiB artefact size cap (string length)
const MAX_FOLDER_NAME = 120;
const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS  = 200;
const MIN_PASSWORD    = 8;

// View-time network references (contract §1: artefacts must render identically offline).
// Same-origin absolute paths never match — /assets/favicon.ico and /assets/ws-logo.svg stay allowed.
const REMOTE_SRC_HREF_RE = /(?:src|href)\s*=\s*["']?https?:\/\//i;  // attribute values, quoted or bare
const REMOTE_CSS_URL_RE  = /url\(\s*['"]?https?:\/\//i;             // CSS url(http…)
const CSS_IMPORT_RE      = /@import\b/i;                            // any @import — all CSS must be inline

export type ValidationIssue = { code: string; message: string; field?: string };
export interface HtmlValidation { errors: ValidationIssue[]; warnings: ValidationIssue[] }
export interface HtmlValidationOptions { checkReferences?: boolean; maxChars?: number; gated?: boolean }
export interface BodyValidation { issues: ValidationIssue[] }
type PublishFields = {
  folder?: unknown; folderName?: unknown; slug?: unknown; title?: unknown; lang?: unknown;
  html?: unknown; password?: unknown; note?: unknown;
};
type RotateFields = { password?: unknown; html?: unknown };

export const validateSlug = (s: unknown): s is string => typeof s === "string" && SLUG_RE.test(s);

/** A BCP-47-shaped language tag (en, hr, en-US, zh-Hant…). `null`/`undefined` is valid: the
 *  artefact then defaults to `en`. */
export const validateLang = (s: unknown): boolean => s == null || (typeof s === "string" && LANG_RE.test(s));

/** Validate an artefact HTML document (contract §1-§2). Pure; never throws.
 *  Returns { errors, warnings }. Publication defers references to the canonical font
 *  capture path, then validates the expanded offline document against its separate cap. */
export function validateArtefactHtml(html: unknown, { checkReferences = true, maxChars = MAX_HTML_CHARS }: HtmlValidationOptions = {}): HtmlValidation {
  const doc = typeof html === "string" ? html : "";
  const errors: ValidationIssue[] = [], warnings: ValidationIssue[] = [];

  if (doc.includes("\uFFFD"))
    errors.push({ code: "not-utf8", message: "document is not valid UTF-8 (contains U+FFFD replacement characters)" });

  if (!/<\s*!doctype\s+html/i.test(doc) || !/<html[\s>]/i.test(doc))
    errors.push({ code: "incomplete-document", message: "missing <!doctype html> or not a complete <html> document" });

  if (checkReferences && (REMOTE_SRC_HREF_RE.test(doc) || CSS_IMPORT_RE.test(doc) || REMOTE_CSS_URL_RE.test(doc)))
    errors.push({ code: "external-reference", message: "view-time network reference: src/href with an http(s) host, @import, or url(http…)" });

  if (doc.length > maxChars)
    errors.push({ code: "too-large", message: `document is ${doc.length} characters; the limit is ${maxChars}` });

  if (doc.includes("{{"))
    warnings.push({ code: "template-braces", message: "{{…}} sequences found — an unrendered template was probably left in" });

  if ((doc.match(/<\/head>/gi) ?? []).length > 1)
    warnings.push({ code: "multiple-head", message: "more than one </head>; platform head injection becomes ambiguous" });

  return { errors, warnings };
}

/** Validate a write-API JSON body (publish route). Returns { issues }; an empty array means valid.
 *  Checks are independent — every problem is reported, in field order. Never throws. */
export function validatePublishBody(value: unknown): BodyValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { issues: [{ code: "invalid-payload", message: "request body must be a JSON object" }] };

  const body = value as PublishFields;
  const issues: ValidationIssue[] = [];
  const flag = (code: string, message: string, field: string) => issues.push({ code, message, field });

  if (!validateSlug(body.folder))
    flag("invalid-slug", `folder slug is malformed (expected ${SLUG_RE.source})`, "folder");

  if (body.folderName != null && (typeof body.folderName !== "string" || body.folderName.length > MAX_FOLDER_NAME))
    flag("invalid-folder-name", `folderName must be a string of at most ${MAX_FOLDER_NAME} characters`, "folderName");

  if (!validateSlug(body.slug))
    flag("invalid-slug", `slug is malformed (expected ${SLUG_RE.source})`, "slug");

  if (typeof body.title !== "string" || body.title.length === 0 || body.title.length > MAX_TITLE_CHARS)
    flag("invalid-title", `title is required (1-${MAX_TITLE_CHARS} characters)`, "title");

  if (!validateLang(body.lang))
    flag("invalid-lang", "lang must be a BCP-47 language tag like en or en-US (null defaults to en)", "lang");

  if (typeof body.html !== "string" || body.html.length === 0)
    flag("missing-html", "html must be a non-empty string containing the artefact document", "html");

  if (body.password != null && (typeof body.password !== "string" || body.password.length < MIN_PASSWORD))
    flag("weak-password", `password must be at least ${MIN_PASSWORD} characters when provided`, "password");

  if (body.note != null && (typeof body.note !== "string" || body.note.length > MAX_NOTE_CHARS))
    flag("invalid-note", `note must be a string of at most ${MAX_NOTE_CHARS} characters`, "note");

  return { issues };
}

/** Validate a write-API JSON body (rotate-gate route): set or clear the password gate, optionally
 *  with a fresh document. `password: null` clears the gate and an omitted `password` leaves it
 *  untouched; a string must clear the same 8-character floor as publish (ADR 0011). `html` is
 *  optional but, when present, must be a string (anything else is `invalid-html`) and non-empty
 *  (an empty string is `missing-html`). Returns { issues }; an empty array means valid. Checks
 *  are independent. Never throws. */
export function validateRotateBody(value: unknown): BodyValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { issues: [{ code: "invalid-payload", message: "request body must be a JSON object" }] };

  const body = value as RotateFields;
  const issues: ValidationIssue[] = [];
  const flag = (code: string, message: string, field: string) => issues.push({ code, message, field });

  if (body.password != null && (typeof body.password !== "string" || body.password.length < MIN_PASSWORD))
    flag("invalid-password", `password must be null or a string of at least ${MIN_PASSWORD} characters`, "password");

  if (body.html != null && typeof body.html !== "string")
    flag("invalid-html", "html must be a string containing the artefact document", "html");
  else if (body.html === "")
    flag("missing-html", "html must be a non-empty string containing the artefact document", "html");

  return { issues };
}
