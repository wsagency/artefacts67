// Node 22+, Chrome, and an authenticated local smoke artefact are required.
// WS_SMOKE_VIEWER, WS_SMOKE_SESSION, WS_SMOKE_CHROME, and WS_SMOKE_API_KEY (a local wak_ master key) are explicit inputs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const viewer = new URL(process.env.WS_SMOKE_VIEWER ?? '');
assert(['localhost', '127.0.0.1'].includes(viewer.hostname), 'This mutating check is local-only.');
assert(process.env.WS_SMOKE_SESSION && process.env.WS_SMOKE_CHROME, 'Supply the local session and Chrome executable.');
assert(process.env.WS_SMOKE_API_KEY?.startsWith('wak_'), 'Supply a local master key (never a production one).');
const profile = await mkdtemp(join(tmpdir(), 'ws-reader-check-'));
const chrome = spawn(process.env.WS_SMOKE_CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
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
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Network.requestWillBeSent' && message.params.request.method === 'POST' && new URL(message.params.request.url).pathname.endsWith('/subfolder')) subfolderPosts++; const request = requests.get(message.id); if (request) { requests.delete(message.id); if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result); } });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => call(method, params, sessionId);
  await command('Network.enable');
  await command('Network.setCookie', { name: 'wsa_session', value: process.env.WS_SMOKE_SESSION, url: viewer.origin, httpOnly: true, sameSite: 'Lax' });
  await command('Page.enable');
  await command('Page.navigate', { url: viewer.href });
  const evaluate = async (expression, contextId, send = command) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const until = async (expression, contextId, send = command, timeout = 15000) => { const deadline = Date.now() + timeout; do { if (await evaluate(expression, contextId, send)) return; await delay(50); } while (Date.now() < deadline); throw new Error(`Reader condition failed: ${expression}`); };
  await until('!!document.querySelector("iframe.artifact-frame")');
  assert(await evaluate('document.querySelector(".viewer-title-button").textContent.includes("Solid 2 smoke")'), 'Use a dedicated Solid 2 smoke fixture, not an ordinary artefact.');
  await evaluate('globalThis.readerFrame=document.querySelector("iframe.artifact-frame"); globalThis.readerDocument=document; globalThis.readerSidebar=document.querySelector("aside.sidebar");');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const openFrame = async (send = command) => {
    const { frameTree } = await send('Page.getFrameTree');
    let frame = frameTree.childFrames?.find(child => child.frame.parentId === frameTree.frame.id)?.frame;
    let frameCommand = send;
    // Chrome isolates the opaque sandbox in its own target on current releases.
    if (!frame) {
      const deadline = Date.now() + 15000;
      do {
        const target = (await call('Target.getTargets')).targetInfos.find(target => target.type === 'iframe' && target.parentFrameId === frameTree.frame.id);
        if (target) {
          const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          frameCommand = (method, params) => call(method, params, attached.sessionId);
          frame = { id: target.targetId };
          break;
        }
        await delay(50);
      } while (Date.now() < deadline);
    }
    assert(frame, 'The authored document must be running.');
    const { executionContextId } = await frameCommand('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'reader-check' });
    await until('document.readyState === "complete"', executionContextId, frameCommand);
    return { executionContextId, frameCommand };
  };
  const { executionContextId, frameCommand } = await openFrame();
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
  const renamedTitle = await evaluate('document.querySelector(".viewer-title-button").textContent.trim()==="Solid 2 smoke renamed"') ? 'Solid 2 smoke updated' : 'Solid 2 smoke renamed';
  await evaluate(`const input=document.querySelector("dialog[open] input[name=title]"); input.value=${JSON.stringify(renamedTitle)}; input.dispatchEvent(new Event("input",{bubbles:true})); input.form.requestSubmit();`);
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
<p id="status"></p>
<form name="lone" id="lone"><input name="q"></form>
<p id="lone-status"></p>
<form name="offer" id="offer"><input type="hidden" name="note">
<button name="decision" value="accept">Accept</button>
<button name="decision" value="decline" id="decline" onclick="this.form.elements.note.value = 'declined via click'">Decline</button>
</form>
<p id="offer-status"></p>
<script>
const form = document.getElementById('rsvp');
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
    await until('!!document.forms.rsvp && !!document.forms.lone && !!document.forms.offer', rsvp.executionContextId, rsvp.frameCommand);
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
    const inFrame = expression => evaluate(expression, frame.executionContextId, frame.frameCommand);
    const untilFrame = (expression, timeout) => until(expression, frame.executionContextId, frame.frameCommand, timeout);
    await untilFrame('document.getElementById("asset-status").textContent !== ""');
    const shown = await inFrame('document.getElementById("asset-status").textContent');
    assert.equal(shown, `image:1x1:image/png:${assetName}`, 'file() must keep the stored name exactly.');
    console.log(`file(): ${shown}`);
    await inFrame('document.getElementById("download").click(); true');
    const [guid, download] = await waitFor(() => [...downloads].find(([, entry]) => entry.done), 'a completed download');
    assert.equal(download.name, savedName, 'A saved download carries the sanitized name.');
    assert.equal(sha(await readFile(join(work, guid))), sha(png));
    await untilFrame('document.getElementById("download-status").textContent === "downloaded"');
    console.log(`download(): ${JSON.stringify(download.name)} sha256 ok`);
    // Isolated-world clicks reach the SDK's submit shim; a native requestSubmit() there would be sandbox-blocked.
    const submitUploads = async () => {
      await setFiles(frame, '#uploads input[name=files]', [bigPath, smallPath]);
      await inFrame('document.forms.uploads.elements.confirm.checked = true; document.querySelector("#uploads button[type=submit]").click(); true');
    };
    let paused;
    const stopPaused = onEvent('Fetch.requestPaused', params => { paused = params; });
    let bigId;
    try {
      await command('Fetch.enable', { patterns: [{ urlPattern: '*/_runtime/files/uploads/*/parts/2', requestStage: 'Request' }] });
      await submitUploads();   // big first, so only big part 1 can complete before the reload
      await waitFor(() => paused, 'the paused part 2');
      bigId = paused.request.url.match(/\/_runtime\/files\/uploads\/([a-f0-9]{32})\/parts\/2$/)?.[1];
      assert(bigId, `Unexpected paused URL ${paused.request.url}`);
      await untilFrame(`document.getElementById("upload-progress").textContent === "files:8388608/${total}"`);
      await command('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Aborted' });
      await evaluate('globalThis.beforeFileReload = true');
      await command('Page.reload');   // before the viewer's 1 s part retry
      await until('!globalThis.beforeFileReload && !!document.querySelector("iframe.artifact-frame")');
    } finally {
      await command('Fetch.disable');
      stopPaused();
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
    if (created.share) await attempt('share', async () => assert.equal((await consolePost(`/app/a/${clientSlug}/share-revoke`, { shareId: created.share })).status, 200));
    for (const slug of created.artifacts) await attempt(`artefact ${slug}`, async () => assert.equal((await consolePost(`/app/a/${slug}/delete`, { confirm: 'delete' })).status, 303));
    await rm(work, { recursive: true, force: true });
    if (failures.length) throw new Error(`Project files cleanup failed: ${failures.join('; ')}`);
  }
  console.log('Solid reader smoke passed: modal focus, Preview/Code, dynamic rename, stable frame/sidebar, opaque sandbox, validation/tab/GET-URL continuity, pending-GET/same-URL/away-back POST ownership, restore GET-URL continuity, account/API-key navigation, native form submission through the SDK and MCP, project files (API upload, in-frame display, viewer download, multipart form upload with reload-and-resume, abort, signed-out visitor upload).');
} finally {
  socket?.close();
  chrome.kill();
  await new Promise(resolve => { if (chrome.exitCode !== null || chrome.signalCode !== null) resolve(); else chrome.once('close', resolve); });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
