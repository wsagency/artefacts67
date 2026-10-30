import type { OpenedArtifact, PagePresentation, ViewerDescriptor } from './types';
import { PAGE_KIT_CSS, PAGE_KIT_RUNTIME } from './page-kit';
import { composeHostedPageDocument, composePageDownload } from './page-composition';
import { PAGE_FRAME_NONCE_BYTES, buildPageFrameBridge } from './page-frame-bridge';
import { getPlatformTheme } from './platform-themes';
import { compileTheme, type CompiledTheme, type PlatformThemeDefinition } from './theme-compiler';

export { PAGE_KIT_CSS, PAGE_KIT_RUNTIME };

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
  const permissions = Object.freeze({ ...viewer.permissions, ...(viewer.runtime?.kind === 'share' ? { write: false } : {}) });
  if (Array.isArray(payload.index)) return { index: payload.index as Array<{ title: string; viewer: ViewerDescriptor }>, html: '', permissions };
  const html = viewer.gated ? await decrypt(payload as unknown as EncryptedPayload, password ?? '') : payload.html;
  if (typeof html !== 'string') throw new Error('The server did not return an authorized artefact.');
  const runtime = payload.runtime;
  if (!runtime || typeof runtime !== 'object' || !('grant' in runtime) || typeof runtime.grant !== 'string') throw new Error('The server did not return an authorized artefact.');
  const pageData = payload.page;
  let page: PagePresentation | undefined;
  if (pageData !== undefined) {
    if (!pageData || typeof pageData !== 'object' || Array.isArray(pageData) || !('type' in pageData) || pageData.type !== 'page' ||
      !('brandLock' in pageData) || typeof pageData.brandLock !== 'boolean' || !('theme' in pageData)) throw new Error('The server returned invalid page metadata.');
    const lang = 'lang' in pageData && typeof pageData.lang === 'string' ? pageData.lang : undefined;
    const selected = pageData.theme;
    let selectedTheme: PagePresentation['theme'];
    if (selected === null) selectedTheme = null;
    else {
      if (!selected || typeof selected !== 'object' || Array.isArray(selected) || !('scope' in selected) || !('slug' in selected) ||
        (selected.scope !== 'platform' && selected.scope !== 'project') || typeof selected.slug !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(selected.slug)) {
        throw new Error('The server returned invalid page metadata.');
      }
      selectedTheme = { scope: selected.scope, slug: selected.slug };
    }
    let compiledTheme: CompiledTheme | undefined;
    if ('compiledTheme' in pageData && pageData.compiledTheme !== undefined) {
      const candidate = pageData.compiledTheme as Record<string, unknown>;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('The server returned invalid page theme metadata.');
      try {
        compiledTheme = compileTheme({
          slug: candidate.slug as string,
          name: candidate.name as string,
          description: candidate.description as string,
          tokens: candidate.tokens as PlatformThemeDefinition['tokens'],
          recipes: candidate.recipes as PlatformThemeDefinition['recipes'],
          logo: candidate.logo as string | null,
        });
      } catch {
        throw new Error('The server returned invalid page theme metadata.');
      }
      if (selectedTheme && (selectedTheme.scope !== 'platform' || (getPlatformTheme(selectedTheme.slug) && compiledTheme.slug !== selectedTheme.slug))) throw new Error('The server returned mismatched page theme metadata.');
    }
    page = { type: 'page', theme: selectedTheme, brandLock: pageData.brandLock, ...(lang === undefined ? {} : { lang }), ...(compiledTheme ? { compiledTheme } : {}) };
  }
  const opened: RuntimeOpened = Object.freeze({ html, permissions, ...(page ? { page } : {}) });
  openedState.set(opened, Object.freeze({ grant: runtime.grant, observation: payload.observation && typeof payload.observation === 'object' ? Object.freeze({ ...(payload.observation as Record<string, unknown>) }) : null }));
  return opened;
}

// Standalone source text, not Function.toString(): bundler helpers must never enter srcdoc.

export type ArtifactTheme = 'light' | 'dark';
const frameThemes = new WeakMap<HTMLIFrameElement, (theme: ArtifactTheme) => void>();
const framePageThemes = new WeakMap<HTMLIFrameElement, (theme: CompiledTheme) => void>();
const frameTextSizes = new WeakMap<HTMLIFrameElement, (size: 's' | 'm' | 'l') => void>();

/** Replace a compiled theme through the authenticated, versioned frame channel. */
export function setArtifactFramePageTheme(iframe: HTMLIFrameElement, theme: CompiledTheme): void {
  framePageThemes.get(iframe)?.(theme);
}

/** Adjust page root type without replacing its document or kit runtime. */
export function setArtifactFrameTextSize(iframe: HTMLIFrameElement, size: 's' | 'm' | 'l'): void {
  frameTextSizes.get(iframe)?.(size);
}

/** Live scheme switch; only a document that opted in (onThemeSupport) applies it. */
export function setArtifactFrameTheme(iframe: HTMLIFrameElement, theme: ArtifactTheme): void {
  frameThemes.get(iframe)?.(theme);
}

export function mountArtifactFrame(iframe: HTMLIFrameElement, opened: OpenedArtifact, { onError, theme: initialTheme = 'light', onThemeSupport, pageTheme, textSize = 'm', origin = location.origin }: { onError?: (error: Error) => void; theme?: ArtifactTheme; onThemeSupport?: () => void; pageTheme?: CompiledTheme; textSize?: 's' | 'm' | 'l'; origin?: string } = {}): () => void {
  const state = openedState.get(opened);
  if (!state || !iframe || iframe.tagName !== 'IFRAME') throw new Error('An authorized artefact and an iframe are required.');
  frameCleanups.get(iframe)?.();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(PAGE_FRAME_NONCE_BYTES)), byte => byte.toString(16).padStart(2, '0')).join('');
  const effectivePageTheme = opened.page ? pageTheme ?? opened.page.compiledTheme
    ?? (opened.page.theme?.scope === 'platform' ? getPlatformTheme(opened.page.theme.slug) : null)
    ?? getPlatformTheme('report')! : undefined;
  const hostedPage = effectivePageTheme
    ? composeHostedPageDocument(opened.html, effectivePageTheme, initialTheme, origin, textSize, opened.page?.lang ?? "en", nonce, opened.permissions.write === true)
    : undefined;
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.removeAttribute('allow');
  iframe.removeAttribute('src');
  let closed = false;
  let disconnect: (() => void) | undefined;
  let lastObservation = 0;
  let observedActive = 0;
  let theme = initialTheme;
  let themed = false;
  let themePort: MessagePort | undefined;
  let pageThemeVersion = 0;
  let pendingPageTheme: CompiledTheme | undefined;
  let pendingTextSize = textSize;
  frameThemes.set(iframe, next => {
    theme = next;
    if (themed) iframe.style.colorScheme = next;
    themePort?.postMessage({ type: 'theme', theme: next });
  });
  if (effectivePageTheme) {
    framePageThemes.set(iframe, next => {
      pendingPageTheme = next;
      pageThemeVersion++;
      themePort?.postMessage({ type: 'page-theme', source: 'parent', nonce, version: pageThemeVersion,
        theme: { scope: 'platform', slug: next.slug }, css: next.css });
    });
    frameTextSizes.set(iframe, size => {
      pendingTextSize = size;
      themePort?.postMessage({ type: 'text-size', source: 'parent', nonce, size });
    });
  }
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
    if (effectivePageTheme) {
      const selected = pendingPageTheme ?? effectivePageTheme;
      themePort.postMessage({ type: 'page-theme', source: 'parent', nonce, version: ++pageThemeVersion,
        theme: { scope: 'platform', slug: selected.slug }, css: selected.css });
      themePort.postMessage({ type: 'text-size', source: 'parent', nonce, size: pendingTextSize });
    }
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
    framePageThemes.delete(iframe);
    frameTextSizes.delete(iframe);
    iframe.style.removeProperty('color-scheme');
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('src');
  };
  frameCleanups.set(iframe, cleanup);
  if (effectivePageTheme) {
    iframe.srcdoc = hostedPage!;
  } else {
    const images = ['/assets/favicon.ico', '/assets/ws-logo.svg'].map(path => new URL(path, location.origin).href).join(' ');
    const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob: ${images}; font-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'`;
    const document = opened.html.replace(/^\s*<!doctype[^>]*>/i, '');
    iframe.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">${buildPageFrameBridge(nonce, theme, opened.permissions.write === true)}${document}`;
  }
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

export async function downloadArtifact(viewer: Pick<ViewerDescriptor, 'title' | 'documentOrigin'>, opened: OpenedArtifact, { filename, pageTheme, mode = 'light', textSize = 'm' }: { filename?: string; pageTheme?: CompiledTheme; mode?: 'light' | 'dark'; textSize?: 's' | 'm' | 'l' } = {}): Promise<void> {
  const source = await readArtifactSource(opened);
  const compiledTheme = opened.page ? pageTheme ?? opened.page.compiledTheme ?? getPlatformTheme(opened.page.theme?.slug ?? 'report') : null;
  const document = compiledTheme
    ? composePageDownload(source, compiledTheme, mode, viewer.documentOrigin ?? location.origin, textSize, opened.page?.lang)
    : source;
  saveBlob(new Blob([document], { type: 'text/html;charset=utf-8' }), filename || `${viewer.title || 'artefact'}.html`);
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
