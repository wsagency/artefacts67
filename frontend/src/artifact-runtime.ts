import type { OpenedArtifact, ViewerDescriptor } from './types';

type RuntimeResponse = Record<string, unknown>;
type RuntimeErrorCode = string | undefined;
class RuntimeError extends Error {
  code: RuntimeErrorCode;
  status?: number;
  retryAfter?: number;
  remaining?: number;
  issues?: Array<{ field: string; message: string }>;
  constructor(message: string, code?: string, status?: number, retryAfter?: number, remaining?: number) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.remaining = remaining;
  }
}

type EncryptedBox = { iv: string; ct: string; tag?: string };
type EncryptedPayload = { wrap: EncryptedBox & { ksalt: string; iter: number }; key?: EncryptedBox; content: EncryptedBox };
type RuntimeState = { grant: string; observation: Record<string, unknown> | null };
type RuntimeOpened = OpenedArtifact & { index?: Array<{ title: string; viewer: ViewerDescriptor }> };

const openedState = new WeakMap<object, RuntimeState>();
const frameCleanups = new WeakMap<HTMLIFrameElement, () => void>();
const utf8 = new TextDecoder();
const b64 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const fromHex = (value: string): Uint8Array<ArrayBuffer> => { const pairs = value.match(/../g); if (!pairs) throw new Error('Invalid encrypted key.'); return new Uint8Array(pairs.map(pair => parseInt(pair, 16))); };
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => { const bytes = new Uint8Array(a.length + b.length); bytes.set(a); bytes.set(b, a.length); return bytes; };

function runtimeUrl(path: string): URL {
  const target = new URL(path, location.origin);
  if (target.origin !== location.origin) throw new Error('Runtime requests must stay on the platform origin.');
  return target;
}

async function runtimeError(response: Response): Promise<RuntimeError> {
  const result = (await response.json().catch(() => ({}))) as RuntimeResponse;
  const retryAfter = Number(result.retryAfter ?? response.headers.get('Retry-After'));
  let message = typeof result.message === 'string' ? result.message : 'Artefact access failed. Reopen it and try again.';
  const code = typeof result.error === 'string' ? result.error : undefined;
  const remaining = typeof result.remaining === 'number' ? result.remaining : undefined;
  if (code === 'wrong') {
    message = 'Incorrect password.';
    if (Number.isInteger(remaining) && (remaining ?? -1) >= 0) message += ` ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`;
  } else if (response.status === 429) {
    message = Number.isFinite(retryAfter) && retryAfter > 0 ? `Too many attempts. Try again in ${Math.ceil(retryAfter)} seconds.` : 'Too many attempts. Try again later.';
  }
  const error = new RuntimeError(message, code, response.status, retryAfter, remaining);
  if (Array.isArray(result.issues)) error.issues = result.issues as Array<{ field: string; message: string }>;
  return error;
}

async function post(url: string, body: unknown, { signal, keepalive = false }: { signal?: AbortSignal; keepalive?: boolean } = {}): Promise<RuntimeResponse> {
  const response = await fetch(runtimeUrl(url), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, keepalive });
  if (!response.ok) throw await runtimeError(response);
  return (response.status === 204 ? {} : await response.json()) as RuntimeResponse;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[\\/\u0000-\u001f]/g, '_');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

type FileRef = { id: string; name: string; type: string; size: number };
type PartView = { number: number; size: number; sha256: string };
type UploadView = { id: string; collection: string; field: string; name: string; type: string; size: number;
  lastModified: number | null; partBytes: number; parts: number; received: PartView[];
  status: 'uploading' | 'ready'; expiresAt: string; partPath: string };

async function sha256Hex(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
}

function backoff(ms: number, signal: AbortSignal): Promise<void> {
  // Promise.withResolvers is outside the frontend's TS lib target.
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}

// One part: up to 4 attempts; a network error, 5xx or 429 retries after 1 s, 2 s, 4 s, or the
// 429/503 Retry-After (1-30 s). A longer Retry-After (hourly limiter windows) or a 4xx rejects at once.
async function putPart(state: RuntimeState, path: string, body: Blob, signal: AbortSignal): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    let wait = 1000 * 2 ** attempt;
    let response: Response | undefined;
    try {
      response = await fetch(runtimeUrl(path), { method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/octet-stream', 'X-Artefacts-Grant': state.grant }, body, signal });
    } catch (cause) {
      if (signal.aborted) throw cause;
      failure = cause;
    }
    if (response) {
      if (response.ok) return;
      const error = await runtimeError(response);
      if (response.status !== 429 && response.status < 500) throw error;
      if (response.status === 429 || response.status === 503) {
        const after = Number(response.headers.get('Retry-After'));
        if (after > 30) throw error;
        if (after >= 1) wait = after * 1000;
      }
      failure = error;
    }
    if (attempt < 3) await backoff(wait, signal);
  }
  throw failure;
}

async function uploadFile(state: RuntimeState, message: { collection?: unknown; field?: unknown; file?: unknown }, signal: AbortSignal, report: (progress: { loaded: number; total: number }) => void): Promise<FileRef> {
  const { collection, field, file } = message;
  if (!(file instanceof File) || typeof collection !== 'string' || typeof field !== 'string') throw new RuntimeError('An upload needs a collection, a field and a File.', 'invalid-value');
  // The start is not abortable: an aborted response would orphan a session (5 open per actor).
  const { upload } = (await post('/_runtime/data', { grant: state.grant, op: 'upload-start', collection, data: { field, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified } })).value as { upload: UploadView };
  try {
    if (signal.aborted) throw new DOMException('The upload was aborted.', 'AbortError');
    const have = new Map(upload.received.map(part => [part.number, part]));
    for (let n = 1; n <= upload.parts; n++) {
      const slice = file.slice((n - 1) * upload.partBytes, Math.min(n * upload.partBytes, file.size));
      const known = have.get(n);
      // A resumed session matches by name/size/lastModified only; the part hash is the proof.
      if (!known || known.size !== slice.size || known.sha256 !== await sha256Hex(slice)) await putPart(state, upload.partPath + n, slice, signal);
      if (n < upload.parts) report({ loaded: Math.min(n * upload.partBytes, file.size), total: file.size });
    }
    const ref = (await post('/_runtime/data', { grant: state.grant, op: 'upload-complete', collection, id: upload.id }, { signal })).value as { file: FileRef };
    report({ loaded: file.size, total: file.size });
    return ref.file;
  } catch (cause) {
    // Only an explicit cancel drops the session; a teardown (reload/unmount) keeps it for resume.
    if (signal.reason === 'cancel') void post('/_runtime/data', { grant: state.grant, op: 'upload-cancel', collection, id: upload.id }).catch(() => undefined);
    // fetch rejects with the raw abort reason (a string); a deduped waiter must still see an abort.
    throw signal.aborted ? new DOMException('The upload was aborted.', 'AbortError') : cause;
  }
}

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(disposition);
  if (star) try { return decodeURIComponent(star[1]); } catch { /* malformed: use the fallback */ }
  return /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? /filename\s*=\s*([^;\s"]+)/i.exec(disposition)?.[1] ?? null;
}

async function fetchFile(state: RuntimeState, collection: unknown, recordId: unknown, fileId: unknown, signal: AbortSignal): Promise<File> {
  const response = await fetch(runtimeUrl(`/_runtime/files/${encodeURIComponent(String(collection))}/${encodeURIComponent(String(recordId))}/${encodeURIComponent(String(fileId))}`), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Artefacts-Grant': state.grant }, signal });
  if (!response.ok) throw await runtimeError(response);
  const blob = await response.blob();
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) !== blob.size) throw new Error('The file download was incomplete.');
  return new File([blob], filenameFrom(response.headers.get('Content-Disposition')) ?? String(fileId), { type: response.headers.get('X-Artefacts-File-Type') ?? '' });
}

async function decrypt(payload: EncryptedPayload, password: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64(payload.wrap.ksalt), iterations: payload.wrap.iter, hash: 'SHA-256' }, material, 256);
  const importKey = (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<CryptoKey> => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
  const open = async (key: CryptoKey, box: EncryptedBox): Promise<{ k: string }> => JSON.parse(utf8.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(box.iv) }, key, concat(b64(box.ct), b64(box.tag ?? ''))))) as { k: string };
  let key = (await open(await importKey(bits), payload.wrap)).k;
  if (payload.key) key = (await open(await importKey(fromHex(key)), payload.key)).k;
  return utf8.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(payload.content.iv) }, await importKey(fromHex(key)), b64(payload.content.ct)));
}

export async function openArtifact(viewer: ViewerDescriptor, { password, signal }: { password?: string; signal?: AbortSignal } = {}): Promise<RuntimeOpened> {
  if (viewer.gated && typeof password !== 'string') throw new RuntimeError('Enter the password.', 'password-required');
  const payload = viewer.gated ? await post(viewer.gateUrl ?? '', { password }, { signal }) : await post(viewer.loadUrl ?? '', { source: viewer.runtime }, { signal });
  if (Array.isArray(payload.index)) return { index: payload.index as Array<{ title: string; viewer: ViewerDescriptor }>, html: '', permissions: Object.freeze({ ...viewer.permissions }) };
  const html = viewer.gated ? await decrypt(payload as unknown as EncryptedPayload, password ?? '') : payload.html;
  const runtime = payload.runtime;
  if (typeof html !== 'string' || typeof runtime !== 'object' || runtime === null || typeof (runtime as { grant?: unknown }).grant !== 'string') throw new Error('The server did not return an authorized artefact.');
  const opened: RuntimeOpened = Object.freeze({ html, permissions: Object.freeze({ ...viewer.permissions }) });
  openedState.set(opened, Object.freeze({ grant: (runtime as { grant: string }).grant, observation: payload.observation && typeof payload.observation === 'object' ? Object.freeze({ ...(payload.observation as Record<string, unknown>) }) : null }));
  return opened;
}

// Standalone source text, not Function.toString(): bundler helpers must never enter srcdoc.
const CHILD = String.raw`(() => {
  const script = document.currentScript, nonce = script.dataset.nonce;
  const pending = new Map();
  let sequence = 0, port;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const invalidJson = () => { throw Object.assign(new TypeError('Artefact data accepts JSON values only.'), { code: 'invalid-value' }); };
  const validateJson = (value, ancestors = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalidJson(); return; }
    if (typeof value !== 'object' || ancestors.has(value)) invalidJson();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) invalidJson();
    if (Object.getOwnPropertySymbols(value).length) invalidJson();
    const keys = Object.keys(value);
    if (array && keys.length !== value.length) invalidJson();
    ancestors.add(value);
    for (let i = 0; i < keys.length; i++) {
      const key = array ? String(i) : keys[i];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidJson();
      validateJson(descriptor.value, ancestors);
    }
    ancestors.delete(value);
  };
  const send = async (message, { onProgress, signal } = {}) => {
    if (pending.size >= 32) throw new Error('Too many pending artefact requests.');
    if (!port) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Artefact connection unavailable.')), 10000);
      ready.then(() => { clearTimeout(timer); resolve(); });
    });
    if (pending.size >= 32) throw new Error('Too many pending artefact requests.');
    if (signal?.aborted) throw new DOMException('The upload was aborted.', 'AbortError');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      // Transfers take as long as they take; every other request keeps the 30 s limit.
      const untimed = message.type === 'upload' || message.type === 'file' || message.type === 'download';
      const timer = untimed ? null : setTimeout(() => { pending.delete(id); reject(new Error('Artefact request timed out.')); }, 30000);
      const onAbort = () => {
        if (!pending.delete(id)) return;
        try { port.postMessage({ type: 'cancel', id: ++sequence, upload: id }); } catch { /* port closed: the parent already tore the upload down */ }
        reject(new DOMException('The upload was aborted.', 'AbortError'));
      };
      const done = () => signal?.removeEventListener('abort', onAbort);
      pending.set(id, { resolve, reject, timer, onProgress, done });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { port.postMessage({ ...message, id }); }
      catch (error) { clearTimeout(timer); done(); pending.delete(id); reject(error); }
    });
  };
  const call = (op, key, value, options = {}) => send({ type: 'storage', op, key, value, scope: options.scope ?? 'personal', prefix: options.prefix ?? '' });
  const storage = Object.freeze({
    get: (key, options) => call('get', key, undefined, options),
    set: async (key, value, options) => { validateJson(value); await call('set', key, value, options); },
    delete: async (key, options) => { await call('delete', key, undefined, options); },
    list: (options) => call('list', undefined, undefined, options),
  });
  const dataCall = (op, collection, { recordId, data, ifVersion, limit, cursor } = {}) =>
    send({ type: 'data', op, collection, recordId, data, ifVersion, limit, cursor });
  const formValue = (form, submitter = null) => {
    const value = Object.create(null);
    for (const [name, entry] of new FormData(form, submitter)) {
      // An unselected <input type="file"> contributes a nameless 0-byte File: absent.
      if (typeof entry !== 'string' && entry.name === '' && entry.size === 0) continue;
      const input = form.elements.namedItem(name);
      if (input instanceof HTMLInputElement && input.type === 'file' && input.multiple) (value[name] ??= []).push(entry);
      else if (!Object.hasOwn(value, name)) value[name] = entry;
      else if (Array.isArray(value[name])) value[name].push(entry);
      else value[name] = [value[name], entry];
    }
    return value;
  };
  // Uploads top-level File values (or Files in top-level arrays) one by one, then returns the
  // value with their ids. validateJson sees placeholders first, so bad JSON never costs an upload.
  const uploadFiles = async (collection, value, onProgress) => {
    const proto = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.getPrototypeOf(value) : undefined;
    if (proto !== Object.prototype && proto !== null) { validateJson(value); return value; }
    const copy = Object.assign(Object.create(null), value), jobs = [];
    for (const [field, item] of Object.entries(copy)) {
      if (item instanceof File) { jobs.push({ field, file: item, put: id => { copy[field] = id; } }); copy[field] = ''; }
      else if (Array.isArray(item) && item.some(entry => entry instanceof File)) {
        const list = copy[field] = [...item];
        list.forEach((entry, index) => { if (entry instanceof File) { jobs.push({ field, file: entry, put: id => { list[index] = id; } }); list[index] = ''; } });
      }
    }
    validateJson(copy);
    const total = jobs.reduce((sum, job) => sum + job.file.size, 0);
    let done = 0;
    for (const job of jobs) {   // sequential, in field order (object insertion / form document order)
      const ref = await data.upload(collection, job.field, job.file, { onProgress: p => onProgress?.({ field: job.field, loaded: done + p.loaded, total }) });
      job.put(ref.id); done += job.file.size;
    }
    return copy;
  };
  const data = Object.freeze({
    list: (collection, options = {}) => dataCall('list', collection, { limit: options.limit, cursor: options.cursor }),
    get: (collection, id) => dataCall('get', collection, { recordId: id }),
    create: async (collection, value, options = {}) => dataCall('create', collection, { data: await uploadFiles(collection, value, options.onProgress) }),
    update: async (collection, id, value, options = {}) => dataCall('update', collection, { recordId: id, data: await uploadFiles(collection, value, options.onProgress), ifVersion: options.ifVersion }),
    delete: async (collection, id, options = {}) => { await dataCall('delete', collection, { recordId: id, ifVersion: options.ifVersion }); },
    submit: async (collection, value, options = {}) => {
      // A SubmitEvent carries the clicked button, whose name/value FormData then includes.
      const payload = value instanceof SubmitEvent && value.target instanceof HTMLFormElement ? formValue(value.target, value.submitter)
        : value instanceof HTMLFormElement ? formValue(value) : value;
      return dataCall('submit', collection, { data: await uploadFiles(collection, payload, options.onProgress) });
    },
    mine: (collection, options = {}) => dataCall('mine', collection, { limit: options.limit, cursor: options.cursor }),
    upload: async (collection, field, file, options = {}) => {
      if (!(file instanceof File)) throw Object.assign(new TypeError('upload needs a File.'), { code: 'invalid-value' });
      return send({ type: 'upload', collection, field, file }, { onProgress: options.onProgress, signal: options.signal });
    },
    file: (collection, recordId, fileId) => send({ type: 'file', collection, recordId, fileId }),
    download: async (collection, recordId, fileId) => { await send({ type: 'download', collection, recordId, fileId }); },
  });
  // Opt-in by standard declaration: <meta name="color-scheme" content="light dark">. Parser
  // mutations are delivered as microtasks, so the scheme lands before the first paint.
  let theme = script.dataset.initialTheme === 'dark' ? 'dark' : 'light', themed = false;
  const applyTheme = () => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; };
  const setTheme = (next) => {
    if ((next !== 'light' && next !== 'dark') || next === theme) return;
    theme = next;
    if (!themed) return;
    applyTheme();
    dispatchEvent(new CustomEvent('artefacts:theme', { detail: { theme } }));
  };
  const detectTheme = (meta) => {
    const words = meta.content.toLowerCase().split(/\s+/);
    if (themed || meta.name.toLowerCase() !== 'color-scheme' || !words.includes('light') || !words.includes('dark')) return;
    themed = true;
    applyTheme();
    ready.then(() => port.postMessage({ type: 'theme-support' }));
  };
  // Only parser-added META nodes are inspected, and only until <body> starts: the declaration belongs in <head>.
  const themeWatch = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeName === 'META') detectTheme(node);
    if (themed || document.body) themeWatch.disconnect();
  });
  themeWatch.observe(document, { childList: true, subtree: true });
  Object.defineProperty(window, 'artefacts', { value: Object.freeze({ storage, data, get theme() { return themed ? theme : null; } }), writable: false, configurable: false });
  // The sandbox (no allow-forms) blocks every native submission before validation and the submit
  // event, so these hooks restore both without ever navigating; form.submit() stays a no-op.
  // Submission runs after authored click handlers, as native activation behaviour does, so an
  // authored preventDefault() on the click cancels it.
  // ponytail: no formaction/formmethod/formtarget emulation because nothing navigates (so a
  // submitter's formmethod="dialog" is not honoured); a click whose propagation authored code
  // stopped submits on the next task instead of synchronously; an authored window-level bubble
  // click listener runs after the decision, so it cannot cancel, and sees defaultPrevented === true
  // on submit-button clicks because the shim cancels the blocked native attempt.
  const isSubmitter = (element) => element instanceof HTMLButtonElement ? element.type === 'submit'
    : element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'image');
  const firing = new WeakSet();
  const submitForm = (form, submitter) => {
    // Native "firing submission events": a nested requestSubmit during validation or dispatch is a no-op.
    if (firing.has(form)) return;
    firing.add(form);
    let proceed = false;
    try {
      if (!form.noValidate && !submitter?.formNoValidate && !form.reportValidity()) return;
      proceed = form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
    } finally { firing.delete(form); }
    const dialog = proceed && form.method === 'dialog' ? form.closest('dialog') : null;
    if (dialog) { if (submitter) dialog.close(submitter.value); else dialog.close(); }
  };
  const armedClicks = new WeakMap();
  const finishClick = (state) => {
    if (state.done) return;
    state.done = true;
    const cancelled = state.event.defaultPrevented;
    state.event.preventDefault();   // suppresses the sandbox's blocked native attempt
    if (!cancelled && state.submitter.form) submitForm(state.submitter.form, state.submitter);
  };
  addEventListener('click', (event) => {
    const submitter = event.target instanceof Element ? event.target.closest('button, input[type=submit], input[type=image]') : null;
    if (!submitter || !isSubmitter(submitter) || submitter.matches(':disabled') || !submitter.form) return;
    const state = { event, submitter, done: false };
    armedClicks.set(event, state);
    setTimeout(() => finishClick(state), 0);
  }, true);
  addEventListener('click', (event) => {
    const state = armedClicks.get(event);
    if (state) finishClick(state);
  });
  const blocksImplicit = (element) => element instanceof HTMLInputElement &&
    ['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number'].includes(element.type);
  addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented || !blocksImplicit(event.target)) return;
    const form = event.target.form;
    if (!form || Array.from(form.elements).some(isSubmitter) || Array.from(form.elements).filter(blocksImplicit).length !== 1) return;
    event.preventDefault();
    submitForm(form, null);
  });
  HTMLFormElement.prototype.requestSubmit = function requestSubmit(submitter) {
    if (submitter != null) {
      if (!isSubmitter(submitter)) throw new TypeError('The specified element is not a submit button.');
      if (submitter.form !== this) throw new DOMException('The specified element is not owned by this form element.', 'NotFoundError');
    }
    submitForm(this, submitter ?? null);
  };
  const connect = (event) => {
    if (event.source !== parent || event.data?.type !== 'artefacts:connect' || event.data.nonce !== nonce || !event.ports[0]) return;
    removeEventListener('message', connect);
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'theme') { setTheme(data.theme); return; }
      const request = pending.get(data?.id);
      if (!request) return;
      if (data.progress) { request.onProgress?.(data.progress); return; }
      pending.delete(data.id); clearTimeout(request.timer); request.done();
      if (data.error) request.reject(Object.assign(new Error(data.error.message), { code: data.error.code }, Array.isArray(data.error.issues) ? { issues: data.error.issues } : {}));
      else request.resolve(data.value);
    };
    port.start(); resolveReady();
    setTheme(event.data.theme);
    if (event.data.observe) observe();
    if (event.data.commandPalette) addEventListener('keydown', event => {
      if (!event.isTrusted || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (!event.repeat) port.postMessage({ type: 'command-palette' });
    }, true);
  };
  addEventListener('message', connect);
  parent.postMessage({ type: 'artefacts:ready', nonce }, '*');
  // srcdoc inherits the parent URL as its base; resolve fragment links against this document instead.
  addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target?.closest?.('a[href]');
    const href = link?.getAttribute('href').trim();
    if (!href?.startsWith('#')) return;
    event.preventDefault();
    location.hash = href;
  });
  function observe() {
    let activeMs = 0, lastTick = performance.now(), lastActivity = lastTick, scroll = 0;
    const tick = () => {
      const now = performance.now();
      if (document.visibilityState === 'visible' && document.hasFocus() && lastTick - lastActivity < 60000) activeMs += Math.min(now - lastTick, 15000);
      lastTick = now;
    };
    const send = () => {
      tick();
      const root = document.scrollingElement || document.documentElement;
      scroll = Math.max(scroll, Math.floor(Math.min(100, (root.scrollTop + innerHeight) / Math.max(1, root.scrollHeight) * 100) / 25) * 25);
      port.postMessage({ type: 'observation', activeSeconds: Math.min(14400, Math.floor(activeMs / 1000)), scroll });
    };
    const activity = () => { tick(); lastActivity = performance.now(); };
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'focus']) addEventListener(type, activity, { passive: true });
    addEventListener('blur', send); addEventListener('pagehide', send);
    document.addEventListener('visibilitychange', send);
    const timer = setInterval(send, 15000);
    setTimeout(() => clearInterval(timer), 4 * 60 * 60 * 1000);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', send, { once: true }); else send();
  }
})();`;

export type ArtifactTheme = 'light' | 'dark';
const frameThemes = new WeakMap<HTMLIFrameElement, (theme: ArtifactTheme) => void>();

/** Live scheme switch; only a document that opted in (onThemeSupport) applies it. */
export function setArtifactFrameTheme(iframe: HTMLIFrameElement, theme: ArtifactTheme): void {
  frameThemes.get(iframe)?.(theme);
}

export function mountArtifactFrame(iframe: HTMLIFrameElement, opened: OpenedArtifact, { onError, theme: initialTheme = 'light', onThemeSupport }: { onError?: (error: Error) => void; theme?: ArtifactTheme; onThemeSupport?: () => void } = {}): () => void {
  const state = openedState.get(opened);
  if (!state || !iframe || iframe.tagName !== 'IFRAME') throw new Error('An authorized artefact and an iframe are required.');
  frameCleanups.get(iframe)?.();
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.removeAttribute('allow');
  iframe.removeAttribute('src');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  let closed = false;
  let disconnect: (() => void) | undefined;
  let lastObservation = 0;
  let observedActive = 0;
  let theme = initialTheme;
  let themed = false;
  let themePort: MessagePort | undefined;
  // The frame element's color-scheme also drives prefers-color-scheme inside the frame (CSS Color
  // Adjust); it is set only once the document opted in, so light-only artefacts stay untouched.
  frameThemes.set(iframe, next => {
    theme = next;
    if (themed) iframe.style.colorScheme = next;
    themePort?.postMessage({ type: 'theme', theme: next });
  });
  const connectionTimer = setTimeout(() => { if (!closed) onError?.(new Error('The isolated artefact could not connect. Reload it to try again.')); }, 10000);
  const connect = (event: MessageEvent): void => {
    if (closed || event.source !== iframe.contentWindow || event.origin !== 'null' || event.data?.type !== 'artefacts:ready' || event.data.nonce !== nonce) return;
    disconnect?.();
    const channel = new MessageChannel();
    const controller = new AbortController();
    const activeBase = observedActive;
    let active = true;
    let inFlight = 0;
    const uploads = new Map<number, AbortController>();
    // One transfer per file at a time (the server's resume key): a double submit awaits the first.
    const uploading = new Map<string, Promise<FileRef>>();
    disconnect = () => { active = false; controller.abort(); channel.port1.close(); channel.port2.close(); };
    const sendError = (id: number, error: Error): void => channel.port1.postMessage({ id, error: {
      code: error instanceof RuntimeError && error.code ? error.code : error.name === 'AbortError' ? 'aborted' : 'storage-failed', message: error.message || 'Storage failed.',
      ...(error instanceof RuntimeError && error.issues ? { issues: error.issues } : {}),
    } });
    channel.port1.onmessage = async (message: MessageEvent): Promise<void> => {
      const data = message.data as { type?: string; id?: number; activeSeconds?: number; scroll?: number; op?: string; scope?: string; key?: string; value?: unknown; prefix?: string;
        collection?: unknown; recordId?: unknown; data?: unknown; ifVersion?: unknown; limit?: unknown; cursor?: unknown;
        field?: unknown; file?: unknown; fileId?: unknown; upload?: unknown } | null;
      if (closed || !active || !data || typeof data !== 'object') return;
      if (data.type === 'command-palette') {
        if (iframe.closest('.console')) iframe.dispatchEvent(new Event('wsa:command-palette', { bubbles: true }));
        return;
      }
      if (data.type === 'theme-support') {
        themed = true;
        iframe.style.colorScheme = theme;
        onThemeSupport?.();
        return;
      }
      if (data.type === 'observation' && state.observation) {
        if (Date.now() - lastObservation < 1000 || !Number.isInteger(data.activeSeconds) || (data.activeSeconds ?? -1) < 0 || (data.activeSeconds ?? 0) > 14400 || ![0, 25, 50, 75, 100].includes(data.scroll ?? -1)) return;
        lastObservation = Date.now();
        observedActive = Math.min(14400, Math.max(observedActive, activeBase + (data.activeSeconds ?? 0)));
        void post('/_ev', { ...state.observation, activeSeconds: observedActive, scroll: data.scroll }, { keepalive: true }).catch(() => undefined);
        return;
      }
      if (data.type === 'cancel') { uploads.get(data.upload as number)?.abort('cancel'); return; }
      if (!['storage', 'data', 'upload', 'file', 'download'].includes(data.type ?? '') || !Number.isSafeInteger(data.id) || (data.id ?? 0) < 1) return;
      const id = data.id as number;
      if (inFlight >= 32) { sendError(id, new Error('Too many pending artefact requests.')); return; }
      inFlight++;
      // Registered before the first await so a cancel posted right behind the upload finds it.
      const cancel = data.type === 'upload' ? new AbortController() : undefined;
      // Connection teardown keeps the session (its reason is not 'cancel'): re-picking the file resumes it.
      const forward = (): void => cancel?.abort(controller.signal.reason);
      if (cancel) { uploads.set(id, cancel); controller.signal.addEventListener('abort', forward, { once: true }); }
      try {
        let value: unknown;
        if (cancel) {
          const file = data.file instanceof File ? data.file : null;
          const key = file && JSON.stringify([data.collection, data.field, file.name, file.size, file.lastModified]);
          let task = key ? uploading.get(key) : undefined;
          if (!task) {
            task = uploadFile(state, data, cancel.signal, progress => { if (!closed && active) channel.port1.postMessage({ id, progress }); });
            if (key) { uploading.set(key, task); task.finally(() => uploading.delete(key)).catch(() => undefined); }
          }
          value = await task;
        } else if (data.type === 'file' || data.type === 'download') {
          const file = await fetchFile(state, data.collection, data.recordId, data.fileId, controller.signal);
          if (data.type === 'download') {
            // Only file() keeps the declared type; a saved download never carries a renderable one.
            saveBlob(new Blob([file], { type: 'application/octet-stream' }), file.name);
            value = null;
          } else value = file;
        } else {
          value = (data.type === 'data'
            ? await post('/_runtime/data', { grant: state.grant, op: data.op, collection: data.collection, id: data.recordId, data: data.data, ifVersion: data.ifVersion, limit: data.limit, cursor: data.cursor }, { signal: controller.signal })
            : await post('/_runtime/state', { grant: state.grant, op: data.op, scope: data.scope, key: data.key, value: data.value, prefix: data.prefix }, { signal: controller.signal })).value;
        }
        if (!closed && active) channel.port1.postMessage({ id, value });
      } catch (cause) {
        if (!closed && active) sendError(id, cause instanceof Error ? cause : new Error('Storage failed.'));
      } finally {
        inFlight--;
        uploads.delete(id);
        controller.signal.removeEventListener('abort', forward);
      }
    };
    channel.port1.start();
    themePort = channel.port1;
    clearTimeout(connectionTimer);
    const targetWindow = iframe.contentWindow;
    if (targetWindow) targetWindow.postMessage({ type: 'artefacts:connect', nonce, theme, observe: Boolean(state.observation), commandPalette: Boolean(iframe.closest('.console')) }, '*', [channel.port2]);
  };
  window.addEventListener('message', connect);
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(connectionTimer);
    disconnect?.();
    window.removeEventListener('message', connect);
    frameCleanups.delete(iframe);
    frameThemes.delete(iframe);
    iframe.style.removeProperty('color-scheme');
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('src');
  };
  frameCleanups.set(iframe, cleanup);
  const images = ['/assets/favicon.ico', '/assets/ws-logo.svg'].map(path => new URL(path, location.origin).href).join(' ');
  const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob: ${images}; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'`;
  const document = opened.html.replace(/^\s*<!doctype[^>]*>/i, '');
  iframe.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script data-nonce="${nonce}" data-initial-theme="${theme === 'dark' ? 'dark' : 'light'}">${CHILD}</script>${document}`;
  return cleanup;
}

async function check(opened: OpenedArtifact): Promise<RuntimeState> {
  const state = openedState.get(opened);
  if (!state) throw new Error('Open the artefact first.');
  await post('/_runtime/check', { grant: state.grant });
  return state;
}

export async function readArtifactSource(opened: OpenedArtifact): Promise<string> {
  await check(opened);
  return opened.html;
}

export async function downloadArtifact(viewer: Pick<ViewerDescriptor, 'title'>, opened: OpenedArtifact, { filename }: { filename?: string } = {}): Promise<void> {
  const source = await readArtifactSource(opened);
  saveBlob(new Blob([source], { type: 'text/html;charset=utf-8' }), filename || `${viewer.title || 'artefact'}.html`);
}

export async function reportArtifact(_viewer: ViewerDescriptor, opened: OpenedArtifact, { reason, csrf }: { reason?: FormDataEntryValue | null; csrf?: string } = {}): Promise<void> {
  const state = openedState.get(opened);
  if (!state) throw new Error('Open the artefact first.');
  await post('/_runtime/report', { grant: state.grant, reason, csrf });
}

export async function duplicateArtifact(viewer: ViewerDescriptor, opened: OpenedArtifact | null | undefined, { folderId, title, slug, password, csrf }: { folderId?: FormDataEntryValue | null; title?: FormDataEntryValue | null; slug?: FormDataEntryValue | null; password?: FormDataEntryValue | null; csrf?: string } = {}): Promise<RuntimeResponse> {
  if (!opened) throw new Error('Open the artefact first.');
  const state = openedState.get(opened);
  if (!state) throw new Error('Open the artefact first.');
  return post('/_runtime/duplicate', { grant: state.grant, folderId, title, slug, password, csrf: csrf ?? viewer.csrf });
}
