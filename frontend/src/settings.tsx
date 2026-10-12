import { untrack } from 'solid-js';
import { Panel, Field, Choice, PostForm, DataTable, CopyValue, roleLabel, stamp } from './ui';
import { Passkey } from './auth';
import { Analytics } from './collaboration';
import type { PageProps } from './types';

export function Settings(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const me = p.me;
  const passkeys = p.passkeys ?? [];
  return <><h1>Account & security</h1><p class="muted">Settings for your account alone.</p><div class="panel-grid"><Panel title="Profile"><PostForm action="/settings/profile" csrf={me.csrf}><Field name="name" label="Display name" value={me.name} required /><Field label="Email" type="email" value={me.email} readonly /></PostForm></Panel><Panel title="New password"><PostForm action="/settings/password" csrf={me.csrf} submit="Change password"><Field name="current" label="Current password" type="password" autocomplete="current-password" required /><Field name="new" label="New password (at least 8 characters)" type="password" minlength={8} autocomplete="new-password" required /><Field name="confirm" label="Confirm new password" type="password" minlength={8} autocomplete="new-password" required /></PostForm></Panel><Panel title="Second factor (TOTP)"><p>{me.totpEnrolled ? 'Active' : 'Not set'}</p><p class="muted">Your authenticator code remains the fallback alongside passkeys and cannot be removed.</p></Panel></div><Panel title="Passkeys"><p>Sign in with a passkey alone (your device checks your PIN or biometric), or use it as the second factor after your password. TOTP remains available.</p><p class="muted">A passkey added before passkey-first sign-in may not be stored on your device as a sign-in passkey. It keeps working as the second factor; add a new passkey to sign in with it directly.</p><DataTable headers={['Name', 'Added', 'Last used', 'Actions']} rows={passkeys.map(passkey => [passkey.name || 'Passkey', stamp(passkey.createdAt), stamp(passkey.lastUsedAt) || '—', <PostForm action="/settings/passkeys/remove" csrf={me.csrf} hidden={{ passkeyId: passkey.id }} submit="Delete" danger />])} empty="No passkeys yet." /><Passkey csrf={me.csrf} enroll /></Panel></>;
}

export function Keys(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const me = p.me;
  const keys = p.keys ?? [];
  const artifacts = p.artifacts ?? [];
  const revoked = (key: (typeof keys)[number]): boolean => Boolean(key.revokedAt ?? key.revoked_at);
  const hasMaster = keys.some(key => key.kind === 'master' && !revoked(key));
  return <><h1>API keys</h1><p class="muted">Full keys appear only once, immediately after creation or rotation.</p>{p.secret && <Panel title="Copy the new key now"><CopyValue value={p.secret} label="Copy API key" /></Panel>}<Panel title="New key"><PostForm action="/settings/keys/mint" csrf={me.csrf} submit="Create key"><Choice name="kind" label="Kind" options={[['artifact', 'Artefact key'], ...(!hasMaster ? [['master', 'Master key'] as [string, string]] : [])]} />{hasMaster && <p class="muted">A master key already exists. Rotate it rather than creating another.</p>}<Choice name="artifactId" label="Artefact (for an artefact key)" options={artifacts.map(artifact => [artifact.id, artifact.slug || artifact.id])} />{!artifacts.length && <p class="muted">Publish an artefact before creating an artefact key.</p>}<Choice name="scopes" label="Scope (for an artefact key)" options={[['read', 'Read'], ['write', 'Write'], ['read_write', 'Read and write']]} /></PostForm></Panel><Panel title="Your keys"><DataTable headers={['Key', 'Kind', 'Artefact', 'Scope', 'Created', 'Last used', 'Status', 'Actions']} rows={keys.map(key => { const id = key.artifactId ?? key.artifact_id; return [<><span>{key.prefix}</span><small>{key.label}</small></>, key.kind, id ? (artifacts.find(artifact => artifact.id === id)?.slug || id) : '—', key.scopes, stamp(key.createdAt), stamp(key.lastUsedAt) || '—', revoked(key) ? 'Revoked' : 'Active', !revoked(key) && <div class="row"><PostForm action="/settings/keys/rotate" csrf={me.csrf} hidden={{ keyId: key.id }} submit="Rotate" /><PostForm action="/settings/keys/revoke" csrf={me.csrf} hidden={{ keyId: key.id }} submit="Revoke" danger /></div>]; })} /></Panel><Panel title="Documentation"><a href="/_api/contract">API contract</a> · <a href="/instructions">Agent onboarding</a></Panel></>;
}

export function AdminHome(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const stats: Array<[string, number]> = [['Users', p.counts?.users ?? 0], ['Active', p.counts?.active ?? 0], ['Suspended', p.counts?.suspended ?? 0], ['Open invitations', p.pendingInvites ?? 0]];
  return <><h1>Platform overview</h1><div class="stats">{stats.map(([label, value]) => <div><strong>{value}</strong><span>{label}</span></div>)}</div>{p.analytics && <Analytics summary={p.analytics} title="Reading across the platform" platform />}<Panel title="Recent activity"><p class="muted">The audit trail, newest first.</p><DataTable headers={['When', 'Actor', 'Action', 'Artefact', 'Detail']} rows={(p.audit ?? []).map(record => [stamp(record.at), `${record.actor_type ?? ''} · ${String(record.actor_id ?? '').slice(0, 8)}`, record.action, record.artifact_id ? String(record.artifact_id).slice(0, 12) : '—', String(record.detail ?? '').slice(0, 90)])} /></Panel></>;
}

export function Users(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  const me = p.me;
  const users = p.users ?? [];
  const invites = p.invites ?? [];
  const csrf = me.csrf;
  const rows = users.map(user => {
    const touch = ['owner', 'admin'].includes(me.role) && user.id !== me.id && (me.role === 'owner' || user.role !== 'owner');
    const roleOptions: Array<[string, string]> = ['member', 'admin', ...(me.role === 'owner' ? ['owner'] : [])].map(role => [role, roleLabel(role)]);
    return [<>{user.name || '—'}{user.id === me.id && ' · You'}</>, user.email, touch ? <PostForm action="/admin/users/role" csrf={csrf} hidden={{ userId: user.id }}><Choice name="role" label={`Role for ${user.name || user.email}`} value={user.role} options={roleOptions} /></PostForm> : roleLabel(user.role), user.status === 'active' ? 'Active' : 'Suspended', user.passkeyCount ?? 0, stamp(user.lastLoginAt) || '—', touch && <PostForm action="/admin/users/suspend" csrf={csrf} hidden={{ userId: user.id, suspend: user.status === 'active' ? '1' : '0' }} submit={user.status === 'active' ? 'Suspend' : 'Activate'} danger />];
  });
  return <><h1>Users & invitations</h1><p class="muted">Invitations last seven days and can be used once.</p>{p.inviteLink && <Panel title="Invitation"><CopyValue value={p.inviteLink} /></Panel>}<Panel title="Invite a new user"><PostForm action="/admin/users/invite" csrf={csrf} submit="Send invitation"><Field name="email" label="Email" type="email" required /><Choice name="role" label="Role" value="member" options={[['member', 'Member'], ['admin', 'Administrator']]} /></PostForm></Panel><Panel title="All users"><DataTable headers={['Name', 'Email', 'Role', 'Status', 'Passkeys', 'Last sign-in', 'Actions']} rows={rows} /></Panel><Panel title="Open invitations"><DataTable headers={['Email', 'Role', 'Expires', 'Actions']} rows={invites.map(invite => [invite.email, roleLabel(invite.role), stamp(invite.expires_at ?? invite.expiresAt), <PostForm action="/admin/users/cancel-invite" csrf={csrf} hidden={{ inviteId: invite.id }} submit="Cancel" />])} /></Panel></>;
}

export function PlatformSettings(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  return <><h1>Platform settings</h1><p class="muted">These rules apply to the whole platform.</p><div class="panel-grid"><Panel title="Version retention"><p>Older retained versions are deleted at the next publish. Public links remain unchanged.</p><PostForm action="/admin/settings/retention" csrf={p.me.csrf}><Field name="retention" label="Versions per artefact" type="number" min={1} max={10000} step={1} value={p.retention} required /></PostForm></Panel><Panel title="Reading records"><p>Content-blind observations contain no address, person or visitor identity. Reducing retention removes older records.</p><PostForm action="/admin/settings/analytics" csrf={p.me.csrf}><Field name="days" label="Days kept" type="number" min={1} max={365} step={1} value={p.analyticsRetention} required /></PostForm></Panel><Panel title="Sender address"><p>Used for invitations and explicitly requested sharing emails. Empty uses the Worker configuration.</p><PostForm action="/admin/settings/mail" csrf={p.me.csrf}><Field name="mailFrom" label="Sender address (From)" type="email" value={p.mailFrom} /></PostForm></Panel></div></>;
}

export function Reports(props: { p: PageProps }) {
  const p = untrack(() => props.p);
  return <><h1>Content reports</h1><p class="muted">Moderation metadata only. Staff status does not grant access to another estate's content or secret links.</p><Panel title="Reports"><DataTable headers={['Report', 'Artefact ID', 'Reason', 'Reported', 'Reporter', 'Status', 'Actions']} rows={(p.reports ?? []).map(report => [report.id, report.artifactId, report.reason, stamp(report.createdAt), report.reporterLabel || 'Anonymous', report.resolvedAt ? `Resolved ${stamp(report.resolvedAt)}` : 'Open', !report.resolvedAt && <PostForm action={`/admin/reports/${encodeURIComponent(report.id)}/resolve`} csrf={p.me.csrf} submit="Resolve" />])} empty="No reports." /></Panel></>;
}
