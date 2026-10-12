/* SolidUI button/dialog designs adapted for Solid 2 and native browser primitives.
 * Source: https://github.com/stefan-karger/solid-ui (apps/docs/src/registry/ui)
 * MIT License. Copyright (c) 2023 shadcn; Copyright (c) 2023 Stefan E-K.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createSignal, createEffect, onSettled, omit, untrack, For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Capabilities, PageProps, TableRow, Version } from './types';

const icons = {
  preview: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  back: 'm10 5-7 7 7 7M3 12h18',
  home: 'm3 10 9-7 9 7v11h-6v-7H9v7H3Z',
  chevron: 'm6 9 6 6 6-6',
  share: 'M12 16V3m-5 5 5-5 5 5M5 13v8h14v-8',
  download: 'M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  exitFullscreen: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
  settings: 'm9 3-1 3-3 1-2 5 2 3 3 1 1 3h6l1-3 3-1 2-5-2-3-3-1-1-3H9Zm7 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5V11Zm7 4v2',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
} as const;

export function Icon(props: { name: keyof typeof icons }) {
  return <svg class="viewer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={1.6} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={icons[props.name]} /></svg>;
}

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  iconOnly?: boolean;
  class?: string;
}
export function Button(props: ButtonProps) {
  return <button {...omit(props, 'variant', 'size', 'iconOnly', 'class')} type={props.type ?? 'button'} class={`button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 button--${props.variant ?? 'primary'} button--${props.size ?? 'md'}${props.iconOnly ? ' button--icon' : ''} ${props.class ?? ''}`} />;
}
export const roleLabel = (role: string | undefined): string => ({ owner: 'Owner', admin: 'Administrator', member: 'Member', manager: 'Manager', editor: 'Editor', viewer: 'Viewer' }[role ?? ''] ?? role ?? '');
export const atLeast = (role: string | undefined, need: string): boolean => ({ viewer: 1, editor: 2, manager: 3, owner: 4 }[role ?? ''] ?? 0) >= ({ viewer: 1, editor: 2, manager: 3, owner: 4 }[need] ?? 99);
export const stamp = (value: unknown): string => String(value ?? '').slice(0, 16).replace('T', ' ');
export const duration = (seconds: unknown): string => {
  const total = Math.max(0, Math.round(Number(seconds ?? 0)));
  return total < 60 ? `${total}s` : total < 3600 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
};
let nextId = 0;
export function Panel(props: { title?: JSX.Element; children: JSX.Element; class?: string }) {
  return <section class={`panel rounded-lg border shadow-sm ${props.class ?? ''}`}>{props.title && <header class="panel-header"><h2>{props.title}</h2></header>}<div class="panel-content">{props.children}</div></section>;
}
export function Feedback(props: { error?: string | null; notice?: string | null }) {
  return <>{props.error && <div class="feedback error" role="alert">{props.error}</div>}{props.notice && <div class="feedback success" role="status">{props.notice}</div>}</>;
}
export interface FieldProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onInput'> {
  label: string;
  value?: string | number;
  multiline?: boolean;
  description?: string;
  rows?: number;
  onChange?: (value: string) => void;
}
export function Field(props: FieldProps) {
  const generatedId = `field-${++nextId}`;
  const id = () => props.id ?? generatedId;
  const rest = omit(props, 'label', 'value', 'multiline', 'description', 'onChange', 'id');
  return <div class="field"><label for={id()}>{props.label}</label>{props.multiline ? <textarea {...rest as JSX.TextareaHTMLAttributes<HTMLTextAreaElement>} id={id()} value={props.value ?? ''} aria-describedby={props.description ? `${id()}-description` : props['aria-describedby']} onInput={event => props.onChange?.(event.currentTarget.value)} /> : <input {...rest} id={id()} type={props.type ?? 'text'} value={props.value ?? ''} aria-describedby={props.description ? `${id()}-description` : props['aria-describedby']} onInput={event => props.onChange?.(event.currentTarget.value)} />}{props.description && <small id={`${id()}-description`}>{props.description}</small>}</div>;
}
export interface ChoiceProps {
  label: string; name?: string; options: Array<[string, string]>; value?: string; required?: boolean; onChange?: (value: string) => void; disabled?: boolean;
}
export function Choice(props: ChoiceProps) {
  const id = `choice-${++nextId}`;
  return <div class="field"><label for={id}>{props.label}</label><select id={id} name={props.name} required={props.required} disabled={props.disabled} value={props.value ?? props.options[0]?.[0] ?? ''} onChange={event => props.onChange?.(event.currentTarget.value)}><For each={props.options}>{option => <option value={option[0]}>{option[1]}</option>}</For></select></div>;
}
export interface CheckProps {
  name?: string; value?: string; children: JSX.Element; onChange?: (checked: boolean) => void; required?: boolean; checked?: boolean; defaultChecked?: boolean; disabled?: boolean;
}
export function Check(props: CheckProps) {
  const id = `check-${++nextId}`;
  return <label class="check" for={id}><input id={id} type="checkbox" name={props.name} value={props.value ?? '1'} checked={props.checked ?? props.defaultChecked ?? false} required={props.required} disabled={props.disabled} onChange={event => props.onChange?.(event.currentTarget.checked)} /><span>{props.children}</span></label>;
}
export interface PostFormProps {
  action?: string; csrf?: string; children?: JSX.Element; submit?: false | string; danger?: boolean; hidden?: Record<string, unknown>; onSubmit?: JSX.EventHandler<HTMLFormElement, SubmitEvent>; class?: string;
}
export function PostForm(props: PostFormProps) {
  return <form class={`stack ${props.class ?? ''}`} method="post" action={props.action} onSubmit={props.onSubmit}><input type="hidden" name="csrf" value={props.csrf ?? ''} /><For each={Object.entries(props.hidden ?? {})}>{entry => <input type="hidden" name={entry[0]} value={entry[1] == null ? '' : String(entry[1])} />}</For>{props.children}{props.submit !== false && <Button type="submit" variant={props.danger ? 'danger' : 'primary'}>{props.submit ?? 'Save'}</Button>}</form>;
}
export function LinkButton(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...omit(props, 'class')} class={`button button--secondary button--md ${props.class ?? ''}`} />;
}
export function DataTable(props: { headers: string[]; rows: TableRow[]; empty?: string }) {
  return <div class="table-wrap"><table><thead><tr><For each={props.headers}>{header => <th>{header}</th>}</For></tr></thead><tbody><For each={props.rows} fallback={<tr><td colspan={props.headers.length}>{props.empty ?? 'Nothing here yet.'}</td></tr>}>{row => <tr><For each={row}>{cell => <td>{cell}</td>}</For></tr>}</For></tbody></table></div>;
}
export function CopyValue(props: { value: string; label?: string }) {
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal('');
  return <div class="stack"><div class="copy"><Field label={props.label ?? 'Value'} value={props.value} readonly /><Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(props.value); setCopied(true); setError(''); } catch { setError('Copy failed. Select and copy the value manually.'); } }}>{copied() ? 'Copied' : 'Copy'}</Button></div><Feedback error={error()} /></div>;
}
export function Dialog(props: { title: string; open: boolean; onOpenChange: (open: boolean) => void; children: JSX.Element }) {
  const id = `dialog-${++nextId}`;
  let element!: HTMLDialogElement;
  let returnFocus: HTMLElement | null = null;
  createEffect(() => props.open, open => {
    if (open && !element.open) { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; element.showModal(); }
    else if (!open && element.open) element.close();
  });
  onSettled(() => () => { if (element.open) element.close(); });
  return <dialog ref={element} aria-labelledby={id} class="dialog-content grid gap-4 border p-6 shadow-lg sm:rounded-lg" onCancel={event => { event.preventDefault(); props.onOpenChange(false); }} onClose={() => { props.onOpenChange(false); if (returnFocus?.isConnected) returnFocus.focus(); }} onClick={event => { if (event.target !== element) return; const rect = element.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onOpenChange(false); }}><header class="dialog-header"><h2 id={id} class="text-lg font-semibold leading-none tracking-tight">{props.title}</h2><Button variant="ghost" aria-label="Close dialog" onClick={() => props.onOpenChange(false)}>×</Button></header>{props.children}</dialog>;
}
export function Menu(props: { label: string; trigger: JSX.Element; children: JSX.Element; class?: string; align?: 'start' | 'end' }) {
  const id = `menu-${++nextId}`;
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [expanded, setExpanded] = createSignal(false);
  const items = () => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
  const focus = (last = false) => { const list = items(); (last ? list.at(-1) : list[0])?.focus(); };
  const close = () => { menu.hidePopover(); trigger.focus(); };
  const activate = () => {
    if (menu.matches(':popover-open')) { close(); return; }
    menu.showPopover();
    const rect = trigger.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width;
    const height = menu.getBoundingClientRect().height;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(props.align === 'end' ? rect.right - width : rect.left, window.innerWidth - width - 8))}px`;
    focus();
  };
  return <><Button ref={trigger} variant="ghost" class={props.class} aria-label={props.label} aria-haspopup="menu" aria-controls={id} aria-expanded={(expanded()) ? 'true' : 'false'} onClick={activate} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!menu.matches(':popover-open')) activate(); focus(event.key === 'ArrowUp'); } }} >{props.trigger}</Button><div ref={menu} id={id} popover="auto" role="menu" aria-label={props.label} class="menu-content rounded-md border p-1 shadow-md" onToggle={() => setExpanded(menu.matches(':popover-open'))} onClick={event => { if ((event.target as Element).closest('[role="menuitem"]:not(:disabled)')) close(); }} onKeyDown={event => { const list = items(); const index = list.indexOf(document.activeElement as HTMLElement); if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const target = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; list[target]?.focus(); } else if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(); } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { const ordered = [...list.slice(index + 1), ...list.slice(0, index + 1)]; ordered.find(item => item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()))?.focus(); } }}>{props.children}</div></>;
}
export function MenuItem(props: { children: JSX.Element; onSelect?: () => void; disabled?: boolean }) {
  return <button type="button" role="menuitem" tabindex={-1} disabled={props.disabled} onClick={event => { const menu = event.currentTarget.closest<HTMLElement>('[popover]'); menu?.hidePopover(); document.querySelector<HTMLElement>(`[aria-controls="${menu?.id}"]`)?.focus(); props.onSelect?.(); }}>{props.children}</button>;
}
export function MenuLink(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props} role="menuitem" tabindex={-1} />; }
export function Sections(props: { items: Array<[string, string, JSX.Element]> }) {
  const id = `sections-${++nextId}`;
  const remembered = (() => { try { return location.hash.slice(1) || sessionStorage.getItem(`wsa-tab:${location.pathname}`); } catch { return location.hash.slice(1); } })();
  const [active, setActive] = createSignal(props.items.some(item => item[0] === remembered) ? remembered! : props.items[0]?.[0] ?? '');
  const select = (value: string) => { setActive(value); history.replaceState(history.state, '', `#${value}`); try { sessionStorage.setItem(`wsa-tab:${location.pathname}`, value); } catch { /* Storage may be disabled. */ } };
  onSettled(() => { const hashChanged = () => { const value = location.hash.slice(1); if (props.items.some(item => item[0] === value)) setActive(value); }; window.addEventListener('hashchange', hashChanged); return () => window.removeEventListener('hashchange', hashChanged); });
  return <div class="sections"><div class="tabs" role="tablist" aria-label="Sections"><For each={props.items}>{item => <button type="button" id={`${id}-${item[0]}-tab`} role="tab" aria-selected={(active() === item[0]) ? 'true' : 'false'} aria-controls={`${id}-${item[0]}-panel`} tabindex={active() === item[0] ? 0 : -1} onClick={() => select(item[0])} onKeyDown={event => { const index = props.items.findIndex(candidate => candidate[0] === item[0]); const target = event.key === 'Home' ? 0 : event.key === 'End' ? props.items.length - 1 : event.key === 'ArrowRight' ? (index + 1) % props.items.length : event.key === 'ArrowLeft' ? (index + props.items.length - 1) % props.items.length : -1; if (target >= 0) { event.preventDefault(); const next = props.items[target]; if (next) { select(next[0]); document.getElementById(`${id}-${next[0]}-tab`)?.focus(); } } }}>{item[1]}</button>}</For></div><For each={props.items}>{item => <section id={`${id}-${item[0]}-panel`} role="tabpanel" aria-labelledby={`${id}-${item[0]}-tab`} hidden={active() !== item[0]} tabindex={0}>{item[2]}</section>}</For></div>;
}
export function Navigation(props: { sections: Array<[string, string]> }) { return <nav class="section-nav" aria-label="Console"><For each={props.sections}>{item => <a href={item[1]} aria-current={location.pathname === item[1] ? 'page' : undefined}>{item[0]}</a>}</For></nav>; }
export function DeleteArtifact(props: { base: string; csrf: string }) {
  const [open, setOpen] = createSignal(false);
  return <><Button variant="danger" onClick={() => setOpen(true)}>Delete artefact</Button><Dialog title="Permanently delete artefact?" open={open()} onOpenChange={setOpen}><p>This removes the content, retained versions and personal/shared application data. Existing links stop working and remain reserved. This cannot be undone.</p><PostForm action={`${props.base}/delete`} csrf={props.csrf} submit="Permanently delete" danger><Check name="confirm" value="delete" required>Delete this artefact and all its application data permanently.</Check></PostForm></Dialog></>;
}
/** Only an empty folder can be deleted (ADR 0033): blockers replace the action; project data is counted in the confirmation. */
export function DeleteFolder(props: { base: string; csrf: string; contents?: PageProps['folderContents'] }) {
  const [open, setOpen] = createSignal(false);
  const held = untrack(() => props.contents) ?? { subfolders: 0, artefacts: 0, unpublished: 0, collections: 0, records: 0, responses: 0 };
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const blockers = ([[held.subfolders, 'subfolder'], [held.artefacts, 'artefact'], [held.unpublished, 'unpublished artefact']] as const).filter(([n]) => n > 0).map(([n, noun]) => count(n, noun));
  if (blockers.length) return <><p>This folder still contains {blockers.join(' and ')}. Only an empty folder can be deleted: move or delete them first.</p><Button variant="danger" disabled>Delete folder</Button></>;
  return <><Button variant="danger" onClick={() => setOpen(true)}>Delete folder</Button><Dialog title="Permanently delete folder?" open={open()} onOpenChange={setOpen}><p>The folder is removed, its visitor shares are revoked and direct colleague access to it ends. Its private paths stop working and remain reserved. This cannot be undone.</p>{held.collections > 0 && <p class="feedback error" role="alert">Its project data will be permanently deleted: {count(held.collections, 'collection')} with {count(held.records, 'record')} and {count(held.responses, 'response')}.</p>}<PostForm action={`${props.base}/delete`} csrf={props.csrf} submit="Permanently delete" danger><Check name="confirm" value="delete" required>{held.collections > 0 ? 'Delete this folder and its project data permanently.' : 'Delete this folder permanently.'}</Check></PostForm></Dialog></>;
}
export function VersionHistory(props: { versions?: Version[]; base: string; csrf: string; write?: boolean; currentVersion?: number }) {
  const [restoreVersion, setRestoreVersion] = createSignal<number | null>(null);
  return <><DataTable headers={['Version', 'Published', 'Size', 'By', 'Note', 'Actions']} rows={(props.versions ?? []).map(version => [<span>v{version.version}{version.version === props.currentVersion ? ' · Live' : ''}</span>, stamp(version.createdAt), `${version.size ?? 0} B`, version.authorType === 'api_key' ? 'API' : 'Console', version.note || '—', <div class="row"><a href={`${props.base}/download?version=${version.version}`}>Download</a>{props.write && version.version !== props.currentVersion && <Button variant="secondary" onClick={() => setRestoreVersion(version.version)}>Restore as new version</Button>}</div>])} /><Dialog title={`Restore version ${restoreVersion() ?? ''}?`} open={restoreVersion() !== null} onOpenChange={open => { if (!open) setRestoreVersion(null); }}><p>This publishes the retained source as a new live version. Personal and shared application data stay unchanged.</p><PostForm action={`${props.base}/restore`} csrf={props.csrf} hidden={{ version: restoreVersion() }} submit="Restore version" /></Dialog></>;
}
export async function postJSON(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // All callers use the same-origin Worker's JSON mutation envelope.
  const data = await response.json() as Record<string, unknown> & { error?: { code?: unknown; message?: unknown } };
  if (!response.ok || data?.error) {
    const error = new Error(typeof data?.error?.message === 'string' ? data.error.message : 'The request failed.');
    throw Object.assign(error, { code: typeof data?.error?.code === 'string' ? data.error.code : '' });
  }
  return data;
}
export type { Capabilities };
