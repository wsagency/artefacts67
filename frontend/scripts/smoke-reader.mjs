// Node 22+, Chrome, and an authenticated local smoke artefact are required.
// WS_SMOKE_VIEWER, WS_SMOKE_SESSION, WS_SMOKE_CHROME, WS_SMOKE_API_KEY (local content-read wak_ master), and WS_SMOKE_NOREAD_API_KEY (local key without content-read capability) are required.
// WS_SMOKE_OWNER_SESSION is optional and is used only for cleanup console POSTs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { register } from '../../worker/node_modules/tsx/dist/esm/api/index.mjs';
register({ tsconfig: new URL('../../worker/tsconfig.json', import.meta.url).pathname });
const { PLATFORM_THEMES } = await import('../src/platform-themes.ts');
const { PAGE_KIT_CSS: kitCss, PAGE_KIT_RUNTIME: kitRuntime, themeConfigurationScript } = await import('../src/page-kit.ts');

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axeRows = [];
const axeIncomplete = [];
let axeSource;
const axeWorlds = new Map();
const axeTargets = new Set();
const runAxeRow = async (page, send, evaluate, theme, scheme, width, viewportSend = send) => {
  if (!axeSource) axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
  let contextId = axeWorlds.get(send);
  if (!contextId) {
    const { frameTree } = await send('Page.getFrameTree');
    ({ executionContextId: contextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'axe-accessibility-check' }));
    axeWorlds.set(send, contextId);
  }
  const axeEvaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  if (!axeTargets.has(send)) {
    const injected = await send('Runtime.evaluate', { expression: axeSource, contextId, awaitPromise: true, returnByValue: true });
    if (injected.exceptionDetails) throw new Error(`axe-core injection failed: ${injected.exceptionDetails.text}`);
    axeTargets.add(send);
  }
  await viewportSend('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
  const cssViewport = await evaluate('window.innerWidth');
  assert.equal(cssViewport, width, `Axe row ${page}/${theme.slug}/${scheme} requested ${width}px but rendered at ${cssViewport}px CSS width.`);
  await evaluate(`(() => {
    document.documentElement.dataset.a67Theme=${JSON.stringify(theme.slug)};
    document.documentElement.dataset.theme=${JSON.stringify(scheme)};
    let style=document.getElementById('__pageAxeTheme');
    if(!style){style=document.createElement('style');style.id='__pageAxeTheme';document.head.append(style);}
    style.textContent=${JSON.stringify(theme.css)};
  })()`);
  const active = await axeEvaluate(`axe.getRules().flatMap(rule=>rule.tags)`);
  for (const tag of axeTags) assert(active.includes(tag), `axe-core WCAG tag ${tag} must be active.`);
  const result = await axeEvaluate(`axe.run(document,{runOnly:{type:'tag',values:${JSON.stringify(axeTags)}}})`);
  const row = { page, theme: theme.slug, scheme, width, violations: result.violations, incomplete: result.incomplete };
  axeRows.push(row);
  assert.equal(row.violations.length, 0, `axe violations in ${page}/${theme.slug}/${scheme}/${width}: ${JSON.stringify(row.violations.map(item=>({id:item.id,help:item.help,nodes:item.nodes.map(node=>node.target)})))}`);
  axeIncomplete.push(...row.incomplete.map(item=>({page,theme:theme.slug,scheme,width,id:item.id,help:item.help,nodes:item.nodes.map(node=>node.target)})));
};
const runAxeThemeMatrix = async (page, send, evaluate, viewportSend = send) => {
  for (const theme of PLATFORM_THEMES) for (const scheme of ['light','dark']) for (const width of [390,1440]) {
    await runAxeRow(page, send, evaluate, theme, scheme, width, viewportSend);
  }
};


const viewer = new URL(process.env.WS_SMOKE_VIEWER ?? '');
assert(['localhost', '127.0.0.1'].includes(viewer.hostname), 'This mutating check is local-only.');
assert(process.env.WS_SMOKE_SESSION && process.env.WS_SMOKE_CHROME, 'Supply the local session and Chrome executable.');
assert(process.env.WS_SMOKE_API_KEY?.startsWith('wak_'), 'Supply a local content-read master key (never a production one).');
assert(/^(wak_|waa_)/.test(process.env.WS_SMOKE_NOREAD_API_KEY ?? ''), 'Supply a separate local key without can_read_content (never a production one).');
const profile = await mkdtemp(join(tmpdir(), 'ws-reader-check-'));
const chrome = spawn(process.env.WS_SMOKE_CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let settingsMasterKey;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let logs = '';
    const timeout = setTimeout(() => reject(new Error('Chrome did not start.')), 15000);
    chrome.once('error', reject);
    chrome.stderr.on('data', data => { logs += data; const match = logs.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const requests = new Map();
  let subfolderPosts = 0;
  const runtimeFileResponses = [];
  let kitSessionId;
  const kitRequests = [], kitConsoleErrors = [], kitExceptions = [], kitCspViolations = [];
  const diagnosticsBySession = new Map();
  const autoAttachHandlers = new Map();
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject, method, contextId: params.contextId, expression: typeof params.expression === 'string' ? params.expression.slice(0, 140) : '' }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const diagnosticsFor = sessionId => {
    let diagnostics = diagnosticsBySession.get(sessionId);
    if (!diagnostics) {
      diagnostics = { requests: [], networkFailures: [], consoleErrors: [], exceptions: [], cspViolations: [], domains: [], captureReady: false };
      diagnosticsBySession.set(sessionId, diagnostics);
    }
    return diagnostics;
  };
  const enableDiagnostics = async (sessionId, domains) => {
    const diagnostics = diagnosticsFor(sessionId);
    for (const domain of domains) {
      await call(`${domain}.enable`, {}, sessionId);
      diagnostics.domains.push(domain);
    }
    diagnostics.captureReady = true;
    return diagnostics;
  };
  const externalRequestUrls = urls => urls.filter(url => {
    const resource = new URL(url);
    return (resource.protocol === 'http:' || resource.protocol === 'https:') && resource.origin !== viewer.origin;
  });
  const autoAttachFrames = async (targetId, retainedSessionIds) => {
    const sessions = new Map(), setups = new Map(), targetInfos = new Map(), setupErrors = [];
    autoAttachHandlers.set(undefined, message => {
      const { sessionId, targetInfo, waitingForDebugger } = message.params;
      targetInfos.set(targetInfo.targetId, targetInfo);
      if (targetInfo.type === 'iframe') retainedSessionIds?.add(sessionId);
      sessions.set(targetInfo.targetId, sessionId);
      const setup = (async () => {
        const diagnostics = targetInfo.type === 'iframe' ? await enableDiagnostics(sessionId, ['Page', 'Network', 'Runtime', 'Log']) : null;
        if (diagnostics) {
          diagnostics.targetInfo = targetInfo;
          diagnostics.waitingForDebugger = waitingForDebugger === true;
        }
        if (waitingForDebugger) await call('Runtime.runIfWaitingForDebugger', {}, sessionId);
      })().catch(error => { setupErrors.push(`${targetInfo.targetId}: ${error.message}`); });
      setups.set(targetInfo.targetId, setup);
    });
    await call('Target.autoAttachRelated', { targetId, waitForDebuggerOnStart: true, filter: [{ type: 'page' }, { type: 'iframe' }] });
    return { sessions, setups, targetInfos, setupErrors };
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const diagnostic = diagnosticsBySession.get(message.sessionId);
    if (diagnostic) {
      if (message.method === 'Network.requestWillBeSent') diagnostic.requests.push(message.params.request.url);
      if (message.method === 'Network.loadingFailed') diagnostic.networkFailures.push({ error: message.params.errorText, blockedReason: message.params.blockedReason ?? null });
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') diagnostic.consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      if (message.method === 'Runtime.exceptionThrown') diagnostic.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === 'Log.entryAdded' && (message.params.entry.source === 'security' || /content security policy/i.test(message.params.entry.text))) diagnostic.cspViolations.push(message.params.entry.text);
    }
    const autoAttachHandler = autoAttachHandlers.get(message.sessionId);
    if (message.method === 'Target.attachedToTarget' && autoAttachHandler) autoAttachHandler(message);
    if (message.sessionId === kitSessionId) {
      if (message.method === 'Network.requestWillBeSent') kitRequests.push(message.params.request.url);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') kitConsoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      if (message.method === 'Runtime.exceptionThrown') kitExceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === 'Log.entryAdded' && (message.params.entry.source === 'security' || /content security policy/i.test(message.params.entry.text))) kitCspViolations.push(message.params.entry.text);
    }
    if (message.method === 'Network.requestWillBeSent' && message.params.request.method === 'POST' && new URL(message.params.request.url).pathname.endsWith('/subfolder')) subfolderPosts++;
    if (message.method === 'Network.responseReceived' && new URL(message.params.response.url).pathname.startsWith('/_runtime/files/')) {
      const headers = message.params.response.headers;
      const disposition = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-disposition')?.[1];
      runtimeFileResponses.push({ url: message.params.response.url, status: message.params.response.status, disposition });
    }
    const request = requests.get(message.id);
    if (request) {
      requests.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}${request.contextId ? ` (context ${request.contextId})` : ''}${request.expression ? ` [${request.expression}]` : ''}: ${message.error.message}`));
      else request.resolve(message.result);
    }
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => call(method, params, sessionId);
  await command('Network.enable');
  await command('Network.setCookie', { name: 'wsa_session', value: process.env.WS_SMOKE_SESSION, url: viewer.origin, httpOnly: true, sameSite: 'Lax' });
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const NativeChannel = MessageChannel;
    Object.defineProperty(window, '__pageSmokeChannels', { value: [] });
    window.MessageChannel = class extends NativeChannel {
      constructor() { super(); window.__pageSmokeChannels.push(this.port1); }
    };
    let pendingReady;
    window.addEventListener('message', event => {
      if (window.top === window && sessionStorage.getItem('__holdPageReaderReady') === 'true' && !pendingReady && event.data?.type === 'artefacts:ready') {
        event.stopImmediatePropagation();
        pendingReady = event;
        window.__pagePendingReady = () => {
          pendingReady = undefined;
          sessionStorage.removeItem('__holdPageReaderReady');
          window.__pagePendingReadyData = event.data;
        };
      }
    }, true);
  })();` });
  await command('Page.navigate', { url: viewer.href });
  const evaluate = async (expression, contextId, send = command) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const until = async (expression, contextId, send = command, timeout = 15000) => { const deadline = Date.now() + timeout; do { if (await evaluate(expression, contextId, send)) return; await delay(50); } while (Date.now() < deadline); throw new Error(`Reader condition failed: ${expression}`); };
  let cspProbeTarget, cspProbeAutoAttach, cspProbeSession, cspProbeDiagnostics, probeCommand;
  try {
    cspProbeTarget = await call('Target.createTarget', { url: 'about:blank' });
    cspProbeAutoAttach = await autoAttachFrames(cspProbeTarget.targetId);
    const attachDeadline = Date.now() + 5000;
    while (!cspProbeAutoAttach.sessions.has(cspProbeTarget.targetId) && Date.now() < attachDeadline) await delay(25);
    assert(cspProbeAutoAttach.sessions.has(cspProbeTarget.targetId), 'The CSP probe page must attach before it is navigated.');
    cspProbeSession = cspProbeAutoAttach.sessions.get(cspProbeTarget.targetId);
    await cspProbeAutoAttach.setups.get(cspProbeTarget.targetId);
    await call('Page.enable', {}, cspProbeSession);
    cspProbeDiagnostics = await enableDiagnostics(cspProbeSession, ['Network', 'Runtime', 'Log']);
    cspProbeDiagnostics.targetInfo = cspProbeAutoAttach.targetInfos.get(cspProbeTarget.targetId);
    cspProbeDiagnostics.domains.unshift('Page');
    probeCommand = (method, params) => call(method, params, cspProbeSession);
    const blockedChild = `<!doctype html><script>window.__pageSmokeCspEvents=[];window.addEventListener('securitypolicyviolation',event=>window.__pageSmokeCspEvents.push({blockedURI:event.blockedURI,violatedDirective:event.violatedDirective}))</script><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'"><script>window.__cspProbeExecuted=true</script>`;
    const escapedChild = blockedChild.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const probeHtml = `<!doctype html><iframe sandbox="allow-scripts" srcdoc="${escapedChild}"></iframe>`;
    await probeCommand('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(probeHtml)}` });
    await until('!!document.querySelector("iframe")', undefined, probeCommand);
    const rootFrameId = (await probeCommand('Page.getFrameTree')).frameTree.frame.id;
    const deadline = Date.now() + 5000;
    let probeDiagnostics = [], probeFrames = [];
    do {
      await Promise.all(cspProbeAutoAttach.setups.values());
      probeFrames = [...cspProbeAutoAttach.targetInfos.entries()].filter(([, targetInfo]) => targetInfo.type === 'iframe' && targetInfo.parentFrameId === rootFrameId);
      probeDiagnostics = [cspProbeDiagnostics, ...probeFrames.map(([targetId]) => diagnosticsBySession.get(cspProbeAutoAttach.sessions.get(targetId))).filter(Boolean)];
      if (probeDiagnostics.some(diagnostics => diagnostics.cspViolations.length > 0)) break;
      await delay(50);
    } while (Date.now() < deadline);
    assert.deepEqual(cspProbeDiagnostics.domains, ['Page', 'Network', 'Runtime', 'Log'], 'Parent diagnostics must be armed before probe navigation.');
    assert(probeDiagnostics.some(diagnostics => diagnostics.cspViolations.some(text => /Content Security Policy|content security policy/i.test(text))), 'The startup CSP canary must be captured before an opaque srcdoc resumes.');
    const attachedProbeFrames = probeFrames.map(([targetId]) => diagnosticsBySession.get(cspProbeAutoAttach.sessions.get(targetId))).filter(Boolean);
    assert(attachedProbeFrames.length > 0, 'The opaque CSP canary must attach a child target.');
    assert(attachedProbeFrames.every(diagnostics => diagnostics.captureReady), 'Child Network, Runtime, and Log domains must be enabled and retained.');
    const probeFrameSession = cspProbeAutoAttach.sessions.get(probeFrames[0][0]);
    const probeFrameCommand = (method, params) => call(method, params, probeFrameSession);
    const probeFrameCspEvents = await evaluate('window.__pageSmokeCspEvents', undefined, probeFrameCommand);
    assert(probeFrameCspEvents.some(event => /script-src/.test(event.violatedDirective)), 'The startup CSP violation must be recorded by a listener in the child before its policy is parsed.');
    assert.equal(await evaluate('window.__cspProbeExecuted === true', undefined, probeFrameCommand), false, 'The canary CSP must continue blocking inline script.');
    assert.deepEqual(externalRequestUrls(await evaluate('performance.getEntriesByType("resource").map(entry => entry.name)', undefined, probeFrameCommand)), [], 'The canary child must have no external resource requests.');
    assert.deepEqual(externalRequestUrls(probeDiagnostics.flatMap(diagnostics => diagnostics.requests)), [], 'The startup CSP canary must not make external requests.');
    console.log('CDP startup smoke: opaque srcdoc CSP event captured before load and child resources accounted');
  } finally {
    autoAttachHandlers.delete(undefined);
    if (cspProbeTarget) await call('Target.closeTarget', { targetId: cspProbeTarget.targetId });
    for (const attachedSessionId of new Set(cspProbeAutoAttach?.sessions.values() ?? [])) {
      await call('Target.detachFromTarget', { sessionId: attachedSessionId }).catch(() => {});
    }
  }
  // Exercise the platform CSS with an isolated static document, rather than an authored site.
  const bindingSdk = String.raw`<script>
window.__a67PageKit = { canWriteRecords: true };
globalThis.bindingCalls = [];
globalThis.salesRecord = { id: "sale-1", collection: "sales", version: 1, data: { title: "January", amount: 7 } };
const salesSchema = { name: "sales", kind: "records", visitors: true, fields: { title: { type: "text", required: true }, amount: { type: "number" } } };
window.artefacts = {
  storage: {
    get: async (key, options) => { bindingCalls.push({ op: "storage.get", key, scope: options.scope }); return ["chapter-1"]; },
    set: async (key, value, options) => { bindingCalls.push({ op: "storage.set", key, value, scope: options.scope }); },
  },
  data: {
    schema: async collection => {
      if (collection === "private") throw Object.assign(new Error("Denied"), { code: "forbidden" });
      if (collection === "pending") return new Promise(resolve => { globalThis.resolvePendingSchema = () => resolve(salesSchema); });
      if (collection === "rsvp") return { name: "rsvp", kind: "responses", visitors: true, fields: { email: { type: "email", required: true } } };
      return salesSchema;
    },
    list: async collection => {
      if (collection === "broken") throw new Error("Records unavailable.");
      if (collection === "empty") return { records: [], cursor: null };
      return { records: [salesRecord], cursor: null };
    },
    get: async () => salesRecord,
    update: async (_collection, _id, data, options) => {
      bindingCalls.push({ op: "data.update", data, version: options.ifVersion });
      salesRecord = { ...salesRecord, version: salesRecord.version + 1, data: { ...data, amount: Number(data.amount) } };
      return salesRecord;
    },
    submit: async (collection, form) => {
      bindingCalls.push({ op: "data.submit", collection, data: Object.fromEntries(new FormData(form)) });
      return { id: "smoke-response" };
    },
  },
};
</script>`;
  const photo = (await readFile(new URL('../../worker/test/fixtures/page-photo.jpg', import.meta.url))).toString('base64');
  const staticTarget = await call('Target.createTarget', { url: 'about:blank' });
  const staticAttached = await call('Target.attachToTarget', { targetId: staticTarget.targetId, flatten: true });
  const staticCommand = (method, params) => call(method, params, staticAttached.sessionId);
  kitSessionId = staticAttached.sessionId;
  await staticCommand('Page.enable');
  await staticCommand('Runtime.enable');
  await staticCommand('Network.enable');
  await staticCommand('Log.enable');
  const { frameTree: staticTree } = await staticCommand('Page.getFrameTree');
  const staticHtml = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>${kitCss}</style></head><body><main><header data-variant="hero"><div><h1>Static report</h1><p data-tone="muted">Responsive page-kit smoke content.</p></div><figure><img id="photo" alt="Smoke fixture photo" width="640" height="480" src="data:image/jpeg;base64,${photo}"><figcaption>JPEG photo</figcaption></figure></header><section data-variant="grid"><article data-tone="info"><h2>Information</h2><p>Readable content remains visible.</p></article><article data-tone="ok"><h2>Healthy</h2><p>Status text remains visible.</p></article></section><details><summary>More information</summary><p id="details-content">Print-visible details.</p></details><button type="button">Screen action</button></main></body></html>`;
  await staticCommand('Page.setDocumentContent', { frameId: staticTree.frame.id, html: staticHtml });
  const staticEvaluate = async expression => evaluate(expression, undefined, staticCommand);
  for (const width of [320, 390, 1440]) {
    await staticCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await until(`document.readyState === "complete" && !!document.querySelector("#photo")`, undefined, staticCommand);
    const layout = await staticEvaluate(`(() => { const image=document.querySelector("#photo"); return { viewport:innerWidth, page:document.documentElement.scrollWidth, image:image.getBoundingClientRect().width, container:image.parentElement.getBoundingClientRect().width, loaded:image.complete && image.naturalWidth>0, columns:getComputedStyle(document.querySelector('[data-variant="grid"]')).gridTemplateColumns }; })()`);
    assert.equal(layout.viewport, width);
    assert(layout.page <= width, `Page-kit content overflows at ${width}px: ${layout.page}px.`);
    assert(layout.image <= layout.container, `JPEG overflows its figure at ${width}px: ${layout.image}px > ${layout.container}px.`);
    assert(layout.loaded, 'Inline JPEG fixture must render.');
    if (width < 500) assert.equal(layout.columns.split(' ').length, 1, `Grid must reflow at ${width}px.`);
  }
  const inversePalette = await staticEvaluate('(() => { const main=document.querySelector("main"), accentReference=document.createElement("span"), foregroundReference=document.createElement("span"); accentReference.style.backgroundColor="var(--a67-accent)"; foregroundReference.style.color="var(--a67-on-accent)"; main.append(accentReference,foregroundReference); const entries=[["plain",null],["band","band"],["full-bleed","full-bleed"]].map(([name,variant])=>{ const container=document.createElement("section"); container.dataset.tone="inverse"; if(variant)container.dataset.variant=variant; container.innerHTML="<h2>Inverse heading</h2><p>Inverse body text</p><a href=\\"#\\">Inverse link</a>"; main.append(container); return {name,container}; }); const luminance=color=>{ const [red,green,blue]=color.match(/[\\d.]+/g).map(Number).map(channel=>channel/255).map(channel=>channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4); return 0.2126*red+0.7152*green+0.0722*blue; }; const contrast=(background,foreground)=>{ const values=[luminance(background),luminance(foreground)].sort((a,b)=>b-a); return (values[0]+0.05)/(values[1]+0.05); }; const colors=[]; for(const theme of ["light","dark"]){ document.documentElement.dataset.theme=theme; const expectedBackground=getComputedStyle(accentReference).backgroundColor, expectedForeground=getComputedStyle(foregroundReference).color; for(const {name,container} of entries){ const background=getComputedStyle(container).backgroundColor, foreground=getComputedStyle(container).color, body=getComputedStyle(container.querySelector("p")).color; colors.push({theme,name,expectedBackground,expectedForeground,background,foreground,body,heading:getComputedStyle(container.querySelector("h2")).color,link:getComputedStyle(container.querySelector("a")).color,contrast:contrast(background,body)}); } } return colors; })()');
  for (const palette of inversePalette) {
    assert.equal(palette.background, palette.expectedBackground, `${palette.theme} ${palette.name} inverse container accent background`);
    assert.equal(palette.foreground, palette.expectedForeground, `${palette.theme} ${palette.name} inverse container on-accent foreground`);
    assert.equal(palette.body, palette.expectedForeground, `${palette.theme} ${palette.name} inverse body foreground`);
    assert.equal(palette.heading, palette.expectedForeground, `${palette.theme} ${palette.name} inverse heading foreground`);
    assert.equal(palette.link, palette.expectedForeground, `${palette.theme} ${palette.name} inverse link foreground`);
    assert(palette.contrast >= 4.5, `${palette.theme} ${palette.name} inverse body contrast must be at least 4.5:1; got ${palette.contrast}`);
  }
  console.log('page kit inverse palette static smoke: plain/band/full-bleed light/dark container and body colors, heading/link foregrounds and contrast passed');
  await staticEvaluate('document.documentElement.dataset.theme="light"');
  await staticCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert(await staticEvaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'));
  assert(await staticEvaluate('getComputedStyle(document.querySelector("main")).transitionDuration === "0s"'));
  await staticCommand('Emulation.setEmulatedMedia', { media: 'print' });
  const printState = await staticEvaluate('(() => { const details=document.querySelector("details"), content=document.querySelector("#details-content"); return { closed:!details.open, display:getComputedStyle(content).display, container:getComputedStyle(details,"::details-content").contentVisibility, height:content.getBoundingClientRect().height, main:getComputedStyle(document.querySelector("main")).visibility, action:getComputedStyle(document.querySelector("button")).display, color:getComputedStyle(document.body).color, background:getComputedStyle(document.body).backgroundColor }; })()');
  assert(printState.closed, 'The print disclosure fixture must be closed.');
  assert.notEqual(printState.display, 'none');
  assert.equal(printState.container, 'visible', 'Closed details content container must be visible in print.');
  assert(printState.height > 0, 'Meaningful disclosure content must participate in print layout.');
  assert.equal(printState.main, 'visible');
  assert.equal(printState.action, 'none', 'Screen-only actions are hidden in print.');
  assert.equal(printState.color, 'rgb(0, 0, 0)');
  assert.equal(printState.background, 'rgb(255, 255, 255)');
  await staticCommand('Emulation.setEmulatedMedia', { media: '' });
  console.log('page kit static smoke: JPEG at 320/390/1440, print and reduced motion passed');
  for (const theme of PLATFORM_THEMES) for (const scheme of ['light', 'dark']) {
    const compiledHtml = `<!doctype html><html lang="en" data-a67-theme="${theme.slug}" data-theme="${scheme}"><head><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'"><style>${kitCss}${theme.css}</style></head><body><main><section data-tone="inverse"><header data-variant="hero" data-style="aurora"><div><h1>Theme smoke</h1><p>Readable page content.</p></div><figure><span>Direct figure label</span><h2>Figure heading</h2><h2 data-tone="inverse">Inverse figure heading</h2><svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#000000"/><text x="1" y="4" fill="#ffffff">Vector text</text></svg><p>Figure note <a href="#">Figure link</a></p><div><section data-variant="band" data-tone="inverse"><h2>Nested inverse heading</h2><a href="#">Nested inverse link</a></section></div><figcaption>Decorative caption</figcaption><figcaption data-tone="inverse"><a href="#">Inverse caption link</a></figcaption></figure></header><a67-kpi data-style="glow" label="Metric" value="42"></a67-kpi></section><header data-variant="hero" data-style="aurora" data-tone="inverse"><div><h1>Inverse header</h1></div><figure><span>Header inverse figure label</span><p>Header inverse note <a href="#">Header inverse link</a></p></figure></header><button type="button">Action</button></main><script>${kitRuntime}</script><script>${themeConfigurationScript(theme)}</script></body></html>`;
    const semanticSurfaces = '<section id="inverse-surfaces" data-tone="inverse"><h2 id="inverse-heading">Inverse heading</h2><pre id="inverse-pre"><code id="inverse-code">code sample</code></pre><table><thead><tr><th id="inverse-head">Header</th></tr></thead><tbody><tr><td>First row</td></tr><tr id="inverse-stripe"><td>Striped row<h2 id="inverse-stripe-heading">Stripe heading</h2></td></tr></tbody></table><section data-variant="grid" id="density-grid"><div>One</div><div>Two</div></section></section>';
    const responsiveCompiledHtml = compiledHtml.replace('<section data-tone="inverse"><header', '<section><header').replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">').replace('<main>', '<main>' + semanticSurfaces);
    await staticCommand('Page.setDocumentContent', { frameId: staticTree.frame.id, html: responsiveCompiledHtml });
    await until('document.readyState === "complete" && !!document.querySelector("header[data-style=aurora] > figure") && !!document.querySelector("a67-kpi > [role=group] > [data-a67-kpi-value]")', undefined, staticCommand);
    const themeState = await staticEvaluate(`(() => {
      const styles = document.querySelector("style").sheet;
      const root = getComputedStyle(document.documentElement);
      const caption = getComputedStyle(document.querySelector("figcaption"));
      const auroraFigure = document.querySelector("header[data-variant=hero][data-style=aurora] > figure");
      const figure = getComputedStyle(auroraFigure, "::before");
      const figureStyle = getComputedStyle(auroraFigure);
      const directFigureText = getComputedStyle(document.querySelector("figure > span"));
      const figureParagraph = getComputedStyle(document.querySelector("figure > p"));
      const figureSvg = getComputedStyle(document.querySelector("figure > svg"));
      const figureSvgText = getComputedStyle(document.querySelector("figure svg text"));
      const figureHeading = getComputedStyle(document.querySelector("figure > h2:not([data-tone])"));
      const inverseFigureHeading = getComputedStyle(document.querySelector("figure > h2[data-tone=inverse]"));
      const inverseFigureCaption = getComputedStyle(document.querySelector("figure > figcaption[data-tone=inverse]"));
      const inverseFigureCaptionLink = getComputedStyle(document.querySelector("figure > figcaption[data-tone=inverse] a"));
      const figureLink = getComputedStyle(document.querySelector("figure > p a"));
      const nestedInverse = document.querySelector("figure > div > [data-tone=inverse]");
      const nestedInverseStyle = getComputedStyle(nestedInverse);
      const nestedInverseHeading = getComputedStyle(nestedInverse.querySelector("h2"));
      const nestedInverseLink = getComputedStyle(nestedInverse.querySelector("a"));
      const headerInverseFigure = document.querySelector("header[data-tone=inverse] > figure");
      const headerInverseFigureStyle = getComputedStyle(headerInverseFigure);
      const headerInverseLink = getComputedStyle(headerInverseFigure.querySelector("a"));
      const kpi = document.querySelector("a67-kpi[data-style=glow]");
      const kpiBlock = kpi.querySelector(':scope > [role="group"]');
      const kpiStyle = getComputedStyle(kpiBlock);
      const kpiValue = getComputedStyle(kpiBlock.querySelector("[data-a67-kpi-value]"));
      const button = getComputedStyle(document.querySelector("main > button"));
      const channels = color => {
        const modern = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*[\\d.]+)?\\)$/.exec(color);
        if (modern) return modern.slice(1, 4).map(Number);
        const legacy = /^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)/.exec(color);
        if (legacy) return legacy.slice(1, 4).map(value => Number(value) / 255);
        throw new Error('Unsupported computed color syntax: ' + color);
      };
      const luminance = color => { const rgb = channels(color).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
      const contrast = (first, second) => { const a=luminance(first), b=luminance(second); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
      if (Math.abs(contrast('color(srgb 1 1 1)', 'color(srgb 0 0 0)') - 21) > .01) throw new Error('Modern computed-color contrast parsing failed.');
      const inverseSection = getComputedStyle(document.querySelector("#inverse-surfaces"));
      const inverseHeading = getComputedStyle(document.querySelector("#inverse-heading"));
      const inverseCode = getComputedStyle(document.querySelector("#inverse-code"));
      const inversePre = getComputedStyle(document.querySelector("#inverse-pre"));
      const inverseHead = getComputedStyle(document.querySelector("#inverse-head"));
      const inverseThead = getComputedStyle(document.querySelector("#inverse-head").parentElement.parentElement);
      const inverseStripe = getComputedStyle(document.querySelector("#inverse-stripe"));
      const stripeCell = getComputedStyle(document.querySelector("#inverse-stripe td"));
      const inverseStripeHeading = getComputedStyle(document.querySelector("#inverse-stripe-heading"));
      const grid = document.querySelector("#density-grid");
      document.documentElement.style.setProperty("--a67-density","0.75");
      const compactGap = parseFloat(getComputedStyle(grid).columnGap);
      document.documentElement.style.setProperty("--a67-density","1.25");
      const expandedGap = parseFloat(getComputedStyle(grid).columnGap);
      document.documentElement.style.removeProperty("--a67-density");
      return {
        bg: root.getPropertyValue("--a67-bg").trim(),
        ink: root.getPropertyValue("--a67-ink").trim(),
        figureBackground: figureStyle.backgroundColor,
        figureColor: figureStyle.color,
        directFigureTextBackground: directFigureText.backgroundColor,
        directFigureTextColor: directFigureText.color,
        figureHeadingColor: figureHeading.color,
        figureLinkColor: figureLink.color,
        figureLinkContrast: contrast(figureLink.color, figureStyle.backgroundColor),
        figureSvgTextFill: figureSvgText.fill,
        captionBackground: caption.backgroundColor,
        inverseFigureHeadingBackground: inverseFigureHeading.backgroundColor,
        inverseFigureHeadingColor: inverseFigureHeading.color,
        inverseFigureHeadingContrast: contrast(inverseFigureHeading.color, inverseFigureHeading.backgroundColor),
        inverseFigureCaptionBackground: inverseFigureCaption.backgroundColor,
        inverseFigureCaptionColor: inverseFigureCaption.color,
        inverseFigureCaptionLinkColor: inverseFigureCaptionLink.color,
        inverseFigureCaptionContrast: contrast(inverseFigureCaptionLink.color, inverseFigureCaption.backgroundColor),
        captionColor: caption.color,
        figureParagraphBackground: figureParagraph.backgroundColor,
        figureParagraphColor: figureParagraph.color,
        figureSvgBackground: figureSvg.backgroundColor,
        nestedInverseBackground: nestedInverseStyle.backgroundColor,
        nestedInverseHeadingColor: nestedInverseHeading.color,
        nestedInverseLinkColor: nestedInverseLink.color,
        nestedInverseHeadingContrast: contrast(nestedInverseHeading.color, nestedInverseStyle.backgroundColor),
        nestedInverseLinkContrast: contrast(nestedInverseLink.color, nestedInverseStyle.backgroundColor),
        headerInverseFigureBackground: headerInverseFigureStyle.backgroundColor,
        headerInverseFigureColor: headerInverseFigureStyle.color,
        headerInverseLinkColor: headerInverseLink.color,
        gradient: figure.backgroundImage,
        glow: kpiStyle.boxShadow,
        kpiDisplay: kpiStyle.display,
        kpiBackground: kpiStyle.backgroundColor,
        kpiColor: kpiValue.color,
        buttonColor: button.color,
        buttonBackground: button.backgroundColor,
        captionContrast: contrast(caption.color, caption.backgroundColor),
        figureParagraphContrast: contrast(figureParagraph.color, figureParagraph.backgroundColor),
        kpiContrast: contrast(kpiValue.color, kpiStyle.backgroundColor),
        buttonContrast: contrast(button.color, button.backgroundColor),
        rules: styles.cssRules.length,
        inverseHeadingColor: inverseHeading.color,
        inverseHeadingContrast: contrast(inverseHeading.color, inverseSection.backgroundColor),
        inversePreBackground: inversePre.backgroundColor,
        inversePreColor: inversePre.color,
        inversePreContrast: contrast(inversePre.color, inversePre.backgroundColor),
        inverseCodeColor: inverseCode.color,
        inverseCodeContrast: contrast(inverseCode.color, inversePre.backgroundColor),
        inverseHeadBackground: inverseThead.backgroundColor,
        inverseHeadColor: inverseHead.color,
        inverseHeadContrast: contrast(inverseHead.color, inverseThead.backgroundColor),
        inverseStripeBackground: inverseStripe.backgroundColor,
        inverseStripeColor: stripeCell.color,
        inverseStripeContrast: contrast(stripeCell.color, inverseStripe.backgroundColor),
        inverseStripeHeadingColor: inverseStripeHeading.color,
        inverseStripeHeadingContrast: contrast(inverseStripeHeading.color, inverseStripe.backgroundColor),
        densityGapRatio: expandedGap / compactGap,
      };
    })()`);
    const expected = theme.tokens[scheme];
    const rgb = value => `rgb(${parseInt(value.slice(1, 3), 16)}, ${parseInt(value.slice(3, 5), 16)}, ${parseInt(value.slice(5, 7), 16)})`;
    const expectedSurface = rgb(expected.surface);
    const expectedInk = rgb(expected.ink);
    const expectedAccent = rgb(expected.accent);
    const expectedAccentInk = rgb(expected["accent-ink"]);
    const expectedOnAccent = rgb(expected["on-accent"]);
    assert.equal(themeState.bg, expected.bg, `${theme.slug} ${scheme} canvas token`);
    assert.equal(themeState.ink, expected.ink, `${theme.slug} ${scheme} ink token`);
    assert(themeState.glow.includes('inset'), `${theme.slug} ${scheme} glow effect must parse`);
    assert.equal(themeState.kpiDisplay, 'block', `${theme.slug} ${scheme} glow applies to the generated KPI group block`);
    assert.equal(themeState.kpiBackground, expectedSurface, `${theme.slug} ${scheme} glow surface is opaque`);
    assert.equal(themeState.kpiColor, expectedInk, `${theme.slug} ${scheme} inverse KPI text uses its checked ink/surface pair`);
    assert(themeState.kpiContrast >= 4.5, `${theme.slug} ${scheme} rendered KPI contrast`);
    assert.equal(themeState.figureBackground, expectedSurface, `${theme.slug} ${scheme} aurora figure has an opaque base behind direct text and gradient`);
    assert.equal(themeState.figureColor, expectedInk, `${theme.slug} ${scheme} inverse direct figure text uses its checked ink/surface pair`);
    assert.equal(themeState.figureParagraphBackground, expectedSurface, `${theme.slug} ${scheme} figure paragraph opaque surface`);
    assert.equal(themeState.figureParagraphColor, expectedInk, `${theme.slug} ${scheme} inverse figure paragraph text uses its checked ink/surface pair`);
    assert.equal(themeState.figureHeadingColor, expectedInk, `${theme.slug} ${scheme} inverse figure heading text uses its checked ink/surface pair`);
    assert.equal(themeState.inverseFigureHeadingBackground, expectedAccent, `${theme.slug} ${scheme} direct inverse aurora heading retains accent background`);
    assert.equal(themeState.inverseFigureHeadingColor, expectedOnAccent, `${theme.slug} ${scheme} direct inverse aurora heading retains on-accent foreground`);
    assert(themeState.inverseFigureHeadingContrast >= 4.5, `${theme.slug} ${scheme} direct inverse aurora heading contrast`);
    assert.equal(themeState.inverseFigureCaptionBackground, expectedAccent, `${theme.slug} ${scheme} inverse aurora caption retains accent background`);
    assert.equal(themeState.inverseFigureCaptionColor, expectedOnAccent, `${theme.slug} ${scheme} inverse aurora caption retains on-accent foreground`);
    assert.equal(themeState.inverseFigureCaptionLinkColor, expectedOnAccent, `${theme.slug} ${scheme} inverse aurora caption link retains on-accent foreground`);
    assert(themeState.inverseFigureCaptionContrast >= 4.5, `${theme.slug} ${scheme} inverse aurora caption link contrast`);
    assert.equal(themeState.figureLinkColor, expectedAccentInk, `${theme.slug} ${scheme} unwrapped figure link uses the kit accent-ink token`);
    assert(themeState.figureLinkContrast >= 4.5, `${theme.slug} ${scheme} rendered figure-link contrast against its opaque surface`);
    assert.equal(themeState.directFigureTextBackground, expectedSurface, `${theme.slug} ${scheme} wrapped direct figure text has an opaque surface`);
    assert.equal(themeState.directFigureTextColor, expectedInk, `${theme.slug} ${scheme} wrapped direct figure text uses checked ink`);
    assert.equal(themeState.nestedInverseBackground, expectedAccent, `${theme.slug} ${scheme} nested inverse region retains accent surface`);
    assert.equal(themeState.nestedInverseHeadingColor, expectedOnAccent, `${theme.slug} ${scheme} nested inverse heading retains on-accent foreground`);
    assert.equal(themeState.nestedInverseLinkColor, expectedOnAccent, `${theme.slug} ${scheme} nested inverse link retains on-accent foreground`);
    assert(themeState.nestedInverseHeadingContrast >= 4.5, `${theme.slug} ${scheme} nested inverse heading contrast`);
    assert(themeState.nestedInverseLinkContrast >= 4.5, `${theme.slug} ${scheme} nested inverse link contrast`);
    assert.equal(themeState.headerInverseFigureBackground, expectedSurface, `${theme.slug} ${scheme} inverse hero header's figure remains on an opaque surface`);
    assert.equal(themeState.headerInverseFigureColor, expectedInk, `${theme.slug} ${scheme} inverse hero header figure uses checked ink`);
    assert.equal(themeState.headerInverseLinkColor, expectedInk, `${theme.slug} ${scheme} inverse hero header figure link uses checked ink`);
    assert.equal(themeState.figureSvgBackground, expectedSurface, `${theme.slug} ${scheme} SVG figure opaque surface`);
    assert.equal(themeState.figureSvgTextFill, 'rgb(255, 255, 255)', `${theme.slug} ${scheme} explicit SVG text paint remains intact`);
    assert(themeState.figureParagraphContrast >= 4.5, `${theme.slug} ${scheme} rendered figure paragraph contrast`);
    assert(themeState.rules > 5, `${theme.slug} ${scheme} generated CSS rules must parse`);
    assert(themeState.captionContrast >= 4.5, `${theme.slug} ${scheme} rendered caption contrast`);
    assert(themeState.buttonContrast >= 4.5, `${theme.slug} ${scheme} rendered control contrast`);
    assert.equal(themeState.inverseHeadingColor, expectedOnAccent, `${theme.slug} ${scheme} inverse-section heading uses on-accent`);
    assert(themeState.inverseHeadingContrast >= 4.5, `${theme.slug} ${scheme} rendered inverse-section heading contrast`);
    assert.equal(themeState.inverseCodeColor, expectedInk, `${theme.slug} ${scheme} code inside inverse pre uses surface ink`);
    assert(themeState.inverseCodeContrast >= 4.5, `${theme.slug} ${scheme} rendered inverse code contrast`);
    assert.equal(themeState.inversePreBackground, expectedSurface, `${theme.slug} ${scheme} inverse pre uses an opaque surface`);
    assert.equal(themeState.inversePreColor, expectedInk, `${theme.slug} ${scheme} inverse pre restores its ink foreground`);
    assert(themeState.inversePreContrast >= 4.5, `${theme.slug} ${scheme} rendered inverse pre contrast`);
    assert.equal(themeState.inverseHeadBackground, expectedSurface, `${theme.slug} ${scheme} inverse table header uses an opaque surface`);
    assert.equal(themeState.inverseHeadColor, expectedInk, `${theme.slug} ${scheme} inverse table header restores its ink foreground`);
    assert(themeState.inverseHeadContrast >= 4.5, `${theme.slug} ${scheme} rendered inverse table-header contrast`);
    assert.notEqual(themeState.inverseStripeBackground, expectedAccent, `${theme.slug} ${scheme} inverse striped row does not retain accent`);
    assert.equal(themeState.inverseStripeColor, expectedInk, `${theme.slug} ${scheme} inverse striped row restores its ink foreground`);
    assert(themeState.inverseStripeContrast >= 4.5, `${theme.slug} ${scheme} rendered inverse striped-row contrast`);
    assert.equal(themeState.inverseStripeHeadingColor, expectedInk, `${theme.slug} ${scheme} heading on striped opaque surface uses surface ink`);
    assert(themeState.inverseStripeHeadingContrast >= 4.5, `${theme.slug} ${scheme} rendered inverse striped-row heading contrast`);
    assert(Math.abs(themeState.densityGapRatio - 1.25 / 0.75) < 0.02, `${theme.slug} ${scheme} density changes rendered layout gap; got ${themeState.densityGapRatio}`);
  }
  await staticEvaluate('document.title="Page theme static and data-bound smoke"');
  await runAxeThemeMatrix('static-and-data-bound', staticCommand, staticEvaluate);
  assert.deepEqual(kitRequests.filter(url => !/^(?:data:|blob:|about:)/i.test(url)), [], 'Theme runtime smoke must make no external or network requests.');
  assert.deepEqual(kitConsoleErrors, [], 'Theme runtime smoke must not log console errors.');
  assert.deepEqual(kitExceptions, [], 'Theme runtime smoke must not throw exceptions.');
  assert.deepEqual(kitCspViolations, [], 'Theme runtime smoke must have no CSP violations.');
  console.log('page theme smoke: report/editorial/launch in light/dark, runtime KPI/aurora opaque text foregrounds and explicit SVG fill preservation under CSP passed (SVG contrast not automated)');
  const kitTarget = await call('Target.createTarget', { url: 'about:blank' });
  const kitAttached = await call('Target.attachToTarget', { targetId: kitTarget.targetId, flatten: true });
  const kitCommand = (method, params) => call(method, params, kitAttached.sessionId);
  kitSessionId = kitAttached.sessionId;
  await kitCommand('Network.enable');
  await kitCommand('Runtime.enable');
  await kitCommand('Log.enable');
  await kitCommand('Page.enable');
  const { frameTree: kitTree } = await kitCommand('Page.getFrameTree');
  const inlineLogo = (await readFile(new URL('../../worker/test/fixtures/page-image.png', import.meta.url))).toString('base64');
  const interactiveHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>${kitCss}</style></head><body>
    ${bindingSdk}
    <main><h1>Interactive report</h1><a67-toc label="Contents">
    </a67-toc><h2>Summary</h2><h3>Revenue</h3><h2>Details</h2>
    <a67-tabs><div role="tablist" aria-label="Report sections"><button id="tab-one" type="button" role="tab" aria-controls="panel-one" aria-selected="true" tabindex="0">One</button><button id="tab-two" type="button" role="tab" aria-controls="panel-two" aria-selected="false" tabindex="-1" disabled="">Two</button><button id="tab-three" type="button" role="tab" aria-controls="panel-three" aria-selected="false" tabindex="-1">Three</button></div><section id="panel-one" role="tabpanel" aria-labelledby="tab-one">First panel</section><section id="panel-two" role="tabpanel" aria-labelledby="tab-two" hidden="">Second panel</section><section id="panel-three" role="tabpanel" aria-labelledby="tab-three">Third panel<a67-tabs id="nested-tabs"><div role="tablist"><button id="inner-tab-one" type="button" role="tab" aria-controls="inner-panel-one" aria-selected="true" tabindex="0">Inner one</button><button id="inner-tab-two" type="button" role="tab" aria-controls="inner-panel-two" aria-selected="false" tabindex="-1">Inner two</button></div><section id="inner-panel-one" role="tabpanel" aria-labelledby="inner-tab-one">Nested first</section><section id="inner-panel-two" role="tabpanel" aria-labelledby="inner-tab-two" hidden="">Nested second</section></a67-tabs></section></a67-tabs>
    <a67-kpi label="Visitors" value="1,240" delta="+12%" trend="up"></a67-kpi>
    <table id="chart-source"><caption>Monthly visits</caption><thead><tr><th scope="col">Month</th><th scope="col">Visitors</th></tr></thead><tbody><tr><th scope="row">January</th><td>10</td></tr><tr><th scope="row">February</th><td>20</td></tr></tbody></table>
    <a67-chart id="visitors-chart" for="chart-source" type="bar" title="Visitors by month" label-column="Month" value-column="Visitors"></a67-chart>
    <a67-chart id="visitors-line" for="chart-source" type="line" title="Visitors trend" label-column="Month" value-column="Visitors"></a67-chart>
    <a67-chart id="visitors-donut" for="chart-source" type="donut" title="Visitors share" label-column="Month" value-column="Visitors"></a67-chart>
    <a67-form id="bound-form" collection="rsvp"></a67-form>
    <a67-form id="forbidden-form" collection="private"></a67-form>
    <a67-checklist id="bound-checklist" storage-key="reading" storage-scope="shared"><span data-item="chapter-1">Read chapter one</span></a67-checklist>
    <a67-records id="read-only" collection="sales" fields="title,amount"></a67-records>
    <a67-records id="editable" collection="sales" fields="title,amount" editable=""></a67-records>
    <a67-records id="empty-records" collection="empty"></a67-records>
    <a67-records id="broken-records" collection="broken"></a67-records>
    <a67-records id="denied-records" collection="private"></a67-records>
    <a67-kpi id="bound-kpi" label="Sales" collection="sales" field="amount" aggregate="sum"></a67-kpi>
    <a67-kpi id="empty-kpi" label="Empty" collection="empty" field="amount" aggregate="sum"></a67-kpi>
    <a67-kpi id="broken-kpi" label="Broken" collection="broken" field="amount" aggregate="sum"></a67-kpi>
    <a67-kpi id="denied-kpi" label="Denied" collection="private" field="amount" aggregate="sum"></a67-kpi>
    <a67-kpi id="pending-kpi" label="Pending" collection="pending" field="amount" aggregate="sum"></a67-kpi>
    <a67-logo id="resolved-logo" label="Example logo"></a67-logo><a67-logo id="fallback-logo" label="Fallback logo"></a67-logo><a67-logo id="decorative-logo" label=""></a67-logo></main>
    <script>${kitRuntime}</script></body></html>`;
  const kitDocument = interactiveHtml.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' data: blob:; style-src \'unsafe-inline\'; img-src data:; font-src data: blob:; media-src data: blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; object-src \'none\'; frame-src \'none\'; worker-src \'none\'">');
  await kitCommand('Page.setDocumentContent', { frameId: kitTree.frame.id, html: kitDocument });
  const kitEvaluate = async expression => evaluate(expression, undefined, kitCommand);
  await until('document.readyState === "complete" && !!document.querySelector("a67-toc nav") && !!document.querySelector("a67-chart svg")', undefined, kitCommand);
  await until('document.querySelector("#bound-form [data-a67-state]")?.dataset.state==="ready" && document.querySelector("#forbidden-form [data-a67-state]")?.dataset.state==="forbidden" && document.querySelector("#bound-checklist [data-a67-state]")?.dataset.state==="ready" && document.querySelector("#read-only tbody tr") && document.querySelector("#editable tbody tr") && document.querySelector("#empty-records [data-a67-state]")?.dataset.state==="empty" && document.querySelector("#broken-records [data-a67-state]")?.dataset.state==="error" && document.querySelector("#denied-records [data-a67-state]")?.dataset.state==="forbidden" && document.querySelector("#bound-kpi [data-a67-state]")?.dataset.state==="ready" && document.querySelector("#empty-kpi [data-a67-state]")?.dataset.state==="empty" && document.querySelector("#broken-kpi [data-a67-state]")?.dataset.state==="error" && document.querySelector("#denied-kpi [data-a67-state]")?.dataset.state==="forbidden"', undefined, kitCommand);
  const bindingStates = await kitEvaluate(`(() => {
    const state = id => document.querySelector("#" + id + " [data-a67-state]")?.dataset.state;
    return {
      form: state("bound-form"), formDenied: state("forbidden-form"),
      checklist: state("bound-checklist"), restored: document.querySelector("#bound-checklist input")?.checked,
      readOnly: state("read-only"), readOnlyActions: document.querySelectorAll("#read-only tbody button").length,
      editable: state("editable"), recordsEmpty: state("empty-records"), recordsError: state("broken-records"), recordsDenied: state("denied-records"),
      kpi: state("bound-kpi"), kpiValue: document.querySelector("#bound-kpi [data-a67-kpi-value]")?.textContent,
      kpiEmpty: state("empty-kpi"), kpiError: state("broken-kpi"), kpiDenied: state("denied-kpi"),
      loading: state("pending-kpi"), storage: bindingCalls.find(call => call.op === "storage.get"),
    };
  })()`);
  assert.deepEqual(bindingStates, {
    form: "ready", formDenied: "forbidden", checklist: "ready", restored: true,
    readOnly: "ready", readOnlyActions: 0, editable: "ready", recordsEmpty: "empty", recordsError: "error", recordsDenied: "forbidden",
    kpi: "ready", kpiValue: "7", kpiEmpty: "empty", kpiError: "error", kpiDenied: "forbidden", loading: "loading",
    storage: { op: "storage.get", key: "reading", scope: "shared" },
  }, 'Bound components expose live data, scoped persistence, editable authority path, and distinct accessible states.');
  const formPayload = await kitEvaluate('(() => { const form=document.querySelector("#bound-form form"), input=document.querySelector("#bound-form input[name=email]"); input.value="ana@example.test"; return { name:input.name, entries:[...new FormData(form)] }; })()');
  assert.deepEqual(formPayload, { name: "email", entries: [["email", "ana@example.test"]] }, 'Generated controls serialize through native FormData.');
  await kitEvaluate('document.querySelector("#bound-form form").requestSubmit()');
  await until('document.querySelector("#bound-form [data-a67-state]")?.textContent==="Response submitted."', undefined, kitCommand);
  assert.deepEqual(await kitEvaluate('bindingCalls.find(call => call.op === "data.submit")'), {
    op: "data.submit", collection: "rsvp", data: { email: "ana@example.test" },
  }, 'The generated form submits the schema-named value through the SDK.');
  await kitEvaluate('document.querySelector("#bound-checklist").save("chapter-1", false)');
  assert.deepEqual(await kitEvaluate('bindingCalls.find(call => call.op === "storage.set")'), {
    op: "storage.set", key: "reading", value: [], scope: "shared",
  }, 'Checklist changes preserve their declared storage key and scope.');
  await kitEvaluate('document.querySelector("#editable tbody button").click()');
  await until('!!document.querySelector("#editable form input[name=title]")', undefined, kitCommand);
  await kitEvaluate('(() => { const form=document.querySelector("#editable form"); form.elements.title.value="January revised"; form.requestSubmit(); })()');
  await until('document.querySelector("#editable tbody tr td")?.textContent==="January revised"', undefined, kitCommand);
  assert.deepEqual(await kitEvaluate('bindingCalls.find(call => call.op === "data.update")'), {
    op: "data.update", data: { title: "January revised", amount: "7" }, version: 1,
  }, 'Authorized record edits use get/update and the live record version.');
  await kitEvaluate('resolvePendingSchema()');
  await until('document.querySelector("#pending-kpi [data-a67-state]")?.dataset.state!=="loading"', undefined, kitCommand);
  const pendingState = await kitEvaluate('({ state:document.querySelector("#pending-kpi [data-a67-state]")?.dataset.state, message:document.querySelector("#pending-kpi [data-a67-state]")?.textContent })');
  assert.equal(pendingState.state, "ready", `The pending KPI should settle after schema resolution: ${JSON.stringify(pendingState)}`);
  await kitEvaluate('delete window.artefacts.data; delete window.artefacts.storage');
  await kitEvaluate('Promise.all([document.querySelector("#bound-form").load(), document.querySelector("#read-only").load(), document.querySelector("#bound-kpi").loadAggregate()])');
  await kitEvaluate('document.querySelector("#bound-checklist").save("chapter-1", false)');
  const standaloneBindings = await kitEvaluate(`(() => ({
    form: document.querySelector("#bound-form [data-a67-state]")?.dataset.state,
    fakeForm: !!document.querySelector("#bound-form form"),
    records: document.querySelector("#read-only [data-a67-state]")?.dataset.state,
    kpi: document.querySelector("#bound-kpi [data-a67-state]")?.dataset.state,
    checklist: document.querySelector("#bound-checklist [data-a67-state]")?.textContent,
  }))()`);
  assert.deepEqual(standaloneBindings, {
    form: "error", fakeForm: false, records: "error", kpi: "error",
    checklist: "Session-only checklist; changes are not saved.",
  }, 'Standalone output labels hosted-only bindings and session-only checklist state instead of faking data.');
  const toc = await kitEvaluate('(() => { const nav=document.querySelector("a67-toc nav"); const headings=[...document.querySelectorAll("h2,h3")]; const links=[...nav.querySelectorAll("a")]; links[0].click(); return { label:nav.getAttribute("aria-label"),count:links.length,href:links[0].getAttribute("href"),headingId:headings[0].id,hash:location.hash,depth:nav.querySelector("[data-depth]")?.textContent.trim() }; })()');
  assert.equal(toc.label, 'Contents');
  assert.equal(toc.count, 3, 'TOC discovers h2 and h3 headings.');
  assert.equal(toc.href, `#${toc.headingId}`, 'Generated TOC fragment links point at the discovered heading.');
  assert.equal(toc.hash, toc.href, 'Clicking a TOC link uses normal fragment navigation.');
  assert.equal(toc.depth, 'Revenue', 'Nested h3 headings remain visible and identified.');
  assert(await kitEvaluate('(() => { const group=document.querySelector("a67-kpi [role=group]"); return group.getAttribute("aria-label")==="Visitors" && group.querySelector("[data-a67-kpi-value]").textContent==="1,240" && group.querySelector("[data-a67-kpi-delta]").textContent==="Increase: +12%" && !document.querySelector("a67-kpi").hasAttribute("collection"); })()'), 'Literal KPI value and non-color trend must render without a binding.');
  const tabsFocus = async id => kitEvaluate(`document.getElementById(${JSON.stringify(id)}).focus()`);
  const pressTabKey = async (key, code, virtualKey) => {
    await kitCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
    await kitCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
  };
  await tabsFocus('tab-one');
  await pressTabKey('ArrowRight', 'ArrowRight', 39);
  await until('document.activeElement.id === "tab-three" && document.getElementById("tab-three").getAttribute("aria-selected")==="true"', undefined, kitCommand);
  assert(await kitEvaluate('!document.getElementById("panel-three").hidden && document.getElementById("panel-one").hidden && document.getElementById("tab-two").disabled && document.getElementById("tab-two").tabIndex===-1'), 'ArrowRight skips the disabled tab while preserving selection, roving tabindex, and panel visibility.');
  await pressTabKey('End', 'End', 35);
  assert(await kitEvaluate('document.activeElement.id==="tab-three" && document.getElementById("tab-three").getAttribute("aria-selected")==="true" && !document.getElementById("panel-three").hidden'), 'End focuses and selects the last enabled tab and reveals its panel.');
  await pressTabKey('Home', 'Home', 36);
  assert(await kitEvaluate('document.activeElement.id==="tab-one" && document.getElementById("tab-one").getAttribute("aria-selected")==="true" && !document.getElementById("panel-one").hidden'), 'Home focuses and selects the first enabled tab and reveals its panel.');
  await pressTabKey('ArrowLeft', 'ArrowLeft', 37);
  assert(await kitEvaluate('document.activeElement.id==="tab-three" && document.getElementById("tab-three").getAttribute("aria-selected")==="true"'), 'ArrowLeft wraps to the last enabled tab.');
  await kitEvaluate('document.getElementById("inner-tab-two").click()');
  assert(await kitEvaluate('document.getElementById("tab-three").getAttribute("aria-selected")==="true" && !document.getElementById("panel-three").hidden && document.getElementById("inner-tab-two").getAttribute("aria-selected")==="true" && !document.getElementById("inner-panel-two").hidden'), 'Nested tab clicks change only the nested tab component.');
  await kitCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  const resizeViewport = await kitEvaluate('innerWidth');
  await kitEvaluate('document.documentElement.style.fontSize="200%"');
  const textResize = await kitEvaluate('(() => { const heading=document.querySelector("h1"), tab=document.getElementById("tab-one"), rect=heading.getBoundingClientRect(), main=document.querySelector("main"), client=document.documentElement.clientWidth, overflow=[...document.querySelectorAll("body *")].filter(el=>el.getBoundingClientRect().right>client+1).slice(0,8).map(el=>[el.tagName,el.id,Math.round(el.getBoundingClientRect().right),el.scrollWidth,el.clientWidth]); return { viewport:innerWidth, client, fontSize:parseFloat(getComputedStyle(document.documentElement).fontSize), page:document.documentElement.scrollWidth, heading:heading.textContent, headingVisible:rect.width>0&&rect.left>=0&&rect.right<=innerWidth, content:main.textContent.includes("January")&&main.textContent.includes("Monthly visits"), tabVisible:tab.getBoundingClientRect().width>0, tabEnabled:!tab.disabled, overflow }; })()');
  assert.equal(resizeViewport, 390, 'The text-resize check must start with a 390 CSS-pixel viewport.');
  assert.equal(textResize.viewport, 390, 'The 200% text-resize check must keep the 390 CSS-pixel viewport.');
  assert.equal(textResize.fontSize, 32, '200% text resizing must double the 16px root text size.');
  assert(textResize.page <= textResize.client, `Interactive content overflows horizontally at 200% text size: ${textResize.page}px > ${textResize.client}px; ${JSON.stringify(textResize.overflow)}.`);
  assert.equal(textResize.heading, "Interactive report");
  assert(textResize.headingVisible && textResize.content && textResize.tabVisible && textResize.tabEnabled, 'Text, content and keyboard controls remain visible and operable at 200% size.');
  await tabsFocus('tab-one');
  await pressTabKey('ArrowRight', 'ArrowRight', 39);
  assert(await kitEvaluate('document.activeElement.id==="tab-three" && !document.getElementById("panel-three").hidden'), 'Keyboard tab operation remains available at 200% size.');
  await kitEvaluate('document.documentElement.style.removeProperty("font-size")');
  await kitCommand('Emulation.clearDeviceMetricsOverride');
  await kitCommand('Emulation.setEmulatedMedia', { media: 'print' });
  const tabPrint = await kitEvaluate('({hidden:document.getElementById("panel-one").hidden,display:getComputedStyle(document.getElementById("panel-one")).display,selected:document.getElementById("tab-three").getAttribute("aria-selected"),nestedDisplay:getComputedStyle(document.getElementById("inner-panel-one")).display})');
  assert.equal(tabPrint.hidden, true);
  assert.notEqual(tabPrint.display, 'none', 'Inactive panels must be visible in print.');
  assert.equal(tabPrint.selected, 'true', 'Printing does not change the screen tab selection state.');
  assert.notEqual(tabPrint.nestedDisplay, 'none', 'Inactive nested panels must be visible in print.');
  await kitCommand('Emulation.setEmulatedMedia', { media: '' });
  assert(await kitEvaluate('document.getElementById("panel-one").hidden && document.getElementById("tab-three").getAttribute("aria-selected")==="true"'), 'Leaving print preserves screen selection and panel state.');
  const chart = await kitEvaluate('(() => { const host=document.querySelector("a67-chart"); const svg=host.querySelector("svg"); const title=document.getElementById(svg.querySelector("title").id); const description=svg.querySelector("desc").textContent; const widths=[...svg.querySelectorAll("rect")].map(rect=>Number(rect.getAttribute("width"))); return { role:svg.getAttribute("role"),title:title.textContent,description,widths,tableVisible:getComputedStyle(document.getElementById("chart-source")).display!=="none",summary:host.querySelector("figcaption").textContent }; })()');
  assert.equal(chart.role, 'img');
  assert.equal(chart.title, 'Visitors by month');
  assert.match(chart.description, /January, 10; February, 20/);
  assert(chart.widths[1] > chart.widths[0], 'Chart bar lengths derive from the visible table values.');
  assert(chart.tableVisible, 'The source table remains visible as the chart alternative.');
  assert.match(chart.summary, /January — 10; February — 20/);
  const chartVariants = await kitEvaluate('(() => { const line=document.querySelector("#visitors-line"), donut=document.querySelector("#visitors-donut"), lineSvg=line.querySelector("svg"), donutSvg=donut.querySelector("svg"); return { lineRole:lineSvg.getAttribute("role"),lineTitle:lineSvg.querySelector("title").textContent,lineDescription:lineSvg.querySelector("desc").textContent,lineMarkers:lineSvg.querySelectorAll("circle").length,donutRole:donutSvg.getAttribute("role"),donutDescription:donutSvg.querySelector("desc").textContent,donutArcs:donutSvg.querySelectorAll("circle").length,donutHeight:Number(donutSvg.getAttribute("viewBox").split(" ")[3]),donutBottom:88+58+15,donutSummary:donut.querySelector("figcaption").textContent }; })()');
  assert.equal(chartVariants.lineRole, 'img');
  assert.equal(chartVariants.lineTitle, 'Visitors trend');
  assert.match(chartVariants.lineDescription, /January, 10; February, 20/);
  assert.equal(chartVariants.lineMarkers, 2);
  assert.equal(chartVariants.donutRole, 'img');
  assert.match(chartVariants.donutDescription, /January, 10; February, 20/);
  assert.equal(chartVariants.donutArcs, 2);
  assert(chartVariants.donutHeight >= chartVariants.donutBottom + 8, 'Donut SVG reserves room for the complete stroked circle.');
  assert.match(chartVariants.donutSummary, /January — 10; February — 20/);
  await kitEvaluate('document.querySelector("#chart-source tbody tr td").textContent="30"');
  await until('document.querySelector("a67-chart figcaption")?.textContent.includes("January — 30")', undefined, kitCommand);
  assert.match(await kitEvaluate('document.querySelector("a67-chart svg desc").textContent'), /January, 30/);
  const nestedChart = await kitEvaluate(`(async () => {
    document.documentElement.setAttribute("lang","hr-HR");
    const table=document.createElement("table"); table.id="self-observed-source";
    const caption=document.createElement("caption"); caption.textContent="Self-observed chart";
    const head=document.createElement("thead"), header=document.createElement("tr");
    const monthHeader=document.createElement("th"), valueHeader=document.createElement("th");
    monthHeader.textContent="Month"; valueHeader.textContent="Value"; header.append(monthHeader,valueHeader); head.append(header);
    const body=document.createElement("tbody"), row=document.createElement("tr");
    const month=document.createElement("th"), value=document.createElement("td");
    month.textContent="April"; value.textContent="1.234,5"; row.append(month,value); body.append(row);
    table.append(caption,head,body); document.body.append(table);
    let observed=0, frames=0, ticking=true;
    const observer=new MutationObserver(records=>observed+=records.length);
    observer.observe(table,{subtree:true,childList:true,characterData:true});
    const chart=document.createElement("a67-chart");
    chart.id="self-observed-chart"; chart.setAttribute("for",table.id); chart.setAttribute("type","bar");
    chart.setAttribute("title","Self-observed chart"); chart.setAttribute("label-column","Month"); chart.setAttribute("value-column","Value");
    requestAnimationFrame(function tick(){frames++;if(ticking)requestAnimationFrame(tick);});
    caption.append(chart);
    await new Promise(resolve=>setTimeout(resolve,120));
    const firstCount=observed, firstFrames=frames;
    await new Promise(resolve=>setTimeout(resolve,120));
    ticking=false; observer.disconnect();
    return {stable:observed===firstCount, responsive:frames>firstFrames, mutations:observed, figure:!!chart.querySelector("figure"), summary:chart.querySelector("figcaption")?.textContent};
  })()`);
  assert.equal(nestedChart.stable, true, `Chart must not observe its own generated content indefinitely: ${nestedChart.mutations} mutations.`);
  assert.equal(nestedChart.responsive, true, 'The frame must continue servicing animation frames during chart initialization.');
  assert.equal(nestedChart.figure, true, 'The chart frame remains present after observer processing.');
  assert.match(nestedChart.summary, /April — 1234\.5/);
  console.log('page kit browser regression: table-caption chart observer settles, preserves its SVG, parses decimal-comma values, and keeps animation frames responsive');
  await kitEvaluate(`window.__a67PageKit.configure({ logo: "data:image/png;base64,${inlineLogo}" })`);
  const resolvedLogo = await kitEvaluate('(() => { const svg=document.querySelector("#resolved-logo svg"); return { role:svg.getAttribute("role"),label:svg.getAttribute("aria-label"),href:svg.querySelector("image")?.getAttribute("href"),fallback:svg.querySelectorAll("path").length }; })()');
  assert.equal(resolvedLogo.role, 'img');
  assert.equal(resolvedLogo.label, 'Example logo');
  assert.equal(resolvedLogo.href, `data:image/png;base64,${inlineLogo}`);
  assert.equal(resolvedLogo.fallback, 0, 'Resolved theme logo renders as an inline SVG image.');
  await kitEvaluate('window.__a67PageKit.configure({ logo: null })');
  const logoFallback = await kitEvaluate('(() => { const svg=document.querySelector("#fallback-logo svg"), decorative=document.querySelector("#decorative-logo svg"); return { role:svg.getAttribute("role"),label:svg.getAttribute("aria-label"),paths:svg.querySelectorAll("path").length,mark:svg.querySelector("path")?.getAttribute("d").startsWith("M297.8"),decorative:decorative.getAttribute("aria-hidden"),decorativeRole:decorative.getAttribute("role") }; })()');
  assert.deepEqual(logoFallback, { role: 'img', label: 'Fallback logo', paths: 2, mark: true, decorative: 'true', decorativeRole: null }, 'Missing logo uses the actual platform mark; an empty label is decorative.');
  await new Promise(resolve => setTimeout(resolve, 25));
  await kitEvaluate('document.title="Page theme interactive and data-bound smoke"');
  await runAxeThemeMatrix('interactive-and-data-bound', kitCommand, kitEvaluate);
  assert.deepEqual(kitRequests.filter(url => !/^(?:data:|blob:|about:)/i.test(url)), [], 'Page-kit behavior must not issue external or network requests.');
  assert.deepEqual(kitConsoleErrors, [], 'Page-kit behavior must not log console errors.');
  assert.deepEqual(kitExceptions, [], 'Page-kit behavior must not throw uncaught exceptions.');
  assert.deepEqual(kitCspViolations, [], 'Page-kit behavior must not trigger Content Security Policy violations.');
  await call('Target.closeTarget', { targetId: kitTarget.targetId });
  console.log('page kit interaction smoke: TOC links, keyboard tabs, literal KPI, table-synchronized chart, resolved logo and platform-mark fallback; no requests, console errors, exceptions or CSP violations');
  await until('!!document.querySelector("iframe.artifact-frame")');
  await command('Page.bringToFront');
  await command('Browser.grantPermissions', { origin: viewer.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const promptCopy = await evaluate('new Promise(async (resolve, reject) => { const button = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Copy AI prompt"); if (!button) return reject(new Error("Copy AI prompt button is missing.")); button.click(); const until = async () => { const status = document.querySelector("[aria-live=polite]"); if (status?.textContent.trim() === "AI prompt copied") return resolve({ status: status.textContent.trim(), text: await navigator.clipboard.readText() }); if (status?.textContent.includes("Unable to copy")) return reject(new Error(status.textContent)); setTimeout(until, 50); }; until(); })');
  assert(promptCopy.text.startsWith('# Artefacts67: instructions for AI agents'), 'Copy AI prompt must copy /llms.txt.');
  assert.equal(promptCopy.status, 'AI prompt copied', 'Copy AI prompt must announce success.');
  assert(await evaluate('document.querySelector(".viewer-title-button").textContent.includes("Solid 2 smoke")'), 'Use a dedicated Solid 2 smoke fixture, not an ordinary artefact.');
  const viewerArtifact = /^\/app\/a\/([^/]+)\/view\/?$/.exec(viewer.pathname);
  assert(viewerArtifact, 'Use the prescribed local /app/a/<smoke-slug>/view URL.');
  const artifactRef = decodeURIComponent(viewerArtifact[1]);
  const artifactListResponse = await fetch(new URL('/_api/artifacts', viewer.origin), {
    headers: { Authorization: `Bearer ${process.env.WS_SMOKE_API_KEY}` },
  });
  assert.equal(artifactListResponse.status, 200, 'The local master key must list the smoke fixture.');
  const fixture = (await artifactListResponse.json()).artifacts.find(artifact =>
    artifact.id === artifactRef || artifact.slug === artifactRef);
  assert(fixture, 'The reader URL must identify the dedicated Solid 2 smoke artefact.');
  await evaluate('globalThis.readerFrame=document.querySelector("iframe.artifact-frame"); globalThis.readerDocument=document; globalThis.readerSidebar=document.querySelector("aside.sidebar");');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const openFrame = async (send = command) => {
    const { frameTree } = await send('Page.getFrameTree');
    let frame = frameTree.childFrames?.find(child => child.frame.parentId === frameTree.frame.id && child.frame.url === 'about:srcdoc')?.frame;
    let frameCommand = send, frameSessionId;
    // Chrome isolates the opaque sandbox in its own target on current releases.
    if (!frame) {
      const deadline = Date.now() + 15000;
      do {
        const target = (await call('Target.getTargets')).targetInfos.find(target => target.type === 'iframe' && target.parentFrameId === frameTree.frame.id && target.url === 'about:srcdoc');
        if (target) {
          const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          frameSessionId = attached.sessionId;
          frameCommand = (method, params) => call(method, params, attached.sessionId);
          const attachedTree = await frameCommand('Page.getFrameTree');
          frame = attachedTree.frameTree.frame;
        }
        await delay(50);
      } while (Date.now() < deadline);
    }
    assert(frame, 'The authored document must be running.');
    const { executionContextId } = await frameCommand('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'reader-check' });
    await until('document.readyState === "complete"', executionContextId, frameCommand);
    return { executionContextId, frameCommand, frameSessionId };
  };
  const { executionContextId, frameCommand } = await openFrame();
  assert.equal(await evaluate('document.documentElement.lang', executionContextId, frameCommand), fixture.lang, 'Hosted page documents must use the published BCP-47 language.');
  // Model user-entered state inside the authored document, not in its parent.
  const bootId = globalThis.crypto.randomUUID();
  await evaluate(`document.documentElement.dataset.readerSmokeState = ${JSON.stringify(bootId)}`, executionContextId, frameCommand);
  const frameRead = () => evaluate('document.documentElement.dataset.readerSmokeState', executionContextId, frameCommand);
  await evaluate('document.querySelector("button[aria-label=Code]").click()');
  await until('!!document.querySelector(".artifact-code")');
  await evaluate('document.querySelector("button[aria-label=Preview]").click()');
  await until('!document.querySelector(".artifact-code")');
  assert.equal(await frameRead(), bootId, 'Preview/Code must preserve the authored document.');
  const parent = await evaluate(`(() => { const button = document.querySelector('button[aria-label^="Create subfolder in "]'); if (!button) throw new Error('Use a smoke fixture with an editable folder.'); const target = new URL(button.parentElement.querySelector('a[title="Folder settings"]').href).pathname; button.focus(); button.click(); return { label: button.getAttribute('aria-label'), target }; })()`);
  await until('!!document.querySelector("dialog[open] input[name=name]")');
  assert.equal(await evaluate('document.querySelector("dialog[open] form").getAttribute("action")'), `${parent.target}/subfolder`, 'The folder plus must target its own parent.');
  const beforeCancel = subfolderPosts;
  await evaluate('const name=document.querySelector("dialog[open] input[name=name]"); name.value="Cancelled reader smoke folder"; name.dispatchEvent(new Event("input",{bubbles:true}));');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await until('!document.querySelector("dialog[open]")');
  assert.equal(subfolderPosts, beforeCancel, 'Escape must not submit folder creation.');
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), parent.label, 'Cancellation must return focus to the folder plus.');
  assert.equal(await frameRead(), bootId, 'Cancelled folder creation must preserve authored state.');
  await evaluate('const share=document.querySelector("button[aria-label=Share]"); share.focus(); share.click();');
  await until('!!document.querySelector("dialog[open]")');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await until('!document.querySelector("dialog[open]")');
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Share', 'Escape must return focus to the opener.');
  await evaluate(`document.querySelector('button[aria-label="Artefact actions"]').click()`);
  await until('!!document.querySelector("[popover]:popover-open")');
  await evaluate('Array.from(document.querySelectorAll("[popover]:popover-open [role=menuitem]")).find(item=>item.textContent.trim()==="Rename").click()');
  await until('!!document.querySelector("dialog[open] input[name=title]")');
  // The queued close from Share must not dismiss a newly opened rename dialog.
  await delay(100);
  assert.equal(await evaluate('!!document.querySelector("dialog[open] input[name=title]")'), true, "A stale dialog close must not dismiss the new rename dialog.");
  const renamedTitle = await evaluate('document.querySelector(".viewer-title-button").textContent.trim()==="Solid 2 smoke renamed"') ? 'Solid 2 smoke updated' : 'Solid 2 smoke renamed';
  await evaluate(`(() => { const input=document.querySelector("dialog[open] input[name=title]"); if (!input) throw new Error("Rename dialog title input disappeared before submission."); input.value=${JSON.stringify(renamedTitle)}; input.dispatchEvent(new Event("input",{bubbles:true})); input.form.requestSubmit(); })()`);
  await until(`!document.querySelector("dialog[open]") && document.querySelector(".viewer-title-button").textContent.trim()===${JSON.stringify(renamedTitle)}`);
  assert(await evaluate('document===readerDocument && document.querySelector("iframe.artifact-frame")===readerFrame && document.querySelector("aside.sidebar")===readerSidebar'), 'Saving metadata must preserve the console, sidebar and frame.');
  assert.equal(await frameRead(), bootId, 'Saving metadata must preserve authored state.');
  assert.equal(await evaluate('document.querySelector("iframe.artifact-frame").getAttribute("sandbox")'), 'allow-scripts');
  const management = new URL(viewer.href);
  management.pathname = management.pathname.replace(/\/(?:view|preview)\/?$/, '');
  management.hash = 'sharing';
  await evaluate(`document.querySelector('button[aria-label="Artefact actions"]').click()`);
  await until('!!document.querySelector("[popover]:popover-open")');
  await evaluate('Array.from(document.querySelectorAll("[popover]:popover-open [role=menuitem]")).find(item=>item.textContent.trim()==="Artefact settings").click()');
  await until('!!document.querySelector("[role=tablist]")');
  assert(await evaluate('document.querySelector("aside.sidebar")===readerSidebar'), 'Opening resource settings must preserve the sidebar owner.');
  await evaluate('Array.from(document.querySelectorAll("[role=tab]")).find(item=>item.textContent==="Sharing").click()');
  await until('document.querySelector("[role=tab][aria-selected=true]").textContent==="Sharing"');
  // Reject an expired share: the POST error must not lose the tab or its GET URL.
  await evaluate('const panel=document.querySelector("[role=tabpanel]:not([hidden])");panel.querySelector("input[name=name]").value="Rejected Solid smoke share";panel.querySelector("input[name=expiresAt]").value="2000-01-01";panel.querySelector("form").requestSubmit();');
  await until('!!document.querySelector("[role=alert]")');
  assert.equal(await evaluate('document.querySelector("[role=tab][aria-selected=true]").textContent'), 'Sharing');
  assert.equal(await evaluate('location.href'), management.href);
  assert(await evaluate('document===readerDocument'), 'Validation responses must not reload the console.');
  // Hold real Worker responses, not mocked pages, to control stale POST ordering.
  const onEvent = (method, listener, session = sessionId) => {
    const handler = event => { const message = JSON.parse(event.data); if (message.sessionId === session && message.method === method) listener(message.params); };
    socket.addEventListener('message', handler);
    return () => socket.removeEventListener('message', handler);
  };
  management.hash = '';
  const clickManagement = () => evaluate(`Array.from(document.querySelectorAll('a[href]')).find(link => link.href === ${JSON.stringify(management.href)} && !link.target).click()`);
  for (const ordering of ['pending-get', 'same-url', 'away-back']) {
    await clickManagement();
    await until(`location.href === ${JSON.stringify(management.href)} && !document.querySelector('[role=alert]') && document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Sharing'`);
    const paused = new Map();
    const waiters = new Map();
    let interceptionError;
    const waitForPaused = key => new Promise((resolve, reject) => {
      if (paused.has(key)) { resolve(paused.get(key)); paused.delete(key); return; }
      const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`No paused ${key} response for ${ordering}.`)); }, 15000);
      waiters.set(key, response => { clearTimeout(timer); resolve(response); });
    });
    const stopPausing = onEvent('Fetch.requestPaused', response => {
      const path = new URL(response.request.url).pathname;
      const key = response.request.method === 'POST' && path === `${management.pathname}/share` ? 'post' : response.request.method === 'GET' && path === management.pathname && ordering === 'pending-get' ? 'get' : null;
      if (key) {
        if (waiters.has(key)) { waiters.get(key)(response); waiters.delete(key); }
        else paused.set(key, response);
      } else void command('Fetch.continueRequest', { requestId: response.requestId }).catch(error => { interceptionError = error; });
    });
    let stopFinished = () => {};
    let finishTimer;
    try {
      await command('Fetch.enable', { patterns: [{ urlPattern: `${management.origin}${management.pathname}`, requestStage: 'Response' }, { urlPattern: `${management.origin}${management.pathname}/share`, requestStage: 'Response' }] });
      await evaluate('(() => { const panel=document.querySelector("[role=tabpanel]:not([hidden])");globalThis.raceMutationForm=panel.querySelector("form");panel.querySelector("input[name=name]").value="Rejected navigation race share";panel.querySelector("input[name=expiresAt]").value="2000-01-01";raceMutationForm.requestSubmit(raceMutationForm.querySelector("button[type=submit]")); })()');
      const post = await waitForPaused('post');
      assert.equal(post.responseStatusCode, 400, 'The expired share must be rejected without creating a share.');
      if (ordering === 'away-back') {
        await evaluate('document.querySelector(\'a[href="/app/folders/new"]\').click()');
        await until('location.pathname === "/app/folders/new" && !document.querySelector("[role=tablist]")');
      }
      await clickManagement();
      let get;
      if (ordering === 'pending-get') get = await waitForPaused('get');
      else {
        await until(`!raceMutationForm.isConnected && location.href === ${JSON.stringify(management.href)} && !document.querySelector('[role=alert]')`);
        await evaluate('globalThis.raceLatestForm=document.querySelector("[role=tabpanel]:not([hidden]) form");raceLatestForm.querySelector("input[name=name]").value="Latest navigation draft";');
      }
      const finished = new Promise((resolve, reject) => {
        finishTimer = setTimeout(() => reject(new Error(`The held POST did not finish for ${ordering}.`)), 15000);
        stopFinished = onEvent('Network.loadingFinished', event => { if (event.requestId === post.networkId) { clearTimeout(finishTimer); resolve(); } });
      });
      await command('Fetch.continueResponse', { requestId: post.requestId });
      await finished;
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assert.equal(await evaluate('!!document.querySelector("[role=alert]")'), false, `${ordering}: a stale POST must not restore its validation error.`);
      assert.equal(await evaluate('location.href'), management.href, `${ordering}: latest navigation owns history.`);
      if (get) {
        assert(await evaluate('document.querySelector("[role=tabpanel]:not([hidden]) form") === raceMutationForm'), 'Starting a GET must invalidate a POST before the URL changes.');
        await command('Fetch.continueResponse', { requestId: get.requestId });
        await until('!raceMutationForm.isConnected && !document.querySelector("[role=alert]")');
      } else {
        assert(await evaluate('document.querySelector("[role=tabpanel]:not([hidden]) form") === raceLatestForm'), `${ordering}: a stale POST must not replace the latest form.`);
        assert.equal(await evaluate('raceLatestForm.querySelector("input[name=name]").value'), 'Latest navigation draft', `${ordering}: keep edits made after navigation.`);
      }
      assert.equal(await evaluate('document.querySelector("[role=tab][aria-selected=true]").textContent'), 'Sharing');
      assert(await evaluate('document === readerDocument'), 'Stale-response protection must not reload the console.');
      if (interceptionError) throw interceptionError;
    } finally {
      clearTimeout(finishTimer);
      stopFinished();
      await command('Fetch.disable');
      stopPausing();
    }
  }
  // A reader restore renders artefact settings, but its POST endpoint is not a GET route.
  await evaluate(`Array.from(document.querySelectorAll('a[href]')).find(link => link.href === ${JSON.stringify(viewer.href)} && !link.target).click()`);
  await until('!!document.querySelector("iframe.artifact-frame")');
  await evaluate('globalThis.readerRestoreUrl=location.href;document.querySelector(\'button[aria-label="Artefact actions"]\').click()');
  await until('!!document.querySelector("[popover]:popover-open")');
  await evaluate('Array.from(document.querySelectorAll("[popover]:popover-open [role=menuitem]")).find(item=>item.textContent.trim()==="Version history").click()');
  await until('!!document.querySelector("dialog[open]")');
  assert(await evaluate('Array.from(document.querySelectorAll("dialog[open] button")).some(button=>button.textContent==="Restore as new version")'), 'The smoke fixture needs a retained version older than its live version.');
  await evaluate('Array.from(document.querySelectorAll("dialog[open] button")).find(button=>button.textContent==="Restore as new version").click()');
  await until('!!document.querySelector("dialog[open] input[name=version]")');
  await evaluate('document.querySelector("dialog[open] input[name=version]").form.requestSubmit()');
  await until('Array.from(document.querySelectorAll(".feedback.success")).some(message=>message.textContent.includes("restored"))');
  assert.equal(await evaluate('location.href'), await evaluate('readerRestoreUrl'), 'A rendered restore must keep the refreshable reader GET URL.');
  assert(await evaluate('document===readerDocument'), 'Restoring must not reload the console document.');
  await command('Page.reload');
  await until('!!document.querySelector("iframe.artifact-frame")');
  assert.equal(await evaluate('location.href'), viewer.href, 'Reloading after restore must reopen the reader, not a POST-only endpoint.');
  await evaluate('globalThis.settingsSidebar=document.querySelector("aside.sidebar");globalThis.settingsDocument=document;document.querySelector(\'button[aria-label="Account menu"]\').click()');
  await until('!!document.querySelector("[popover]:popover-open")');
  await evaluate('document.querySelector(\'[popover]:popover-open a[href="/settings"]\').click()');
  await until('document.querySelector("main h1")?.textContent==="Account & security"');
  assert(await evaluate('document===settingsDocument && document.querySelector("aside.sidebar")===settingsSidebar'), 'Account settings must update content without replacing the console or sidebar.');
  await evaluate('document.querySelector(\'nav.section-nav a[href="/settings/keys"]\').click()');
  await until('location.pathname==="/settings/keys" && !!document.querySelector(\'main form[action="/settings/keys/mint"]\')');
  assert(await evaluate('document.querySelector("aside.sidebar")===settingsSidebar'), 'API-key navigation must preserve the sidebar owner.');
  assert(await evaluate('(() => { const form=document.querySelector(\'main form[action="/settings/keys/mint"]\'); const kind=form.querySelector(\'select[name="kind"]\'); return !!kind && Array.from(kind.options).some(option=>option.value==="master") && !form.querySelector(\'input[name="can_read_content"]\'); })()'), 'A dedicated local smoke user must not see a content-read checkbox while creating an artefact key.');
  await evaluate('(() => { const form=document.querySelector(\'main form[action="/settings/keys/mint"]\'); const kind=form.querySelector(\'select[name="kind"]\'); kind.value="master"; kind.dispatchEvent(new Event("change",{bubbles:true})); return true; })()');
  await until('!!document.querySelector(\'main form[action="/settings/keys/mint"] input[name="can_read_content"]\')');
  assert(await evaluate('(() => { const form=document.querySelector(\'main form[action="/settings/keys/mint"]\'); const capability=form.querySelector(\'input[name="can_read_content"]\'); return capability && !capability.checked; })()'), 'The master-key option must show an unchecked content-read checkbox.');
  await evaluate('(() => { const form=document.querySelector(\'main form[action="/settings/keys/mint"]\'); form.querySelector(\'input[name="can_read_content"]\').checked=true; form.requestSubmit(); return true; })()');
  await until('document.querySelector("main h1")?.textContent==="API keys" && document.querySelector("main h2")?.textContent==="Copy the new key now"');
  const contentKey = await evaluate('document.querySelector("main input[readonly]")?.value');
  settingsMasterKey = contentKey;
  assert(contentKey?.startsWith("wak_"), 'The one-time token notice remains intact after minting the opted-in master key.');
  const contentPath = `/_api/artifacts/${encodeURIComponent(artifactRef)}/content?version=${fixture.version}`;
  const contentResponse = await fetch(new URL(contentPath, viewer.origin), {
    headers: { Authorization: `Bearer ${process.env.WS_SMOKE_API_KEY}` },
  });
  assert.equal(contentResponse.status, 200, 'The local content-read wak_ key must read artefact content.');
  const content = await contentResponse.json();
  assert.equal(content.version, fixture.version);
  assert.equal(content.artifact.version, fixture.version);
  assert.equal(content.title, renamedTitle, 'The returned title must match the metadata saved by the smoke.');
  assert.match(content.html, /Solid 2 smoke/, 'The authorized read must return the fixture HTML.');
  console.log(`content read (HTTP): ${artifactRef} version=${content.version} capability=allowed`);
  const uiContentResponse = await fetch(new URL(contentPath, viewer.origin), {
    headers: { Authorization: `Bearer ${contentKey}` },
  });
  assert.equal(uiContentResponse.status, 200, 'The opted-in key created through Settings must read artefact content.');
  console.log(`content read (HTTP): ${artifactRef} version=${fixture.version} capability=allowed (Settings key)`);
  const deniedContent = await fetch(new URL(contentPath, viewer.origin), {
    headers: { Authorization: `Bearer ${process.env.WS_SMOKE_NOREAD_API_KEY}` },
  });
  assert.equal(deniedContent.status, 403, 'A local wak_ key without can_read_content must be refused.');
  const staleSiteSlug = `smoke-stale-site-${Date.now().toString(36)}`;
  const staleSiteHtml = `<!-- prefix that defeats HTML sniffing -->
<!doctype html><html lang="en"><head><title>Stale site fixture</title></head><body><p>Version one</p></body></html>`;
  const publishSite = body => fetch(new URL('/_api/artifacts', viewer.origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WS_SMOKE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const staleSiteCreated = await publishSite({
    type: 'site', folder: fixture.folder.slug ?? fixture.folder.id, slug: staleSiteSlug, title: 'Stale site type regression', lang: 'en', html: staleSiteHtml,
  });
  assert.equal(staleSiteCreated.status, 201, 'The typed stale-site regression fixture must be created.');
  const createdSite = await staleSiteCreated.json();
  assert.equal(createdSite.artifact.version, 1);
  const staleSiteHtmlV2 = staleSiteHtml.replace('Version one', 'Version two');
  const staleSiteUpdated = await publishSite({
    type: 'site', folder: fixture.folder.slug ?? fixture.folder.id, slug: staleSiteSlug, title: 'Stale site type regression',
    lang: 'en', html: staleSiteHtmlV2, ifVersion: createdSite.artifact.version,
  });
  assert.equal(staleSiteUpdated.status, 200, 'The typed stale-site fixture must advance to version two.');
  const currentSiteResponse = await fetch(new URL(`/_api/artifacts/${encodeURIComponent(staleSiteSlug)}/content`, viewer.origin), {
    headers: { Authorization: `Bearer ${process.env.WS_SMOKE_API_KEY}` },
  });
  assert.equal(currentSiteResponse.status, 200);
  const currentSite = await currentSiteResponse.json();
  assert.equal(currentSite.version, 2);
  assert.match(currentSite.html, /^<!-- prefix that defeats HTML sniffing -->\s*<!doctype html>/i);
  const staleSite = { type: 'site', folder: fixture.folder, slug: staleSiteSlug, title: 'Stale site type regression', lang: 'en', version: createdSite.artifact.version };
  const staleSitePublish = await publishSite({
    type: staleSite.type, folder: staleSite.folder.slug ?? staleSite.folder.id, slug: staleSite.slug, title: staleSite.title,
    lang: staleSite.lang, html: currentSite.html, ifVersion: staleSite.version,
  });
  assert.equal(staleSitePublish.status, 409, 'A stale site publish must conflict even when its HTML comment precedes the doctype.');
  const staleSiteBody = await staleSitePublish.json();
  assert.equal(staleSiteBody.error?.code, 'conflict');
  assert.equal(staleSiteBody.error?.details?.currentVersion, currentSite.version);
  const unchangedSiteResponse = await fetch(new URL(`/_api/artifacts/${encodeURIComponent(staleSiteSlug)}/content`, viewer.origin), {
    headers: { Authorization: `Bearer ${process.env.WS_SMOKE_API_KEY}` },
  });
  assert.equal(unchangedSiteResponse.status, 200);
  const unchangedSite = await unchangedSiteResponse.json();
  assert.equal(unchangedSite.version, currentSite.version);
  assert.equal(unchangedSite.html, currentSite.html);
  console.log(`ifVersion (HTTP): comment-prefixed site stale publish rejected (409), currentVersion=${currentSite.version}, fixture unchanged`);
  console.log('content read (HTTP): capability=denied (403)');
  // Native forms inside the sandbox reach project responses through the SDK (ADR 0032).
  let mcpId = 0;
  const mcp = async (method, params) => {
    const response = await fetch(new URL('/_mcp', viewer.origin), { method: 'POST', headers: { Authorization: `Bearer ${process.env.WS_SMOKE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpId, method, params }) });
    const body = await response.json();
    assert(response.ok && !body.error, `MCP ${method} failed: ${JSON.stringify(body)}`);
    return body.result;
  };
  const tool = async (name, args) => {
    const result = await mcp('tools/call', { name, arguments: args });
    assert(!result.isError, `${name} failed: ${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent;
  };
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-reader', version: '1' } });
  const rsvpHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Solid 2 smoke RSVP</title></head><body>
<form name="rsvp" id="rsvp">
<label>Name <input name="name" required></label>
<fieldset><legend>Attend</legend><label><input type="radio" name="attend" value="yes" required> Yes</label><label><input type="radio" name="attend" value="no"> No</label></fieldset>
<label>Menu <select name="menu" required><option value="">Choose</option><option value="fish">Fish</option><option value="veg">Veg</option></select></label>
<label><input type="checkbox" name="confirm" required> I confirm</label>
<button type="submit">Send</button><button type="button" id="via-request">Send via requestSubmit</button>
<button type="submit" id="cancel-click" onclick="event.preventDefault()">Send (cancelled by its click handler)</button>
</form>
<p id="status"></p><p id="schema-state"></p>
<form name="lone" id="lone"><input name="q"></form>
<p id="lone-status"></p>
<form name="offer" id="offer"><input type="hidden" name="note">
<button name="decision" value="accept">Accept</button>
<button name="decision" value="decline" id="decline" onclick="this.form.elements.note.value = 'declined via click'">Decline</button>
</form>
<p id="offer-status"></p>
<script>
const form = document.getElementById('rsvp');
window.artefacts.data.schema('rsvp').then(definition => {
  document.getElementById('schema-state').textContent = JSON.stringify(definition);
}).catch(error => { document.getElementById('schema-state').textContent = 'error:' + error.code; });
document.getElementById('via-request').addEventListener('click', () => form.requestSubmit());
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  form.dataset.submits = String(Number(form.dataset.submits || 0) + 1);
  const status = document.getElementById('status');
  try { status.textContent = 'saved:' + (await window.artefacts.data.submit('rsvp', form)).id; }
  catch (error) { status.textContent = 'error:' + error.code; }
});
document.getElementById('lone').addEventListener('submit', (event) => { event.preventDefault(); document.getElementById('lone-status').textContent = 'lone'; });
document.getElementById('offer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('offer-status');
  try { status.textContent = 'saved:' + (await window.artefacts.data.submit('offer', event)).id; }
  catch (error) { status.textContent = 'error:' + error.code; }
});
</script>
<dialog id="dlg" open><form method="dialog"><button value="ok">OK</button></form></dialog>
</body></html>`;
  const published = await tool('publish_artifact', { folder: 'smoke-project', slug: 'smoke-rsvp', title: 'Solid 2 smoke RSVP', html: rsvpHtml });
  const publishedVersion = published.artifact.version;
  assert(Number.isInteger(publishedVersion), 'publish_artifact must report the live version.');
  await tool('define_collection', { folder: 'smoke-project', name: 'rsvp', kind: 'responses', visitors: false, fields: {
    name: { type: 'text', required: true }, attend: { type: 'choice', options: ['yes', 'no'], required: true },
    menu: { type: 'choice', options: ['fish', 'veg'], required: true }, confirm: { type: 'boolean', required: true },
  } });
  await tool('define_collection', { folder: 'smoke-project', name: 'offer', kind: 'responses', visitors: false, fields: {
    decision: { type: 'choice', options: ['accept', 'decline'], required: true }, note: { type: 'text' },
  } });
  const rsvpViewer = new URL('/app/a/smoke-rsvp/view', viewer.origin).href;
  const createdIds = { rsvp: [], offer: [] };
  try {
    await command('Page.navigate', { url: rsvpViewer });
    await until('!!document.querySelector("iframe.artifact-frame")');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    let rsvp = await openFrame();
    const inRsvp = expression => evaluate(expression, rsvp.executionContextId, rsvp.frameCommand);
    await until('!!document.forms.rsvp && !!document.forms.lone && !!document.forms.offer && document.getElementById("schema-state").textContent.startsWith("{")', rsvp.executionContextId, rsvp.frameCommand);
    const schema = await inRsvp('JSON.parse(document.getElementById("schema-state").textContent)');
    assert.deepEqual(schema, {
      name: 'rsvp', kind: 'responses', visitors: false,
      fields: {
        name: { type: 'text', required: true }, attend: { type: 'choice', options: ['yes', 'no'], required: true },
        menu: { type: 'choice', options: ['fish', 'veg'], required: true }, confirm: { type: 'boolean', required: true },
      },
    }, 'The injected data schema method returns the authorized public definition without submissions.');
    const pressEnter = async () => {
      await rsvp.frameCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await rsvp.frameCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    };
    // A trusted mouse click at top-level viewport coordinates (iframe content box + element centre).
    const mouseClick = async (selector) => {
      // Two frames after scrolling, so the compositor's hit-test data routes the input to the sandbox process.
      const inner = await inRsvp(`(async () => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
      const outer = await evaluate('(() => { const frame = document.querySelector("iframe.artifact-frame"); const box = frame.getBoundingClientRect(); return { x: box.left + frame.clientLeft, y: box.top + frame.clientTop }; })()');
      const point = { x: outer.x + inner.x, y: outer.y + inner.y };
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    };
    // An empty form: interactive validation focuses the first invalid control and no submit event fires.
    await mouseClick('#rsvp button[type=submit]');
    await until('document.activeElement?.name === "name"', rsvp.executionContextId, rsvp.frameCommand);
    const invalid = await inRsvp('({ submits: document.forms.rsvp.dataset.submits ?? null, focus: document.activeElement?.name ?? null })');
    console.log(`validation (mouse click): submits=${invalid.submits} focus=${invalid.focus}`);
    assert.equal(invalid.submits, null, 'An invalid form must not dispatch submit.');
    assert.equal(invalid.focus, 'name', 'reportValidity must focus the first invalid control.');
    await inRsvp('const f = document.forms.rsvp; f.elements.name.value = "Ana"; f.querySelector("input[name=attend][value=yes]").checked = true; f.elements.menu.value = "fish"; f.elements.confirm.checked = true; f.elements.name.focus(); true');
    await pressEnter();
    await until('/^(saved|error):/.test(document.getElementById("status").textContent)', rsvp.executionContextId, rsvp.frameCommand);
    const saved = await inRsvp('document.getElementById("status").textContent');
    console.log(`enter: ${saved}`);
    assert.match(saved, /^saved:[a-f0-9]+$/, 'Enter must submit through the SDK.');
    const firstId = saved.slice('saved:'.length);
    createdIds.rsvp.push(firstId);
    // A submit button whose own click handler calls preventDefault() cancels submission, as natively.
    await mouseClick('#cancel-click');
    await delay(500);
    const cancelled = await inRsvp('document.forms.rsvp.dataset.submits');
    console.log(`authored cancel (mouse click): submits=${cancelled}`);
    assert.equal(cancelled, '1', 'An authored click preventDefault() must cancel submission.');
    await inRsvp('document.getElementById("via-request").click(); true');
    await until(`document.forms.rsvp.dataset.submits === "2" && /^(saved|error):/.test(document.getElementById("status").textContent) && document.getElementById("status").textContent !== ${JSON.stringify(saved)}`, rsvp.executionContextId, rsvp.frameCommand);
    const viaRequest = await inRsvp('({ submits: document.forms.rsvp.dataset.submits, status: document.getElementById("status").textContent })');
    console.log(`requestSubmit: submits=${viaRequest.submits} ${viaRequest.status}`);
    assert.match(viaRequest.status, /^saved:[a-f0-9]+$/, 'requestSubmit must submit through the SDK.');
    const secondId = viaRequest.status.slice('saved:'.length);
    createdIds.rsvp.push(secondId);
    await tool('delete_record', { folder: 'smoke-project', collection: 'rsvp', id: secondId });
    createdIds.rsvp.pop();
    await inRsvp('document.forms.lone.elements.q.focus(); true');
    await pressEnter();
    await until('document.getElementById("lone-status").textContent === "lone"', rsvp.executionContextId, rsvp.frameCommand);
    console.log(`lone: ${await inRsvp('document.getElementById("lone-status").textContent')}`);
    // Named submit buttons: the SubmitEvent carries the clicked button, and its own click handler runs first.
    await mouseClick('#decline');
    await until('/^(saved|error):/.test(document.getElementById("offer-status").textContent)', rsvp.executionContextId, rsvp.frameCommand);
    const offerStatus = await inRsvp('document.getElementById("offer-status").textContent');
    assert.match(offerStatus, /^saved:[a-f0-9]+$/, 'The Decline click must submit the offer through the SDK.');
    const offerId = offerStatus.slice('saved:'.length);
    createdIds.offer.push(offerId);
    const offerRecord = (await tool('list_records', { folder: 'smoke-project', collection: 'offer' })).records.find(record => record.id === offerId);
    assert.deepEqual(offerRecord?.data, { decision: 'decline', note: 'declined via click' });
    console.log(`offer (mouse click Decline): ${offerId} data=${JSON.stringify(offerRecord.data)}`);
    await mouseClick('#dlg button');
    await until('!document.getElementById("dlg").open', rsvp.executionContextId, rsvp.frameCommand);
    const dialog = await inRsvp('({ open: document.getElementById("dlg").open, returnValue: document.getElementById("dlg").returnValue })');
    console.log(`dialog (mouse click): open=${dialog.open} returnValue=${dialog.returnValue}`);
    assert.equal(dialog.returnValue, 'ok', 'A method=dialog form must close its dialog with the button value.');
    await command('Page.reload');
    await until('!!document.querySelector("iframe.artifact-frame")');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    rsvp = await openFrame();
    await until('!!document.forms.rsvp', rsvp.executionContextId, rsvp.frameCommand);
    const { records } = await tool('list_records', { folder: 'smoke-project', collection: 'rsvp' });
    const stored = records.find(record => record.id === firstId);
    assert(stored, 'The submitted response must be listed for the agent.');
    assert.deepEqual(stored.data, { name: 'Ana', attend: 'yes', menu: 'fish', confirm: true });
    assert.equal(stored.submission.artifactVersion, publishedVersion);
    assert.equal(stored.submission.submittedBy.type, 'user');
    console.log(`list_records: ${firstId} data=${JSON.stringify(stored.data)} submittedBy.type=${stored.submission.submittedBy.type} artifactVersion=${stored.submission.artifactVersion} (published ${publishedVersion})`);
  } finally {
    for (const [collection, ids] of Object.entries(createdIds)) for (const id of ids) await tool('delete_record', { folder: 'smoke-project', collection, id });
    await tool('delete_collection', { folder: 'smoke-project', name: 'rsvp' });
    await tool('delete_collection', { folder: 'smoke-project', name: 'offer' });
  }
  // Project files (ADR 0035): agent upload, in-frame display, viewer download, a resumable
  // multipart form upload, abort, and a signed-out share visitor's upload.
  const key = process.env.WS_SMOKE_API_KEY;
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const waitFor = async (check, label, timeout = 15000) => { const deadline = Date.now() + timeout; do { const value = check(); if (value) return value; await delay(50); } while (Date.now() < deadline); throw new Error(`Timed out waiting for ${label}.`); };
  const work = await mkdtemp(join(tmpdir(), 'ws-files-smoke-'));
  const bigPath = join(work, 'big.bin'), smallPath = join(work, 'small.txt');
  const big = randomBytes(30 * 1024 * 1024);   // 4 parts: 3 × 8 MiB + 6 MiB
  const small = Buffer.from('hello project files\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await writeFile(bigPath, big);
  await writeFile(smallPath, small);
  const total = big.length + small.length;
  const run = Date.now().toString(36);   // deleted artefact paths stay reserved
  const filesSlug = `smoke-files-${run}`, clientSlug = `smoke-client-files-${run}`;
  const cookie = `wsa_session=${process.env.WS_SMOKE_SESSION}`;
  const csrf = (await (await fetch(new URL('/app', viewer.origin), { headers: { Cookie: cookie } })).text()).match(/"csrf":"([^"]+)"/)?.[1];
  assert(csrf, 'The local session must render the console.');
  const consolePost = (path, fields) => fetch(new URL(path, viewer.origin), { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: viewer.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }) });
  const cleanupCookie = `wsa_session=${process.env.WS_SMOKE_OWNER_SESSION ?? process.env.WS_SMOKE_SESSION}`;
  const cleanupCsrf = process.env.WS_SMOKE_OWNER_SESSION
    ? (await (await fetch(new URL('/app', viewer.origin), { headers: { Cookie: cleanupCookie } })).text()).match(/"csrf":"([^"]+)"/)?.[1]
    : csrf;
  assert(cleanupCsrf, 'The local owner session must render the console for cleanup.');
  const cleanupConsolePost = (path, fields) => fetch(new URL(path, viewer.origin), { method: 'POST', redirect: 'manual', headers: { Cookie: cleanupCookie, Origin: viewer.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: cleanupCsrf, ...fields }) });
  const apiBytes = async path => {
    const response = await fetch(new URL(path, viewer.origin), { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, `GET ${path}`);
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const setFiles = async (frame, selector, files) => {
    const { root } = await frame.frameCommand('DOM.getDocument', { depth: 0 });
    const { nodeId } = await frame.frameCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert(nodeId, `No ${selector} in the frame.`);
    await frame.frameCommand('DOM.setFileInputFiles', { nodeId, files });
  };
  const project = { folder: 'smoke-project' };
  const created = { collections: [], records: [], artifacts: [], share: null, apiUpload: null, visitorContext: null };
  const stops = [];
  try {
    for (const [name, definition] of Object.entries({
      assets: { kind: 'records', visitors: false, fields: { image: { type: 'file', accept: ['image/png'], maxBytes: 1048576, required: true } } },
      uploads: { kind: 'responses', visitors: false, fields: { files: { type: 'file', multiple: true, required: true, maxBytes: 104857600 }, extra: { type: 'file' }, confirm: { type: 'boolean', required: true } } },
      'client-files': { kind: 'responses', visitors: true, fields: { name: { type: 'text', required: true }, attachment: { type: 'file', required: true } } },
      'client-library': { kind: 'records', visitors: true, fields: { doc: { type: 'file' } } },
    })) {
      await tool('define_collection', { ...project, name, ...definition });
      created.collections.push(name);
    }
    const photo = await readFile(new URL('../../worker/test/fixtures/page-photo.jpg', import.meta.url));
    const pngImage = await readFile(new URL('../../worker/test/fixtures/page-image.png', import.meta.url));
    const photoSrc = `data:image/jpeg;base64,${photo.toString('base64')}`;
    const pngSrc = `data:image/png;base64,${pngImage.toString('base64')}`;
    const pageSlug = `smoke-page-images-${run}`;
    const pageHtml = `<main><h1>Image publishing smoke</h1><figure><img src="${photoSrc}" alt="A landscape beside a lake" width="96" height="72"><figcaption>Lake landscape</figcaption></figure><img src="${pngSrc}" alt="" width="8" height="8"></main>`;
    const siteSlug = `smoke-site-compat-${run}`;
    const siteHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy site</title></head><body><main><h1>Legacy site bytes</h1></main></body></html>';
    const publishHeaders = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const pageInvalid = await fetch(new URL('/_api/artifacts', viewer.origin), {
      method: 'POST', headers: publishHeaders,
      body: JSON.stringify({ ...project, slug: `smoke-page-invalid-${run}`, title: 'Invalid page image', type: 'page',
        html: `<main><img src="data:image/png;base64,${photo.toString('base64')}" alt="Photo" width="96" height="72"></main>` }),
    });
    assert.equal(pageInvalid.status, 422, 'An image MIME/signature mismatch must be rejected before publication.');
    const pagePublish = await fetch(new URL('/_api/artifacts', viewer.origin), {
      method: 'POST', headers: publishHeaders,
      body: JSON.stringify({ ...project, slug: pageSlug, title: 'Page image smoke', type: 'page', html: pageHtml }),
    });
    assert.equal(pagePublish.status, 201, 'Valid inline JPEG and PNG page images must publish.');
    created.artifacts.push(pageSlug);
    const pageArtifact = (await pagePublish.json()).artifact;
    const pageContentResponse = await fetch(new URL(`/_api/artifacts/${encodeURIComponent(pageArtifact.id)}/content?version=${pageArtifact.version}`, viewer.origin), {
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(pageContentResponse.status, 200);
    const pageContent = await pageContentResponse.json();
    assert.equal(pageContent.html, pageHtml, 'Published page content must preserve both complete data-image sources byte-for-byte.');
    const controlPageSlug = `smoke-controls-${run}`;
    const controlPageHtml = '<main><h1>Reader controls smoke</h1><a67-tabs id="reader-tabs"><div role="tablist"><button id="reader-tab-one" type="button" role="tab" aria-controls="reader-panel-one" aria-selected="true" tabindex="0">One</button><button id="reader-tab-two" type="button" role="tab" aria-controls="reader-panel-two" aria-selected="false" tabindex="-1">Two</button></div><section id="reader-panel-one" role="tabpanel" aria-labelledby="reader-tab-one">First panel</section><section id="reader-panel-two" role="tabpanel" aria-labelledby="reader-tab-two" hidden="">Second panel</section></a67-tabs><a67-checklist id="reader-checklist" storage-key="reader-smoke" storage-scope="personal"><span data-item="chapter-one">Read chapter one</span></a67-checklist><input id="reader-state" type="text" value="initial" aria-label="Retained reader state"></main>';
    const controlPage = await fetch(new URL('/_api/artifacts', viewer.origin), {
      method: 'POST', headers: publishHeaders,
      body: JSON.stringify({ ...project, slug: controlPageSlug, title: 'Reader controls smoke', type: 'page', theme: { scope: 'platform', slug: 'report' }, html: controlPageHtml }),
    });
    assert.equal(controlPage.status, 201, `A themed page must publish for the controls smoke: ${await controlPage.text()}`);
    created.artifacts.push(controlPageSlug);
    const pendingControlPageSlug = `smoke-controls-pending-${run}`;
    const pendingControlPageHtml = controlPageHtml.replace(/<a67-checklist id="reader-checklist"[\s\S]*?<\/a67-checklist>/, '<div id="reader-checklist-mount"></div>');
    const pendingControlPage = await fetch(new URL('/_api/artifacts', viewer.origin), {
      method: 'POST', headers: publishHeaders,
      body: JSON.stringify({ ...project, slug: pendingControlPageSlug, title: 'Pending reader controls smoke', type: 'page', theme: { scope: 'platform', slug: 'report' }, html: pendingControlPageHtml }),
    });
    assert.equal(pendingControlPage.status, 201, `A themed page must publish for pending connection coverage: ${await pendingControlPage.text()}`);
    created.artifacts.push(pendingControlPageSlug);
    const lockedPageSlug = `smoke-controls-locked-${run}`;
    const lockedPage = await fetch(new URL('/_api/artifacts', viewer.origin), {
      method: 'POST', headers: publishHeaders,
      body: JSON.stringify({ ...project, slug: lockedPageSlug, title: 'Locked controls smoke', type: 'page', theme: { scope: 'platform', slug: 'launch' }, themeOverrides: { tokens: { '--a67-accent': '#8f5e00' } }, html: '<main><h1>Locked reader controls</h1></main>' }),
    });
    assert.equal(lockedPage.status, 201, 'A brand-locked page must publish for the controls smoke.');
    created.artifacts.push(lockedPageSlug);
    assert(pageContent.html.includes(photoSrc) && pageContent.html.includes(pngSrc), 'Both inline image sources must remain intact.');
    const sitePublish = await fetch(new URL('/_api/artifacts', viewer.origin), {
      method: 'POST', headers: publishHeaders,
      body: JSON.stringify({ ...project, slug: siteSlug, title: 'Legacy site compatibility', html: siteHtml }),
    });
    assert.equal(sitePublish.status, 201, 'Omitted type must preserve complete-document site publishing.');
    created.artifacts.push(siteSlug);
    const siteArtifact = (await sitePublish.json()).artifact;
    const siteContentResponse = await fetch(new URL(`/_api/artifacts/${encodeURIComponent(siteArtifact.id)}/content?version=${siteArtifact.version}`, viewer.origin), {
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(siteContentResponse.status, 200);
    const siteHtmlWithAnalytics = (await siteContentResponse.json()).html;
    const siteSourceBytes = siteHtmlWithAnalytics.replace(/<script data-wsa-analytics>[\s\S]*?<\/script>/, '');
    assert.equal(siteSourceBytes, siteHtml, 'Complete-document site source bytes must remain unchanged by page publishing.');
    assert.equal((siteHtmlWithAnalytics.match(/<script data-wsa-analytics>/g) ?? []).length, 1, 'Legacy site analytics instrumentation must remain exactly once.');
    console.log(`page image publishing: JPEG (${photo.length} bytes) + PNG (${pngImage.length} bytes) preserved; invalid MIME/signature rejected (422); complete-document site bytes unchanged with existing analytics script`);
    // The agent path: MCP controls the session, the bytes go to the API part path. A hostile
    // non-ASCII name pins the name handling: file() keeps it exactly, a saved download sanitizes it.
    const assetName = 'Angebot – März "1" 📎.png';
    // Chromium replaces `"` (illegal in its download names); the rest survives.
    const savedName = assetName.replaceAll('"', '_');
    const { upload } = await tool('start_upload', { ...project, collection: 'assets', field: 'image', name: assetName, type: 'image/png', size: png.length });
    created.apiUpload = upload.id;
    assert.equal(upload.parts, 1);
    assert.equal(upload.partBytes, 8388608);
    assert.deepEqual(upload.received, []);
    const put = await fetch(new URL(upload.partPath + '1', viewer.origin), { method: 'PUT', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/octet-stream' }, body: png });
    assert.equal(put.status, 200, 'The API part PUT must succeed.');
    assert.deepEqual((await put.json()).part, { number: 1, size: png.length, sha256: sha(png) });
    const { file: assetFile } = await tool('complete_upload', { ...project, collection: 'assets', uploadId: upload.id });
    created.apiUpload = null;
    assert.deepEqual(assetFile, { id: upload.id, name: assetName, type: 'image/png', size: png.length });
    const { record: assetRecord } = await tool('create_record', { ...project, collection: 'assets', data: { image: assetFile.id } });
    created.records.push(['assets', assetRecord.id]);
    assert.deepEqual(assetRecord.data.image, assetFile);
    console.log(`asset upload (API): ${assetFile.id} ${JSON.stringify(assetName)} parts=1 size=${png.length} sha256 ok`);
    const filesHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Solid 2 smoke files</title></head><body>
<img id="asset" alt="Asset"><p id="asset-status"></p>
<button type="button" id="download">Download</button><p id="download-status"></p>
<form id="uploads"><input type="file" name="files" multiple><input type="file" name="extra"><label><input type="checkbox" name="confirm" required> I confirm</label><button type="submit">Send</button></form>
<p id="upload-progress"></p><p id="upload-status"></p>
<button type="button" id="abort-probe">Abort probe</button><p id="abort-status"></p>
<script>
const data = window.artefacts.data;
const $ = id => document.getElementById(id);
const form = $('uploads');
let asset;
(async () => {
  try {
    const { records } = await data.list('assets');
    asset = { recordId: records[0].id, fileId: records[0].data.image.id };
    const file = await data.file('assets', asset.recordId, asset.fileId);
    const img = $('asset');
    img.src = URL.createObjectURL(file);
    await img.decode();
    $('asset-status').textContent = 'image:' + img.naturalWidth + 'x' + img.naturalHeight + ':' + file.type + ':' + file.name;
  } catch (error) { $('asset-status').textContent = 'error:' + error.code; }
})();
$('download').addEventListener('click', async () => {
  try { await data.download('assets', asset.recordId, asset.fileId); $('download-status').textContent = 'downloaded'; }
  catch (error) { $('download-status').textContent = 'error:' + error.code; }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try { $('upload-status').textContent = 'saved:' + (await data.submit('uploads', event, { onProgress: p => { $('upload-progress').textContent = p.field + ':' + p.loaded + '/' + p.total; } })).id; }
  catch (error) { $('upload-status').textContent = 'error:' + error.code; }
});
$('abort-probe').addEventListener('click', () => {
  const c = new AbortController();
  const pending = data.upload('uploads', 'files', form.elements.files.files[0], { signal: c.signal });
  c.abort();
  pending.then(() => 'resolved', error => error.name).then(result => { $('abort-status').textContent = 'abort:' + result; });
});
</script></body></html>`;
    await tool('publish_artifact', { ...project, slug: filesSlug, title: 'Solid 2 smoke files', html: filesHtml });
    created.artifacts.push(filesSlug);
    // Downloads are browser-level events (no sessionId).
    const downloads = new Map();
    const onDownload = event => {
      const message = JSON.parse(event.data);
      if (message.sessionId) return;
      if (message.method === 'Browser.downloadWillBegin') downloads.set(message.params.guid, { name: message.params.suggestedFilename, done: false });
      if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed' && downloads.has(message.params.guid)) downloads.get(message.params.guid).done = true;
    };
    socket.addEventListener('message', onDownload);
    stops.push(() => socket.removeEventListener('message', onDownload));
    await call('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: work, eventsEnabled: true });
    await command('Page.navigate', { url: new URL(`/app/a/${filesSlug}/view`, viewer.origin).href });
    await until('!!document.querySelector("iframe.artifact-frame")');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    let frame = await openFrame();
    await frame.frameCommand('Network.enable');
    const inFrame = expression => evaluate(expression, frame.executionContextId, frame.frameCommand);
    const untilFrame = (expression, timeout) => until(expression, frame.executionContextId, frame.frameCommand, timeout);
    await untilFrame('document.getElementById("asset-status").textContent !== ""');
    const shown = await inFrame('document.getElementById("asset-status").textContent');
    assert.equal(shown, `image:1x1:image/png:${assetName}`, 'file() must keep the stored name exactly.');
    const encodedAssetName = encodeURIComponent(assetName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const fileResponse = await waitFor(() => runtimeFileResponses.findLast(response => response.url.includes(assetFile.id)), 'the runtime file response');
    assert.equal(fileResponse.status, 200);
    assert(fileResponse.disposition?.includes(`filename*=UTF-8''${encodedAssetName}`), `Content-Disposition must carry the encoded stored filename: ${JSON.stringify(fileResponse.disposition)}`);
    console.log(`file(): ${shown}`);
    await inFrame('document.getElementById("download").click(); true');
    const [guid, download] = await waitFor(() => [...downloads].find(([, entry]) => entry.done), 'a completed download');
    const downloadResponse = await waitFor(() => {
      const responses = runtimeFileResponses.filter(response => response.url.includes(assetFile.id));
      return responses.length >= 2 ? responses.at(-1) : null;
    }, 'the runtime download response');
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.disposition, fileResponse.disposition);
    console.log(`download trace: response=${JSON.stringify(downloadResponse.disposition)} file.name=${JSON.stringify(assetName)} CDP.suggestedFilename=${JSON.stringify(download.name)} expected=${JSON.stringify(savedName)}`);
    assert.equal(download.name, savedName, 'A saved download carries the sanitized name.');
    assert.equal(sha(await readFile(join(work, guid))), sha(png));
    await untilFrame('document.getElementById("download-status").textContent === "downloaded"');
    console.log(`download(): ${JSON.stringify(download.name)} sha256 ok`);
    // Isolated-world clicks reach the SDK's submit shim; a native requestSubmit() there would be sandbox-blocked.
    const submitUploads = async () => {
      await setFiles(frame, '#uploads input[name=files]', [bigPath, smallPath]);
      await inFrame('document.forms.uploads.elements.confirm.checked = true; document.querySelector("#uploads button[type=submit]").click(); true');
    };
    let paused, pausedSession;
    const stopPausedRoot = onEvent('Fetch.requestPaused', params => { paused = params; pausedSession = sessionId; }, sessionId);
    const stopPausedFrame = frame.frameSessionId ? onEvent('Fetch.requestPaused', params => { paused = params; pausedSession = frame.frameSessionId; }, frame.frameSessionId) : () => {};
    const uploadPartPattern = [{ urlPattern: '*/_runtime/files/uploads/*/parts/2', requestStage: 'Request' }];
    let bigId;
    let frameFetchEnabled = false;
    try {
      await command('Fetch.enable', { patterns: uploadPartPattern });
      if (frame.frameSessionId) { await frame.frameCommand('Fetch.enable', { patterns: uploadPartPattern }); frameFetchEnabled = true; }
      await submitUploads();   // big first, so only big part 1 can complete before the reload
      await waitFor(() => paused, 'the paused part 2');
      bigId = paused.request.url.match(/\/_runtime\/files\/uploads\/([a-f0-9]{32})\/parts\/2$/)?.[1];
      assert(bigId, `Unexpected paused URL ${paused.request.url}`);
      await untilFrame(`document.getElementById("upload-progress").textContent === "files:8388608/${total}"`);
      await call('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Aborted' }, pausedSession);
      if (frameFetchEnabled) { await frame.frameCommand('Fetch.disable'); frameFetchEnabled = false; }
      await evaluate('globalThis.beforeFileReload = true');
      await command('Page.reload');   // before the viewer's 1 s part retry
      await until('!globalThis.beforeFileReload && !!document.querySelector("iframe.artifact-frame")');
    } finally {
      await command('Fetch.disable');
      if (frameFetchEnabled) await frame.frameCommand('Fetch.disable');
      stopPausedRoot();
      stopPausedFrame();
    }
    console.log(`interrupted: ${bigId} part 1 acknowledged, reloaded before part 2`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    frame = await openFrame();
    await untilFrame('!!document.forms.uploads');
    // The viewer page performs part transfers, so they show on the page session.
    const puts = [];
    stops.push(onEvent('Network.requestWillBeSent', ({ request }) => {
      const match = request.method === 'PUT' && new URL(request.url).pathname.match(/^\/_runtime\/files\/uploads\/([a-f0-9]{32}\/parts\/\d+)$/);
      if (match) puts.push(match[1]);
    }));
    await submitUploads();   // same paths: same name, size and lastModified, so the same resume key
    await untilFrame('/^(saved|error):/.test(document.getElementById("upload-status").textContent)', 120000);
    const uploadStatus = await inFrame('document.getElementById("upload-status").textContent');
    assert.match(uploadStatus, /^saved:[a-f0-9]+$/, 'The resumed form upload must save.');
    const uploadsId = uploadStatus.slice('saved:'.length);
    created.records.push(['uploads', uploadsId]);
    const smallId = puts.map(path => path.slice(0, 32)).find(id => id !== bigId);
    console.log(`resume: ${bigId} PUTs after reload=${JSON.stringify(puts)}`);
    // Part 1 matched by size + SHA-256 and was not re-sent.
    assert.deepEqual(puts, [`${bigId}/parts/2`, `${bigId}/parts/3`, `${bigId}/parts/4`, `${smallId}/parts/1`]);
    const progress = await inFrame('document.getElementById("upload-progress").textContent');
    assert.equal(progress, `files:${total}/${total}`);
    console.log(`submit with files: ${uploadStatus} progress=${progress}`);
    const uploadsRecord = (await tool('list_records', { ...project, collection: 'uploads' })).records.find(record => record.id === uploadsId);
    assert(uploadsRecord, 'The submitted upload must be listed for the agent.');
    assert.deepEqual(uploadsRecord.data.files.map(({ name, size }) => ({ name, size })), [{ name: 'big.bin', size: big.length }, { name: 'small.txt', size: small.length }]);
    assert.equal('extra' in uploadsRecord.data, false, 'An empty optional file input is absent.');
    assert.equal(uploadsRecord.data.confirm, true);
    for (const [descriptor, local] of [[uploadsRecord.data.files[0], big], [uploadsRecord.data.files[1], small]]) {
      const { file } = await tool('get_file', { ...project, collection: 'uploads', fileId: descriptor.id });
      assert.equal(file.recordId, uploadsId);
      const { response, bytes } = await apiBytes(file.downloadPath);
      assert(response.headers.get('content-disposition')?.includes(`filename*=UTF-8''${descriptor.name}`));
      assert.equal(sha(bytes), sha(local), `${descriptor.name} must round-trip.`);
    }
    console.log('files round-trip: big.bin sha256 ok, small.txt sha256 ok');
    const cancels = [];
    stops.push(onEvent('Network.requestWillBeSent', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/_runtime/data' && request.postData?.includes('"op":"upload-cancel"')) cancels.push(request.url);
    }));
    const putsBeforeAbort = puts.length;
    await inFrame('document.getElementById("abort-probe").click(); true');
    await untilFrame('document.getElementById("abort-status").textContent === "abort:AbortError"');
    await waitFor(() => cancels.length, 'the upload-cancel request');
    await delay(500);
    assert.equal(cancels.length, 1, 'One upload-cancel per aborted upload.');
    assert.equal(puts.length, putsBeforeAbort, 'An aborted upload sends no part.');
    console.log('abort: AbortError, upload-cancel sent, 0 parts');
    // A signed-out share visitor: responses accept their file; records stay closed to shares.
    const clientHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Solid 2 smoke client files</title></head><body>
<form id="client"><label>Name <input name="name" required></label><input type="file" name="attachment" required><button type="submit">Send</button></form>
<p id="client-status"></p>
<input type="file" id="probe"><button type="button" id="probe-upload">Upload to the library</button><p id="probe-status"></p>
<script>
const data = window.artefacts.data;
const $ = id => document.getElementById(id);
$('client').addEventListener('submit', async (event) => {
  event.preventDefault();
  let status = '';
  try {
    const record = await data.submit('client-files', event);
    status = 'saved:' + record.id;
    const file = await data.file('client-files', record.id, record.data.attachment.id);
    status += ' file():' + file.name + ':' + file.size + ':' + (await file.text()).trim();
  } catch (error) { status += (status ? ' ' : '') + 'error:' + error.code; }
  $('client-status').textContent = status;
});
$('probe-upload').addEventListener('click', () => {
  data.upload('client-library', 'doc', $('probe').files[0]).then(file => 'uploaded:' + file.id, error => 'error:' + error.code).then(status => { $('probe-status').textContent = status; });
});
</script></body></html>`;
    await tool('publish_artifact', { ...project, slug: clientSlug, title: 'Solid 2 smoke client files', html: clientHtml });
    created.artifacts.push(clientSlug);
    const shareName = `Smoke visitor files ${run}`;
    const shared = await consolePost(`/app/a/${clientSlug}/share`, { name: shareName });
    assert.equal(shared.status, 200, 'The visitor share must be created.');
    const shareMatch = (await shared.text()).match(new RegExp(`"id":"([0-9a-f]+)","name":"${shareName}","recipient":"","url":"([^"]+)"`));
    assert(shareMatch, 'The created share must be listed with its link.');
    created.share = shareMatch[1];
    const shareUrl = shareMatch[2];
    created.visitorContext = (await call('Target.createBrowserContext')).browserContextId;
    const { targetId: visitorTarget } = await call('Target.createTarget', { url: 'about:blank', browserContextId: created.visitorContext });
    const { sessionId: visitorSession } = await call('Target.attachToTarget', { targetId: visitorTarget, flatten: true });
    const visit = (method, params) => call(method, params, visitorSession);
    await visit('Network.enable');
    await visit('Page.enable');
    assert.deepEqual((await visit('Network.getCookies', { urls: [viewer.origin] })).cookies, [], 'The visitor context must carry no session.');
    const refusedStarts = new Set(), refusedStatuses = [];
    stops.push(onEvent('Network.requestWillBeSent', ({ requestId, request }) => {
      if (new URL(request.url).pathname === '/_runtime/data' && request.postData?.includes('"op":"upload-start"') && request.postData.includes('"collection":"client-library"')) refusedStarts.add(requestId);
    }, visitorSession));
    stops.push(onEvent('Network.responseReceived', ({ requestId, response }) => { if (refusedStarts.has(requestId)) refusedStatuses.push(response.status); }, visitorSession));
    await visit('Page.navigate', { url: shareUrl });
    await until('!!document.querySelector("iframe.artifact-frame")', undefined, visit);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', undefined, visit);
    const client = await openFrame(visit);
    const inClient = expression => evaluate(expression, client.executionContextId, client.frameCommand);
    await until('!!document.forms.client', client.executionContextId, client.frameCommand);
    console.log(`visitor share: ${created.share} opened without a session`);
    await setFiles(client, '#client input[name=attachment]', [smallPath]);
    await inClient('document.forms.client.elements.name.value = "Visitor"; document.querySelector("#client button[type=submit]").click(); true');
    await until('document.getElementById("client-status").textContent !== ""', client.executionContextId, client.frameCommand);
    const clientStatus = await inClient('document.getElementById("client-status").textContent');
    const visitorId = clientStatus.match(/^saved:([a-f0-9]+)/)?.[1];
    if (visitorId) created.records.push(['client-files', visitorId]);
    assert.match(clientStatus, /^saved:[a-f0-9]+ file\(\):small\.txt:20:hello project files$/, 'The visitor submits a file and downloads it back.');
    console.log(`visitor submit: ${clientStatus}`);
    await setFiles(client, '#probe', [smallPath]);
    await inClient('document.getElementById("probe-upload").click(); true');
    await until('document.getElementById("probe-status").textContent !== ""', client.executionContextId, client.frameCommand);
    const probeStatus = await inClient('document.getElementById("probe-status").textContent');
    await waitFor(() => refusedStatuses.length, 'the refused upload-start response');
    assert.equal(probeStatus, 'error:forbidden', 'A share visitor must not upload to a records collection.');
    assert.deepEqual(refusedStatuses, [403]);
    console.log(`visitor records upload: ${probeStatus} (HTTP ${refusedStatuses[0]})`);
    const visitorRecord = (await tool('list_records', { ...project, collection: 'client-files' })).records.find(record => record.id === visitorId);
    assert(visitorRecord, 'The visitor response must be listed for the agent.');
    assert.equal(visitorRecord.data.name, 'Visitor');
    assert.equal(visitorRecord.submission.submittedBy.type, 'share');
    assert.deepEqual({ name: visitorRecord.data.attachment.name, size: visitorRecord.data.attachment.size }, { name: 'small.txt', size: small.length });
    const { file: visitorFile } = await tool('get_file', { ...project, collection: 'client-files', fileId: visitorRecord.data.attachment.id });
    assert.equal(visitorFile.recordId, visitorId);
    assert.equal(sha((await apiBytes(visitorFile.downloadPath)).bytes), sha(small));
    console.log(`visitor file round-trip: small.txt sha256 ok submittedBy.type=${visitorRecord.submission.submittedBy.type}`);
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const startupControlsUrl = new URL(`/app/a/${controlPageSlug}/view`, viewer.origin);
  await command('Page.navigate', { url: startupControlsUrl.href });
  await until('document.querySelectorAll(".viewer-page-controls select").length===2');
  await until('document.querySelector("iframe.artifact-frame")?.srcdoc.length > 0');
  const startupFrame = await openFrame();
  const inStartupFrame = expression => evaluate(expression, startupFrame.executionContextId, startupFrame.frameCommand);
  await until('document.querySelector("#reader-checklist [data-a67-state]")?.dataset.state==="ready" && document.querySelectorAll("#reader-checklist input[type=\\"checkbox\\"]").length===1 && document.querySelector("#reader-checklist label")?.textContent.trim()==="Read chapter one"', startupFrame.executionContextId, startupFrame.frameCommand);
  assert.equal(await inStartupFrame('document.querySelector("#reader-checklist")?.isConnected'), true, 'The checklist must remain parser-authored in the published document.');
  assert.equal(await inStartupFrame('document.querySelector("#reader-checklist input")?.type'), 'checkbox', 'Parser-created checklist must render a real checkbox after bridge startup.');
  console.log('page reader startup smoke: parser-authored checklist initialized through the live bridge');
  const controlsUrl = new URL(`/app/a/${pendingControlPageSlug}/view`, viewer.origin);
  await evaluate("sessionStorage.setItem('__holdPageReaderReady', 'true')");
  await command('Page.navigate', { url: controlsUrl.href });
  await until('document.querySelectorAll(".viewer-page-controls select").length===2');
  await evaluate('globalThis.pageReaderDocument = document; globalThis.readerFrame = document.querySelector("iframe.artifact-frame")');
  await until('document.querySelector("iframe.artifact-frame")?.srcdoc.length > 0');
  const controlFrame = await openFrame();
  const inControlFrame = expression => evaluate(expression, controlFrame.executionContextId, controlFrame.frameCommand);
  await until('!!document.querySelector("#reader-state")', controlFrame.executionContextId, controlFrame.frameCommand);
  const inControlPage = expression => evaluate(expression, undefined, controlFrame.frameCommand);
  const composition = await evaluate(`(() => {
    const iframe = document.querySelector('iframe.artifact-frame');
    const srcdoc = iframe.srcdoc;
    const match = srcdoc.match(/^<!doctype html><html[^>]*><head><meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    return { sandbox: iframe.getAttribute('sandbox'), csp: match?.[1], srcdoc };
  })()`);
  assert.equal(composition.sandbox, 'allow-scripts', 'The page frame must keep its exact opaque sandbox.');
  assert.equal(composition.csp, `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob: ${new URL('/assets/favicon.ico', viewer.origin).href} ${new URL('/assets/ws-logo.svg', viewer.origin).href}; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'`);
  assert(composition.srcdoc.includes('<meta name="color-scheme" content="light dark">'), 'Page composition always declares both color schemes.');
  assert(composition.srcdoc.includes('<style id="a67-page-kit">') && composition.srcdoc.includes('<style id="a67-page-theme"'), 'Kit and selected theme CSS must be inline.');
  assert(!/<link[^>]+stylesheet/i.test(composition.srcdoc), 'Page composition must not issue external stylesheet requests.');
  await inControlFrame('globalThis.controlRoot = document.documentElement; globalThis.controlThemeStyle = document.getElementById("a67-page-theme"); document.getElementById("reader-state").value = "retained"; document.documentElement.dataset.readerSmokeState = "retained"; true');
  const changeControl = async (label, value) => evaluate(`(() => {
    const select = [...document.querySelectorAll('.viewer-page-controls select')].find(item => item.labels[0]?.textContent.trim() === ${JSON.stringify(label)});
    if (!select || select.disabled && ${JSON.stringify(label)} === 'Theme') throw new Error('Missing enabled ' + ${JSON.stringify(label)} + ' control.');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await until('typeof window.__pagePendingReady==="function"');
  await changeControl('Theme', 'editorial');
  await changeControl('Text size', 's');
  const pendingReady = await evaluate('window.__pagePendingReady(); window.__pagePendingReadyData');
  await evaluate(`parent.postMessage(${JSON.stringify(pendingReady)}, '*'); true`, controlFrame.executionContextId, controlFrame.frameCommand);
  await until('window.__pageSmokeChannels.length > 0');
  await until('document.documentElement.dataset.a67Theme==="editorial" && document.documentElement.style.fontSize==="87.5%"', controlFrame.executionContextId, controlFrame.frameCommand);
  await until('!!document.querySelector("#reader-tabs [aria-selected=\\"true\\"]")', controlFrame.executionContextId, controlFrame.frameCommand);
  await inControlPage(`(() => { const checklist=document.createElement('a67-checklist'); checklist.id='reader-checklist'; checklist.setAttribute('storage-key','reader-smoke'); checklist.setAttribute('storage-scope','personal'); checklist.innerHTML='<span data-item="chapter-one">Read chapter one</span>'; document.querySelector('#reader-checklist-mount').replaceWith(checklist); return true; })()`);
  await until('document.querySelector("#reader-checklist [data-a67-state]")?.dataset.state==="ready" && document.querySelectorAll("#reader-checklist input[type=\\"checkbox\\"]").length===1 && document.querySelector("#reader-checklist label")?.textContent.trim()==="Read chapter one"', controlFrame.executionContextId, controlFrame.frameCommand);
  await inControlFrame('document.querySelector("#reader-tab-two").click(); true');
  await until('document.querySelector("#reader-tab-two").getAttribute("aria-selected")==="true" && !document.querySelector("#reader-panel-two").hidden', controlFrame.executionContextId, controlFrame.frameCommand);
  await inControlFrame('document.querySelector("#reader-tab-one").click(); true');
  await until('document.querySelector("#reader-tab-one").getAttribute("aria-selected")==="true"', controlFrame.executionContextId, controlFrame.frameCommand);
  for (const slug of ['report', 'editorial', 'launch']) {
    await changeControl('Theme', slug);
    await until(`document.getElementById("a67-page-theme")?.dataset.themeSlug===${JSON.stringify(slug)}`, controlFrame.executionContextId, controlFrame.frameCommand);
    const retained = await inControlFrame('({ value: document.getElementById("reader-state").value, state: document.documentElement.dataset.readerSmokeState, sameRoot: document.documentElement === globalThis.controlRoot, sameStyle: document.getElementById("a67-page-theme") === globalThis.controlThemeStyle, scope: document.documentElement.dataset.a67Theme, accent: getComputedStyle(document.documentElement).getPropertyValue("--a67-accent").trim() })');
    assert.equal(retained.scope, slug, `Changing to ${slug} must update the actual theme selector scope.`);
    assert.equal(retained.accent, PLATFORM_THEMES.find(theme => theme.slug === slug).tokens.light.accent, `${slug} must apply its checked computed accent token.`);
    assert.equal(await evaluate('document.querySelector("iframe.artifact-frame")===globalThis.readerFrame'), true, 'Theme changes must not replace or reload the frame.');
  }
  const nonce = composition.srcdoc.match(/data-nonce="([a-f0-9]+)"/)?.[1];
  assert(nonce, 'The page runtime must carry a nonce.');
  const beforeSpoof = await inControlFrame('({ slug: document.getElementById("a67-page-theme").dataset.themeSlug, css: document.getElementById("a67-page-theme").textContent })');
  await evaluate(`(() => {
    const port = window.__pageSmokeChannels.at(-1);
    if (!port) throw new Error('The runtime channel was not captured.');
    port.postMessage({ type: 'page-theme', source: 'attacker', nonce: ${JSON.stringify(nonce)}, version: 99, theme: { scope: 'platform', slug: 'report' }, css: 'html { color: red }' });
    port.postMessage({ type: 'page-theme', source: 'parent', nonce: 'stale', version: 100, theme: { scope: 'platform', slug: 'report' }, css: 'html { color: red }' });
    port.postMessage({ type: 'page-theme', source: 'parent', nonce: ${JSON.stringify(nonce)}, version: 1, theme: { scope: 'platform', slug: 'report' }, css: 'html { color: red }' });
    return true;
  })()`);
  await delay(100);
  assert.deepEqual(await inControlFrame('({ slug: document.getElementById("a67-page-theme").dataset.themeSlug, css: document.getElementById("a67-page-theme").textContent })'), beforeSpoof, 'Wrong-source, wrong-nonce and stale theme messages must be ignored.');
  const modeButton = await evaluate('!!document.querySelector(\'button[aria-label="Dark appearance"]\')');
  assert(modeButton, 'The page reader must expose the light/dark switch.');
  await evaluate('document.querySelector(\'button[aria-label="Dark appearance"]\').click()');
  await until('document.querySelector(\'button[aria-label="Dark appearance"]\').getAttribute("aria-pressed")==="true"');
  await until('document.documentElement.dataset.theme==="dark"', controlFrame.executionContextId, controlFrame.frameCommand);
  await evaluate('document.querySelector(\'button[aria-label="Dark appearance"]\').click()');
  await until('document.documentElement.dataset.theme==="light"', controlFrame.executionContextId, controlFrame.frameCommand);
  for (const [size, cssSize] of [['s', '87.5%'], ['m', '100%'], ['l', '120%']]) {
    await changeControl('Text size', size);
    await until(`document.documentElement.style.fontSize===${JSON.stringify(cssSize)}`, controlFrame.executionContextId, controlFrame.frameCommand);
  }
  const externalRequests = await inControlFrame(`performance.getEntriesByType('resource').map(entry => entry.name).filter(url => !url.startsWith('data:') && new URL(url).origin !== ${JSON.stringify(viewer.origin)})`);
  assert.deepEqual(externalRequests, [], 'The composed page must not request external resources.');
  assert.equal(await evaluate('document===globalThis.pageReaderDocument && document.querySelector("iframe.artifact-frame")===globalThis.readerFrame'), true, 'Theme/mode/size changes must not navigate the reader.');
  await command('Page.navigate', { url: controlsUrl.href });
  await until('document.querySelectorAll(".viewer-page-controls select").length===2');
  assert.equal(await evaluate(`[...document.querySelectorAll('.viewer-page-controls select')].find(item => item.labels[0]?.textContent.trim() === 'Theme').value`), 'launch', 'Theme preference persists globally per browser.');
  assert.equal(await evaluate(`[...document.querySelectorAll('.viewer-page-controls select')].find(item => item.labels[0]?.textContent.trim() === 'Text size').value`), 'l', 'Text-size preference persists globally per browser.');
  await command('Page.navigate', { url: new URL(`/app/a/${lockedPageSlug}/view`, viewer.origin).href });
  await until('document.querySelectorAll(".viewer-page-controls select").length===2');
  const lockedControl = await evaluate(`(() => { const select = [...document.querySelectorAll('.viewer-page-controls select')].find(item => item.labels[0]?.textContent.trim() === 'Theme'); return { disabled: select.disabled, value: select.value }; })()`);
  assert.deepEqual(lockedControl, { disabled: true, value: 'launch' }, 'Brand lock disables theme selection but displays the effective theme.');
  await until('document.querySelector("iframe.artifact-frame")?.srcdoc.length > 0');
  const lockedFrame = await openFrame();
  assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--a67-accent").trim()', lockedFrame.executionContextId, lockedFrame.frameCommand), '#8f5e00', 'A brand-locked token override must affect the rendered page.');
  const galleryTarget = await call('Target.createTarget', { url: 'about:blank' });
  const galleryAttached = await call('Target.attachToTarget', { targetId: galleryTarget.targetId, flatten: true });
  const gallerySession = galleryAttached.sessionId;
  const galleryCommand = (method, params) => call(method, params, gallerySession);
  kitSessionId = gallerySession;
  const galleryParentDiagnostics = diagnosticsFor(gallerySession);
  await galleryCommand('Page.enable');
  galleryParentDiagnostics.domains.push('Page');
  await galleryCommand('Network.enable');
  galleryParentDiagnostics.domains.push('Network');
  await galleryCommand('Runtime.enable');
  galleryParentDiagnostics.domains.push('Runtime');
  await galleryCommand('Log.enable');
  galleryParentDiagnostics.domains.push('Log');
  galleryParentDiagnostics.captureReady = true;
  const gallerySessionIds = new Set([gallerySession]);
  const galleryAutoAttach = await autoAttachFrames(galleryTarget.targetId, gallerySessionIds);
  const galleryEvaluate = async expression => evaluate(expression, undefined, galleryCommand);
  const galleryUntil = async expression => until(expression, undefined, galleryCommand);
  try {
    galleryParentDiagnostics.armedBeforeNavigation = true;
    await galleryCommand('Page.navigate', { url: new URL('/themes', viewer.origin).href });
    await galleryUntil('document.querySelectorAll(".theme-card iframe").length===3');
    const gallery = await galleryEvaluate(`(() => {
      const cards=[...document.querySelectorAll('.theme-card')];
      const samples=cards.map(card=>new DOMParser().parseFromString(card.querySelector('iframe').getAttribute('srcdoc'),'text/html'));
      return {
        slugs:cards.map(card=>card.dataset.themeSlug),
        themes:samples.map(sample=>sample.documentElement.dataset.a67Theme),
        content:samples.map(sample=>sample.querySelector('main').innerHTML),
        images:samples.map(sample=>sample.querySelector('img')?.getAttribute('src')),
        srcdocs:cards.map(card=>card.querySelector('iframe').getAttribute('srcdoc')),
      };
    })()`);
    assert.deepEqual(gallery.slugs, ['report', 'editorial', 'launch']);
    assert.deepEqual(gallery.themes, gallery.slugs);
    assert.equal(new Set(gallery.content).size, 1, 'Every gallery preview must use exactly the same sample content.');
    assert(gallery.content[0].includes('Common sample page'));
    assert.equal(new Set(gallery.images).size, 1, 'Every gallery preview must use the same inline sample image.');
    const { frameTree: galleryTree } = await galleryCommand('Page.getFrameTree');
    const galleryFrameDeadline = Date.now() + 15000;
    let targets = [];
    do {
      targets = (await call('Target.getTargets')).targetInfos.filter(target =>
        target.type === 'iframe' && target.parentFrameId === galleryTree.frame.id && target.url === 'about:srcdoc');
      if (targets.length === 3 && targets.every(target => galleryAutoAttach.sessions.has(target.targetId))) break;
      await delay(50);
    } while (Date.now() < galleryFrameDeadline);
    assert.equal(targets.length, 3, 'The three isolated preview frames must be running.');
    assert(targets.every(target => galleryAutoAttach.sessions.has(target.targetId)), 'Every preview target must be registered for diagnostics.');
    await Promise.all(targets.map(target => galleryAutoAttach.setups.get(target.targetId)));
    assert.deepEqual(galleryAutoAttach.setupErrors, [], 'Preview diagnostic domains must be enabled and retained.');
    assert.equal(gallerySessionIds.size, 4, 'Retain diagnostics for the gallery parent and all three preview sessions.');
    const liveGalleryFrames = [];
    for (const target of targets) {
      const sessionId = galleryAutoAttach.sessions.get(target.targetId);
      const diagnostics = diagnosticsBySession.get(sessionId);
      assert(diagnostics?.captureReady && gallerySessionIds.has(sessionId), 'Each isolated preview must retain its diagnostic session.');
      const frameCommand = (method, params) => call(method, params, sessionId);
      const { frameTree } = await frameCommand('Page.getFrameTree');
      liveGalleryFrames.push({ frameId: frameTree.frame.id, frameCommand, sessionId });
    }
    const livePreviews = [];
    for (const preview of liveGalleryFrames) {
      await until('document.readyState === "complete"', undefined, preview.frameCommand);
      const live = await evaluate(`(() => {
        const image=document.querySelector('img');
        const accent=getComputedStyle(document.documentElement).getPropertyValue('--a67-accent').trim();
        return {
          theme:document.documentElement.dataset.a67Theme,
          heading:document.querySelector('h1')?.textContent.trim(),
          kit:typeof window.__a67PageKit?.configure==='function',
          configured:Object.prototype.hasOwnProperty.call(window.__a67PageKit||{},'logo')&&window.__a67PageKit.logo===null,
          imageLoaded:!!image&&image.complete&&image.naturalWidth===1,
          accent,
          resources:performance.getEntriesByType('resource').map(resource=>resource.name),
        };
      })()`, undefined, preview.frameCommand);
      livePreviews.push(live);
    }
    const galleryRecords = [...gallerySessionIds].map(sessionId => diagnosticsBySession.get(sessionId)).filter(Boolean);
    assert.equal(galleryRecords.length, gallerySessionIds.size, 'Every retained parent and preview session must have diagnostic evidence.');
    const galleryDiagnostics = {
      requests: galleryRecords.flatMap(diagnostics => diagnostics.requests),
      networkFailures: galleryRecords.flatMap(diagnostics => diagnostics.networkFailures),
      consoleErrors: galleryRecords.flatMap(diagnostics => diagnostics.consoleErrors),
      exceptions: galleryRecords.flatMap(diagnostics => diagnostics.exceptions),
      cspViolations: galleryRecords.flatMap(diagnostics => diagnostics.cspViolations),
    };
    assert.deepEqual(livePreviews.map(preview => preview.theme).sort(), ['editorial', 'launch', 'report']);
    for (const preview of livePreviews) {
      assert.equal(preview.heading, 'Common sample page');
      assert.equal(preview.kit, true, `${preview.theme} inline page-kit runtime must execute.`);
      assert.equal(preview.configured, true, `${preview.theme} inline theme configuration must execute.`);
      assert.equal(preview.imageLoaded, true, `${preview.theme} data-image sample must render.`);
      assert.notEqual(preview.accent, '', `${preview.theme} compiled theme CSS must apply.`);
    }
    // Audit the exact gallery srcdocs as independent top-level documents so Chromium can apply
    // each requested viewport to the document itself instead of the narrower gallery card.
    for (const [index, theme] of gallery.slugs.entries()) {
      const auditTarget = await call('Target.createTarget', { url: 'about:blank' });
      try {
        const auditAttached = await call('Target.attachToTarget', { targetId: auditTarget.targetId, flatten: true });
        const auditCommand = (method, params) => call(method, params, auditAttached.sessionId);
        await auditCommand('Page.enable');
        await auditCommand('Runtime.enable');
        const { frameTree } = await auditCommand('Page.getFrameTree');
        await auditCommand('Page.setDocumentContent', { frameId: frameTree.frame.id, html: gallery.srcdocs[index] });
        const auditEvaluate = expression => evaluate(expression, undefined, auditCommand);
        await until('document.readyState==="complete"', undefined, auditCommand);
        await runAxeThemeMatrix(`gallery-preview-${theme}`, auditCommand, auditEvaluate);
      } finally {
        await call('Target.closeTarget', { targetId: auditTarget.targetId });
      }
    }
    assert(galleryParentDiagnostics.captureReady && galleryParentDiagnostics.armedBeforeNavigation, 'Gallery parent diagnostics must be registered before navigation.');
    assert.deepEqual(externalRequestUrls([...galleryDiagnostics.requests, ...livePreviews.flatMap(preview => preview.resources)]), [], 'The gallery and live previews must not make external requests.');
    assert.deepEqual(galleryDiagnostics.networkFailures.filter(failure => failure.blockedReason === 'csp' || /content security policy/i.test(failure.error)), [], 'Gallery startup must not block resources under CSP.');
    assert.deepEqual(galleryDiagnostics.consoleErrors, [], 'Live theme previews must not log console errors.');
    assert.deepEqual(galleryDiagnostics.exceptions, [], 'Live theme previews must not throw runtime exceptions.');
    assert.deepEqual(galleryDiagnostics.cspViolations, [], 'Live theme previews must not trigger CSP failures.');
    console.log('Task 7 smoke: live public gallery frames rendered all checked themes without CSP failures');
    console.log('Task 7 smoke: public gallery verified');
    await runAxeThemeMatrix('gallery', galleryCommand, galleryEvaluate);
    await galleryCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    autoAttachHandlers.delete(undefined);
    assert.equal(autoAttachHandlers.has(undefined), false, 'Gallery auto-attachment diagnostics must stop before the download viewer navigation.');

    await galleryCommand('Page.navigate', { url: new URL(`/app/a/${pageSlug}/view`, viewer.origin).href });
    await galleryUntil('!!document.querySelector("button[aria-label=\\"Download HTML\\"]:not(:disabled)") && !!document.querySelector("iframe.artifact-frame")?.srcdoc');
    const themeControl = await galleryEvaluate(`(() => { const select=[...document.querySelectorAll('.viewer-page-controls select')].find(item=>item.labels[0]?.textContent.trim()==='Theme'); return { disabled:select.disabled,value:select.value }; })()`);
    if (!themeControl.disabled) await galleryEvaluate(`(() => { const select=[...document.querySelectorAll('.viewer-page-controls select')].find(item=>item.labels[0]?.textContent.trim()==='Theme'); select.value='editorial'; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    const downloadTheme = await galleryEvaluate(`[...document.querySelectorAll('.viewer-page-controls select')].find(item=>item.labels[0]?.textContent.trim()==='Theme').value`);
    if (!themeControl.disabled) assert.equal(downloadTheme, 'editorial');
    const photoFrame = await openFrame(galleryCommand);
    await until(`document.documentElement.dataset.a67Theme===${JSON.stringify(downloadTheme)}`, photoFrame.executionContextId, photoFrame.frameCommand);
    await galleryEvaluate(`(() => {
      const create=URL.createObjectURL.bind(URL);
      URL.createObjectURL=blob=>{ window.__downloadCapture=blob.text(); return create(blob); };
      HTMLAnchorElement.prototype.click=function(){ window.__downloadName=this.download; };
      document.querySelector('button[aria-label="Download HTML"]').click();
      return true;
    })()`);
    await galleryUntil('window.__downloadName === "Page image smoke.html" && !!window.__downloadCapture');
    const downloadedPage = await galleryEvaluate('window.__downloadCapture');
    assert.equal(await galleryEvaluate('window.__downloadName'), 'Page image smoke.html');
    console.log('Task 7 smoke: reader download blob captured');
    const standalone = await galleryEvaluate(`(() => {
      const source=${JSON.stringify(downloadedPage)};
      const doc=new DOMParser().parseFromString(source,'text/html');
      const images=[...doc.images];
      const external=[...doc.querySelectorAll('[src],[href]')].map(element=>element.getAttribute('src')||element.getAttribute('href')).filter(value=>value&&!value.startsWith('data:'));
      return {
        doctype:source.startsWith('<!doctype html>'),
        slug:doc.documentElement.dataset.a67Theme,
        kit:!!doc.getElementById('a67-page-kit'),
        theme:!!doc.getElementById('a67-page-theme'),
        photo:images.some(image=>image.getAttribute('src')===${JSON.stringify(photoSrc)}),
        png:images.some(image=>image.getAttribute('src')===${JSON.stringify(pngSrc)}),
        noAuthority:!/window\.artefacts\s*=/.test(source),
        noGrant:!source.includes('X-Artefacts-Grant')&&!source.includes('wsa_session')&&!source.includes(${JSON.stringify(process.env.WS_SMOKE_SESSION)}),
        noPrivateData:!source.includes(${JSON.stringify(process.env.WS_SMOKE_API_KEY)}),
        external,
      };
    })()`);
    assert(standalone.doctype, 'Downloaded page must parse as a complete standalone HTML document.');
    assert.equal(standalone.slug, downloadTheme);
    assert(standalone.kit && standalone.theme, 'The downloaded page must include the page kit and resolved theme.');
    assert(standalone.photo && standalone.png, 'The original validated data-image sources must survive byte-for-byte.');
    assert(standalone.noAuthority && standalone.noGrant && standalone.noPrivateData, 'The standalone document must contain no live SDK authority or private state.');
    assert.deepEqual(standalone.external, [], 'Standalone document must not reference external resources.');
    console.log('Task 7 smoke: downloaded page inspected');
    const standaloneTarget = await call('Target.createTarget', { url: 'about:blank' });
    const standaloneAttached = await call('Target.attachToTarget', { targetId: standaloneTarget.targetId, flatten: true });
    const standaloneCommand = (method, params) => call(method, params, standaloneAttached.sessionId);
    kitSessionId = standaloneAttached.sessionId;
    kitRequests.length = kitConsoleErrors.length = kitExceptions.length = kitCspViolations.length = 0;
    await standaloneCommand('Page.enable');
    await standaloneCommand('Network.enable');
    await standaloneCommand('Runtime.enable');
    await standaloneCommand('Log.enable');
    const standaloneEvaluate = async expression => evaluate(expression, undefined, standaloneCommand);
    const standaloneUntil = async expression => until(expression, undefined, standaloneCommand);
    await standaloneCommand('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(downloadedPage)}` });
    await standaloneUntil('typeof window.artefacts==="undefined" && !!window.__a67PageKit');
    console.log('Task 7 smoke: standalone page loaded without SDK authority');
    await runAxeThemeMatrix('download', standaloneCommand, standaloneEvaluate);
    for (const width of [320, 390, 1440]) {
      await standaloneCommand('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await standaloneUntil(`document.readyState==="complete" && document.images[0]?.complete && document.images[0]?.naturalWidth>0`);
      const layout = await standaloneEvaluate(`(() => ({ viewport:innerWidth, page:document.documentElement.scrollWidth, images:[...document.images].map(image=>({src:image.getAttribute('src'),width:image.getBoundingClientRect().width,container:image.parentElement.getBoundingClientRect().width,loaded:image.complete&&image.naturalWidth>0})) }))()`);
      assert.equal(layout.viewport, width);
      assert(layout.page <= width, `Downloaded page overflows at ${width}px: ${layout.page}px.`);
      assert(layout.images.every(image=>image.width<=image.container&&image.loaded), `Downloaded images must render inside their containers at ${width}px.`);
    }
    const externalPageRequests = kitRequests.filter(url => !url.startsWith('data:') && new URL(url).origin !== viewer.origin);
    assert.deepEqual(externalPageRequests, [], 'Gallery and downloaded page must not request external resources.');
    assert.deepEqual(kitConsoleErrors, [], 'Gallery and downloaded page must not log console errors.');
    assert.deepEqual(kitExceptions, [], 'Gallery and downloaded page must not throw runtime exceptions.');
    assert.deepEqual(kitCspViolations, [], 'Gallery and downloaded page must not trigger CSP failures.');
    console.log('themes gallery/download smoke: report/editorial/launch share one image sample; page download preserves JPEG+PNG; standalone, no SDK authority/private data/external resources; 320/390/1440 render with no overflow, console or CSP failures');
    await call('Target.closeTarget', { targetId: standaloneTarget.targetId });
  } finally {
    await call('Target.closeTarget', { targetId: galleryTarget.targetId });
  }
  console.log('page reader controls: report/editorial/launch swaps, light/dark, S/M/L, persisted preferences, stale nonce/source/version rejection, frame state retained and brand lock enforced');
  } finally {
    for (const stop of stops) stop();
    const failures = [];
    const attempt = async (label, step) => { try { await step(); } catch (error) { failures.push(`${label}: ${error.message}`); } };
    if (created.visitorContext) await attempt('visitor context', () => call('Target.disposeBrowserContext', { browserContextId: created.visitorContext }));
    if (created.apiUpload) await attempt('API upload', () => tool('cancel_upload', { ...project, collection: 'assets', uploadId: created.apiUpload }));
    for (const [collection, id] of created.records) await attempt(`record ${id}`, () => tool('delete_record', { ...project, collection, id }));
    // Runtime sessions belong to the reader, not the key: deleting the collection marks any still
    // open (an interrupted run) deleted, so they stop counting toward the 5 per reader; the sweep
    // aborts their R2 multipart uploads.
    for (const name of created.collections) await attempt(`collection ${name}`, () => tool('delete_collection', { ...project, name }));
    if (created.share) await attempt('share', async () => assert.equal((await cleanupConsolePost(`/app/a/${clientSlug}/share-revoke`, { shareId: created.share })).status, 200));
    for (const slug of created.artifacts) await attempt(`artefact ${slug}`, async () => assert.equal((await cleanupConsolePost(`/app/a/${slug}/delete`, { confirm: 'delete' })).status, 303));
    await rm(work, { recursive: true, force: true });
    if (failures.length) throw new Error(`Project files cleanup failed: ${failures.join('; ')}`);
  }
  const expectedAxePages = ['download', 'gallery', 'interactive-and-data-bound', 'static-and-data-bound', ...PLATFORM_THEMES.map(theme => `gallery-preview-${theme.slug}`)];
  const expectedAxeRows = expectedAxePages.length * PLATFORM_THEMES.length * 2 * 2;
  assert.equal(axeRows.length, expectedAxeRows, 'Every static/data-bound, interactive, live gallery, gallery preview and download matrix row must run.');
  assert.equal(new Set(axeRows.map(row => `${row.page}/${row.theme}/${row.scheme}/${row.width}`)).size, expectedAxeRows, 'Every axe matrix row must be unique.');
  assert.deepEqual([...new Set(axeRows.map(row => row.page))].sort(), expectedAxePages.sort());
  assert(axeRows.every(row => row.violations.length === 0), 'Every matrix row must have zero axe violations.');
  console.log(`axe-core matrix passed: ${axeRows.length} rows; tags=${axeTags.join(',')}; themes=${PLATFORM_THEMES.map(theme => theme.slug).join(',')}; schemes=light,dark; viewports=390,1440; violations=0`);
  console.log(`axe-core incomplete findings (not counted as passes): ${JSON.stringify(axeIncomplete)}`);
  console.log('Solid reader smoke passed: modal focus, Preview/Code, dynamic rename, stable frame/sidebar, opaque sandbox, validation/tab/GET-URL continuity, pending-GET/same-URL/away-back POST ownership, restore GET-URL continuity, account/API-key navigation, unchecked content-read checkbox default, authorized HTTP content read and denied-capability 403, stale ifVersion publish conflict with unchanged fixture, native form submission through the SDK and MCP, project files (API upload, in-frame display, viewer download, multipart form upload with reload-and-resume, abort, signed-out visitor upload).');
} finally {
  let revokeError;
  try {
    if (settingsMasterKey) {
      const headers = { Authorization: `Bearer ${settingsMasterKey}` };
      const listed = await fetch(new URL('/_api/keys', viewer.origin), { headers });
      assert.equal(listed.status, 200, 'The Settings-created master key must remain able to list its own record for cleanup.');
      const record = (await listed.json()).keys.find(key => key.prefix === settingsMasterKey.slice(0, 8));
      assert(record, 'The Settings-created master key record must be available for cleanup.');
      const revoked = await fetch(new URL(`/_api/keys/${encodeURIComponent(record.id)}`, viewer.origin), {
        method: 'DELETE', headers,
      });
      assert.equal(revoked.status, 200, 'The smoke must revoke its Settings-created master key.');
      console.log('settings master key revoked: success');
    }
  } catch (error) {
    revokeError = error;
  }
  socket?.close();
  chrome.kill();
  await new Promise(resolve => { if (chrome.exitCode !== null || chrome.signalCode !== null) resolve(); else chrome.once('close', resolve); });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (revokeError) throw revokeError;
}
