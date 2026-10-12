#!/usr/bin/env node
// Regenerate worker/src/contract.ts from dev-docs/artefact-contract.md.
//
// A Worker cannot read files at runtime, so the served contract is inlined into
// worker/src/contract.ts as a template literal; this script is the only hand that writes
// that file. Running it is idempotent: same markdown in, same bytes out (no timestamps).
// Run this generation step when building after an edit to the source contract.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../dev-docs/artefact-contract.md");
const target = resolve(here, "../src/contract.ts");

// Escape the markdown for life inside a template literal. Order matters: backslashes first,
// then backticks, then `${` — each pass must not re-introduce what a later pass escapes.
const escaped = readFileSync(source, "utf8")
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const file = `// GENERATED FILE — worker/scripts/sync-contract.ts wrote this from
// dev-docs/artefact-contract.md. Do not edit by hand: change the markdown, then re-run the
// script. A Worker cannot read files at runtime, so the contract markdown travels inlined as
// CONTRACT_MD.

/** The agent-facing contract, byte-identical to dev-docs/artefact-contract.md. */
export const CONTRACT_MD = \`${escaped}\`;

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
`;

let previous: string | undefined;
try {
  previous = readFileSync(target, "utf8");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
if (previous !== file) {
  writeFileSync(target, file);
  console.log(`synced ${target} (${escaped.length} chars of markdown from ${source})`);
} else {
  console.log(`unchanged ${target}`);
}
