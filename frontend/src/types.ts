import type { CompiledTheme } from './theme-compiler';
import type { JSX } from '@solidjs/web';

export type Role = 'owner' | 'admin' | 'member' | 'manager' | 'editor' | 'viewer';

export interface Me {
  id: string;
  email: string;
  name?: string;
  role: Role;
  status?: string;
  csrf: string;
  totpEnrolled?: boolean;
  passkeyCount?: number;
  lastLoginAt?: string;
}

export interface Capabilities {
  read?: boolean;
  write?: boolean;
  manage?: boolean;
  own?: boolean;
}

export interface ArtifactSummary {
  id: string;
  ref: string;
  title?: string;
  displayTitle?: string;
  slug?: string;
  path?: string;
  lang?: string;
  gated?: boolean;
  ownerId?: string;
  ownerName?: string;
  folderId?: string;
}

export interface Folder {
  id: string;
  ref: string;
  name: string;
  displayName?: string;
  slug?: string;
  path?: string;
  parentName?: string;
  ownerId?: string;
  ownerName?: string;
  role?: Role;
  depth?: number;
  topLevel?: boolean;
  subtreeArtefacts?: number;
  children?: Folder[];
  artefacts?: ArtifactSummary[];
}

export interface Estate {
  mine?: Folder[];
  shared?: Folder[];
  unfiled?: ArtifactSummary[];
}

export interface Version {
  version: number;
  createdAt?: string;
  size?: number;
  authorType?: string;
  note?: string;
}

export interface ShareStats {
  opens?: number;
  activeSeconds?: number;
  maxScroll?: number;
  lastOpenedAt?: string;
  scroll25?: number;
  scroll50?: number;
  scroll75?: number;
  scroll100?: number;
  shares?: number;
}

export interface Share {
  id: string;
  name: string;
  recipient?: string;
  url: string;
  gated?: boolean;
  allowProtected?: boolean;
  createdAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface AnalyticsSummary {
  totals?: ShareStats;
  days?: Array<ShareStats & { day: string }>;
}

export interface Grant {
  userId: string;
  name?: string;
  email: string;
  role: Role;
  inherited?: boolean;
}

export interface ViewerDescriptor {
  title?: string;
  gated?: boolean;
  protected?: boolean;
  mode?: string;
  loadUrl?: string;
  gateUrl?: string;
  signedIn?: boolean;
  csrf?: string;
  actionBase?: string;
  artifactRef?: string;
  currentVersion?: number;
  lang?: string;
  documentOrigin?: string;
  publicUrl?: string;
  runtime?: RuntimeSource;
  permissions?: Capabilities;
  folders?: Destination[];
  versions?: Version[];
  data?: { collections: Array<{ name: string; kind: 'records' | 'responses' }> } | null;
}

export interface RuntimeSource {
  kind?: string;
  path?: string;
  token?: string;
  artifactId?: string;
}

export interface Destination {
  id: string;
  ref?: string;
  name?: string;
  displayName?: string;
  ownerName?: string;
  depth?: number;
}

export interface PagePresentation {
  type: 'page';
  theme: { scope: 'platform' | 'project'; slug: string } | null;
  brandLock: boolean;
  lang?: string;
  compiledTheme?: CompiledTheme;
}
export interface OpenedArtifact {
  html: string;
  permissions: Readonly<Capabilities>;
  page?: PagePresentation;
  index?: Array<{ title: string; viewer: ViewerDescriptor }>;
}

export interface PageValues {
  name?: string;
  email?: string;
  folder?: string;
  newFolder?: string;
  newFolderSlug?: string;
  title?: string;
  slug?: string;
  lang?: string;
  html?: string;
  password?: string;
  retiredPaths?: string;
}

export interface PasskeyRecord {
  id: string;
  name?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface ApiKeyRecord {
  id: string;
  prefix?: string;
  label?: string;
  kind: string;
  scopes?: string;
  artifactId?: string;
  artifact_id?: string;
  createdAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revoked_at?: string;
}

export interface UserRecord {
  id: string;
  name?: string;
  email: string;
  role: Role;
  status?: string;
  passkeyCount?: number;
  lastLoginAt?: string;
}

export interface InviteRecord {
  id: string;
  email: string;
  role: Role;
  expires_at?: string;
  expiresAt?: string;
}

export interface AuditRecord {
  at?: string;
  actor_type?: string;
  actor_id?: string;
  action?: string;
  artifact_id?: string;
  detail?: string;
}

export interface ReportRecord {
  id: string;
  artifactId?: string;
  reason?: string;
  createdAt?: string;
  resolvedAt?: string;
  reporterLabel?: string;
}

export interface ArtifactRecord extends ArtifactSummary {
  currentVersion?: number;
  role?: Role;
}

export interface PageProps {
  me: Me;
  csrf?: string;
  error?: string;
  notice?: string;
  title?: string;
  sub?: string;
  body?: string;
  main?: string;
  email?: string;
  hasPasskey?: boolean;
  bootstrap?: boolean;
  intro?: string;
  operator?: string;
  source?: string;
  inviteLink?: string;
  invite?: { token?: string; email?: string; inviterName?: string };
  values?: PageValues;
  estate?: Estate;
  estateOmitted?: boolean;
  caps?: Capabilities;
  folders?: Destination[];
  moveTargets?: Destination[];
  duplicateFolders?: Destination[];
  aliases?: string[];
  folder?: Folder;
  artifact?: ArtifactRecord;
  versions?: Version[];
  viewer?: ViewerDescriptor | null;
  passkeys?: PasskeyRecord[];
  keys?: ApiKeyRecord[];
  artifacts?: Array<{ id: string; slug?: string }>;
  secret?: string;
  otpauth?: string;
  analytics?: AnalyticsSummary;
  shares?: Share[];
  shareStats?: Record<string, ShareStats>;
  grants?: Grant[];
  /** Owner only: everything deleting this folder removes (ADR 0038), the snapshot the deletion confirms, and the refusal when over the cap. */
  folderContents?: {
    folders: number; subfolders: number; artefacts: number; unpublished: number; versions: number;
    collections: number; records: number; responses: number; files: number; shares: number;
    snapshot: string; tooLarge: string | null;
  };
  expiryDefault?: string;
  expiryMax?: string;
  counts?: { users?: number; active?: number; suspended?: number };
  pendingInvites?: number;
  audit?: AuditRecord[];
  users?: UserRecord[];
  invites?: InviteRecord[];
  reports?: ReportRecord[];
  retention?: number;
  analyticsRetention?: number;
  mailFrom?: string;
}

export interface BootstrapPayload {
  screen: string;
  props: PageProps;
}

export type TableCell = JSX.Element;
export type TableRow = TableCell[];
