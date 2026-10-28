// Compatible controller-facing renderers. Only trusted bootstrap data enters the parent;
// authored HTML is loaded separately by the opaque iframe runtime.
import type { ColleagueGrant, EstateRole } from "./access.js";
import type { RuntimeSource, ViewerDescriptor, ViewerPermissions } from "./artifact-runtime.js";
import type { ArtifactVersion } from "./artifacts.js";
import type { FolderContents } from "./folders.js";
import type { ShareView } from "./shares.js";
import type { AuditRow, InviteRow, User } from "./store.js";
import type { PasskeySummary } from "./webauthn.js";

export interface Standing extends ViewerPermissions { role: EstateRole | null }
export interface ArtifactViewInput {
  id?: string; ref?: string; title?: string; displayTitle?: string; lang?: string;
  gated?: boolean; currentVersion?: number; folderId?: string | null; role?: EstateRole | null;
  ownerId?: string; ownerName?: string; slug?: string | null; path?: string;
}
export interface DestinationViewInput {
  id: string; ref?: string; name?: string; path?: string; depth?: number; ownerId?: string; ownerName?: string;
  role?: EstateRole | null; permissions?: Partial<Standing>;
}
export interface EstateTreeNode {
  id: string; ref: string; name: string; slug: string | null; path: string;
  parentId: string | null; ownerId: string; ownerName: string; role: EstateRole;
  displayName?: string; parentName?: string; topLevel?: boolean; subtreeArtefacts?: number;
  children: EstateTreeNode[]; artefacts: ArtifactViewInput[];
}
export interface FolderViewInput {
  id?: string; ref?: string; name?: string; displayName?: string; parentId?: string | null;
  parentName?: string; ownerId?: string; ownerName?: string; role?: EstateRole | null;
  topLevel?: boolean; subtreeArtefacts?: number; slug?: string | null; path?: string;
  children?: FolderViewInput[]; artefacts?: ArtifactViewInput[];
}
export interface StatsViewInput {
  opens?: number; activeSeconds?: number; maxScroll?: number; lastOpenedAt?: string | null;
  scroll25?: number; scroll50?: number; scroll75?: number; scroll100?: number; shares?: number;
}
export type UserViewInput = Partial<Pick<User, "id" | "email" | "name" | "role" | "status" | "lastLoginAt" | "passkeys">> & {
  csrf?: string; totpEnrolled?: boolean; passkeyCount?: number;
};
export interface KeyViewInput {
  id?: string; prefix?: string; label?: string | null; kind?: string; scopes?: string;
  artifactId?: string | null; artifact_id?: string | null; createdAt?: string;
  lastUsedAt?: string | null; revokedAt?: string | null; revoked_at?: string | null;
}
export interface ViewProps {
  title?: string; sub?: string; body?: string; main?: string; tabRow?: string; reading?: boolean;
  bootstrap?: boolean; error?: string; notice?: string; email?: string; csrf?: string;
  hasPasskey?: boolean; intro?: string; inviteLink?: string; retention?: number;
  analyticsRetention?: number; mailFrom?: string; pendingInvites?: number; secret?: string; otpauth?: string; operator?: string;
  me?: UserViewInput | null; caps?: Partial<Standing>;
  estate?: { mine: EstateTreeNode[]; shared: EstateTreeNode[]; unfiled: ArtifactViewInput[] };
  estateOmitted?: boolean;
  values?: Partial<Record<"name" | "email" | "folder" | "newFolder" | "newFolderSlug" | "title" | "slug" | "lang" | "html" | "retiredPaths", string>>;
  invite?: { token?: string; email?: string; inviterName?: string };
  artifact?: ArtifactViewInput | null; folder?: FolderViewInput | null; viewer?: ViewerDescriptor | null;
  folders?: DestinationViewInput[]; moveTargets?: DestinationViewInput[]; duplicateFolders?: DestinationViewInput[];
  aliases?: string[]; versions?: ArtifactVersion[]; passkeys?: PasskeySummary[]; keys?: KeyViewInput[];
  artifacts?: Array<{ id: string; slug?: string | null }>; users?: UserViewInput[];
  invites?: Array<Partial<InviteRow> & { expiresAt?: string }>;
  grants?: ColleagueGrant[];
  counts?: { users?: number; active?: number; suspended?: number }; audit?: AuditRow[];
  reports?: Array<{ id: string; artifactId?: string; reason?: string; createdAt?: string; resolvedAt?: string | null; reporterLabel?: string }>;
  analytics?: { totals: StatsViewInput; days: Array<StatsViewInput & { day: string }> } | null;
  shares?: ShareView[]; shareStats?: Map<string, StatsViewInput> | Record<string, StatsViewInput>;
  expiryDefault?: string; expiryMax?: string; folderContents?: FolderContents | null;
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, character => entities[character]!);
/** The public source repository (spec §D4): the only definition; docs read it, auth screens get it as payload `source`. */
export const SOURCE_URL = "https://github.com/wsagency/artefacts67";
/** WS design kit (spec §D3/§D5): its stylesheets go before the page's own CSS, the favicons after it. */
export const KIT_CSS = ["fonts", "tokens", "footer"].map(file => `<link rel="stylesheet" href="/assets/ws-design-kit/${file}.css">`).join("");
const PRODUCT = "/assets/ws-design-kit/products/artefacts67/original";
export const FAVICONS = `<link rel="icon" type="image/svg+xml" href="${PRODUCT}/favicon.svg"><link rel="icon" href="/assets/favicon.ico">`;
/** The kit's product-logo snippet at 180 px, for kit-scoped pages that follow the system appearance. */
export const PRODUCT_LOGO = `<picture><source media="(prefers-color-scheme: dark)" srcset="${PRODUCT}/logo-white.svg"><img src="${PRODUCT}/logo-color.svg" alt="Artefacts67" width="180" style="max-width:100%;height:auto"></picture>`;
export const group4 = (value: unknown): string => String(value ?? "").replace(/(.{4})/g, "$1 ").trim();
const platformLabels: Record<string, string> = { owner: "Owner", admin: "Administrator", member: "Member" };
const estateLabels: Record<string, string> = { owner: "Owner", manager: "Manager", editor: "Editor", viewer: "Viewer" };
const ranks: Record<string, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 };
export const roleLabel = (role: string): string => platformLabels[role] ?? role;
export const grantLabel = (role: string): string => estateLabels[role] ?? role;
export const atLeast = (role: string | null | undefined, need: string): boolean => (ranks[role ?? ""] ?? 0) >= (ranks[need] ?? 99);
export const duration = (seconds: unknown): string => {
  const total = Math.max(0, Math.round(Number(seconds ?? 0)));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return minutes < 60 ? `${minutes}m ${total % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
function pick<T extends object, K extends keyof T>(value: T | null | undefined, names: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of names) if (value?.[key] !== undefined) out[key] = value[key];
  return out;
}
const capsView = (value?: Partial<Standing> | null) => pick(value, ["read", "write", "manage", "own", "role"]);
const versionView = (value: ArtifactVersion) => pick(value, ["version", "createdAt", "size", "authorType", "note"]);
const destinationView = (value: DestinationViewInput) => ({ ...pick(value, ["id", "ref", "name", "depth", "ownerId", "ownerName", "role"]), permissions: capsView(value.permissions) });
const artifactView = (value?: ArtifactViewInput | null, showPaths = false): ArtifactViewInput => ({
  ...pick(value, ["id", "ref", "title", "displayTitle", "lang", "gated", "currentVersion", "folderId", "role", "ownerId", "ownerName"]),
  ...(showPaths ? pick(value, ["slug", "path"]) : {}),
});
interface FolderProjection extends Partial<Pick<FolderViewInput, "id" | "ref" | "name" | "displayName" | "parentId" | "parentName" | "ownerId" | "ownerName" | "role" | "topLevel" | "subtreeArtefacts" | "slug" | "path">> {
  children: Array<FolderProjection | null>; artefacts: ArtifactViewInput[];
}
function folderView(value?: FolderViewInput | null, showPaths = false): FolderProjection | null {
  if (!value) return null;
  return {
    ...pick(value, ["id", "ref", "name", "displayName", "parentId", "parentName", "ownerId", "ownerName", "role", "topLevel", "subtreeArtefacts"]),
    ...(showPaths ? pick(value, ["slug", "path"]) : {}),
    children: (value.children ?? []).map(child => folderView(child, showPaths)),
    artefacts: (value.artefacts ?? []).map(artifact => artifactView(artifact, showPaths)),
  };
}
interface RuntimeProjection {
  kind: RuntimeSource["kind"]; path?: string; token?: string; artifactId?: string | null;
}
/** The one safe projection for viewer descriptors. Internal version/storage/author fields
 * (r2Key, sha256, authorId, …) never reach the visitor, including gated share child indexes. */
export const viewerView = (value?: ViewerDescriptor | null) => {
  if (!value) return null;
  return {
    ...pick(value, ["title", "gated", "protected", "mode", "loadUrl", "gateUrl", "signedIn", "csrf", "actionBase", "artifactRef", "currentVersion", "lang", "data"]),
    ...(value.runtime.kind !== "console" || value.permissions.manage ? pick(value, ["publicUrl"]) : {}),
    runtime: pick<RuntimeProjection, keyof RuntimeProjection>(value.runtime, ["kind", "path", "token", "artifactId"]),
    permissions: capsView(value.permissions),
    folders: value.folders.map(destinationView),
    ...(value.actionBase ? { versions: (value.versions ?? []).map(versionView) } : {}),
  };
};
const statsView = (value?: StatsViewInput | null) => pick(value, ["opens", "activeSeconds", "maxScroll", "lastOpenedAt", "scroll25", "scroll50", "scroll75", "scroll100", "shares"]);
function bootstrapProps(screen: string, props: ViewProps) {
  // Controllers may pass full models. Never serialize those models wholesale.
  const out = {
    ...pick(props, ["title", "sub", "body", "main", "tabRow", "reading", "bootstrap", "error", "notice", "email", "csrf", "hasPasskey", "intro", "inviteLink", "retention", "analyticsRetention", "mailFrom", "pendingInvites", "operator"]),
    source: SOURCE_URL,
    ...(screen === "enroll" ? pick(props, ["secret", "otpauth"]) : {}),
    ...(screen === "keys" ? pick(props, ["secret"]) : {}),
    me: pick(props.me, ["id", "email", "name", "role", "status", "csrf", "totpEnrolled", "passkeyCount", "lastLoginAt"]),
    caps: capsView(props.caps),
    ...(props.estateOmitted ? { estateOmitted: true } : { estate: {
      mine: (props.estate?.mine ?? []).map(folder => folderView(folder)),
      shared: (props.estate?.shared ?? []).map(folder => folderView(folder)),
      unfiled: (props.estate?.unfiled ?? []).map(artifact => artifactView(artifact)),
    } }),
    values: pick(props.values, ["name", "email", "folder", "newFolder", "newFolderSlug", "title", "slug", "lang", "html", "retiredPaths"]),
    invite: pick(props.invite, ["token", "email", "inviterName"]),
    artifact: artifactView(props.artifact, Boolean(props.caps?.write)),
    folder: folderView(props.folder, Boolean(props.caps?.write)),
    viewer: viewerView(props.viewer),
    folders: (props.folders ?? []).map(destinationView),
    moveTargets: (props.moveTargets ?? []).map(destinationView),
    duplicateFolders: props.duplicateFolders?.map(destinationView),
    aliases: props.caps?.write ? props.aliases ?? [] : [],
    versions: (props.versions ?? []).map(versionView),
    passkeys: (props.passkeys ?? []).map(key => pick(key, ["id", "name", "createdAt", "lastUsedAt"])),
    keys: (props.keys ?? []).map(key => pick(key, ["id", "prefix", "label", "kind", "scopes", "artifactId", "artifact_id", "createdAt", "lastUsedAt", "revokedAt", "revoked_at"])),
    artifacts: (props.artifacts ?? []).map(artifact => pick(artifact, ["id", "slug"])),
    users: (props.users ?? []).map(user => ({ ...pick(user, ["id", "name", "email", "role", "status", "lastLoginAt"]), passkeyCount: user.passkeys?.length ?? 0 })),
    invites: (props.invites ?? []).map(invite => pick(invite, ["id", "email", "role", "expires_at", "expiresAt"])),
    counts: pick(props.counts, ["users", "active", "suspended"]),
    audit: (props.audit ?? []).map(entry => ({ ...pick(entry, ["at", "actor_type", "actor_id", "action", "artifact_id"]), detail: String(entry.detail ?? "").slice(0, 90) })),
    reports: (props.reports ?? []).map(report => pick(report, ["id", "artifactId", "reason", "createdAt", "resolvedAt", "reporterLabel"])),
    ...(props.caps?.manage || screen === "adminHome" ? (props.analytics ? { analytics: { totals: statsView(props.analytics.totals), days: props.analytics.days.map(day => ({ ...statsView(day), day: day.day })) } } : {}) : {}),
    ...(props.caps?.manage ? {
      shares: (props.shares ?? []).map(share => pick(share, ["id", "name", "recipient", "url", "gated", "allowProtected", "createdAt", "expiresAt", "revokedAt"])),
      shareStats: Object.fromEntries((props.shareStats instanceof Map ? [...props.shareStats] : Object.entries(props.shareStats ?? {})).map(([key, value]) => [key, statsView(value)])),
      ...pick(props, ["expiryDefault", "expiryMax"]),
    } : {}),
    ...(props.caps?.own ? {
      grants: (props.grants ?? []).map(grant => pick(grant, ["userId", "name", "email", "role", "inherited"])),
      ...(props.folderContents ? { folderContents: pick(props.folderContents, ["folders", "subfolders", "artefacts", "unpublished", "versions", "collections", "records", "responses", "files", "shares", "snapshot", "tooLarge"]) } : {}),
    } : {}),
  };
  return out;
}
// ponytail: module-level, set at the start of every fetch (index.ts) from WEB_ANALYTICS_TOKEN; safe because
// a deployment's vars are the same for every request. Thread it through ViewProps if that ever changes.
let webAnalyticsToken = "";
export const setWebAnalyticsToken = (value: unknown): void => { webAnalyticsToken = String(value ?? "").trim(); };
/** Cloudflare Web Analytics beacon: deployment config, emitted only when the operator set a token. */
const beacon = (): string => webAnalyticsToken
  ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${esc(JSON.stringify({ token: webAnalyticsToken }))}'></script>`
  : "";
function page(screen: string, title: string | undefined, props: ViewProps = {}): string {
  const data = JSON.stringify({ screen, props: bootstrapProps(screen, props) })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html lang="en" data-console-theme="original"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)} · Artefacts67</title>${KIT_CSS}<link rel="stylesheet" href="/_ui/console.css">${FAVICONS}<script>try{var t=JSON.parse(localStorage.getItem('wsa-console-theme'));if(['original','light','calm'].includes(t))document.documentElement.dataset.consoleTheme=t}catch(e){}</script></head><body><div id="root"></div><noscript>This console requires JavaScript. Enable it to sign in or open this artefact.</noscript><script id="ws-bootstrap" type="application/json">${data}</script><script type="module" src="/_ui/console.js"></script>${beacon()}</body></html>`;
}
export const layout = (props: ViewProps) => page("layout", props.title, props);
export const shell = (props: ViewProps) => page("shell", props.title, props);
export const homeView = (props: ViewProps = {}) => page("home", "Home", props);
export const loginView = (props: ViewProps = {}) => page("login", "Sign in", props);
export const registerView = (props: ViewProps = {}) => page("register", "Owner setup", props);
export const acceptView = (props: ViewProps = {}) => page("accept", "Invitation", props);
export const twoFaView = (props: ViewProps = {}) => page("twoFa", "Two-factor", props);
export const enrollView = (props: ViewProps = {}) => page("enroll", "Two-factor setup", props);
export const messageView = (props: ViewProps = {}) => page("message", props.title, props);
export const appHomeView = (props: ViewProps = {}) => page("appHome", "Artefacts", props);
export const appNewView = (props: ViewProps = {}) => page("appNew", "New artefact", props);
export const appFolderNewView = (props: ViewProps = {}) => page("appFolderNew", "New folder", props);
export const folderPaneView = (props: ViewProps = {}) => page("folderPane", props.folder?.displayName, props);
export const artefactPaneView = (props: ViewProps = {}) => page("artefactPane", props.artifact?.displayTitle, props);
export const artefactReaderView = (props: ViewProps = {}) => page("artefactReader", props.artifact?.displayTitle, props);
export const artifactViewerView = (props: ViewProps = {}) => page("artifactViewer", props.title ?? props.viewer?.title, props);
export const settingsView = (props: ViewProps = {}) => page("settings", "Account & security", props);
export const keysView = (props: ViewProps = {}) => page("keys", "API keys", props);
export const adminHomeView = (props: ViewProps = {}) => page("adminHome", "Administration", props);
export const usersView = (props: ViewProps = {}) => page("users", "Users & invitations", props);
export const platformSettingsView = (props: ViewProps = {}) => page("platformSettings", "Platform settings", props);
export const reportsView = (props: ViewProps = {}) => page("reports", "Content reports", props);
