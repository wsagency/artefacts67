import test from "node:test";
import assert from "node:assert/strict";
import { Clock, Duration, Effect, Exit } from "effect";
import { prepareArtifactHtml, openArtifactService, captureThemeFonts, FONT_LIMITS } from "../src/fonts.js";
import type { FontFetcher } from "../src/fonts.js";

const document = (head: string, body = "<p>Offline</p>"): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const sheet = "https://fonts.googleapis.com/css2?family=Example:wght@400;700&display=swap";
const font = "https://fonts.gstatic.com/s/example/v1/example.woff2";
// A deterministic transport fixture; format validation checks the container header, not glyph rendering.
const bytes = new Uint8Array(48);
bytes.set(new TextEncoder().encode("wOF2"));
new DataView(bytes.buffer).setUint32(8, bytes.length);
const css = `/* latin */ @font-face { font-family:'Example'; font-style:normal; font-weight:400 700; src:url('${font}') format('woff2'); unicode-range:U+0000-00FF; }`;
const response = (body: BodyInit | null, type: string): Response => new Response(body, { headers: { "content-type": type } });
const provider = (calls: string[] = []): FontFetcher => async (url) => {
  calls.push(url);
  if (url === sheet) return response(css, "text/css; charset=utf-8");
  if (url === font) return response(bytes, "font/woff2");
  throw new Error(`Unexpected resource ${url}`);
};

function cancelAfterAbort(signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

test("Google stylesheet capture embeds font bytes and preserves scripts and face descriptors", async () => {
  const script = '<script>document.addEventListener("DOMContentLoaded",()=>{document.body.dataset.ready="yes"});</script>';
  const source = document(`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${sheet.replaceAll("&", "&amp;")}">`, script);
  const calls: string[] = [];
  const result = await Effect.runPromise(prepareArtifactHtml(source, { fetcher: provider(calls), gated: true }));
  assert.deepEqual(calls, [sheet, font]);
  assert.equal(result.html.includes(`data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}`), true);
  assert.equal(result.html.includes("fonts.googleapis.com"), false);
  assert.equal(result.html.includes("fonts.gstatic.com"), false);
  assert.equal(result.html.includes(script), true);
  assert.equal(result.html.includes("font-weight:400 700"), true);
  assert.equal(result.html.includes("unicode-range:U+0000-00FF"), true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(await Effect.runPromise(prepareArtifactHtml(result.html, { fetcher: () => { throw new Error("must not fetch inline fonts"); } })), result);
});

test("imports and directly authored faces capture once without rewriting unrelated CSS", async () => {
  const calls: string[] = [];
  const untouched = '.card > span { color: rgb(1, 2, 3); --gap:  8px; }';
  const source = document(`<style>@import url("${sheet}") screen;\n${css}\n${untouched}</style>`);
  const result = await Effect.runPromise(prepareArtifactHtml(source, { fetcher: provider(calls) }));
  assert.deepEqual(calls, [sheet, font]);
  assert.equal(result.html.includes("@import"), false);
  assert.equal(result.html.includes("@media screen"), true);
  assert.equal(result.html.includes(untouched), true);
});

test("provider capture cannot redirect to another host or accept credentials/plain HTTP", async () => {
  let calls = 0;
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://internal.example/private" } }); },
  })), { code: "font-provider" });
  assert.equal(calls, 1);
  for (const url of ["http://fonts.googleapis.com/css2?family=X", "https://secret@fonts.googleapis.com/css2?family=X", "https://fonts.googleapis.com:444/css2?family=X"]) {
    await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${url}">`), {
      fetcher: () => { throw new Error("invalid provider must not be fetched"); },
    })), { code: "font-provider" });
  }
});

test("font MIME, signature, response size and provider HTTP errors are explicit failures", async () => {
  const source = document(`<style>${css}</style>`);
  const failures: Array<[() => Response, string]> = [
    [() => response(bytes, "text/html"), "font-format"],
    [() => response("not a font", "font/woff2"), "font-format"],
    [() => new Response(bytes, { headers: { "content-type": "font/woff2", "content-length": String(FONT_LIMITS.fontBytes + 1) } }), "font-limit"],
    [() => new Response("missing", { status: 404 }), "font-fetch"],
  ];
  for (const [make, code] of failures)
    await assert.rejects(Effect.runPromise(prepareArtifactHtml(source, { fetcher: async () => make() })), { code });
});

test("streamed oversized resources fail even without content-length", async () => {
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<style>${css}</style>`), {
    fetcher: async () => response(new Uint8Array(FONT_LIMITS.fontBytes + 1), "font/woff2"),
  })), { code: "font-limit" });
});

test("repeated font references cannot amplify a small input past the expanded document cap", async () => {
  const large = new Uint8Array(1024 * 1024);
  large.set(bytes);
  new DataView(large.buffer).setUint32(8, large.length);
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<style>${css.repeat(12)}</style>`), {
    fetcher: async () => response(large, "font/woff2"),
  })), { code: "font-limit" });
});

test("font providers cannot supply general stylesheets, nested imports or remote script/image dependencies", async () => {
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async () => response("body { display:none }", "text/css"),
  })), { code: "font-css" });
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async () => response(`@import url('${sheet}');`, "text/css"),
  })), { code: "font-css" });
  for (const body of ['<script src="https://cdn.example/script.js"></script>', '<img src="//cdn.example/image.png">', '<style>body{background:url(https://fonts.gstatic.com/s/pixel)}</style>'])
    await assert.rejects(Effect.runPromise(prepareArtifactHtml(document("", body), { fetcher: provider() })), { code: "external-reference" });
});

test("HTML entities and CSS escapes cannot conceal non-font network dependencies", async () => {
  for (const body of [
    '<img src="https&#58;//cdn.example/image.png">',
    '<script src="ht&#10;tps://cdn.example/script.js"></script>',
    String.raw`<style>body{background:url(https\3a //cdn.example/image.png)}</style>`,
  ]) await assert.rejects(Effect.runPromise(prepareArtifactHtml(document("", body), {
    fetcher: () => { throw new Error("non-font references must never be fetched"); },
  })), { code: "external-reference" });
});

test("recoverable author CSS limitations keep their exact bytes and never fetch", async () => {
  const nested = ".card{.child{color:blue}}";
  const nestedChild = ".card{> p{margin:0}}";
  const filter = "a{filter:progid:DXImageTransform.Microsoft.gradient(startColorstr='#fff',endColorstr='#000')}";
  const custom = "a{--x:{color:red}}";
  const stray = "b{color:red} } c{color:blue}";
  const attribute = '<figure style="width:{{w}}px;filter:alpha(opacity=50)"><figcaption>x</figcaption></figure>';
  const source = document(`<style>${nested}${nestedChild}${filter}${custom}${stray}</style>`, attribute);
  const result = await Effect.runPromise(prepareArtifactHtml(source, { fetcher: () => { throw new Error("unparsed CSS must not trigger a fetch"); } }));
  for (const fragment of [nested, nestedChild, filter, custom, stray, attribute])
    assert.equal(result.html.includes(fragment), true, `fragment bytes must survive: ${fragment}`);
});

test("a well-formed quoted font URL in author CSS is captured like an unquoted one", async () => {
  const face = `@font-face{font-family:'Quoted';src:url("${font}") format("woff2")}`;
  const calls: string[] = [];
  const result = await Effect.runPromise(prepareArtifactHtml(document(`<style>${face}</style>`), { fetcher: provider(calls) }));
  assert.deepEqual(calls, [font]);
  assert.equal(result.html.includes(`data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}`), true);
  assert.equal(result.html.includes("fonts.gstatic.com"), false);
});

test("escaped and malformed CSS URL attempts at remote targets are rejected, local ones tolerated", async () => {
  for (const [cssBody, code] of [
    ['a{background:url("https://evil.example/x"}', "external-reference"],   // malformed → unparsed region
    ["a{background:url(//cdn.example/pixel)}", "external-reference"],      // scheme-relative
  ]) await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<style>${cssBody}</style>`), {
    fetcher: () => { throw new Error("a rejected remote attempt must never be fetched"); },
  })), { code });
  const local = "a{background:url( \"x\" y)}";
  const result = await Effect.runPromise(prepareArtifactHtml(document(`<style>.card{.child{color:blue}}${local}</style>`), {
    fetcher: () => { throw new Error("local unparsed CSS must not trigger a fetch"); },
  }));
  assert.equal(result.html.includes(local), true);
  assert.equal(result.html.includes(".card{.child{color:blue}}"), true);
});

test("provider stylesheets remain strict about syntax errors", async () => {
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async () => response(".card{.child{color:blue}}", "text/css"),
  })), { code: "font-css" });
  await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async () => response("a{filter:progid:X.gradient(#fff,#000)}", "text/css"),
  })), { code: "font-css" });
});

test("project theme capture schedules only selected Latin WOFF2 face assets", async () => {
  const themeSheet = "https://fonts.googleapis.com/css2?family=Example:wght@400";
  const selected = "https://fonts.gstatic.com/s/example/v1/selected.woff2";
  const calls: string[] = [];
  const irrelevant = Array.from({ length: FONT_LIMITS.fonts + 2 }, (_, index) =>
    `/* latin */ @font-face{font-family:'Example';font-weight:700;src:url(https://fonts.gstatic.com/s/example/v1/unused-${index}.woff2)}`);
  const sourceCss = [...irrelevant, `/* latin */ @font-face{font-family:'Example';font-weight:400;src:url('${selected}') format('woff2')}`].join("\n");
  const fetcher: FontFetcher = async url => {
    calls.push(url);
    if (url === themeSheet) return response(sourceCss, "text/css");
    if (url === selected) return response(bytes, "font/woff2");
    throw new Error(`Unselected face must not be fetched: ${url}`);
  };
  const captured = await Effect.runPromise(captureThemeFonts([themeSheet], { fetcher, families: ["Example"] }));
  assert.deepEqual(calls, [themeSheet, selected]);
  assert.equal(new TextDecoder().decode(captured).includes(selected), false);
  assert.equal(new TextDecoder().decode(captured).includes("data:font/woff2;base64,"), true);
});
test("project theme font capture negotiates Latin WOFF2 faces from Google CSS2", async () => {
  const themeSheet = "https://fonts.googleapis.com/css2?family=Example:wght@400";
  const themeCss = `/* latin */ @font-face{font-family:'Example';font-weight:400;src:url('${font}') format('woff2')}`;
  const fetcher: FontFetcher = async (url, init) => {
    if (url === themeSheet) {
      const userAgent = new Headers(init.headers).get("user-agent") ?? "";
      return response(userAgent.includes("AppleWebKit") ? themeCss : themeCss.replace("/* latin */ ", ""), "text/css");
    }
    if (url === font) return response(bytes, "font/woff2");
    throw new Error(`Unexpected resource ${url}`);
  };
  const captured = await Effect.runPromise(captureThemeFonts([themeSheet], { fetcher, families: ["Example"] }));
  assert.equal(new TextDecoder().decode(captured).includes("data:font/woff2;base64,"), true);
});

test("project theme CSS redirects remain on Google CSS2 while generic artifact CSS remains compatible", async () => {
  const legacy = "https://fonts.googleapis.com/css?family=Example:wght@400";
  let calls = 0;
  await assert.rejects(Effect.runPromise(captureThemeFonts([sheet], {
    fetcher: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: legacy } });
    },
  })), { code: "font-provider" });
  assert.equal(calls, 1);
  const generic = await Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async url => url === sheet
      ? new Response(null, { status: 302, headers: { location: legacy } })
      : url === legacy ? response(css, "text/css") : url === font ? response(bytes, "font/woff2")
        : (() => { throw new Error(`Unexpected URL: ${url}`); })(),
  }));
  assert.equal(generic.html.includes("@font-face"), true);
});

test("prepared capabilities are service-minted, source-bound and fail closed", async () => {
  const source = document(`<style>${css}</style>`);
  const service = openArtifactService({ fetcher: provider() });
  const foreign = openArtifactService({ fetcher: provider() });
  const capability = await Effect.runPromise(service.prepare(source, { gated: true }));
  assert.equal(typeof capability, "object");
  assert.ok(capability !== null);
  const opened = await Effect.runPromise(service.open(capability, source));
  assert.ok(opened);
  assert.equal(opened.gated, true);
  assert.deepEqual(opened.warnings, []);
  const canonical = await Effect.runPromise(prepareArtifactHtml(source, { fetcher: provider() }));
  assert.equal(opened.html, canonical.html);
  // Bound to the exact source bytes and to the minting service instance.
  assert.equal(await Effect.runPromise(service.open(capability, source.replace("Offline", "Changed"))), null);
  assert.equal(await Effect.runPromise(foreign.open(capability, source)), null);
  // Objects nobody minted, untrusted strings and non-values all fail closed.
  assert.equal(await Effect.runPromise(service.open(Object.freeze(Object.create(null)), source)), null);
  assert.equal(await Effect.runPromise(service.open("garbage", source)), null);
  assert.equal(await Effect.runPromise(service.open(null, source)), null);
  // Every mint is an independent capability: preparing twice shares nothing.
  const second = await Effect.runPromise(service.prepare(source, { gated: true }));
  assert.notEqual(second, capability);
  const secondOpened = await Effect.runPromise(service.open(second, source));
  assert.ok(secondOpened);
  assert.equal(secondOpened.html, opened.html);
});

test("font capture is lazy and each execution gets its own budget and cache", async () => {
  const calls: string[] = [];
  const capture = prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), { fetcher: provider(calls) });
  assert.deepEqual(calls, []);
  const first = await Effect.runPromise(capture);
  const second = await Effect.runPromise(capture);
  assert.deepEqual(calls, [sheet, font, sheet, font]);
  assert.deepEqual(second, first);
});

test("header rejection and byte-budget failure cancel provider bodies and release locks", async () => {
  for (const mode of ["redirect", "oversized"] as const) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "oversized") controller.enqueue(new Uint8Array(FONT_LIMITS.fontBytes + 1));
      },
      cancel() { cancelled = true; },
    });
    const result = mode === "redirect"
      ? new Response(body, { status: 302, headers: { location: "https://internal.example/private" } })
      : response(body, "font/woff2");
    await assert.rejects(Effect.runPromise(prepareArtifactHtml(document(`<style>${css}</style>`), {
      fetcher: async () => result,
    })), { code: mode === "redirect" ? "font-provider" : "font-limit" });
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test("interruption cancels the font reader, releases its lock and aborts the connection", { timeout: 5000 }, async () => {
  const { promise: reading, resolve: readStarted } = Promise.withResolvers<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { readStarted(); },
    cancel() {
      const signal = signals.at(-1);
      assert.ok(signal);
      return cancelAfterAbort(signal).then(() => { cancelled = true; });
    },
  }, { highWaterMark: 0 });
  const signals: AbortSignal[] = [];
  const controller = new AbortController();
  const captured = Effect.runPromiseExit(prepareArtifactHtml(document(`<style>${css}</style>`), {
    fetcher: async (_url, init) => {
      assert.ok(init.signal);
      signals.push(init.signal);
      return response(body, "font/woff2");
    },
  }), { signal: controller.signal });
  await reading;
  controller.abort();
  assert.equal(Exit.isFailure(await captured), true);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(signals[0].aborted, true);
});

test("request and publication deadlines cancel stalled readers without waiting on transport", { timeout: 5000 }, async () => {
  for (const budget of ["request", "publication"] as const) {
    let now = 0, expire!: () => void;
    const { promise: reading, resolve: readStarted } = Promise.withResolvers<void>();
    const sleeps: number[] = [], signals: AbortSignal[] = [];
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      sleep: (duration) => Effect.promise(() => {
        sleeps.push(Duration.toMillis(duration));
        const { promise, resolve } = Promise.withResolvers<void>();
        expire = resolve;
        return promise;
      }),
    };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { readStarted(); },
      cancel() {
        const signal = signals.at(-1);
        assert.ok(signal);
        return cancelAfterAbort(signal).then(() => { cancelled = true; });
      },
    }, { highWaterMark: 0 });
    const source = budget === "request" ? document(`<style>${css}</style>`)
      : document(`<link rel="stylesheet" href="${sheet}">`);
    const capture = prepareArtifactHtml(source, {
      fetcher: async (url, init) => {
        assert.ok(init.signal);
        signals.push(init.signal);
        if (url === sheet) {
          init.signal.addEventListener("abort", () => { now = FONT_LIMITS.totalMs - 100; }, { once: true });
          return response(css, "text/css");
        }
        return response(body, "font/woff2");
      },
    }).pipe(Effect.provideService(Clock.Clock, clock));
    const captured = Effect.runPromise(capture);
    await reading;
    assert.deepEqual(sleeps, budget === "request" ? [FONT_LIMITS.requestMs] : [FONT_LIMITS.requestMs, 100]);
    now += budget === "request" ? FONT_LIMITS.requestMs : 100;
    expire();
    await assert.rejects(captured, { code: "font-timeout" });
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(signals.at(-1)?.aborted, true);
  }
});

test("redirect cleanup aborts only its own connection before waiting for cancellation", { timeout: 5000 }, async () => {
  const redirectedSheet = "https://fonts.googleapis.com/css?family=Example";
  let cancelled = false;
  let redirectBody: ReadableStream<Uint8Array> | undefined;
  const result = await Effect.runPromise(prepareArtifactHtml(document(`<link rel="stylesheet" href="${sheet}">`), {
    fetcher: async (url, init) => {
      const signal = init.signal;
      assert.ok(signal);
      if (signal.aborted) throw new DOMException("Connection aborted.", "AbortError");
      if (url === sheet) {
        redirectBody = new ReadableStream<Uint8Array>({
          cancel() { return cancelAfterAbort(signal).then(() => { cancelled = true; }); },
        });
        return new Response(redirectBody, { status: 302, headers: { location: redirectedSheet } });
      }
      if (url === redirectedSheet) return response(css, "text/css");
      if (url === font) return response(bytes, "font/woff2");
      throw new Error(`Unexpected resource ${url}`);
    },
  }));
  assert.equal(cancelled, true);
  assert.equal(redirectBody?.locked, false);
  assert.equal(result.html.includes(`data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}`), true);
});
test("project theme font capture stores provider-validated fonts at definition time", async () => {
  const themeCss = css.replace("400 700", "400");
  const captured = await Effect.runPromise(captureThemeFonts([sheet], { fetcher: async url =>
    url === sheet ? response(themeCss, "text/css") : url === font ? response(bytes, "font/woff2") : Promise.reject(new Error("unexpected URL")) }));
  assert.match(new TextDecoder().decode(captured), /data:font\/woff2;base64,/);
  assert.ok(captured.byteLength > 0);
});
test("project theme capture keeps only Latin subsets and URL-declared weights", async () => {
  const singleWeightSheet = "https://fonts.googleapis.com/css2?family=Example:wght@400&display=swap";
  const sourceCss = `/* latin */ @font-face { font-family:'Example'; font-weight:400; src:url('${font}') format('woff2'); }` +
    `/* latin */ @font-face { font-family:'Example'; font-weight:700; src:url('${font}') format('woff2'); }` +
    `/* cyrillic */ @font-face { font-family:'Example'; font-weight:400; src:url('${font}') format('woff2'); }`;
  const captured = await Effect.runPromise(captureThemeFonts([singleWeightSheet], { fetcher: async url =>
    url === singleWeightSheet ? response(sourceCss, "text/css") : url === font ? response(bytes, "font/woff2") : Promise.reject(new Error("unexpected URL")) }));
  const text = new TextDecoder().decode(captured);
  assert.equal((text.match(/@font-face/g) ?? []).length, 1);
  assert.match(text, /\/\* latin \*\//);
  assert.doesNotMatch(text, /font-weight:700|cyrillic/);
  assert.ok(captured.byteLength < 150 * 1024);
});

test("project theme capture hard-rejects more than 256 KiB of selected WOFF2 faces", async () => {
  const large = new Uint8Array(256 * 1024 + 1);
  large.set(new TextEncoder().encode("wOF2"));
  new DataView(large.buffer).setUint32(8, large.byteLength);
  const sourceCss = `/* latin */ @font-face { font-family:'Example'; font-weight:400; src:url('${font}') format('woff2'); }`;
  await assert.rejects(Effect.runPromise(captureThemeFonts([sheet], { fetcher: async url =>
    url === sheet ? response(sourceCss, "text/css") : url === font ? response(large, "font/woff2") : Promise.reject(new Error("unexpected URL")) })),
  (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "font-limit");
});
test("project theme capture accepts the exact 256 KiB WOFF2 ceiling", async () => {
  const exact = new Uint8Array(256 * 1024);
  exact.set(new TextEncoder().encode("wOF2"));
  new DataView(exact.buffer).setUint32(8, exact.byteLength);
  const sourceCss = `/* latin */ @font-face { font-family:'Example'; font-weight:400; src:url('${font}') format('woff2'); }`;
  const captured = await Effect.runPromise(captureThemeFonts([sheet], { fetcher: async url =>
    url === sheet ? response(sourceCss, "text/css") : url === font ? response(exact, "font/woff2") : Promise.reject(new Error("unexpected URL")) }));
  assert.ok(captured.byteLength > exact.byteLength);
});
