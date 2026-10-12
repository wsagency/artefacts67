import { createSignal, untrack } from 'solid-js';
import { Panel, Field, Choice, Check, PostForm, DataTable, CopyValue, duration, stamp, roleLabel } from './ui';
import type { AnalyticsSummary, PageProps, Role, ShareStats } from './types';

export function Analytics(props: { summary?: AnalyticsSummary; title?: string; platform?: boolean }) {
  const summary = untrack(() => props.summary ?? {});
  const title = untrack(() => props.title ?? 'Statistics');
  const platform = untrack(() => props.platform ?? false);
  const totals = summary.totals ?? {};
  const days = summary.days ?? [];
  const peak = Math.max(1, ...days.map(day => Number(day.opens ?? 0)));
  const scrollMarks = [25, 50, 75, 100] as const;
  return <Panel title={title}><p class="muted">{platform ? 'Platform-wide totals only. No recipient or artefact content is disclosed.' : 'These figures describe links, not individual people. Ordinary links and internal previews are not measured.'}</p><div class="stats"><div><strong>{totals.opens ?? 0}</strong><span>Opens</span></div><div><strong>{duration(totals.activeSeconds)}</strong><span>Reading time</span></div>{platform && <div><strong>{totals.shares ?? 0}</strong><span>Share links</span></div>}</div>{!platform && <><h3>How far visitors read</h3>{scrollMarks.map(mark => { const key = `scroll${mark}` as keyof ShareStats; const value = totals[key] as number | undefined; return <div class="bar-row"><span>{mark}%</span><meter min="0" max={Math.max(1, totals.opens ?? 0)} value={value ?? 0} aria-label={`${mark}% scroll depth`} /><span>{value ?? 0}</span></div>; })}</>}<h3>By day</h3>{days.length ? days.slice(-30).map(day => <div class="bar-row"><span>{String(day.day).slice(0, 10)}</span><meter min="0" max={peak} value={day.opens ?? 0} aria-label={`Opens on ${day.day}`} /><span>{day.opens ?? 0} · {duration(day.activeSeconds)}</span></div>) : <p class="muted">No opens recorded yet.</p>}</Panel>;
}

export function Shares(props: { p: PageProps; base: string; kind?: 'artifact' | 'folder'; note?: string }) {
  const p = untrack(() => props.p);
  const base = untrack(() => props.base);
  const kind = untrack(() => props.kind ?? 'artifact');
  const note = untrack(() => props.note ?? '');
  const [mail, setMail] = createSignal(false);
  const [password, setPassword] = createSignal('');
  const shares = p.shares ?? [];
  return <Panel title="Visitor shares"><p>Artefacts and folders are private by default. Create an active visitor share to grant external readers access without an account{kind === 'folder' ? ', covering this folder and all its current and future descendants' : ''}. Ordinary links and document passwords do not grant external access. A visitor share can be forwarded; its optional password is independent of the artefact password. Expiry or revocation ends its access.</p>{note ? <p class="callout">{note}</p> : <PostForm action={`${base}/share`} csrf={p.me.csrf} submit="Create share link"><Field name="name" label="Name" maxlength={160} required /><Field name="recipient" label="Recipient email (optional unless sending email)" type="email" maxlength={254} required={mail()} /><div class="fields-row"><Field name="password" label="Password (optional)" type="text" autocomplete="off" onChange={setPassword} /><Field name="expiresAt" label="Expires" type="date" value={p.expiryDefault} max={p.expiryMax} /></div>{!password() && <p class="callout" role="status"><strong>No password:</strong> anyone who receives this visitor share link can read {kind === 'folder' ? 'this folder and its current and future contents' : 'this artefact'}, including protected content, while the share is active. The link can be forwarded. Add a password for an additional barrier.</p>}<Check name="sendMail" onChange={setMail}>Email the link to the recipient</Check></PostForm>}<DataTable headers={['Name', 'Status', 'Gate', 'Visitor share link', 'Reading', 'Actions']} rows={shares.map(share => { const stats = p.shareStats?.[share.id] ?? {}; const state = share.revokedAt ? 'Revoked' : share.expiresAt && Date.parse(share.expiresAt) <= Date.now() ? 'Expired' : 'Active'; return [<><b>{share.name}</b><small>{share.recipient}</small><small>Created {stamp(share.createdAt)}</small></>, <>{state}<small>{share.expiresAt ? `Until ${stamp(share.expiresAt)}` : 'No expiry'}</small></>, share.gated ? 'Password' : share.allowProtected ? 'Link only · includes protected content' : 'Link only · protected content excluded', <CopyValue label="Copy visitor share link" value={share.url} />, <>{stats.opens ?? 0} opens<small>{duration(stats.activeSeconds)} · {stats.maxScroll ?? 0}% · Last {stamp(stats.lastOpenedAt) || '—'}</small></>, !share.revokedAt && <PostForm action={`${base}/share-revoke`} csrf={p.me.csrf} hidden={{ shareId: share.id }} submit="Revoke" danger />]; })} empty="No visitor share links yet." /></Panel>;
}

export function ColleagueAccess(props: { p: PageProps; base: string }) {
  const p = untrack(() => props.p);
  const base = untrack(() => props.base);
  const roles: Role[] = ['viewer', 'editor', 'manager'];
  return <Panel title="Colleague access"><p>Colleagues must sign in with an authorized account. Grants reach everything in this folder, now and later. Viewers read; editors publish and rename; managers also share and see statistics. Only the resource owner changes access. These account grants are separate from external visitor shares.</p><PostForm action={`${base}/grant`} csrf={p.me.csrf} submit="Grant access"><Field name="email" label="Colleague email" type="email" required /><Choice name="role" label="Role" options={roles.map(role => [role, roleLabel(role)] as [string, string])} /></PostForm><DataTable headers={['Colleague', 'Role', 'Where from', 'Actions']} rows={(p.grants ?? []).map(grant => [<>{grant.name || '—'}<small>{grant.email}</small></>, roleLabel(grant.role), grant.inherited ? 'Inherited from a parent folder' : 'This folder', !grant.inherited && <PostForm action={`${base}/grant-revoke`} csrf={p.me.csrf} hidden={{ userId: grant.userId }} submit="Revoke" danger />])} empty="Nobody else has access." /></Panel>;
}

export function ShareBreakdown(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  return <Panel title="By share link"><p class="muted">Everyone using a named link contributes to its figures. Folder shares are included in overall totals.</p><DataTable headers={['Name', 'Opens', 'Reading time', 'Max. scroll', 'Last opened']} rows={(p.shares ?? []).map(share => { const stats = p.shareStats?.[share.id] ?? {}; return [share.name, stats.opens ?? 0, duration(stats.activeSeconds), `${stats.maxScroll ?? 0}%`, stamp(stats.lastOpenedAt) || '—']; })} /></Panel>;
}
