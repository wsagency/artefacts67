import { untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Panel, Field, Choice, Check, PostForm, LinkButton, DataTable, CopyValue, Sections, VersionHistory, DeleteArtifact, DeleteFolder, roleLabel, Icon } from './ui';
import { Analytics, Shares, ColleagueAccess, ShareBreakdown } from './collaboration';
import { countArtifacts } from './shell';
import { DuplicateForm } from './viewer';
import type { Capabilities, Destination, Folder, PageProps } from './types';

function options(folders: Destination[]): Array<[string, string]> {
  return folders.map(folder => [folder.ref ?? folder.id, `${'— '.repeat(folder.depth ?? 0)}${folder.name ?? folder.displayName ?? folder.id}${folder.ownerName ? ` · ${folder.ownerName}` : ''}`] as [string, string]);
}

function Paths(props: { path: string; aliases?: string[]; folder?: boolean }) {
  const aliases = untrack(() => props.aliases ?? []);
  const folder = untrack(() => props.folder ?? false);
  return <Panel title="Private paths"><p>Current and retired paths require authorized sign-in. External readers need an active visitor share.</p><ul class="path-list"><li><a href={props.path}>{props.path}</a> · Current</li>{aliases.map(alias => <li><a href={`/${alias}${folder ? '/' : ''}`}>/{alias}{folder ? '/' : ''}</a> · Retired</li>)}</ul></Panel>;
}

function Aliases(props: { base: string; csrf: string }) {
  return <Panel title="Retired paths"><p>Old links keep resolving to this same artefact or folder.</p><PostForm action={`${props.base}/alias`} csrf={props.csrf} submit="Add paths"><Field name="paths" label="Paths, one per line" multiline required /></PostForm></Panel>;
}

function Rename(props: { base: string; csrf: string; slug?: string }) {
  return <Panel title="Friendly path"><p>The previous path becomes a retired path and keeps working.</p><PostForm action={`${props.base}/rename`} csrf={props.csrf} submit="Rename"><Field name="slug" label="Path (slug)" value={props.slug} required /></PostForm></Panel>;
}

export function AppHome(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const mine = p.estate?.mine ?? [];
  const shared = p.estate?.shared ?? [];
  const unfiled = p.estate?.unfiled ?? [];
  const walk = (nodes: Folder[], fn: (folder: Folder) => number): number => nodes.reduce((total, folder) => total + fn(folder) + walk(folder.children ?? [], fn), 0);
  const stats: Array<[string, number]> = [['Folders', walk(mine, () => 1)], ['Artefacts', countArtifacts(mine) + unfiled.length], ['Password-gated', walk(mine, folder => (folder.artefacts ?? []).filter(artifact => artifact.gated).length) + unfiled.filter(artifact => artifact.gated).length], ['Shared with you', countArtifacts(shared)]];
  return <><header class="page-head"><div><p class="eyebrow">Estate</p><h1>Your artefacts</h1><p class="muted">A private home for the work you share.</p></div><LinkButton href="/app/folders/new">New folder</LinkButton></header><p class="callout">Artefacts and folders are private by default. Ordinary links require authorized sign-in, including documents without passwords. Create a visitor share for external readers; colleague access remains tied to their signed-in account.</p>{p.inviteLink && <Panel title="Invitation"><p>This invitation is valid for seven days and can be used once.</p><CopyValue value={p.inviteLink} /></Panel>}<div class="stats">{stats.map(([label, value]) => <div><strong>{value}</strong><span>{label}</span></div>)}</div><div class="panel-grid"><Panel title="Invite a colleague"><p>They join as a member with an estate of their own. The invitation lasts seven days and can be used once.</p><PostForm action="/app/invite" csrf={p.me.csrf} submit="Send invitation"><Field label="Email" name="email" type="email" required /></PostForm></Panel><Panel title="Features & instructions"><p>Start here for human workflows, permissions, and AI publishing instructions.</p><ul class="path-list"><li><a href="/settings/keys">Manage API keys</a></li><li><a href="/_api/contract">Read the API contract</a></li><li><a href="/instructions">All features & instructions</a></li></ul></Panel></div></>;
}

export function AppFolderNew(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  return <><h1>New folder</h1><p class="muted">Folders are private. Organize your work first; create a visitor share when external readers need access.</p><Panel><PostForm action="/app/folders/new" csrf={p.me.csrf} submit="Create folder"><Field name="name" label="Folder name" value={p.values?.name} description="For example: Clients, Personal, or a project." required autofocus /></PostForm></Panel></>;
}

export function AppNew(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const values = p.values ?? {};
  return <><h1>New artefact</h1><p class="muted">Publish a private, self-contained HTML document. Its ordinary link requires authorized sign-in; only a visitor share grants external access.</p><Panel><PostForm action="/app/new" csrf={p.me.csrf} submit="Publish artefact"><Choice name="folder" label="Folder" value={values.folder} options={[['', 'Create a new folder'], ...options(p.folders ?? [])]} /><div class="fields-row"><Field name="newFolder" label="New folder name" value={values.newFolder} /><Field name="newFolderSlug" label="New folder path (optional)" value={values.newFolderSlug} /></div><div class="fields-row"><Field name="title" label="Title" value={values.title} required /><Field name="slug" label="Path (slug)" value={values.slug} required /><Field name="lang" label="Language" value={values.lang ?? 'en'} /></div><Field name="html" label="HTML document" multiline class="code-input" rows={16} value={values.html} required /><Field name="password" label="Additional document password (optional, any length)" type="password" value={values.password} description="Leave blank to keep it private without an additional password. A password never replaces authorized sign-in or creates a visitor share." /><Field name="retiredPaths" label="Retired paths, one per line (optional)" multiline value={values.retiredPaths} /></PostForm></Panel></>;
}

export function FolderPane(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const folder = p.folder;
  if (!folder) return <p class="feedback error">The folder is unavailable.</p>;
  const caps: Capabilities = p.caps ?? {};
  const base = `/app/f/${folder.ref}`;
  const csrf = p.me.csrf;
  const artefacts = folder.artefacts ?? [];
  const overview = <>
    {caps.write && <Panel title="Create in this folder">
      <LinkButton href={`/app/new?folder=${encodeURIComponent(folder.ref)}`}>New artefact here</LinkButton>
      <p>A new subfolder belongs to this folder's owner and inherits colleague access.</p>
      <PostForm action={`${base}/subfolder`} csrf={csrf} submit="Create subfolder"><Field name="name" label="New subfolder name" required /></PostForm>
    </Panel>}
    {!caps.write && <p class="callout">You have read-only access to this folder.</p>}
    {!!folder.children?.length && <Panel title="Subfolders"><ul class="path-list">{folder.children.map(child => <li><a href={`/app/f/${child.ref}#overview`}>{child.name}</a></li>)}</ul></Panel>}
    <Panel title={`Artefacts (${artefacts.length})`}>
      <p class="muted">{folder.subtreeArtefacts ?? countArtifacts([folder])} including subfolders</p>
      <DataTable headers={['Artefact', caps.write ? 'Private path' : 'Read', 'Language', 'Protection']} rows={artefacts.map(artifact => [<><a href={`/app/a/${artifact.ref}/view`}>{artifact.title}</a> <a href={`/app/a/${artifact.ref}/preview`} target="_blank" rel="noopener" aria-label={`Open ${artifact.title} in a new tab`}>↗</a></>, caps.write ? <a href={artifact.path ?? '#'}>{artifact.path}</a> : <a href={`/app/a/${artifact.ref}/view`}>Preview</a>, artifact.lang, artifact.gated ? caps.write ? <a href={`/app/a/${artifact.ref}#password`} aria-label={`Password options for ${artifact.title}`} title="Private · Additional password · Password options"><Icon name="lock" /></a> : <span aria-label="Private with additional password" title="Private with additional password"><Icon name="lock" /></span> : 'Private'])} empty="No artefacts in this folder yet." />
    </Panel>
  </>;
  const items: Array<[string, string, JSX.Element]> = [['overview', 'Overview', overview]];
  if (caps.manage) items.push(['sharing', 'Sharing', <Shares p={p} base={base} kind="folder" note={folder.topLevel ? '' : 'Visitor shares are created on the top-level folder and cover its whole subtree.'} />], ['password', 'Password', <><p class="callout">Folders have no ordinary password gate. Each visitor-share link has its own optional password; artefact passwords remain independent.</p><Shares p={p} base={base} kind="folder" note={folder.topLevel ? '' : 'Visitor shares are created on the top-level folder and cover its whole subtree.'} /></>]);
  if (caps.own) items.push(['access', 'Access', <ColleagueAccess p={p} base={base} />]);
  if (caps.manage) items.push(['activity', 'Activity', p.analytics ? <Analytics summary={p.analytics} title="Folder statistics" /> : <p class="muted">No folder activity statistics are available yet.</p>]);
  if (caps.write) items.push(['settings', 'Settings', <>
    <Paths path={folder.path ?? base} aliases={p.aliases} folder />
    <div class="panel-grid">
      <Panel title="Display name"><PostForm action={`${base}/name`} csrf={csrf} submit="Save name"><Field name="name" label="Name" value={folder.displayName ?? folder.name} required /></PostForm></Panel>
      <Rename base={base} csrf={csrf} slug={folder.slug} />
      {caps.own && <Panel title="Move folder"><p>Only its owner may move a folder: moving changes inherited access. Private paths remain unchanged.</p><PostForm action={`${base}/move`} csrf={csrf} submit="Move"><Choice name="parent" label="Under" options={[['root', 'Top level'], ...options(p.moveTargets ?? [])]} /></PostForm></Panel>}
      <Aliases base={base} csrf={csrf} />
    </div>
    {caps.own && <Panel title="Delete folder"><DeleteFolder base={base} csrf={csrf} name={folder.displayName ?? folder.name ?? ''} contents={p.folderContents} /></Panel>}
  </>]);
  // Folder visits start at Overview; an explicit hash still opens the requested tab.
  if (!location.hash) history.replaceState(history.state, '', '#overview');
  return <><header class="page-head"><div><p class="eyebrow">Private folder</p><h1>{folder.displayName ?? folder.name}</h1><p class="muted">{folder.parentName && `Inside ${folder.parentName} · `}{folder.ownerName && `Owned by ${folder.ownerName} · `}Your standing: {roleLabel(folder.role)}</p><p class="muted">Ordinary links require authorized sign-in. External readers need an active visitor share.</p></div></header><Sections items={items} /></>;
}

export function ArtefactPane(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const artifact = p.artifact;
  if (!artifact) return <p class="feedback error">The artefact is unavailable.</p>;
  const caps: Capabilities = p.caps ?? {};
  const base = `/app/a/${artifact.ref}`;
  const csrf = p.me.csrf;
  const overview = <><Panel title="Read it"><p>This artefact is private. The signed-in preview uses your existing access without retyping the document password. Ordinary links require authorized sign-in; external readers need an active visitor share.</p><div class="row"><LinkButton href={`${base}/view`}>Open preview</LinkButton><LinkButton href={`${base}/preview`} target="_blank" rel="noopener">Open in a new tab</LinkButton><a href={`${base}/download`}>Download HTML</a></div></Panel><Panel title="Duplicate"><DuplicateForm viewer={{ title: artifact.displayTitle, gated: artifact.gated, signedIn: true, actionBase: base, csrf, folders: p.duplicateFolders ?? p.moveTargets ?? [], permissions: caps }} /></Panel>{caps.write ? <div class="panel-grid"><Panel title="Move to folder"><p>The link stays the same; the artefact remains in its owner's estate.</p><PostForm action={`${base}/move`} csrf={csrf} submit="Move"><Choice name="folder" label="Folder" value={(p.moveTargets ?? []).find(folder => folder.id === artifact.folderId)?.ref} options={options(p.moveTargets ?? [])} /></PostForm></Panel><Panel title="Title & language"><PostForm action={`${base}/meta`} csrf={csrf}><Field name="title" label="Title" value={artifact.displayTitle ?? artifact.title} required /><Field name="lang" label="Language" value={artifact.lang} required /></PostForm></Panel></div> : <p class="callout">You have read-only access.</p>}{caps.own && <Panel title="Delete artefact"><DeleteArtifact base={base} csrf={csrf} /></Panel>}</>;
  const content = <><Panel title="Version history"><p>Restoring appends a new live version; history is never rewound.</p><VersionHistory versions={p.versions} base={base} csrf={csrf} write={caps.write} currentVersion={artifact.currentVersion} /></Panel>{caps.write && <Panel title="Publish a new version"><p>The link stays the same. Older versions are kept up to the retention limit.</p><PostForm action={`${base}/publish`} csrf={csrf} submit="Publish version"><Field name="html" label="HTML document" multiline rows={16} required /><Field name="note" label="Note (optional)" /></PostForm></Panel>}</>;
  const password = <Panel title="Additional document password"><p>This password adds a gate to an authorized ordinary link; it never grants access on its own. Any nonempty length is accepted. Removing it keeps the artefact private and does not create or change visitor shares, which have independent passwords.</p><PostForm action={`${base}/password`} csrf={csrf} submit="Save password"><Field name="password" label="New password" type="password" /><Check name="clear">Remove the additional password (keep private)</Check></PostForm></Panel>;
  const security = <><Paths path={artifact.path ?? base} aliases={p.aliases} /><div class="panel-grid"><Rename base={base} csrf={csrf} slug={artifact.slug} /><Aliases base={base} csrf={csrf} /></div></>;
  const items: Array<[string, string, JSX.Element]> = [['overview', 'Overview', overview], ['content', 'Content & versions', content]];
  if (caps.write) items.push(['password', 'Password', password]);
  if (caps.manage) items.push(['sharing', 'Sharing', <Shares p={p} base={base} />], ['analytics', 'Analytics', <><Analytics summary={p.analytics} /><ShareBreakdown p={p} /></>]);
  if (caps.write) items.push(['security', 'Links', security]);
  return <><p class="eyebrow">Private artefact</p><h1>{artifact.displayTitle ?? artifact.title}</h1><p class="muted">{artifact.gated ? 'Private · Additional password' : 'Private'} · {roleLabel(artifact.role)}{artifact.ownerName && ` · Owned by ${artifact.ownerName}`} {p.folder && <>· In <a href={`/app/f/${p.folder.ref}`}>{p.folder.name}</a></>}</p><Sections items={items} /></>;
}
