import { createSignal } from 'solid-js';
import type { BootstrapPayload } from './types';

export interface PageState extends BootstrapPayload { url: string; title: string }
const bootstrap = document.getElementById('ws-bootstrap');
if (!bootstrap?.textContent) throw new Error('Artefacts67 bootstrap data is missing.');
const initial = JSON.parse(bootstrap.textContent) as BootstrapPayload;
bootstrap.remove();
export const [page, setPage] = createSignal<PageState>({ ...initial, url: location.href, title: document.title });
export const [navigationError, setNavigationError] = createSignal('');
const consoleScreens: Record<string, true> = { appHome: true, appNew: true, appFolderNew: true, folderPane: true, artefactPane: true, artefactReader: true, settings: true, keys: true, adminHome: true, users: true, platformSettings: true, reports: true, shell: true };
export function consoleIdentity(current: BootstrapPayload): string | undefined {
  return Object.hasOwn(consoleScreens, current.screen) ? current.props.me?.id : undefined;
}
let pending: AbortController | undefined;
// Claim ownership when a request starts, even before its URL reaches history.
let navigationGeneration = 0;

function readPage(html: string, url: string): PageState {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const data = document.getElementById('ws-bootstrap')?.textContent;
  if (!data) throw new Error('The server did not return a console page.');
  const payload = JSON.parse(data) as BootstrapPayload;
  if (typeof payload.screen !== 'string' || !payload.props || typeof payload.props !== 'object') throw new Error('The server returned invalid console data.');
  return { ...payload, url, title: document.title };
}
async function applyResponse(response: Response, requested: URL, replace: boolean, generation: number, mutation?: { url: string; form: HTMLFormElement }, estateFor?: string): Promise<void> {
  const mutationFrom = mutation?.url;
  const final = new URL(response.url || requested.href);
  if (final.origin !== location.origin) throw new Error('Navigation to a different origin is not allowed.');
  if (!final.hash && final.pathname === requested.pathname) final.hash = requested.hash;
  const html = await response.text();
  if (generation !== navigationGeneration || (mutationFrom && location.href !== mutationFrom)) return;
  const next = readPage(html, final.href);
  const previous = page();
  if (next.props.estateOmitted === true) {
    if (mutationFrom || !estateFor || !previous.props.estate || consoleIdentity(previous) !== estateFor || consoleIdentity(next) !== estateFor) {
      throw new Error('The server omitted the sidebar without a matching authenticated console.');
    }
    next.props.estate = previous.props.estate;
    delete next.props.estateOmitted;
  }
  // A rendered POST response is not a GET route; keep the refreshable page URL.
  if (mutationFrom && !response.redirected) {
    const hash = final.hash;
    final.href = mutationFrom;
    if (hash) final.hash = hash;
    next.url = final.href;
  }
  if (!final.hash && next.screen === previous.screen && requested.hash) {
    final.hash = requested.hash;
    next.url = final.href;
  }
  const preserveScroll = previous.url.split('#')[0] === next.url.split('#')[0];
  history[replace ? 'replaceState' : 'pushState'](null, '', final.href);
  document.title = next.title;
  if (mutation && response.ok && !next.props.error) mutation.form.closest<HTMLDialogElement>('dialog')?.close();
  setNavigationError('');
  setPage(next);
  if (!preserveScroll) window.scrollTo(0, 0);
}
export async function navigate(url: string, options: { replace?: boolean; refresh?: boolean } = {}): Promise<void> {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin) throw new Error('Only same-origin console navigation is supported.');
  const generation = ++navigationGeneration;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  try {
    const current = page();
    const identity = consoleIdentity(current);
    const headers: Record<string, string> = { Accept: 'text/html' };
    if (!options.refresh && identity && current.props.estate && /^\/settings(?:\/keys)?\/?$/.test(target.pathname)) {
      headers['X-WS-Console-Estate'] = identity;
    }
    const response = await fetch(target, { headers, cache: 'no-store', signal: controller.signal });
    if (controller.signal.aborted) return;
    await applyResponse(response, target, options.replace ?? false, generation, undefined, headers['X-WS-Console-Estate']);
  } catch (error) {
    if (controller.signal.aborted || generation !== navigationGeneration) return;
    setNavigationError(error instanceof Error ? error.message : 'Navigation failed.');
    throw error;
  } finally { if (pending === controller) pending = undefined; }
}
export async function refreshPage(): Promise<void> { await navigate(location.href, { replace: true, refresh: true }); }

export function installNavigation(): () => void {
  const submitting = new WeakSet<HTMLFormElement>();
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const target = new URL(link.href, location.href);
    if (target.origin !== location.origin || !['http:', 'https:'].includes(target.protocol)) return;
    // Public guides and files have no console bootstrap; keep native navigation.
    if (!/^\/(?:app|settings|admin|login|register|invite|2fa|enroll)(?:\/|$)/.test(target.pathname) || /\/(download|export)(?:\/|$)/.test(target.pathname)) return;
    if (target.pathname === location.pathname && target.search === location.search && target.hash) return;
    event.preventDefault();
    void navigate(target.href).catch(() => {});
  };
  const onSubmit = (event: SubmitEvent) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    const submitter = event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement ? event.submitter : null;
    const target = new URL(submitter?.getAttribute('formaction') || form.action || location.href, location.href);
    const method = (submitter?.getAttribute('formmethod') || form.method || 'get').toLowerCase();
    if (target.origin !== location.origin || (form.target && form.target !== '_self') || !['post', 'get'].includes(method)) return;
    event.preventDefault();
    if (submitting.has(form)) return;
    const body = new URLSearchParams();
    for (const [key, value] of new FormData(form, submitter)) {
      if (typeof value !== 'string') { setNavigationError('This form does not support file uploads.'); return; }
      body.append(key, value);
    }
    if (method === 'get') { target.search = body.toString(); void navigate(target.href).catch(() => {}); return; }
    if (!target.hash) target.hash = location.hash;
    submitting.add(form);
    if (submitter) submitter.disabled = true;
    // Never retry POST automatically: a dropped response can still have committed.
    void (async () => {
      const generation = ++navigationGeneration;
      const readerUrl = location.href;
      try {
        pending?.abort();
        const mutationInReader = ['artefactReader', 'artifactViewer'].includes(page().screen) && /\/(meta|subfolder)$/.test(target.pathname);
        const response = await fetch(target, { method: 'POST', headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
        if (mutationInReader) {
          const html = await response.text();
          if (generation !== navigationGeneration || location.href !== readerUrl) return;
          const result = readPage(html, response.url);
          if (!response.ok || result.props.error) throw new Error(result.props.error || 'The request failed.');
          form.closest<HTMLDialogElement>('dialog')?.close();
          await navigate(readerUrl, { replace: true, refresh: true });
        } else await applyResponse(response, target, true, generation, { url: readerUrl, form });
      } catch (error) {
        if (generation === navigationGeneration && location.href === readerUrl) setNavigationError(error instanceof Error ? error.message : 'The request failed. Check the current state before trying again.');
      }
      finally { submitting.delete(form); if (submitter?.isConnected) submitter.disabled = false; }
    })();
  };
  const onPopState = () => { void navigate(location.href, { replace: true }).catch(() => {}); };
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  window.addEventListener('popstate', onPopState);
  return () => { ++navigationGeneration; pending?.abort(); document.removeEventListener('click', onClick); document.removeEventListener('submit', onSubmit); window.removeEventListener('popstate', onPopState); };
}
