import test from "node:test";
import assert from "node:assert/strict";

import {
  validateSlug, validateLang, validateArtefactHtml, validatePublishBody, validateRotateBody,
} from "../src/validate.js";

const MAX_HTML_CHARS = 1_500_000;

/** A document that passes every check — no errors, no warnings, in either gate mode. */
const CLEAN_DOC = "<!doctype html><html><head><title>ok</title></head><body>fine</body></html>";
/** The clean document padded to an exact total length (suffix padding keeps doctype/<html> intact). */
const sizedDoc = (total: number): string => CLEAN_DOC + "x".repeat(total - CLEAN_DOC.length);

// --- validateSlug / validateLang ---------------------------------------------------------------

test("validateSlug: one lowercase path segment, 1-63 chars, both directions", () => {
  for (const ok of ["acme", "a", "x".repeat(63), "acme-corp-2", "q3-report"])
    assert.equal(validateSlug(ok), true, ok);
  for (const bad of ["Acme", "-acme", "a_b", "a/b", "", "x".repeat(64), 42, null, undefined])
    assert.equal(validateSlug(bad), false, String(bad));
});

test("validateLang: BCP-47-shaped tags; null/undefined means the 'en' default", () => {
  for (const ok of ["en", "hr", "haw", "en-US", "zh-Hant", "sr-Latn-RS", "en-abcdefgh", null, undefined])
    assert.equal(validateLang(ok), true, String(ok));
  for (const bad of ["EN", "e", "419", "en-", "en-U", "en-abcdefghi", "", 42])
    assert.equal(validateLang(bad), false, String(bad));
});

// --- validateArtefactHtml: errors ----------------------------------------------------------------

test("validateArtefactHtml: a clean document passes in both gate modes", () => {
  assert.deepEqual(validateArtefactHtml(CLEAN_DOC), { errors: [], warnings: [] });
  assert.deepEqual(validateArtefactHtml(CLEAN_DOC, { gated: true }), { errors: [], warnings: [] });
});

test("not-utf8: U+FFFD replacement characters are rejected", () => {
  const { errors, warnings } = validateArtefactHtml(CLEAN_DOC.replace("fine", "fi\uFFFDne"));
  assert.deepEqual(errors.map((e) => e.code), ["not-utf8"]);
  assert.deepEqual(warnings, []);
});

test("incomplete-document: a fragment without doctype/<html> is rejected", () => {
  const { errors } = validateArtefactHtml("<p>just a fragment</p>");
  assert.deepEqual(errors.map((e) => e.code), ["incomplete-document"]);
});

test("external-reference: src/href with an http(s) host, CSS url(http…), and @import are each rejected", () => {
  for (const doc of [
    CLEAN_DOC.replace("fine", '<img src="https://cdn.example.test/l.png">'),
    CLEAN_DOC.replace("fine", "<style>body { background: url(https://cdn.example.test/b.png); }</style>"),
    CLEAN_DOC.replace("fine", '<style>@import "more.css";</style>'),
  ]) {
    const { errors } = validateArtefactHtml(doc);
    assert.deepEqual(errors.map((e) => e.code), ["external-reference"]);
  }
});

test("too-large: the limit is exactly 1.5 MiB of characters — at the limit passes, one over fails", () => {
  const atLimit = validateArtefactHtml(sizedDoc(MAX_HTML_CHARS));
  assert.equal(atLimit.errors.length, 0);

  const over = validateArtefactHtml(sizedDoc(MAX_HTML_CHARS + 1));
  assert.deepEqual(over.errors.map((e) => e.code), ["too-large"]);
});

// --- validateArtefactHtml: warnings --------------------------------------------------------------

test("template-braces: {{…}} sequences warn without rejecting", () => {
  const { errors, warnings } = validateArtefactHtml(CLEAN_DOC.replace("fine", "{{title}}"));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => w.code), ["template-braces"]);
});

test("multiple-head: more than one </head> warns", () => {
  const { errors, warnings } = validateArtefactHtml(
    "<!doctype html><html><head></head><head></head><body>fine</body></html>",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => w.code), ["multiple-head"]);
});

// --- validatePublishBody -------------------------------------------------------------------------

const VALID_PUBLISH = {
  folder: "acme",
  folderName: "Acme Studio",
  slug: "q3-report",
  title: "Q3 report",
  lang: "en-US",
  html: CLEAN_DOC,
  password: "gate-pw1",   // exactly 8 characters — the ADR 0011 floor
  note: "v2 final",
};

test("validatePublishBody: a well-formed body yields zero issues, with or without optionals", () => {
  assert.deepEqual(validatePublishBody(VALID_PUBLISH), { issues: [] });
  assert.deepEqual(
    validatePublishBody({ folder: "acme", slug: "q3-report", title: "Q3 report", html: CLEAN_DOC }),
    { issues: [] },
  );
});

test("invalid-payload: the body must be a JSON object", () => {
  const { issues } = validatePublishBody([VALID_PUBLISH]);
  assert.deepEqual(issues.map((i) => i.code), ["invalid-payload"]);
});

test("every malformed publish field is flagged independently — no issue masks another", () => {
  const { issues } = validatePublishBody({
    folder: "Not A Slug",
    folderName: "n".repeat(121),
    slug: "NO",
    title: "",
    lang: "EN-US",
    html: "",
    password: "short",     // 5 chars < 8
    note: "n".repeat(201),
  });
  assert.deepEqual(issues.map((i) => ({ code: i.code, field: i.field })), [
    { code: "invalid-slug",        field: "folder" },
    { code: "invalid-folder-name", field: "folderName" },
    { code: "invalid-slug",        field: "slug" },
    { code: "invalid-title",       field: "title" },
    { code: "invalid-lang",        field: "lang" },
    { code: "missing-html",        field: "html" },
    { code: "weak-password",       field: "password" },
    { code: "invalid-note",        field: "note" },
  ]);
});

test("weak-password boundary: 8 characters pass, 7 do not (non-strings fail too)", () => {
  assert.deepEqual(
    validatePublishBody({ ...VALID_PUBLISH, password: "gate-pw" }).issues.map((i) => i.code),
    ["weak-password"],
  );
  assert.deepEqual(
    validatePublishBody({ ...VALID_PUBLISH, password: 42 }).issues.map((i) => i.code),
    ["weak-password"],
  );
  assert.deepEqual(validatePublishBody({ ...VALID_PUBLISH, password: null }).issues, []);
});

// --- validateRotateBody --------------------------------------------------------------------------

test("validateRotateBody: setting, clearing, and omitting the gate are all valid", () => {
  assert.deepEqual(validateRotateBody({ password: "gate-pw1" }), { issues: [] });
  assert.deepEqual(validateRotateBody({ password: null }), { issues: [] });
  assert.deepEqual(validateRotateBody({}), { issues: [] });
  assert.deepEqual(validateRotateBody({ password: "gate-pw1", html: CLEAN_DOC }), { issues: [] });
});

test("invalid-password: 7 characters do not clear the 8-character floor", () => {
  const { issues } = validateRotateBody({ password: "gate-pw" });
  assert.deepEqual(issues.map((i) => ({ code: i.code, field: i.field })), [
    { code: "invalid-password", field: "password" },
  ]);
});

test("invalid-html and missing-html: rotate html, when present, must be a non-empty string", () => {
  const badType = validateRotateBody({ html: 42 });
  assert.deepEqual(badType.issues.map((i) => ({ code: i.code, field: i.field })), [
    { code: "invalid-html", field: "html" },
  ]);
  const empty = validateRotateBody({ html: "" });
  assert.deepEqual(empty.issues.map((i) => ({ code: i.code, field: i.field })), [
    { code: "missing-html", field: "html" },
  ]);
});
