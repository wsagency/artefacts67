import test from "node:test";
import assert from "node:assert/strict";

import { validateArtefactHtml } from "../src/validate.js";
import { validatePageFragment } from "../src/page-validation.js";

test("page inverse tone accepts independent sections and ordinary table/code surfaces", () => {
  assert.doesNotThrow(() => validatePageFragment(
    '<main><section data-tone="inverse"><h2>Inverse heading</h2><pre><code>code sample</code></pre><table><thead><tr><th scope="col">Heading</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table></section><section data-tone="inverse"><p>Independent inverse region</p></section></main>',
  ));
});

test("page inverse tone rejects nesting and opaque table/code placement", () => {
  const forbidden = [
    '<section data-tone="inverse"><div data-tone="inverse">nested</div></section>',
    '<table data-tone="inverse"><tbody><tr><td>table</td></tr></tbody></table>',
    '<table><tbody><tr><td><span data-tone="inverse">inside table</span></td></tr></tbody></table>',
    '<table><thead data-tone="inverse"><tr><th>heading</th></tr></thead></table>',
    '<table><thead><tr><th><span data-tone="inverse">inside thead</span></th></tr></thead></table>',
    '<table><tbody><tr><th data-tone="inverse">heading</th></tr></tbody></table>',
    '<table><tbody><tr><th><span data-tone="inverse">inside th</span></th></tr></tbody></table>',
    '<pre data-tone="inverse">code</pre>',
    '<pre><span data-tone="inverse">inside pre</span></pre>',
    '<code data-tone="inverse">inline code</code>',
    '<code><span data-tone="inverse">inside code</span></code>',
  ];
  for (const html of forbidden) assert.throws(
    () => validatePageFragment(html),
    /data-tone="inverse".*(?:nested|not allowed)|(?:nested|not allowed).*data-tone="inverse"/i,
    html,
  );
});

test("inverse-tone page restrictions do not change complete-document site validation", () => {
  const legacySite = '<!doctype html><html><body><table data-tone="inverse"><thead><tr><th><span data-tone="inverse">legacy content</span></th></tr></thead></table></body></html>';
  assert.deepEqual(validateArtefactHtml(legacySite).errors, []);
});
