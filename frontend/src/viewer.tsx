import { createEffect, createSignal, onSettled, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { duplicateArtifact, downloadArtifact, mountArtifactFrame, openArtifact, readArtifactSource, reportArtifact, setArtifactFramePageTheme, setArtifactFrameTextSize, setArtifactFrameTheme, type ArtifactTheme } from './artifact-runtime';
import { usePreference } from './shell';
import { PLATFORM_THEMES } from './platform-themes';
import { navigate } from './navigation';
import { Button, Check, Choice, CopyValue, Dialog, Feedback, Field, Icon, LinkButton, Menu, MenuItem, MenuLink, Panel, PostForm, VersionHistory } from './ui';
import type { Capabilities, Destination, OpenedArtifact, ViewerDescriptor } from './types';

const shareScope = (viewer: ViewerDescriptor | null): string | null => {
  const runtime = viewer?.runtime;
  return runtime?.kind === 'share' ? `share:${String(runtime.path ?? '')}|${String(runtime.token ?? '')}` : null;
};

const sourceIdentity = (viewer: ViewerDescriptor | null): string => {
  if (!viewer) return 'none';
  const runtime = viewer.runtime;
  const source = runtime ? {
    kind: runtime.kind ?? '',
    artifactId: runtime.artifactId ?? '',
    path: runtime.path ?? '',
    token: runtime.token ?? '',
  } : {
    artifactRef: viewer.artifactRef ?? '',
    loadUrl: viewer.loadUrl ?? '',
    gateUrl: viewer.gateUrl ?? '',
  };
  return JSON.stringify({
    mode: viewer.mode ?? '',
    gated: Boolean(viewer.gated),
    version: viewer.currentVersion ?? null,
    source,
  }) ?? '';
};

export interface DuplicateViewer extends ViewerDescriptor {
  title?: string;
  protected?: boolean;
  folders?: Destination[];
}

export function DuplicateForm(props: { viewer: DuplicateViewer; opened?: OpenedArtifact | null; onSuccess?: (result: Record<string, unknown>) => void }) {
  const [choice, setChoice] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const protectedSource = () => Boolean(props.viewer.protected || props.viewer.gated);
  const folders = () => props.viewer.folders ?? [];

  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }): Promise<void> {
    if (!choice()) { event.preventDefault(); setError('Choose whether the copy requires a new password.'); return; }
    if (props.viewer.actionBase && !props.opened) return;
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = event.currentTarget;
    const viewer = props.viewer;
    const opened = props.opened;
    const formData = new FormData(form);
    try {
      const result = await duplicateArtifact(viewer, opened, { folderId: formData.get('folderId') || '', title: formData.get('title'), slug: formData.get('slug') || '', password: choice() === 'password' ? formData.get('password') : '', csrf: viewer.csrf });
      const destination = result.url;
      if (typeof destination !== 'string') throw new Error('The duplicate returned an invalid destination.');
      const url = new URL(destination, location.origin);
      if (url.origin !== location.origin) throw new Error('The duplicate returned an invalid destination.');
      if (props.onSuccess) props.onSuccess(result); else await navigate(url.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The duplicate failed.');
      setBusy(false);
    }
  }

  return <PostForm action={props.viewer.actionBase ? `${props.viewer.actionBase}/duplicate` : undefined} csrf={props.viewer.csrf} submit={false} onSubmit={submit}>
    <p>The copy stays private. Copy the current HTML only. Shares, colleague grants, API keys, prior versions and personal/shared application data are not copied.</p>
    <Feedback error={error()} />
    <Field name="title" label="Title" value={`${props.viewer.title || 'Artefact'} (copy)`} required />
    <Choice name="folderId" label="Destination" options={[['', 'My estate (unfiled)'], ...folders().map(folder => [folder.id, `${folder.name ?? folder.displayName ?? folder.id}${folder.ownerName ? ` · ${folder.ownerName}` : ''}`] as [string, string])]} />
    <Field name="slug" label="Path (optional)" />
    <Choice label="Additional protection for the private copy" value="" options={[['', 'Choose protection'], ['password', 'Require a new password'], ['link', 'No additional password (still private)']]} onChange={setChoice} />
    {protectedSource() && <p class="callout">The source password will not be copied. Choose a new password or keep the copy private without an additional password.</p>}
    {choice() === 'password' ? <Field name="password" label="New password for the copy" type="password" required autocomplete="new-password" /> : <input type="hidden" name="password" value="" />}
    {choice() === 'link' && <p class="callout">The copy requires authorized sign-in. To give external readers access, create a visitor share after duplicating.</p>}
    <Button type="submit" disabled={busy() || !choice()}>{busy() ? 'Duplicating…' : 'Create duplicate'}</Button>
  </PostForm>;
}

function DataStatus(props: { data: NonNullable<ViewerDescriptor['data']> }) {
  let panel!: HTMLDivElement;
  const [expanded, setExpanded] = createSignal(false);
  const place = (event: ToggleEvent): void => {
    const open = event.newState === 'open';
    setExpanded(open);
    if (!open) return;
    const rect = (panel.previousElementSibling as HTMLElement).getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
    panel.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  };
  return <>
    <Button variant="ghost" size="sm" class="viewer-data" aria-label="Project data" title="Project data" aria-expanded={expanded() ? 'true' : 'false'} popovertarget="viewer-data-popover"><Icon name="database" /><span class="viewer-data-label">Data</span></Button>
    <div ref={panel} id="viewer-data-popover" popover="auto" role="group" aria-label="Project data" class="menu-content viewer-data-panel" onToggle={place}>
      <p class="viewer-data-title">Project data</p>
      <ul>{props.data.collections.map(collection => <li><span>{collection.name}</span><span class="viewer-data-kind">{collection.kind}</span></li>)}</ul>
    </div>
  </>;
}

const dialogTitles: Record<string, string> = { share: 'Share this artefact', duplicate: 'Duplicate artefact', report: 'Report this artefact', history: 'Version history', rename: 'Rename artefact', delete: 'Delete artefact' };

export function ArtifactViewer(props: { viewer: ViewerDescriptor | null; title?: string }) {
  const initialViewer = untrack(() => props.viewer);
  const [viewer, setViewer] = createSignal<ViewerDescriptor | null>(initialViewer);
  const [opened, setOpened] = createSignal<OpenedArtifact | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [dialog, setDialog] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const [password, setPassword] = createSignal('');
  const [submitted, setSubmitted] = createSignal<string | null>(null);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [sourceDocument, setSourceDocument] = createSignal<OpenedArtifact | null>(null);
  const [frameElement, setFrameElement] = createSignal<HTMLIFrameElement | undefined>(undefined);
  // One explicit reader choice for every artefact; without one, the system preference.
  const [storedTheme, setStoredTheme] = usePreference<ArtifactTheme | null>('wsa-artefact-theme', null);
  const [storedPageTheme, setStoredPageTheme] = usePreference<string | null>('wsa-page-theme', null);
  const [textSize, setTextSize] = usePreference<'s' | 'm' | 'l'>('wsa-page-text-size', 'm');
  const systemScheme = matchMedia('(prefers-color-scheme: dark)');
  const [systemTheme, setSystemTheme] = createSignal<ArtifactTheme>(systemScheme.matches ? 'dark' : 'light');
  const theme = (): ArtifactTheme => { const chosen = storedTheme(); return chosen === 'light' || chosen === 'dark' ? chosen : systemTheme(); };
  const pageThemeSlug = (): string | null => {
    const current = opened();
    if (!current?.page) return null;
    const assigned = current.page.theme?.scope === 'platform' ? current.page.theme.slug : 'report';
    const selected = current.page.brandLock ? assigned : storedPageTheme() ?? assigned;
    return PLATFORM_THEMES.find(item => item.slug === selected)?.slug ?? assigned;
  };
  const pageTheme = () => {
    const current = opened();
    const selected = pageThemeSlug();
    if (current?.page?.compiledTheme && selected === (current.page.theme?.scope === 'platform' ? current.page.theme.slug : 'report')) return current.page.compiledTheme;
    return PLATFORM_THEMES.find(item => item.slug === selected) ?? null;
  };
  const [themed, setThemed] = createSignal(false);
  const passwords = new Map<string, string>();
  let surface: HTMLElement | undefined;
  let initialSource = sourceIdentity(initialViewer);

  const title = () => viewer()?.title ?? props.title ?? 'Artefact';
  const caps = (): Capabilities => viewer()?.permissions ?? {};
  const base = () => viewer()?.actionBase;
  const codeView = () => {
    const current = opened();
    return Boolean(current && sourceDocument() === current);
  };
  const canShare = () => {
    const current = viewer();
    const permissions = current?.permissions ?? {};
    return Boolean(current?.publicUrl && (!current.actionBase || permissions.write || permissions.manage || permissions.own));
  };
  const isIndex = () => viewer()?.mode === 'index' || Boolean(opened()?.index);
  const accessLabel = () => {
    const permissions = caps();
    return permissions.own ? 'Owner' : permissions.manage ? 'Manager' : permissions.write ? 'Editor' : 'Viewer';
  };
  const selectedChild = () => sourceIdentity(viewer()) !== sourceIdentity(props.viewer);

  createEffect(
    () => props.viewer,
    (incoming) => {
      const nextSource = sourceIdentity(incoming);
      const selectedSource = sourceIdentity(viewer());
      if (nextSource !== initialSource || selectedSource === initialSource) {
        setViewer(incoming);
        if (selectedSource !== nextSource) {
          setOpened(null);
          setSourceDocument(null);
          setSubmitted(null);
          setPassword('');
          setNotice('');
          setDialog(null);
          setError('');
          setAttempt(value => value + 1);
        }
      }
      initialSource = nextSource;
    },
  );

  onSettled(() => {
    const change = (): void => { setFullscreen(Boolean(document.fullscreenElement)); };
    document.addEventListener('fullscreenchange', change);
    change();
    return () => document.removeEventListener('fullscreenchange', change);
  });

  onSettled(() => {
    const change = (): void => { setSystemTheme(systemScheme.matches ? 'dark' : 'light'); };
    systemScheme.addEventListener('change', change);
    return () => systemScheme.removeEventListener('change', change);
  });

  createEffect(
    () => attempt(),
    () => {
      const current = viewer();
      const supplied = submitted();
      if (!current) {
        setError('The viewer is unavailable.');
        setLoading(false);
        return;
      }
      if (current.gated && supplied === null) {
        setLoading(false);
        setOpened(null);
        return;
      }
      const abort = new AbortController();
      const scope = shareScope(current);
      setLoading(true);
      setError('');
      setOpened(null);
      void openArtifact(current, { password: supplied ?? undefined, signal: abort.signal }).then(value => {
        if (abort.signal.aborted) return;
        if (current.gated && typeof supplied === 'string' && scope) passwords.set(scope, supplied);
        setOpened(value);
        setLoading(false);
        setPassword('');
      }).catch(cause => {
        if (abort.signal.aborted) return;
        const code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
        if (code === 'wrong' || code === 'password-required') {
          if (scope) passwords.delete(scope);
          setSubmitted(null);
          setPassword('');
        }
        setError(cause instanceof Error ? cause.message : 'Unable to open this artefact.');
        setLoading(false);
      });
      return () => abort.abort();
    },
  );

  createEffect(
    () => opened(),
    () => { setSourceDocument(null); },
  );

  createEffect(
    () => ({ artifact: opened(), frame: frameElement() }),
    ({ artifact, frame }) => {
      setThemed(false);
      if (!artifact || artifact.index || !frame || !frame.isConnected) return;
      try {
        return mountArtifactFrame(frame, artifact, { onError: cause => setError(cause.message), theme: theme(), pageTheme: pageTheme() ?? undefined, textSize: textSize(), origin: viewer()?.documentOrigin ?? location.origin, onThemeSupport: () => setThemed(true) });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to mount the artefact.');
      }
    },
  );

  createEffect(
    () => ({ frame: frameElement(), scheme: theme() }),
    ({ frame, scheme }) => { if (frame) setArtifactFrameTheme(frame, scheme); },
  );
  createEffect(
    () => ({ frame: frameElement(), artifact: opened(), selected: pageTheme() }),
    ({ frame, artifact, selected }) => { if (frame && artifact?.page && selected) setArtifactFramePageTheme(frame, selected); },
  );

  createEffect(
    () => ({ frame: frameElement(), artifact: opened(), size: textSize() }),
    ({ frame, artifact, size }) => { if (frame && artifact?.page) setArtifactFrameTextSize(frame, size); },
  );

  function select(child: ViewerDescriptor | null): void {
    const scope = shareScope(child);
    const remembered = scope ? passwords.get(scope) : undefined;
    setOpened(null);
    setError('');
    setNotice('');
    setDialog(null);
    setViewer(child);
    setSubmitted(child?.gated && typeof remembered === 'string' ? remembered : null);
    setPassword('');
    setSourceDocument(null);
    setAttempt(value => value + 1);
  }

  async function action(run: () => Promise<void>): Promise<void> {
    setError('');
    setBusy(true);
    try { await run(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The action failed.'); } finally { setBusy(false); }
  }

  const toggleFullscreen = (): void => {
    void action(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (surface) await surface.requestFullscreen();
    });
  };
  const showCode = (): void => {
    void action(async () => {
      const current = opened();
      if (!current) return;
      await readArtifactSource(current);
      if (opened() === current) setSourceDocument(current);
    });
  };
  const copySource = (): void => {
    void action(async () => {
      const current = opened();
      if (!current) return;
      const source = await readArtifactSource(current);
      if (opened() !== current) return;
      try {
        await navigator.clipboard.writeText(source);
        setNotice('HTML copied.');
      } catch {
        setSourceDocument(current);
        setNotice('Clipboard access is unavailable. Select and copy the HTML from the code view.');
      }
    });
  };

  const menu = (): JSX.Element => <Menu label="Artefact actions" trigger={<><span>{title()}</span><Icon name="chevron" /></>} class="viewer-title-button" align="start">
    {base() && <MenuItem disabled>Your access: {accessLabel()}</MenuItem>}
    {!isIndex() && <MenuItem disabled={!opened() || busy()} onSelect={copySource}>Copy HTML</MenuItem>}
    <hr role="separator" />
    <MenuItem disabled={loading()} onSelect={() => { setOpened(null); setAttempt(value => value + 1); }}>Refresh</MenuItem>
    {!isIndex() && viewer()?.signedIn && <MenuItem disabled={!opened()} onSelect={() => setDialog('duplicate')}>Duplicate</MenuItem>}
    {base() && viewer()?.versions && <MenuItem onSelect={() => setDialog('history')}>Version history</MenuItem>}
    {base() && caps().write && <MenuItem onSelect={() => setDialog('rename')}>Rename</MenuItem>}
    {base() && <MenuLink href={base() ?? ''}>Artefact settings</MenuLink>}
    {base() && caps().write && <MenuLink href={`${base() ?? ''}#password`}>Password options</MenuLink>}
    {base() && <MenuLink href={`${base() ?? ''}/preview`} target="_blank" rel="noopener">Open in a new tab</MenuLink>}
    {viewer()?.signedIn && <MenuLink href="/app">All artefacts</MenuLink>}
    <hr role="separator" />
    {!isIndex() && <MenuItem disabled={!opened()} onSelect={() => setDialog('report')}>Report</MenuItem>}
    <MenuLink href="/instructions" target="_blank" rel="noopener">Learn about artefacts</MenuLink>
    {base() && caps().own && <><hr role="separator" /><MenuItem onSelect={() => setDialog('delete')}>Delete artefact</MenuItem></>}
  </Menu>;

  return <section class="viewer" ref={element => { surface = element; }}>
    <header class="viewer-bar">
      <div class="viewer-identity">
        {selectedChild() && <Button variant="ghost" size="sm" class="viewer-icon-button" aria-label="Back to folder" title="Back to folder" onClick={() => select(props.viewer)}><Icon name="back" /></Button>}
        <a class="viewer-home" href={viewer()?.signedIn ? '/app' : '/'} aria-label="Artefacts67 home" title="Artefacts67 home"><svg viewBox="0 0 64 64" width="18" height="18" aria-hidden="true"><path fill="#ea9423" fill-rule="evenodd" d="M32 5 59 21 32 37 5 21ZM32 15 21.875 21 32 27 42.125 21Z" /><path fill="currentColor" d="m8 33 24 14 24-14v10L32 57 8 43Z" /></svg></a>
        <h1 class="sr-only">{title()}</h1>
        {menu()}
      </div>
      <div class="viewer-actions">
        {viewer()?.data && <DataStatus data={viewer()!.data!} />}
        {opened()?.page && <div class="viewer-page-controls">
          <Choice label="Theme" options={PLATFORM_THEMES.map(item => [item.slug, item.name])} value={pageTheme()?.slug ?? 'report'}
            disabled={opened()?.page?.brandLock || busy()} onChange={setStoredPageTheme} />
          <Choice label="Text size" options={ [['s', 'S'], ['m', 'M'], ['l', 'L']] } value={textSize()} onChange={value => { if (value === 's' || value === 'm' || value === 'l') setTextSize(value); }} />
        </div>}
        {!isIndex() && <div class="viewer-modes" role="group" aria-label="Artefact view">
          <Button variant="ghost" size="sm" iconOnly aria-label="Preview" title="Preview" aria-pressed={(!codeView()) ? 'true' : 'false'} disabled={!opened() || busy()} onClick={() => setSourceDocument(null)}><Icon name="preview" /></Button>
          <Button variant="ghost" size="sm" iconOnly aria-label="Code" title="Code" aria-pressed={(codeView()) ? 'true' : 'false'} disabled={!opened() || busy()} onClick={showCode}><Icon name="code" /></Button>
        </div>}
        {canShare() && <Button variant="ghost" size="sm" iconOnly class="viewer-icon-button" aria-label="Share" title="Share and copy link" onClick={() => setDialog('share')}><Icon name="share" /></Button>}
        {!isIndex() && <Button variant="ghost" size="sm" iconOnly class="viewer-icon-button" aria-label="Download HTML" title="Download HTML only — application data is not included" disabled={!opened() || busy()} onClick={() => { const current = opened(); const currentViewer = viewer(); if (current) void action(() => downloadArtifact(currentViewer ?? {}, current, { filename: `${title().replace(/[^a-z0-9 _.-]/gi, '_') || 'artefact'}.html`, pageTheme: pageTheme() ?? undefined, mode: theme(), textSize: textSize() })); }}><Icon name="download" /></Button>}
        {!isIndex() && themed() && !codeView() && <Button variant="ghost" size="sm" iconOnly class="viewer-icon-button" aria-label="Dark appearance" title="Dark appearance" aria-pressed={theme() === 'dark' ? 'true' : 'false'} onClick={() => setStoredTheme(theme() === 'dark' ? 'light' : 'dark')}><Icon name={theme() === 'dark' ? 'sun' : 'moon'} /></Button>}
        <Button variant="ghost" size="sm" iconOnly class="viewer-icon-button" aria-label={fullscreen() ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen() ? 'Exit fullscreen' : 'Fullscreen'} aria-pressed={fullscreen() ? 'true' : 'false'} onClick={toggleFullscreen}><Icon name={fullscreen() ? 'exitFullscreen' : 'fullscreen'} /></Button>
      </div>
    </header>
    <Feedback error={error()} notice={notice()} />
    {loading() && <div class="viewer-state" role="status"><span class="spinner" aria-hidden="true" />Opening artefact…</div>}
    {!opened() && !loading() && viewer()?.gated && <div class="viewer-state"><Panel title="Enter the password"><p>{viewer()?.runtime?.kind === 'share' ? 'This visitor share requires its password before content is released.' : 'This private link requires authorized sign-in and this additional document password.'} The password is never stored in your browser preferences.</p><form class="stack" onSubmit={event => { event.preventDefault(); setSubmitted(password()); setAttempt(value => value + 1); }}><Field label="Password" type="password" name="password" required autofocus onChange={setPassword} /><Button type="submit">Unlock</Button></form></Panel></div>}
    {!opened() && !loading() && !viewer()?.gated && error() && <div class="viewer-state"><Button onClick={() => setAttempt(value => value + 1)}>Try again</Button></div>}
    {opened()?.index && <div class="viewer-index"><Panel title="Shared artefacts">{opened()?.index?.length ? <ul class="index-list">{opened()?.index?.map((item, index) => <li><Button variant="secondary" onClick={() => select(item.viewer)}>{item.title}</Button></li>)}</ul> : <p>No artefacts are currently available through this link.</p>}</Panel></div>}
    {opened() && !opened()?.index && <><iframe ref={setFrameElement} title={title()} class="artifact-frame" hidden={codeView()} sandbox="allow-scripts" referrerpolicy="no-referrer" /><>{codeView() && <section class="artifact-code" aria-label="Artefact source code" tabindex={0}><pre><code>{opened()?.html}</code></pre></section>}</></>}
    <Dialog title={dialogTitles[dialog() ?? ''] ?? 'Artefact'} open={Boolean(dialog())} onOpenChange={open => { if (!open) setDialog(null); }}>
      <Feedback error={error()} />
      {dialog() === 'share' && <div class="stack">{viewer()?.runtime?.kind === 'share' ? <><p>This visitor share link grants access only within its existing scope. It can be forwarded; recipients need its password when required. Access stops when the share expires or is revoked. Copying does not change these rules.</p>{viewer()?.publicUrl && <CopyValue label="Copy visitor share link" value={new URL(viewer()?.publicUrl ?? '', location.origin).href} />}</> : <><p>This is a private link. Readers must sign in with an authorized account; knowing the link or document password does not grant access. External readers need an active visitor share.</p>{viewer()?.publicUrl && <CopyValue label="Copy private link" value={new URL(viewer()?.publicUrl ?? '', location.origin).href} />}{base() && caps().manage ? <LinkButton href={`${base() ?? ''}#sharing`}>Manage visitor shares</LinkButton> : <p>Ask the owner or a manager to create a visitor share for external readers.</p>}</>}</div>}
      {dialog() === 'duplicate' && viewer() && <DuplicateForm viewer={viewer()!} opened={opened()} />}
      {dialog() === 'report' && <form class="stack" onSubmit={event => { event.preventDefault(); const reason = new FormData(event.currentTarget).get('reason'); void action(async () => { const current = opened(); const currentViewer = viewer(); if (!current || !currentViewer) return; await reportArtifact(currentViewer, current, { reason, csrf: currentViewer.csrf }); setDialog(null); setNotice('Report submitted for staff review.'); }); }}><p>Describe the concern. Do not include passwords or sensitive personal information.</p><Field name="reason" label="Reason" multiline minlength={3} maxlength={2000} required /><Button type="submit" disabled={busy()}>{busy() ? 'Submitting…' : 'Submit report'}</Button></form>}
      {dialog() === 'history' && viewer() && <VersionHistory versions={viewer()?.versions} base={base() ?? ''} csrf={viewer()?.csrf ?? ''} write={caps().write} currentVersion={viewer()?.currentVersion} />}
      {dialog() === 'rename' && base() && viewer() && <PostForm action={`${base() ?? ''}/meta`} csrf={viewer()?.csrf} hidden={{ lang: viewer()?.lang ?? 'en' }} submit="Save title"><Field name="title" label="Title" value={title()} required /></PostForm>}
      {dialog() === 'delete' && base() && viewer() && <PostForm action={`${base() ?? ''}/delete`} csrf={viewer()?.csrf} submit="Permanently delete" danger><p>This permanently removes content, retained versions and personal/shared application data. Existing links stop working and remain reserved. This cannot be undone.</p><Check name="confirm" value="delete" required>Delete this artefact and all its application data permanently.</Check></PostForm>}
    </Dialog>
  </section>;
}

