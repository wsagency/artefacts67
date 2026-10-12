import { createEffect, createMemo, createSignal, onSettled, For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Button, Dialog, Feedback, Field, Icon, Menu, MenuItem, MenuLink, Navigation, PostForm, atLeast, postJSON, roleLabel } from './ui';
import { navigate, refreshPage } from './navigation';
import { CommandPalette, type CommandEntry } from './command-palette';
import type { ArtifactSummary, Folder as FolderModel, PageProps } from './types';

function stored<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return (value as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are best effort and never block the console.
  }
}

export function usePreference<T>(key: string, fallback: T): [Accessor<T>, (value: T) => void] {
  const [value, setValue] = createSignal<T>(() => stored(key, fallback));
  const update = (next: T): void => {
    setValue(() => next);
    save(key, next);
  };
  return [value, update];
}

type DragPayload = { kind: 'folder' | 'artifact'; ref: string; id: string; ownerId?: string };
type Position = { kind: 'folder' | 'artifact'; ref: string; route?: string };
type FolderLocation = { folder: FolderModel; path: string; parent?: FolderLocation };
type ArtifactLocation = { artifact: ArtifactSummary; path: string; folder?: FolderLocation };
type TreeContext = {
  activeRef: Accessor<string | undefined>;
  openMap: Accessor<Record<string, boolean>>;
  setOpenMap: (value: Record<string, boolean>) => void;
  dragTarget: Accessor<string | null>;
  start: (event: DragEvent, data: DragPayload) => void;
  canDrop: (folder: FolderModel) => boolean;
  setDragTarget: (value: string | null) => void;
  move: (folder: FolderModel | null) => Promise<void>;
  setSubfolder: (folder: FolderModel) => void;
  position: (value: Position) => void;
};

function Folder(props: { f: FolderModel; shared?: boolean; tree: TreeContext }) {
  const role = () => props.f.role ?? 'owner';
  const write = () => atLeast(role(), 'editor');
  const own = () => atLeast(role(), 'owner');
  const open = () => props.tree.openMap()[props.f.id] !== false;
  const count = () => props.f.subtreeArtefacts ?? countArtifacts([props.f]);
  return <li>
    <div class={`tree-row ${props.tree.activeRef() === props.f.ref ? 'active' : ''} ${props.tree.dragTarget() === props.f.id ? 'drop-target' : ''}`} draggable={own() ? 'true' : 'false'} onDragStart={event => props.tree.start(event, { kind: 'folder', ref: props.f.ref, id: props.f.id, ownerId: props.f.ownerId })} onDragOver={event => { if (props.tree.canDrop(props.f)) { event.preventDefault(); event.stopPropagation(); props.tree.setDragTarget(props.f.id); } }} onDrop={event => { event.stopPropagation(); if (props.tree.canDrop(props.f)) { event.preventDefault(); void props.tree.move(props.f); } }}>
      <button type="button" class="tree-name tree-toggle" aria-label={props.f.name} aria-expanded={open() ? 'true' : 'false'} aria-controls={`folder-${props.f.id}-children`} onClick={() => { props.tree.position({ kind: 'folder', ref: props.f.ref }); props.tree.setOpenMap({ ...props.tree.openMap(), [props.f.id]: !open() }); }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.tree.position({ kind: 'folder', ref: props.f.ref }); props.tree.setOpenMap({ ...props.tree.openMap(), [props.f.id]: event.key === 'ArrowRight' }); } }}>
        <svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={open() ? 'M3 9V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 9h18l-3 11H4L3 9Z' : 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'} /></svg>
        <span class="tree-label">{props.f.name}<small>{props.shared && props.f.ownerName ? props.f.ownerName : role() !== 'owner' ? roleLabel(role()) : ''}</small></span>
      </button>
      <span class="count" title="Artefacts including subfolders">{count()}</span>
      <span class="tree-actions">
      <Show when={atLeast(role(), 'manager')}><a class="tree-action" href={`/app/f/${props.f.ref}#password`} aria-label={`Password options for ${props.f.name}`} title="Visitor-share passwords" onClick={() => props.tree.position({ kind: 'folder', ref: props.f.ref })}><Icon name="lock" /></a></Show>
      <Show when={write()}><button type="button" class="tree-action" aria-label={`Create subfolder in ${props.f.name}`} title="Create subfolder" aria-haspopup="dialog" onClick={() => props.tree.setSubfolder(props.f)}><span aria-hidden="true">+</span></button></Show>
      <a class="tree-action" href={`/app/f/${props.f.ref}#overview`} aria-label={`Settings for ${props.f.name}`} title="Folder settings" onClick={() => props.tree.position({ kind: 'folder', ref: props.f.ref })}><Icon name="settings" /></a>
      </span>
    </div>
    <Show when={open()}>
      <ul id={`folder-${props.f.id}-children`}>
        <For each={props.f.children ?? []}>{child => <Folder f={child} tree={props.tree} />}</For>
        <For each={props.f.artefacts ?? []}>{artifact => <li>
          <div class={`tree-row artifact-row ${props.tree.activeRef() === artifact.ref ? 'active' : ''}`} draggable={write() ? 'true' : 'false'} onDragStart={event => props.tree.start(event, { kind: 'artifact', ref: artifact.ref, id: artifact.id, ownerId: artifact.ownerId ?? props.f.ownerId })}>
            <a class="tree-name" href={`/app/a/${artifact.ref}/view`} onClick={() => props.tree.position({ kind: 'artifact', ref: artifact.ref })}>{artifact.title}</a>
            <Show when={!write() && artifact.gated}><span class="tree-action tree-status" role="img" aria-label="Password protected" title="Password protected"><Icon name="lock" /></span></Show>
            <span class="tree-actions">
              <Show when={write()}><a class="tree-action" href={`/app/a/${artifact.ref}#password`} aria-label={`Password options for ${artifact.title}`} title={artifact.gated ? 'Password protected · Password options' : 'Password options'} onClick={() => props.tree.position({ kind: 'artifact', ref: artifact.ref })}><Icon name="lock" /></a></Show>
              <a class="tree-action" href={`/app/a/${artifact.ref}/preview`} target="_blank" rel="noopener" aria-label={`Open ${artifact.title} in a new tab`}>↗</a>
              <a class="tree-action" href={`/app/a/${artifact.ref}`} aria-label={`Manage ${artifact.title}`} title="Artefact settings" onClick={() => props.tree.position({ kind: 'artifact', ref: artifact.ref })}><Icon name="settings" /></a>
            </span>
          </div>
        </li>}</For>
        <Show when={!(props.f.children?.length || props.f.artefacts?.length) && !write()}><li class="tree-empty">Empty folder</li></Show>
      </ul>
    </Show>
  </li>;
}

export function ConsoleShell(props: { p: PageProps; screen: string; children: JSX.Element }) {
  const [theme, setTheme] = usePreference<string>('wsa-console-theme', 'original');
  const [size, setSize] = usePreference<'s' | 'm' | 'l'>('wsa-side-size', 'm');
  const [collapsed, setCollapsed] = usePreference<boolean>('wsa-side-collapsed', false);
  const [width, setWidth] = usePreference<number>('wsa-side-width', 256);
  const [openMap, setOpenMap] = usePreference<Record<string, boolean>>('wsa-tree-open', {});
  const [position, rememberPosition] = usePreference<Position | null>('wsa-tree-position', null);
  const setPosition = (value: Position): void => rememberPosition({ kind: value.kind, ref: value.ref, route: location.pathname + location.search });
  const [commandsOpen, setCommandsOpen] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal('');
  const [subfolder, setSubfolder] = createSignal<FolderModel | null>(null);
  const [dragTarget, setDragTarget] = createSignal<string | null>(null);
  let drag: DragPayload | null = null;
  let resize: { x: number; width: number } | null = null;
  let logout: HTMLFormElement | undefined;
  const clamp = (value: number): number => Math.max(256, Math.min(480, Number(value) || 256));

  createEffect(
    () => theme(),
    value => { document.documentElement.dataset.consoleTheme = ['original', 'light', 'calm'].includes(value) ? value : 'original'; },
  );

  const canDrop = (folder: FolderModel): boolean => Boolean(drag && atLeast(folder.role ?? 'owner', 'editor') && folder.ownerId === drag.ownerId && !(drag.kind === 'folder' && drag.id === folder.id));
  const canMoveToRoot = (): boolean => drag?.kind === 'folder' && drag.ownerId === props.p.me.id;
  async function move(folder: FolderModel | null): Promise<void> {
    const data = drag;
    drag = null;
    setDragTarget(null);
    setDragging(false);
    if (!data) return;
    try {
      await postJSON(`/app/${data.kind === 'folder' ? 'f' : 'a'}/${encodeURIComponent(data.ref)}/move`, { csrf: props.p.me.csrf, [data.kind === 'folder' ? 'parent' : 'folder']: folder?.ref ?? 'root' });
      await refreshPage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to move the item.');
    }
  }
  function start(event: DragEvent, data: DragPayload): void {
    event.stopPropagation();
    if (!event.dataTransfer) return;
    drag = data;
    event.dataTransfer.setData('text/plain', data.ref);
    setDragging(true);
    event.dataTransfer.effectAllowed = 'move';
  }

  const locations = createMemo(() => {
    const folders: FolderLocation[] = [];
    const artefacts: ArtifactLocation[] = [];
    const walk = (nodes: FolderModel[], parent?: FolderLocation): void => {
      for (const folder of nodes) {
        const node: FolderLocation = { folder, parent, path: `${parent ? `${parent.path} / ` : folder.ownerName ? `${folder.ownerName} / ` : ''}${folder.name}` };
        folders.push(node);
        for (const artifact of folder.artefacts ?? []) artefacts.push({ artifact, folder: node, path: node.path });
        walk(folder.children ?? [], node);
      }
    };
    walk(props.p.estate?.mine ?? []);
    walk(props.p.estate?.shared ?? []);
    for (const artifact of props.p.estate?.unfiled ?? []) artefacts.push({ artifact, path: 'Unfiled' });
    return { folders, artefacts };
  });
  const routeRef = createMemo(() => props.p.artifact?.ref ?? props.p.folder?.ref ?? props.p.values?.folder);
  const selectedFolder = createMemo(() => position()?.kind === 'folder' ? locations().folders.find(node => node.folder.ref === position()?.ref) : undefined);
  const selectedArtifact = createMemo(() => position()?.kind === 'artifact' ? locations().artefacts.find(node => node.artifact.ref === position()?.ref) : undefined);
  createEffect(() => routeRef(), ref => {
    // Ordinary POST responses remount the shell; a refresh must not change the user's context.
    if (ref && (position()?.route !== location.pathname + location.search || !(selectedFolder() || selectedArtifact()))) {
      setPosition({ kind: props.p.artifact?.ref === ref ? 'artifact' : 'folder', ref });
    }
  });
  const contextFolder = createMemo(() => selectedFolder() ?? selectedArtifact()?.folder);
  const activeRef = createMemo(() => selectedFolder()?.folder.ref ?? selectedArtifact()?.artifact.ref ?? routeRef());
  const openPage = (url: string): void => { void navigate(url).catch(() => {}); };
  const reveal = (node: FolderLocation): void => {
    const next = { ...openMap() };
    for (let current: FolderLocation | undefined = node; current; current = current.parent) next[current.folder.id] = true;
    setOpenMap(next);
  };
  const newSubfolder = (folder: FolderModel): void => {
    setPosition({ kind: 'folder', ref: folder.ref });
    setOpenMap({ ...openMap(), [folder.id]: true });
    setSubfolder(folder);
  };
  const commandEntries = createMemo<CommandEntry[]>(() => {
    const entries: CommandEntry[] = [{ id: 'create-top-folder', label: 'Create new top folder', detail: 'At the top level of your estate', group: 'Commands', onSelect: () => openPage('/app/folders/new') }];
    const folder = contextFolder();
    if (folder && atLeast(folder.folder.role ?? 'owner', 'editor')) {
      entries.push(
        { id: 'create-folder', label: 'Create folder', detail: `Inside ${folder.path}`, group: 'Commands', onSelect: () => newSubfolder(folder.folder) },
        { id: 'create-artefact', label: 'Create artefact', detail: `Inside ${folder.path}`, group: 'Commands', onSelect: () => openPage(`/app/new?folder=${encodeURIComponent(folder.folder.ref)}`) },
      );
    }
    const artifact = selectedArtifact();
    const shareFolder = selectedFolder();
    if (artifact && atLeast(artifact.folder?.folder.role ?? 'owner', 'manager')) {
      entries.push({ id: 'share', label: 'Share', detail: `Visitor-share options for ${artifact.artifact.displayTitle ?? artifact.artifact.title ?? artifact.artifact.ref}`, group: 'Commands', onSelect: () => openPage(`/app/a/${artifact.artifact.ref}#sharing`) });
    } else if (shareFolder && atLeast(shareFolder.folder.role ?? 'owner', 'manager')) {
      entries.push({ id: 'share', label: 'Share', detail: `Visitor-share options for ${shareFolder.path}`, group: 'Commands', onSelect: () => openPage(`/app/f/${shareFolder.folder.ref}#sharing`) });
    }
    for (const node of locations().folders) entries.push({ id: `folder:${node.folder.id}`, label: node.folder.name, detail: node.path, group: 'Folders', onSelect: () => { setPosition({ kind: 'folder', ref: node.folder.ref }); reveal(node); openPage(`/app/f/${node.folder.ref}#overview`); } });
    for (const node of locations().artefacts) entries.push({ id: `artifact:${node.artifact.id}`, label: node.artifact.displayTitle ?? node.artifact.title ?? node.artifact.ref, detail: node.path, group: 'Artefacts', onSelect: () => { setPosition({ kind: 'artifact', ref: node.artifact.ref }); if (node.folder) reveal(node.folder); openPage(`/app/a/${node.artifact.ref}/view`); } });
    return entries;
  });
  onSettled(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open]') && !commandsOpen()) return;
        event.preventDefault();
        if (!event.repeat) setCommandsOpen(!commandsOpen());
      }
    };
    document.addEventListener('keydown', shortcut);
    const fromFrame = (): void => { if (!document.querySelector('dialog[open]')) setCommandsOpen(true); };
    document.addEventListener('wsa:command-palette', fromFrame);
    return () => { document.removeEventListener('keydown', shortcut); document.removeEventListener('wsa:command-palette', fromFrame); };
  });
  const nav = createMemo<Array<[string, string]>>(() => {
    const settings = ['settings', 'keys'].includes(props.screen);
    const admin = ['adminHome', 'users', 'platformSettings', 'reports'].includes(props.screen);
    return settings
      ? [['Account & security', '/settings'], ['API keys', '/settings/keys']]
      : admin
        ? [['Overview', '/admin'], ['Users & invitations', '/admin/users'], ['Reports', '/admin/reports'], ...(props.p.me.role === 'owner' ? [['Platform settings', '/admin/settings'] as [string, string]] : [])]
        : [];
  });
  const tree: TreeContext = { activeRef, openMap, setOpenMap, dragTarget, start, canDrop, setDragTarget, move, setSubfolder: newSubfolder, position: setPosition };

  return <div class={`console ${collapsed() ? 'sidebar-collapsed' : ''}`} style={{ '--sidebar-width': `${clamp(width())}px` }}>
    <a class="skip-link" href="#content">Skip to content</a>
    <aside class="sidebar" data-size={['s', 'm', 'l'].includes(size()) ? size() : 'm'}>
      <div class="sidebar-header">
        <a class="brand" href="/app"><img src="/assets/ws-design-kit/products/artefacts67/original/logo-color.svg" alt="Artefacts67" width="180" /></a>
        <Button size="sm" iconOnly variant="ghost" aria-label={collapsed() ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={(!collapsed()) ? 'true' : 'false'} onClick={() => setCollapsed(!collapsed())}>{collapsed() ? '→' : '←'}</Button>
      </div>
      <Show when={!collapsed()}>
        <nav class="estate-tree" aria-label="Your estate" onDragEnd={() => { drag = null; setDragging(false); setDragTarget(null); }}>
          <button type="button" class="sidebar-search" aria-label="Search and commands" aria-haspopup="dialog" onClick={() => setCommandsOpen(true)}><span>Search…</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'}</kbd></button>
          <Feedback error={error()} />
          <ul>
            <For each={props.p.estate?.mine ?? []}>{folder => <Folder f={folder} tree={tree} />}</For>
            <Show when={!(props.p.estate?.mine?.length || props.p.estate?.unfiled?.length)}><li class="tree-empty">Your estate is empty. Create a folder to organize your work.</li></Show>
          </ul>
          <Show when={props.p.estate?.unfiled?.length}>
            <h2 class="tree-heading">Unfiled</h2>
            <ul><For each={props.p.estate?.unfiled ?? []}>{artifact => <li>
              <div class={`tree-row artifact-row ${activeRef() === artifact.ref ? 'active' : ''}`} draggable="true" onDragStart={event => start(event, { kind: 'artifact', ref: artifact.ref, id: artifact.id, ownerId: artifact.ownerId })}>
                <a class="tree-name" href={`/app/a/${artifact.ref}/view`} onClick={() => setPosition({ kind: 'artifact', ref: artifact.ref })}>{artifact.title}</a>
                <span class="tree-actions">
                <a class="tree-action" href={`/app/a/${artifact.ref}#password`} aria-label={`Password options for ${artifact.title}`} title={artifact.gated ? 'Password protected · Password options' : 'Password options'} onClick={() => setPosition({ kind: 'artifact', ref: artifact.ref })}><Icon name="lock" /></a>
                <a class="tree-action" href={`/app/a/${artifact.ref}/preview`} target="_blank" rel="noopener" aria-label={`Open ${artifact.title} in a new tab`}>↗</a>
                <a class="tree-action" href={`/app/a/${artifact.ref}`} aria-label={`Manage ${artifact.title}`} title="Artefact settings" onClick={() => setPosition({ kind: 'artifact', ref: artifact.ref })}><Icon name="settings" /></a>
                </span>
              </div>
            </li>}</For></ul>
          </Show>
          <Show when={props.p.estate?.shared?.length}>
            <h2 class="tree-heading">Shared with you</h2>
            <ul><For each={props.p.estate?.shared ?? []}>{folder => <Folder f={folder} tree={tree} shared />}</For></ul>
          </Show>
          <a class="new-link" href="/app/folders/new">+ New top folder</a>
          <Show when={dragging() && canMoveToRoot()}><div class={`root-drop ${dragTarget() === 'root' ? 'drop-target' : ''}`} onDragOver={event => { if (canMoveToRoot()) { event.preventDefault(); setDragTarget('root'); } }} onDrop={event => { if (canMoveToRoot()) { event.preventDefault(); void move(null); } }}>Drop an owned folder here to move it to the top level</div></Show>
        </nav>
        <footer class="account">
          <div class="preference-row" role="group" aria-label="Sidebar text size"><For each={['s', 'm', 'l'] as const}>{option => <Button size="sm" variant={size() === option ? 'secondary' : 'ghost'} aria-pressed={(size() === option) ? 'true' : 'false'} onClick={() => setSize(option)}>{option.toUpperCase()}</Button>}</For></div>
          <div class="preference-row" role="group" aria-label="Console theme"><For each={['original', 'light', 'calm']}>{option => <Button size="sm" variant={theme() === option ? 'secondary' : 'ghost'} aria-pressed={(theme() === option) ? 'true' : 'false'} onClick={() => setTheme(option)}>{option[0].toUpperCase() + option.slice(1)}</Button>}</For></div>
          <Menu label="Account menu" trigger={<><span>{props.p.me.name || props.p.me.email}</span><small>{roleLabel(props.p.me.role)}</small></>} class="account-trigger" align="end">
            <MenuLink href="/settings">Profile &amp; security</MenuLink>
            <MenuLink href="/settings/keys">API keys</MenuLink>
            <MenuLink href="/instructions">Documentation</MenuLink>
            <Show when={['admin', 'owner'].includes(props.p.me.role)}><MenuLink href="/admin">Administration</MenuLink></Show>
            <MenuItem onSelect={() => logout?.requestSubmit()}>Sign out</MenuItem>
          </Menu>
          <form ref={element => { logout = element; }} hidden method="post" action="/logout"><input type="hidden" name="csrf" value={props.p.me.csrf} /></form>
        </footer>
      </Show>
      <div class="sidebar-resize" role="separator" tabindex={collapsed() ? -1 : 0} aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={256} aria-valuemax={480} aria-valuenow={clamp(width())} onPointerDown={event => { resize = { x: event.clientX, width: clamp(width()) }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (resize) setWidth(clamp(resize.width + event.clientX - resize.x)); }} onPointerUp={() => { resize = null; }} onPointerCancel={() => { resize = null; }} onLostPointerCapture={() => { resize = null; }} onKeyDown={event => { const next = { ArrowLeft: clamp(width()) - 20, ArrowRight: clamp(width()) + 20, Home: 256, End: 480 }[event.key]; if (next !== undefined) { event.preventDefault(); setWidth(clamp(next)); } }} />
    </aside>
    <main id="content" class={`content ${props.screen === 'artefactReader' ? 'reading' : ''}`}>
      <Show when={nav().length}><Navigation sections={nav()} /></Show>
      <Feedback error={props.p.error} notice={props.p.notice} />
      {props.children}
    </main>
    <CommandPalette open={commandsOpen()} onOpenChange={setCommandsOpen} entries={commandEntries()} context={contextFolder()?.path} />
    <Dialog title={`New subfolder in ${subfolder()?.name ?? ''}`} open={subfolder() !== null} onOpenChange={open => { if (!open) setSubfolder(null); }}>
      <Show when={subfolder()}>{folder => <PostForm action={`/app/f/${folder().ref}/subfolder`} csrf={props.p.me.csrf} submit="Create subfolder"><Field label="Name" name="name" required autofocus /></PostForm>}</Show>
    </Dialog>
  </div>;
}

export function countArtifacts(nodes: FolderModel[]): number {
  return nodes.reduce((total, folder) => total + (folder.artefacts?.length ?? 0) + countArtifacts(folder.children ?? []), 0);
}
