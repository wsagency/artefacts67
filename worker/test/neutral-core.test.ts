// The neutral core (Artefacts67): origin derived from the request or PUBLIC_ORIGIN, the root
// redirect, the configured legacy-host redirect, a cron that never freezes the origin, and the
// operator line. Hosts are example hosts only.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import * as Effect from "effect/Effect";
import worker from "../src/index.js";
import { originOf } from "../src/http.js";
import { otpauthUrl } from "../src/auth.js";
import { EHLO_NAME } from "../src/mail.js";
import { openStore } from "../src/store.js";
import type { WorkerEnv } from "../src/types.js";
import { openD1Shim } from "./db.js";
import { memoryBucket, rateLimitBinding, TEST_MASTER } from "./doubles.js";

const env: WorkerEnv = { DB: openD1Shim(), ARTIFACTS: memoryBucket(), RATELIMIT: rateLimitBinding(), ARTEFACTS_MASTER_KEY: TEST_MASTER };
await Effect.runPromise(openStore(env.DB).users.create({
  id: "owner0000000a1", email: "owner@example.test", name: "Owner", role: "owner", passwordHash: "{}",
}));

test("root redirects to /login", async () => {
  const res = await worker.fetch(new Request("https://fork.example/"), env);
  assert.equal(res.status, 302); assert.equal(res.headers.get("location"), "/login");
});
test("originOf strips one trailing slash", () => {
  assert.equal(originOf({ PUBLIC_ORIGIN: "https://app.example/" }, new Request("https://x.example/")), "https://app.example");
  assert.equal(originOf({}, new Request("https://fork.example/a")), "https://fork.example");
});
test("legacy redirect keeps path and query, for every method", async () => {
  const e = { ...env, PUBLIC_ORIGIN: "https://app.example", LEGACY_HOSTS: "old.example" };
  for (const [url, to] of [["https://old.example/s/tok/", "https://app.example/s/tok/"], ["https://old.example/a/b?x=1", "https://app.example/a/b?x=1"]] as const) {
    const res = await worker.fetch(new Request(url, { method: "POST" }), e);
    assert.equal(res.status, 308); assert.equal(res.headers.get("location"), to);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});
test("legacy redirect keeps protocol-relative paths on the app host", async () => {
  const res = await worker.fetch(new Request("https://old.example//evil.example/x?y=1"), { ...env, PUBLIC_ORIGIN: "https://app.example", LEGACY_HOSTS: "old.example" });
  assert.equal(res.headers.get("location"), "https://app.example//evil.example/x?y=1");
});
test("legacy host list is trimmed and case-insensitive; inert without PUBLIC_ORIGIN", async () => {
  assert.equal((await worker.fetch(new Request("https://old.example/_health"), { ...env, PUBLIC_ORIGIN: "https://app.example", LEGACY_HOSTS: " Old.Example , " })).status, 308);
  assert.notEqual((await worker.fetch(new Request("https://old.example/_health"), { ...env, LEGACY_HOSTS: "old.example" })).status, 308);
  assert.notEqual((await worker.fetch(new Request("https://other.example/_health"), { ...env, PUBLIC_ORIGIN: "https://app.example", LEGACY_HOSTS: "old.example" })).status, 308);
});
test("cron first does not freeze the RP ID", async () => {
  const fresh = { DB: openD1Shim(), ARTIFACTS: memoryBucket(), RATELIMIT: rateLimitBinding(), ARTEFACTS_MASTER_KEY: TEST_MASTER }; // new DB => new runtime cache entry; no PUBLIC_ORIGIN
  await worker.scheduled({} as ScheduledController, fresh, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
  const res = await worker.fetch(new Request("https://fork.example/passkey/login/begin", { method: "POST", headers: { origin: "https://fork.example", "content-type": "application/json" }, body: "{}" }), fresh);
  assert.equal((await res.json() as { options: { rpId: string } }).options.rpId, "fork.example");
});
test("auth payload carries operator only when set", async () => {
  const page = async (e: WorkerEnv) => (await worker.fetch(new Request("https://fork.example/login"), e)).text();
  assert.doesNotMatch(await page(env), /Hosted by/);
  const html = await page({ ...env, OPERATOR_NAME: '<b>A&B "x"</b>' });
  // the bootstrap JSON escapes < > & as \u003c \u003e \u0026 (views.ts:169); Solid renders it as text
  assert.match(html, /"operator":"\\u003cb\\u003eA\\u0026B/);
  assert.doesNotMatch(html, /<b>A&B/);
});

for (const path of ["/instructions", "/llms.txt"]) {
  test(`${path} uses the request origin or PUBLIC_ORIGIN`, async () => {
    const a = await (await worker.fetch(new Request(`https://fork.example${path}`), {} as WorkerEnv)).text();
    assert.match(a, /https:\/\/fork\.example/); assert.doesNotMatch(a, /wsagency\.io/);
    const b = await (await worker.fetch(new Request(`https://fork.example${path}`), { PUBLIC_ORIGIN: "https://app.example" } as WorkerEnv)).text();
    assert.match(b, /https:\/\/app\.example/); assert.doesNotMatch(b, /https:\/\/fork\.example/);
  });
  test(`${path} names a template only when DESIGN_TEMPLATE_URL is set`, async () => {
    const off = await (await worker.fetch(new Request(`https://fork.example${path}`), { DESIGN_TEMPLATE_URL: "  " } as WorkerEnv)).text();
    assert.doesNotMatch(off, /Design template|report-template/i);
    const on = await (await worker.fetch(new Request(`https://fork.example${path}`), { DESIGN_TEMPLATE_URL: "https://site.example/t.html" } as WorkerEnv)).text();
    assert.match(on, /https:\/\/site\.example\/t\.html/);
  });
}
test("operator and template values are escaped on the page, plain in llms.txt", async () => {
  const e = { OPERATOR_NAME: '<b>A&B "x"</b>', DESIGN_TEMPLATE_URL: 'https://site.example/t.html?a=1&b="2"' } as WorkerEnv;
  const page = await (await worker.fetch(new Request("https://fork.example/instructions"), e)).text();
  assert.match(page, /Hosted by &lt;b&gt;A&amp;B &quot;x&quot;&lt;\/b&gt;/); assert.match(page, /t\.html\?a=1&amp;b=&quot;2&quot;/);
  const txt = await (await worker.fetch(new Request("https://fork.example/llms.txt"), e)).text();
  assert.match(txt, /t\.html\?a=1&b="2"/);
});
test("documentation is plain and uses ARTEFACTS67_KEY", async () => {
  const page = await (await worker.fetch(new Request("https://fork.example/instructions"), {} as WorkerEnv)).text();
  assert.match(page, /<h1>Artefacts67 documentation<\/h1>/);
  assert.doesNotMatch(page, /Why use it|Motion walkthrough|WS_KEY\b|WS-Artefacts/);
  assert.match(await (await worker.fetch(new Request("https://fork.example/llms.txt"), {} as WorkerEnv)).text(), /ARTEFACTS67_KEY/);
});

test("MCP client snippets use the deployment origin", async () => {
  const text = await (await worker.fetch(new Request("https://fork.example/llms.txt"), {
    ...env, PUBLIC_ORIGIN: "https://app.example",
  })).text();
  assert.match(text, /codex mcp add artefacts67 --url https:\/\/app\.example\/_mcp/);
  assert.match(text, /claude mcp add --transport http --scope user artefacts67 https:\/\/app\.example\/_mcp/);
  assert.match(text, /"url":"https:\/\/app\.example\/_mcp"/);
  assert.doesNotMatch(text, /https:\/\/fork\.example\/_mcp/);
});
test("no core source references the report template asset", () => { for (const f of ["src/instructions.ts", "src/contract.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /ws-agency-report-template/); }); // tests run in worker/

test("a fresh database does not seed mail_from", async () => {
  const db = openD1Shim(); // applies all migrations
  const row = await db.prepare("SELECT mail_from FROM platform_settings").first<{ mail_from: string }>();
  assert.equal(row?.mail_from ?? "", "");
});
test("product identifiers are artefacts67", () => {
  assert.match(otpauthUrl("JBSWY3DPEHPK3PXP"), /issuer=Artefacts67/); // auth.ts:24 default
  assert.equal(EHLO_NAME, "artefacts67");
});
test("documentation and folder index use the kit", async () => {
  const page = await (await worker.fetch(new Request("https://fork.example/instructions"), {} as WorkerEnv)).text();
  assert.match(page, /<html class="wsa-brand" data-identity="original" data-appearance="auto"/);
  for (const f of ["fonts.css", "tokens.css", "footer.css"]) assert.match(page, new RegExp(`/assets/ws-design-kit/${f}`));
  assert.match(page, /products\/artefacts67\/original\/logo-white\.svg/); assert.match(page, /aria-label="Made with love by WS Agency"/);
  assert.match(page, /rel="icon" type="image\/svg\+xml" href="\/assets\/ws-design-kit\/products\/artefacts67\/original\/favicon\.svg"/);
  assert.doesNotMatch(page, /ws-artefacts-logo/);
});
test("the console page shell links the kit and both favicons", async () => {
  const page = await (await worker.fetch(new Request("https://fork.example/login"), env)).text();
  for (const f of ["fonts.css", "tokens.css", "footer.css"]) assert.match(page, new RegExp(`<link rel="stylesheet" href="/assets/ws-design-kit/${f}">`));
  assert.match(page, /<link rel="icon" type="image\/svg\+xml" href="\/assets\/ws-design-kit\/products\/artefacts67\/original\/favicon\.svg"><link rel="icon" href="\/assets\/favicon\.ico">/);
});
test("the Web Analytics beacon appears only when WEB_ANALYTICS_TOKEN is set", async () => {
  const page = async (e: WorkerEnv) => (await worker.fetch(new Request("https://fork.example/login"), e)).text();
  for (const unset of [env, { ...env, WEB_ANALYTICS_TOKEN: "  " }]) assert.doesNotMatch(await page(unset), /cloudflareinsights|cf-beacon/);
  assert.match(await page({ ...env, WEB_ANALYTICS_TOKEN: " tok'<1> " }), /<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon='\{&quot;token&quot;:&quot;tok&#39;&lt;1&gt;&quot;\}'><\/script>/);
  assert.doesNotMatch(await page(env), /cloudflareinsights/); // a set token never leaks into a later request without it
});
test("documentation and sign-in link the public source repository from one constant", async () => {
  assert.match(await (await worker.fetch(new Request("https://fork.example/instructions"), env)).text(), /href="https:\/\/github\.com\/wsagency\/artefacts67">Source code \(MIT\)<\/a>/);
  assert.match(await (await worker.fetch(new Request("https://fork.example/login"), env)).text(), /"source":"https:\/\/github\.com\/wsagency\/artefacts67"/);
  const sources = readdirSync("src", { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts")).map(f => readFileSync(`src/${f}`, "utf8")).join("\n"); // tests run in worker/
  assert.equal(sources.match(/github\.com\/wsagency\/artefacts67"/g)?.length, 1);
});
