export const PAGE_FRAME_NONCE_BYTES = 24;
export const PAGE_FRAME_NONCE_HEX_LENGTH = PAGE_FRAME_NONCE_BYTES * 2;

type PageFrameTheme = "light" | "dark";

const CHILD = String.raw`(() => {
  const script = document.currentScript, nonce = script.dataset.nonce;
  const pageKit = window.__a67PageKit || (window.__a67PageKit = {});
  Object.defineProperty(pageKit, 'canWriteRecords', { value: script.dataset.recordWrite === 'true' });
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
    schema: collection => dataCall('schema', collection),
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
  let theme = script.dataset.initialTheme === 'dark' ? 'dark' : 'light', themed = false, pageThemeVersion = 0;
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
  document.querySelectorAll('meta[name="color-scheme"]').forEach(detectTheme);
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
      if (data?.type === 'page-theme') {
        const style = document.getElementById('a67-page-theme');
        if (data.source !== 'parent' || data.nonce !== nonce || !Number.isSafeInteger(data.version) || data.version <= pageThemeVersion ||
          !data.theme || !['platform', 'project'].includes(data.theme.scope) || !/^[a-z][a-z0-9-]{0,47}$/.test(data.theme.slug) ||
          typeof data.css !== 'string' || data.css.length > 131072 || !(style instanceof HTMLStyleElement)) return;
        style.textContent = data.css;
        style.dataset.themeScope = data.theme.scope;
        style.dataset.themeSlug = data.theme.slug;
        document.documentElement.dataset.a67Theme = data.theme.slug;
        pageThemeVersion = data.version;
        return;
      }
      if (data?.type === 'text-size') {
        if (data.source !== 'parent' || data.nonce !== nonce || !['s', 'm', 'l'].includes(data.size)) return;
        document.documentElement.style.fontSize = data.size === 's' ? '87.5%' : data.size === 'l' ? '120%' : '100%';
        return;
      }
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

export function buildPageFrameBridge(nonce: string, theme: PageFrameTheme, canWrite: boolean): string {
  return `<script data-nonce="${nonce}" data-initial-theme="${theme}" data-record-write="${canWrite}">${CHILD}</script>`;
}
