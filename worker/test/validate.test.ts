import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  validateSlug, validateLang, validateArtefactHtml, validatePublishBody, validateRotateBody,
} from "../src/validate.js";
import { validatePageFragment } from "../src/page-validation.js";

const MAX_HTML_CHARS = 1_500_000;

/** A document that passes every check — no errors, no warnings, in either gate mode. */
const CLEAN_DOC = "<!doctype html><html><head><title>ok</title></head><body>fine</body></html>";
/** The clean document padded to an exact total length (suffix padding keeps doctype/<html> intact). */
const sizedDoc = (total: number): string => CLEAN_DOC + "x".repeat(total - CLEAN_DOC.length);
const PAGE_PNG = Buffer.from(readFileSync(new URL("./fixtures/page-image.png", import.meta.url))).toString("base64");
const PAGE_JPEG = Buffer.from(readFileSync(new URL("./fixtures/page-photo.jpg", import.meta.url))).toString("base64");
const validPage = `<main><h1>Report</h1><figure><img src="data:image/jpeg;base64,${PAGE_JPEG}" alt="A person walking beside a lake" width="96" height="72"><figcaption>Lake walk</figcaption></figure><img src="data:image/png;base64,${PAGE_PNG}" alt="" width="8" height="8"></main>`;

const u16be = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const u32be = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const fullBox = (version = 0) => Buffer.from([version, 0, 0, 0]);
const bmffBox = (type: string, payload: Buffer) =>
  Buffer.concat([u32be(payload.length + 8), Buffer.from(type), payload]);
type AvifItemFixture = { id: number; type: string; method: 0 | 1; offset: number; length: number };
function avifItemsFixture(items: AvifItemFixture[], primaryId: number, payload: Buffer,
  references: Array<{ from: number; to: number[] }> = [], idatOffset?: number): Buffer {
  const ftyp = bmffBox("ftyp", Buffer.concat([Buffer.from("avif"), u32be(0)]));
  const pitm = bmffBox("pitm", Buffer.concat([fullBox(), u16be(primaryId)]));
  const infe = items.map(({ id, type }) => bmffBox("infe",
    Buffer.concat([fullBox(2), u16be(id), u16be(0), Buffer.from(type), Buffer.from([0])])));
  const iinf = bmffBox("iinf", Buffer.concat([fullBox(), u16be(infe.length), ...infe]));
  const iloc = bmffBox("iloc", Buffer.concat([
    Buffer.from([1, 0, 0, 0, 0x44, 0x40]), u16be(items.length),
    ...items.map(({ id, method, offset, length }) => Buffer.concat([
      u16be(id), u16be(method), u16be(0), u32be(0), u16be(1), u32be(offset), u32be(length),
    ])),
  ]));
  const ipco = bmffBox("ipco", bmffBox("ispe", Buffer.concat([fullBox(), u32be(8), u32be(8)])));
  const ipma = bmffBox("ipma", Buffer.concat([fullBox(), u32be(0)]));
  const iprp = bmffBox("iprp", Buffer.concat([ipco, ipma]));
  const iref = references.length ? bmffBox("iref", Buffer.concat([
    fullBox(), ...references.map(({ from, to }) => bmffBox("dimg", Buffer.concat([u16be(from), u16be(to.length), ...to.map(u16be)]))),
  ])) : null;
  const beforeIdat = [pitm, iinf, iloc, iprp, ...(iref ? [iref] : [])];
  const idat = bmffBox("idat", payload);
  const metaPayload = Buffer.concat([fullBox(), ...beforeIdat, idat]);
  const idatPayloadOffset = ftyp.length + 12 + beforeIdat.reduce((size, child) => size + child.length, 0) + 8;
  let free = Buffer.alloc(0);
  if (idatOffset !== undefined) {
    const freeSize = idatOffset - idatPayloadOffset;
    assert(freeSize >= 8, "fixture padding must leave room for a BMFF free box");
    free = bmffBox("free", Buffer.alloc(freeSize - 8));
  }
  return Buffer.concat([ftyp, free, bmffBox("meta", metaPayload)]);
}

const avifPage = (bytes: Uint8Array) =>
  `<img src="data:image/avif;base64,${Buffer.from(bytes).toString("base64")}" alt="pixel" width="8" height="8">`;

test("page fragment validation accepts real JPEG and PNG data images", () => {
  assert.doesNotThrow(() => validatePageFragment(validPage));
});

test("aurora hero figures reject unwrapped direct text but accept text in a child surface", () => {
  const aurora = '<header data-variant="hero" data-style="aurora"><figure>';
  assert.throws(() => validatePageFragment(`${aurora}Visible text</figure></header>`), /aurora|direct text|surface/i);
  assert.doesNotThrow(() => validatePageFragment(`${aurora}<span>Visible text</span></figure></header>`));
  assert.doesNotThrow(() => validatePageFragment('<header data-variant="hero"><figure>Visible text</figure></header>'));
});

test("page validation rejects source tags discarded by fragment parsing", () => {
  for (const html of [
    '<body onload="alert(1)"><p>ok</p></body>',
    '<p>ok</p><body onload="alert(1)"></body>',
  ]) assert.throws(() => validatePageFragment(html));
});

test("page validation accepts registered inline token values", () => {
  for (const style of [
    "--a67-accent:#123;--a67-heading-weight:100;--a67-section-gap:clamp(1rem,2vw,4rem);--a67-card-border:1px solid var(--a67-line);--a67-table-stripe:color-mix(in srgb,var(--a67-muted) 6%,var(--a67-surface))",
    "--a67-heading-weight:900;--a67-card-pad:calc(1rem + 4px)",
    "--a67-font-heading:system-ui,sans-serif",
    "--a67-font-mono:ui-monospace,monospace",
    "--a67-radius:1rem",
    "--a67-space:1.15rem",
    "--a67-density:.75",
    "--a67-density:1.25",
    "--a67-accent:#123;--a67-line:var(--a67-accent)",
    "--a67-shadow:0 12px 36px #1729441c",
    "--a67-table-head-bg:var(--a67-surface)",
    "--a67-section-rule:1px solid var(--a67-line)",
  ]) assert.doesNotThrow(() => validatePageFragment(`<p style="${style}">token</p>`), style);
});
test("page validation rejects important, out-of-range, and unapproved token values", () => {
  const styles = [
    "--a67-accent:#123!important",
    "--a67-heading-weight:0",
    "--a67-heading-weight:1000",
    "--a67-heading-weight:99",
    "--a67-heading-weight:901",
    "--a67-density:0.74",
    "--a67-density:1.26",
    "--a67-density:1;--a67-heading-weight:var(--a67-density)",
    "--a67-radius:expression(alert(1))",
    "--a67-radius:color-mix(in srgb,#123 6%,#456)",
    "--a67-card-pad:expression(alert(1))",
    "--a67-table-head-bg:var(--a67-unknown)",
    "--a67-shadow:drop-shadow(0 0 1px #123)",
  ];
  const accepted = styles.filter(style => {
    try {
      validatePageFragment(`<p style="${style}">no</p>`);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(accepted, []);
});


test("page validation rejects AVIF primary item extents beyond truncated mdat", () => {
  const avif = "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgQAMAAAAABRpc3BlAAAAAAAAAAgAAAAIAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAwbWRhdBIACggYCL9ogIaDQjIaGUeHbiGHnnnmgkAAkEER1USVg8zd6PXXOoA=";
  const bytes = Buffer.from(avif, "base64");
  const mdatType = bytes.indexOf(Buffer.from("mdat"));
  assert.ok(mdatType >= 4);
  const mdatStart = mdatType - 4;
  const truncated = Buffer.from(bytes.subarray(0, mdatStart + 9));
  truncated.writeUInt32BE(9, mdatStart);
  assert.throws(() => validatePageFragment(`<img src="data:image/avif;base64,${truncated.toString("base64")}" alt="pixel" width="8" height="8">`), /image|signature/i);
});

test("page validation accepts real WebP images", () => {
  const webp = "UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAfQq5L0tP+BiOh/AAA=";
  assert.doesNotThrow(() => validatePageFragment(`<img src="data:image/webp;base64,${webp}" alt="pixel" width="1" height="1">`));
});

test("page validation rejects an AVIF brand box without image payload", () => {
  const headerOnly = "AAAAEGZ0eXBhdmlmAAAAAA==";
  assert.throws(() => validatePageFragment(`<img src="data:image/avif;base64,${headerOnly}" alt="pixel" width="1" height="1">`));
});

test("page validation accepts a complete AVIF image item", () => {
  const avif = "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgQAMAAAAABRpc3BlAAAAAAAAAAgAAAAIAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAwbWRhdBIACggYCL9ogIaDQjIaGUeHbiGHnnnmgkAAkEER1USVg8zd6PXXOoA=";
  assert.doesNotThrow(() => validatePageFragment(`<img src="data:image/avif;base64,${avif}" alt="pixel" width="8" height="8">`));
});

test("page validation resolves method-1 AVIF extents relative to idat", () => {
  const payload = Buffer.alloc(40, 0x31);
  const item = { id: 1, type: "av01", method: 1 as const, offset: 0, length: payload.length };
  const valid = avifItemsFixture([item], 1, payload);
  assert.doesNotThrow(() => validatePageFragment(avifPage(valid)));

  const outOfRange = avifItemsFixture([{ ...item, offset: 500 }], 1, payload, [], 500);
  assert.throws(() => validatePageFragment(avifPage(outOfRange)), /image|signature/i);
});

test("page validation rejects method-1 AVIF extents outside idat despite matching file offsets", () => {
  const payload = Buffer.alloc(40, 0x31);
  const bytes = avifItemsFixture([
    { id: 1, type: "av01", method: 1, offset: 500, length: payload.length },
  ], 1, payload, [], 500);
  assert.throws(() => validatePageFragment(avifPage(bytes)), /image|signature/i);
});

test("page validation accepts AVIF grid primary items with coded tile extents", () => {
  const descriptor = Buffer.concat([Buffer.from([0, 0, 0, 0]), u16be(8), u16be(8)]);
  const tile = Buffer.alloc(16, 0x31);
  const bytes = avifItemsFixture([
    { id: 1, type: "grid", method: 1, offset: 0, length: descriptor.length },
    { id: 2, type: "av01", method: 1, offset: descriptor.length, length: tile.length },
  ], 1, Buffer.concat([descriptor, tile]), [{ from: 1, to: [2] }]);
  assert.doesNotThrow(() => validatePageFragment(avifPage(bytes)));
});

test("page validation rejects a PNG without nonempty IDAT image data", () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => Buffer.concat([
    u32be(data.length), Buffer.from(type), data, u32be(0),
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  const png = Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]).toString("base64");
  assert.throws(() => validatePageFragment(`<img src="data:image/png;base64,${png}" alt="pixel" width="1" height="1">`), /image/i);
});

test("page validation rejects AVIF grid tiles whose method-1 extent exceeds idat", () => {
  const descriptor = Buffer.concat([Buffer.from([0, 0, 0, 0]), u16be(8), u16be(8)]);
  const tile = Buffer.alloc(16, 0x31);
  const bytes = avifItemsFixture([
    { id: 1, type: "grid", method: 1, offset: 0, length: descriptor.length },
    { id: 2, type: "av01", method: 1, offset: descriptor.length, length: tile.length + 1 },
  ], 1, Buffer.concat([descriptor, tile]), [{ from: 1, to: [2] }]);
  assert.throws(() => validatePageFragment(avifPage(bytes)), /image|signature/i);
});

test("page SVG paint accepts only currentColor and registered color tokens", () => {
  for (const paint of ["none", "currentColor", "var(--a67-accent)", "var(--a67-c3)"])
    assert.doesNotThrow(() => validatePageFragment(`<svg><path d="M0 0L1 1" fill="${paint}"></path></svg>`));
  for (const paint of ["#fff", "#ffffff", "red", "var(--a67-space)", "var(--accent)"])
    assert.throws(() => validatePageFragment(`<svg><path d="M0 0L1 1" fill="${paint}"></path></svg>`), /svg|paint/i);
});

test("page validation resolves exact Unicode references and rejects mixed NFC/NFD spellings", () => {
  const nfc = "é", nfd = "e\u0301";
  assert.doesNotThrow(() => validatePageFragment(`<input id="${nfc}"><label for="${nfc}">Value</label><span id="label" role="note" aria-labelledby="${nfc}">Name</span>`));
  assert.doesNotThrow(() => validatePageFragment(`<input id="${nfd}"><label for="${nfd}">Value</label>`));
  assert.throws(() => validatePageFragment(`<input id="${nfc}"><label for="${nfd}">Value</label>`), /reference/i);
  assert.throws(() => validatePageFragment(`<span id="${nfc}" role="note">Name</span><input aria-labelledby="${nfd}">`), /reference/i);
  assert.throws(() => validatePageFragment(`<p id="${nfd}">Name</p><a href="#${nfc}">Link</a>`), /reference/i);
  assert.throws(() => validatePageFragment(`<table><thead><tr><th id="${nfc}" scope="col">Value</th></tr></thead><tbody><tr><td headers="${nfd}">1</td></tr></tbody></table>`), /reference/i);
  assert.throws(() => validatePageFragment(`<table id="${nfc}"><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead><tbody><tr><th scope="row">A</th><td>1</td></tr></tbody></table><a67-chart for="${nfd}" type="bar" title="Chart" label-column="Name" value-column="Value"></a67-chart>`), /reference/i);
  assert.throws(() => validatePageFragment(`<p id="${nfc}">Name</p><span id="${nfd}">Duplicate after NFC</span>`), /unique/i);
});

test("page chart numeric validation uses the explicit page locale", () => {
  const html = '<table id="sales"><thead><tr><th>Month</th><th>Revenue</th></tr></thead><tbody><tr><th>April</th><td>1.234,5</td></tr></tbody></table><a67-chart for="sales" type="bar" title="Sales" label-column="Month" value-column="Revenue"></a67-chart>';
  assert.doesNotThrow(() => validatePageFragment(html, { lang: "hr-HR" }));
  assert.throws(() => validatePageFragment(html, { lang: "en-US" }), /numeric/i);
});


test("page validation accepts the SVG viewBox source token", () => {
  assert.doesNotThrow(() => validatePageFragment('<svg viewBox="0 0 10 10"></svg>'));
});

test("page validation accepts explicitly self-closing SVG shapes", () => {
  assert.doesNotThrow(() => validatePageFragment('<svg><circle cx="1" cy="1" r="1"/></svg>'));
});

test("page validation rejects external SVG presentation references", () => {
  assert.throws(() => validatePageFragment('<svg><path d="M0 0L1 1" stroke="url(https://example.test/paint.svg#p)"></path></svg>'));
});
test("page validation resolves local SVG marker references", () => {
  assert.doesNotThrow(() => validatePageFragment('<svg><defs><marker id="m"></marker></defs><path d="M0 0L1 1" marker-end="url(#m)"></path></svg>'));
});

test("page validation rejects non-labelable label references", () => {
  assert.throws(() => validatePageFragment('<p id="x">Text</p><label for="x">Name</label>'));
});
test("page validation rejects label references to hidden inputs", () => {
  assert.throws(() => validatePageFragment('<input id="x" type="hidden"><label for="x">Name</label>'));
});

test("page validation requires chart references to identify records tables", () => {
  assert.throws(() => validatePageFragment('<p id="x">Text</p><a67-chart for="x"></a67-chart>'));
});
test("page validation accepts a chart sourced from an a67-records table", () => {
  const source = '<a67-records id="sales" collection="sales" fields="month,revenue"></a67-records>';
  const chart = '<a67-chart for="sales" type="bar" title="Sales" label-column="month" value-column="revenue"></a67-chart>';
  assert.doesNotThrow(() => validatePageFragment(source + chart));
});

test("page validation accepts schema-driven a67-form descriptors", () => {
  assert.doesNotThrow(() => validatePageFragment(
    '<a67-form collection="rsvp"><label data-field="email" label="Contact address">Email</label></a67-form>',
  ));
});

test("page validation aligns chart columns to runtime headers and rejects hidden chart sources", () => {
  const chart = '<a67-chart for="sales" type="bar" title="Sales" label-column="Month" value-column="Revenue"></a67-chart>';
  const source = '<table id="sales"><thead><tr><th>Month</th><th>Revenue</th></tr></thead><tbody><tr><th scope="row">Total</th><td>12</td></tr></tbody></table>';
  assert.doesNotThrow(() => validatePageFragment(source + chart));
  assert.throws(() => validatePageFragment(
    '<table id="sales"><thead><tr><th>Month</th><th>Revenue</th></tr></thead><tbody><tr><th>Total</th><td>12</td></tr></tbody></table>' +
    '<a67-chart for="sales" type="bar" title="Sales" label-column="Total" value-column="Revenue"></a67-chart>',
  ));
  for (const table of [
    source.replace('<table id="sales">', '<table id="sales" hidden="">'),
    source.replace('<table id="sales">', '<div hidden=""><table id="sales">').replace('</table>', '</table></div>'),
  ]) assert.throws(() => validatePageFragment(table + chart), /referenced table and its ancestors must be visible/);
});

test("page validation resolves matching decomposed Unicode references without normalizing the DOM", () => {
  assert.doesNotThrow(() => validatePageFragment('<p id="e&#x301;">Text</p><a href="#e&#x301;">Link</a>'));
});

test("page fragment validation rejects missing image alternatives and intrinsic dimensions", () => {
  for (const html of [
    `<img src="data:image/png;base64,${PAGE_PNG}" width="8" height="8">`,
    `<img src="data:image/png;base64,${PAGE_PNG}" alt="pixel" height="8">`,
    `<img src="data:image/png;base64,${PAGE_PNG}" alt="pixel" width="8">`,
  ]) assert.throws(() => validatePageFragment(html), /page|image|attribute/i);
});

test("page fragment validation rejects unsupported and malformed image sources", () => {
  for (const src of [
    "https://example.test/image.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/html;base64,PGgxPk5vPC9oMT4=",
    "data:image/jpeg;base64,iVBORw0KGgo=",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/jpeg;base64,/9j/",
    "data:image/png;base64,%%%",
    `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString("base64")}`,
  ]) assert.throws(() => validatePageFragment(`<img src="${src}" alt="image" width="1" height="1">`), /page|image|source|base64|size/i);
  assert.throws(() => validatePageFragment(`<img src="data:image/png;base64,${PAGE_PNG}" srcset="data:image/png;base64,${PAGE_PNG} 2x" alt="image" width="8" height="8">`), /page|attribute|srcset/i);
});

test("page fragment validation rejects parse recovery and forbidden source policy", () => {
  for (const html of [
    "<p>missing close",
    "<div><p>misnested</div></p>",
    `<img src='data:image/png;base64,${PAGE_PNG}' alt='image' width='8' height='8'>`,
    '<p id="same">a</p><p id="same">b</p>',
    '<a href="#missing">go</a>',
    '<p class="authored">no classes</p>',
    '<p onclick="run()">no handlers</p>',
    '<div style="color:red">no arbitrary css</div>',
    '<div style="--a67-unknown: 1">no unknown tokens</div>',
    '<script>no</script>',
  ]) assert.throws(() => validatePageFragment(html), /page|parse|source|attribute|reference|style|element|id|image/i);
});

test("site validation remains complete-document-only and accepts legacy markup", () => {
  assert.deepEqual(validateArtefactHtml(CLEAN_DOC).errors, []);
  assert.deepEqual(validateArtefactHtml(validPage).errors.map(({ code }) => code), ["incomplete-document"]);
});

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
test("page validation accepts appendix-defined literal component structures", () => {
  const content = `<main><h1>Report</h1><h2>Overview</h2><a67-toc label="Contents"></a67-toc>
    <a67-kpi label="Visitors" value="1,240" delta="+12%" trend="up"></a67-kpi>
    <table id="sales"><caption>Sales by month</caption><thead><tr><th scope="col">Month</th><th scope="col">Revenue</th></tr></thead><tbody><tr><th scope="row">January</th><td>120</td></tr></tbody></table>
    <a67-chart for="sales" type="bar" title="Revenue by month" label-column="Month" value-column="Revenue"></a67-chart>
    <a67-tabs><div role="tablist"><button id="one-tab" type="button" role="tab" aria-controls="one-panel" aria-selected="true" tabindex="0">One</button><button id="two-tab" type="button" role="tab" aria-controls="two-panel" aria-selected="false" tabindex="-1">Two</button></div><section id="one-panel" role="tabpanel" aria-labelledby="one-tab">First</section><section id="two-panel" role="tabpanel" aria-labelledby="two-tab" hidden=""></section></a67-tabs>
    <a67-logo label="Example"></a67-logo><a67-logo label=""></a67-logo></main>`;
  assert.doesNotThrow(() => validatePageFragment(content));
});

test("page validation accepts only complete record aggregate KPI bindings", () => {
  assert.doesNotThrow(() => validatePageFragment('<a67-kpi label="Revenue" collection="sales" field="amount" aggregate="sum"></a67-kpi>'));
  for (const html of [
    '<a67-kpi label="Revenue" collection="sales" field="amount"></a67-kpi>',
    '<a67-kpi label="Revenue" value="10" collection="sales" field="amount" aggregate="sum"></a67-kpi>',
    '<a67-kpi label="Revenue" collection="sales" field="amount" aggregate="average"></a67-kpi>',
  ]) assert.throws(() => validatePageFragment(html), html);
});

test("page validation rejects unsupported component values and child structures", () => {
  for (const html of [
    '<a67-kpi label="Revenue" value="10"><span>10</span></a67-kpi>',
    '<a67-kpi label="Revenue" value="10" trend="sideways"></a67-kpi>',
    '<a67-kpi label="Revenue"></a67-kpi>',
    '<a67-toc label="Contents"><span>Authored list</span></a67-toc>',
    '<a67-logo label="Brand"><span>External image</span></a67-logo>',
    '<a67-chart for="sales" type="pie" title="Sales" label-column="Month" value-column="Revenue"></a67-chart>',
    '<a67-chart for="sales" title="Sales" label-column="Month" value-column="Revenue"></a67-chart>',
    '<a67-chart for="missing" type="bar" title="Sales" label-column="Month" value-column="Revenue"></a67-chart>',
    '<a67-chart for="sales" type="bar" title="Sales" label-column="Month" value-column="Revenue"></a67-chart><table id="sales"><tr><td>Month</td></tr></table>',
    '<a67-tabs><div role="tablist"><button type="button" role="tab" id="x" aria-controls="absent">X</button></div></a67-tabs>',
    '<a67-tabs><div role="tablist"><button type="button" role="tab" id="x" aria-controls="p">X</button></div><section id="p" role="tabpanel" aria-labelledby="other">P</section></a67-tabs>',
    '<a67-tabs><div role="tablist"><button id="one" type="button" role="tab" aria-controls="panel-one" aria-selected="false" tabindex="0">One</button></div><section id="panel-one" role="tabpanel" aria-labelledby="one">One</section></a67-tabs>',
  ]) assert.throws(() => validatePageFragment(html), html);
});
test("page validation requires native buttons for tabs", () => {
  assert.throws(() => validatePageFragment('<a67-tabs><div role="tablist"><div id="one" role="tab" aria-controls="panel" aria-selected="true" tabindex="0">One</div></div><section id="panel" role="tabpanel" aria-labelledby="one">One</section></a67-tabs>'));
});

test("page validation permits disabled tabs only when an enabled tab is selected", () => {
  const enabledSelection = '<a67-tabs><div role="tablist"><button id="one" type="button" role="tab" aria-controls="panel-one" aria-selected="true" tabindex="0">One</button><button id="two" type="button" role="tab" aria-controls="panel-two" aria-selected="false" tabindex="-1" disabled="">Two</button></div><section id="panel-one" role="tabpanel" aria-labelledby="one">One</section><section id="panel-two" role="tabpanel" aria-labelledby="two" hidden="">Two</section></a67-tabs>';
  assert.doesNotThrow(() => validatePageFragment(enabledSelection));
  assert.throws(() => validatePageFragment(
    '<a67-tabs><div role="tablist"><button id="one" type="button" role="tab" aria-controls="panel-one" aria-selected="true" tabindex="0" disabled="">One</button></div><section id="panel-one" role="tabpanel" aria-labelledby="one">One</section></a67-tabs>',
  ));
});
