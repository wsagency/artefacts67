// The public reference endpoint must retain the platform's response hygiene.

import test from "node:test";
import assert from "node:assert/strict";

import { agentInstructions } from "../src/instructions.js";
import { contract } from "../src/contract.js";

test("contract() serves the markdown under the platform hygiene headers", async () => {
  const res = contract();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("contract() documents M1 content-read capability and conditional writes", async () => {
  const body = (await contract().text()).replace(/\s+/g, " ");
  for (const statement of [
    "`can_read_content` is an explicit opt-in on key creation; absent and unchecked values are false, including for existing keys.",
    "Content reads require this capability and the key's current authority; password and visitor shares never authorize the API or MCP read.",
    "Every content read is audited with its outcome and without source content.",
    "`get_artifact({artifact,version?})` returns content only through an explicitly authorized read.",
    "`ifVersion` is optional and must be a positive integer.",
    "the API returns `409 conflict` with `currentVersion`",
    "Omitting `ifVersion` preserves the existing unconditional publish behavior.",
    "Ordinary `site` publishes remain complete-document writes and are unchanged.",
  ]) {
    assert.ok(body.includes(statement), `contract is missing: ${statement}`);
  }
});
test("AI instructions describe the scoped MCP content-read capability", async () => {
  const instructions = agentInstructions("https://example.test", {});
  assert.match(instructions, /Only wak_ master keys may use project data and full MCP tools; an opted-in waa_ key with read scope and current read authority may call only get_artifact\./);
  assert.match(instructions, /get_artifact/);
  assert.match(instructions, /master key with content-read enabled using the console checkbox under Settings → API keys/);
  assert.match(instructions, /scoped artifact key with content-read capability created by POST `\/_api\/keys` with `\{artifact, scopes: "read", can_read_content: true\}`/);
  assert.doesNotMatch(instructions, /artifact key with content-read capability created under Settings → API keys/);
});
test("AI instructions keep complete-document `site` as the default unless `page` is chosen", () => {
  const instructions = agentInstructions("https://example.test", {});
  assert.ok(instructions.includes("By default, author one complete self-contained site HTML document."));
  assert.ok(instructions.includes("Existing and omitted type values remain site; do not switch a user's requested site to page."));
  assert.ok(instructions.includes('Only use the optional type: "page" when the user or task specifically chooses the constrained fragment format.'));
});
test("contract documents the M2 page contract without changing site compatibility", async () => {
  const body = (await contract().text()).replace(/\s+/g, " ");
  for (const statement of [
    "Page artefacts use `type: \"page\"`",
    "Existing and omitted `type` values remain `site`",
    "Page HTML is a fragment, not a complete document",
    "Theme references use `ThemeRef`",
    "Platform themes are `report`, `editorial`, and `launch`",
    "The trusted inline page kit",
    "Content Security Policy",
    "`window.artefacts.data.schema(collection)`",
  ]) {
    assert.ok(body.includes(statement), `contract is missing: ${statement}`);
  }
});
test("contract distinguishes raw page source copying from composed page downloads", async () => {
  const body = (await contract().text()).replace(/\s+/g, " ");
  assert.ok(body.includes("Copy HTML returns the authored source exactly, which is a fragment for `page` artefacts and a complete document for `site` artefacts."));
  assert.ok(body.includes("For a page with a registered theme, Download HTML wraps that fragment in a standalone document with the trusted kit, selected compiled theme, runtime, and CSP, including the platform shell, `PAGE_KIT_CSS`, and `PAGE_KIT_RUNTIME`."));
  assert.ok(body.includes("Download HTML preserves authored complete-document source for `site`."));
  assert.ok(body.includes("The composed viewer and gallery Content Security Policy sets `default-src 'none'`; it allows inline, `data:`, and `blob:` scripts (including `unsafe-eval`), inline styles, `data:`/`blob:` images, fonts and media, and same-origin `/assets/favicon.ico` and `/assets/ws-logo.svg` images."));
  assert.ok(body.includes("`connect-src 'none'` blocks network connections; form actions, base URLs, objects, frames, and workers are denied. No arbitrary external resource origins are allowed."));
  assert.ok(body.includes("Composed page downloads exclude the hosted SDK, live persistence, and application data;"));
});

test("contract specifies page grammar and the shipped unknown-theme fallback", async () => {
  const body = (await contract().text()).replace(/\s+/g, " ");
  for (const statement of [
    "Page grammar permits only these semantic HTML elements: `body`, `header`, `footer`, `main`, `nav`",
    "static scriptless SVG elements: `svg`, `g`, `path`, `circle`",
    "Its P1 kit components are `a67-toc`, `a67-kpi`, `a67-chart`, `a67-tabs`, `a67-form`, `a67-checklist`, `a67-logo`, and `a67-records`",
    "`a67-custom` is deferred",
    "Page attributes are allowlisted per element; these lists are exhaustive",
    "Source attributes must be double-quoted and unique; malformed nesting, implied repair/error recovery",
    "Authoring excludes the `class` attribute, `<script>` and `<style>` elements, authored `<form>` and `<textarea>` elements, `on*` event attributes, and external resources",
    "Inline `style` is the only object override. It accepts declarations of exactly one registered custom property per declaration",
    "| `img` | Required `src` only as strict-base64 `data:image/{png,jpeg,webp,gif,avif};base64,…` with matching MIME/signature and decoded bytes ≤1 MiB; required `alt`; positive-integer intrinsic `width` and `height`",
    "literal colours are rejected. `stop-color` is not an allowed attribute.",
    "`data-tone` = `accent|muted|inverse|info|ok|warn|crit`; inverse may not be nested within another inverse region or applied on/inside `table`, `thead`, `th`, `pre`, or `code`",
    "If a valid but unregistered theme slug is stored, viewer rendering falls back to `report`, while Download HTML returns the authored fragment because no compiled theme is available",
  ]) {
    assert.ok(body.includes(statement), `contract is missing: ${statement}`);
  }
});
test("served contract pins the exact page CSS token grammars without an external appendix", async () => {
  const body = (await contract().text()).replace(/\s+/g, " ");
  for (const statement of [
    "| `a` | `href` only for same-document fragments |",
    "| `img` | Required `src` only as strict-base64 `data:image/{png,jpeg,webp,gif,avif};base64,…` with matching MIME/signature and decoded bytes ≤1 MiB",
    "| `a67-form` | `collection`, `submit-label`; direct field descriptors use `data-field`, `label` |",
    "| Color | `bg`, `surface`, `ink`, `muted`, `line`, `accent`, `accent-ink`, `on-accent`, `ok`, `warn`, `crit`, `focus`, `c1`, `c2`, `c3`, `c4`, `c5`, `c6` |",
    "| Font stack | `font-heading`, `font-body`, `font-mono` |",
    "| Dimension | `radius`, `space`, `section-gap`, `card-pad` |",
    "| Density | `density` |",
    "| Heading weight | `heading-weight` |",
    "| Shadow | `shadow` |",
    "| Border | `card-border`, `section-rule` |",
    "| Table head color | `table-head-bg` |",
    "| Table stripe color | `table-stripe` |",
    "whole-value `var(--a67-name)` reference to a different registered token in the same domain",
    "A token cannot reference itself. References cannot be combined with any other value text",
    "color references among color, table-head, and table-stripe tokens; font-stack references among font tokens; or references within the dimension, density, heading-weight, shadow, or border class",
    "`var` is case-insensitive, the `(` immediately follows its name, whitespace inside the parentheses is optional, and the referenced token name is lowercase",
    "case-insensitive hexadecimal `#rgb` or `#rrggbb`",
    "`system-ui, sans-serif`; `ui-monospace, monospace`; `\"manrope\"` or `'manrope'` followed by `, sans-serif`; or `\"ibm plex mono\"` or `'ibm plex mono'` followed by `, monospace`",
    "are parsed and serialized by css-tree before `checkStyle` compares the value, so either quote delimiter is accepted; family-name case is ignored",
    "CSS backslash escapes are rejected before parsing",
    "Density: a nonnegative decimal number with no sign or exponent, written as digits with an optional decimal fraction or as `.digits`; its numeric value is inclusive from `0.75` to `1.25`",
    "Heading weight: any integer from `100` through `900`, inclusive",
    "Dimension tokens: `0` (unitless) or a nonnegative decimal number followed by exactly one of `px`, `rem`, `em`, `vw`, `vh`, or `%`. A number is digits with an optional decimal fraction, or `.digits`; signs and exponents are not accepted",
    "whitespace around the operators and commas is optional, as is whitespace just inside function parentheses",
    "the color is case-insensitive `#rgb`, `#rrggbb`, or `#rrggbbaa`",
    "three or four dimensions followed by a color",
    "one of `solid`, `dashed`, `dotted`, `double`",
    "`color-mix(in srgb, <color> <percentage>, <color>)`",
    "there is no whitespace before `(`, optional CSS whitespace is accepted just inside parentheses and around commas, `in srgb` has one space, and at least one whitespace separates the first color and percentage",
    "first color's percentage uses `(?:100(?:\\.0+)?|\\d{1,2}(?:\\.\\d+)?|\\.\\d+)%` and has a numeric value from `0` through `100` inclusive",
    "Dimension values alone may use `calc()`, `clamp()`, and `var()`; table-stripe values alone may use `color-mix()` and `var()`",
    "every `url()` function, including `data:` URLs",
    "backslash escape, CSS parser `Url`, `Atrule`, or `Raw` node",
  ]) {
    assert.ok(body.includes(statement), `contract is missing: ${statement}`);
  }
  assert.doesNotMatch(body, /`url\(\)` is rejected except|bounded approved units|platform-parsed safe subsets/);
  assert.doesNotMatch(body, /tickets\/open\//, "public contract must not require a repository-relative appendix URL");
});

