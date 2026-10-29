// Visitor shares: one named invitation, one link, one revocation (M6).
// Scope is live; gated links require prepared wraps, and legacy passwordless grants never expand.
import * as Effect from "effect/Effect";
import {
  PBKDF2_ITER, hex, makeVerifier, randomBytes, randomHex, scalarSeal, scalarUnseal,
  sealAES, sha256hex, unsealAES, verifyVerifier, wrapUnderPassword,
  type PasswordWrap, type SealRecord, type Verifier,
} from "./crypto.js";
import { normalizePath } from "./paths.js";
import type { Artifact, ArtifactRow, ArtifactCiphertext } from "./artifacts.js";
import type { Folder } from "./folders.js";
import { asCodeError, type CodeError, type DatabaseLike } from "./types.js";

const nowIso = () => new Date().toISOString();
const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const parseJson = <A>(value: string | null | undefined): A | null => {
  if (!value) return null;
  try { return JSON.parse(value) as A; } catch { return null; }
};
const DAY_MS = 86_400_000;
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 365;
const TOKEN_BYTES = 20;
export const SHARE_TOKEN_RE = /^[0-9a-f]{40}$/;
const SHARE_KEY_BYTES = 32;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const MAX_SHARE_NAME = 160;
const sharePassword = (password: unknown): string | null =>
  password == null || String(password) === "" ? null : String(password);

export type ShareKind = "artifact" | "folder";
export type ShareRow = {
  id: string; kind: ShareKind; target_id: string; owner_id: string; created_by: string;
  token_prefix: string; token_sealed: string; recipient_sealed: string; allow_protected: number;
  password_salt: string | null; password_verifier: string | null;
  key_wrap_password: string | null; key_wrap_master: string | null;
  created_at: string; expires_at: string; revoked_at: string | null; last_sent_at: string | null;
};
/** Internal projection; handlers receive ShareView or VisitorShare instead. */
export interface Share {
  id: string; kind: ShareKind; targetId: string; ownerId: string; createdBy: string;
  tokenPrefix: string; tokenSealed: string; recipientSealed: string; allowProtected: boolean;
  verifier: Verifier | null; wrapPassword: PasswordWrap | null; wrapMaster: SealRecord | null;
  createdAt: string; expiresAt: string; revokedAt: string | null; lastSentAt: string | null;
}
export interface ShareView {
  id: string; kind: ShareKind; targetId: string; name: string; recipient: string; url: string;
  createdAt: string; expiresAt: string; revokedAt: string | null; lastSentAt: string | null;
  gated: boolean; allowProtected: boolean;
}
export interface ManagedShare extends ShareView { ownerId: string }
export interface VisitorShare {
  id: string; kind: ShareKind; targetId: string; ownerId: string; gated: boolean;
  expiresAt: string; revokedAt: null;
}
export interface ResolvedShare {
  share: VisitorShare;
  artifact?: Artifact;
  folder?: Folder | null;
}
export interface ShareGatePayload {
  wrap: PasswordWrap; key: SealRecord;
  content: ArtifactCiphertext;
}
export type ShareMailStatus = "not-requested" | "unavailable" | "dry-run" | "sent" | "failed";
export interface CreatedShare extends ManagedShare { mailStatus: ShareMailStatus }
export interface ShareTargetInput { actorId?: unknown; kind?: unknown; targetId?: unknown }
export interface CreateShareInput extends ShareTargetInput {
  name?: unknown; recipient?: unknown; password?: unknown; expiresAt?: unknown; sendMail?: boolean;
}
export interface ResolveShareInput { path?: unknown; token?: unknown; artifactId?: unknown }
export interface ShareAccess {
  may(userId: unknown, resource: { ownerId?: string | null; folderId?: string | null }, need?: "read" | "write" | "manage" | "own"): Effect.Effect<boolean, CodeError>;
}
export interface ShareArtifacts {
  byId(id: unknown): Effect.Effect<Artifact | null, CodeError>;
  byPath(path: unknown): Effect.Effect<Artifact | null, CodeError>;
  toArtifact(row: ArtifactRow): Artifact;
  contentKey(artifact: Artifact): Effect.Effect<string, CodeError>;
  title(artifact: Artifact): Effect.Effect<string, CodeError>;
  ciphertext(artifact: Artifact): Effect.Effect<ArtifactCiphertext, CodeError>;
  path(artifact: Artifact): string;
  gated(artifact: Artifact): boolean;
  live(artifact: Artifact): boolean;
}
export interface ShareFolders {
  byId(id: unknown): Effect.Effect<Folder | null, CodeError>;
  byPath(path: unknown): Effect.Effect<Folder | null, CodeError>;
  subtreeIds(id: unknown): Effect.Effect<string[], CodeError>;
  ancestorIds(id: unknown): Effect.Effect<string[], CodeError>;
  name(folder: Folder): Effect.Effect<string, CodeError>;
  path(folder: Folder): string;
}
export interface ShareAudit {
  write(entry: { actorType: string; actorId: unknown; action: string; artifactId?: string | null; detail?: unknown }): Effect.Effect<void, CodeError>;
}
export interface ShareMailer {
  send(message: { to: string; from: string; subject: string; text: string }): Effect.Effect<{
    ok: boolean; dryRun?: boolean; error?: { message?: string };
  }, CodeError>;
}
export interface ShareSettings { mailFrom(): Effect.Effect<string, CodeError> }
export interface Shares {
  gated(share: Pick<Share, "wrapPassword"> | null | undefined): boolean;
  active(share: Pick<Share, "revokedAt" | "expiresAt"> | null | undefined, at?: number): boolean;
  byId(id: unknown): Effect.Effect<ManagedShare | null, CodeError>;
  syncArtifact(artifactId: unknown): Effect.Effect<void, CodeError>;
  syncFolder(folderId: unknown): Effect.Effect<void, CodeError>;
  create(input?: CreateShareInput): Effect.Effect<CreatedShare, CodeError>;
  listFor(input?: ShareTargetInput): Effect.Effect<ShareView[], CodeError>;
  revoke(input?: { actorId?: unknown; id?: unknown }): Effect.Effect<boolean, CodeError>;
  resolve(input?: ResolveShareInput): Effect.Effect<ResolvedShare | null, CodeError>;
  contents(shareId: unknown): Effect.Effect<Artifact[], CodeError>;
  verifyPassword(shareId: unknown, password: unknown): Effect.Effect<boolean, CodeError>;
  gatePayload(input?: { shareId?: unknown; artifactId?: unknown }): Effect.Effect<ShareGatePayload, CodeError>;
}
export interface ShareOptions {
  db: DatabaseLike; masterKeyHex: string; artifacts: ShareArtifacts; folders: ShareFolders; access: ShareAccess;
  audit?: ShareAudit | null; publicOrigin?: string; mailer?: ShareMailer | null;
  settings?: ShareSettings | null; iterations?: number;
}
type ManagedTarget = { artifact: Artifact; folder?: never } | { folder: Folder; artifact?: never };

export function openShares({
  db, masterKeyHex, artifacts, folders, access, audit = null,
  publicOrigin = "", mailer = null, settings = null, iterations = PBKDF2_ITER,
}: ShareOptions): Shares {
  if (!db) throw coded("invalid-db", "the share model requires a database");
  if (!artifacts || !folders) throw coded("invalid-models", "the share model requires the artefact and folder models");
  if (!access) throw coded("invalid-access", "the share model requires the access adapter");
  const origin = String(publicOrigin ?? "").replace(/\/+$/, "");

  const toShare = (row: ShareRow): Share => {
    const verifier = parseJson<Pick<Verifier, "viter" | "vhash">>(row.password_verifier);
    return {
      id: row.id, kind: row.kind, targetId: row.target_id, ownerId: row.owner_id, createdBy: row.created_by,
      tokenPrefix: row.token_prefix, tokenSealed: row.token_sealed, recipientSealed: row.recipient_sealed,
      allowProtected: row.allow_protected === 1,
      verifier: verifier && row.password_salt ? { vsalt: row.password_salt, viter: verifier.viter, vhash: verifier.vhash } : null,
      wrapPassword: parseJson<PasswordWrap>(row.key_wrap_password), wrapMaster: parseJson<SealRecord>(row.key_wrap_master),
      createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at ?? null, lastSentAt: row.last_sent_at ?? null,
    };
  };
  const load = (id: unknown) => Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT * FROM shares WHERE id = ?").bind(String(id ?? "")).first<ShareRow>(),
      catch: asCodeError,
    });
    return row ? toShare(row) : null;
  });
  const gated = (share: Pick<Share, "wrapPassword"> | null | undefined) => Boolean(share?.wrapPassword);
  const active = <A extends Pick<Share, "revokedAt" | "expiresAt">>(share: A | null | undefined, at = Date.now()): share is A =>
    share != null && !share.revokedAt && Date.parse(share.expiresAt) > at;

  // Recipient and manager label stay sealed and never enter a visitor DTO or the audit trail.
  const identityOf = (share: Share) => Effect.gen(function* () {
    const sealed = yield* scalarUnseal<{ e?: string; n?: string }>(masterKeyHex, share.recipientSealed);
    const recipient = String(sealed?.e ?? "");
    return { name: String(sealed?.n ?? "").trim() || recipient, recipient };
  });
  const tokenOf = (share: Share) => Effect.gen(function* () {
    return String((yield* scalarUnseal<{ t?: string }>(masterKeyHex, share.tokenSealed))?.t ?? "");
  });
  const basePath = (share: Share) => Effect.gen(function* () {
    if (share.kind === "artifact") {
      const artifact = yield* artifacts.byId(share.targetId);
      return artifact ? artifacts.path(artifact) : null;
    }
    const folder = yield* folders.byId(share.targetId);
    return folder ? folders.path(folder) : null;
  });
  const urlOf = (share: Share) => Effect.gen(function* () {
    const base = yield* basePath(share);
    return base ? `${origin}${base}s/${yield* tokenOf(share)}/` : "";
  });
  const safe = (share: Share): Effect.Effect<ShareView, CodeError> => Effect.gen(function* () {
    const { name, recipient } = yield* identityOf(share);
    return {
      id: share.id, kind: share.kind, targetId: share.targetId, name, recipient, url: yield* urlOf(share),
      createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: share.revokedAt,
      lastSentAt: share.lastSentAt, gated: gated(share), allowProtected: share.allowProtected,
    };
  });
  const byId = (id: unknown) => Effect.gen(function* () {
    const share = yield* load(id);
    return share ? { ...(yield* safe(share)), ownerId: share.ownerId } : null;
  });

  const ancestry = (folderId: string | null) => Effect.gen(function* () {
    return folderId ? [folderId, ...(yield* folders.ancestorIds(folderId))] : [];
  });
  const artifactsIn = (folderIds: string[]) => Effect.gen(function* () {
    const { results } = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT * FROM artifacts WHERE folder_id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(folderIds)).all<ArtifactRow>(),
      catch: asCodeError,
    });
    return results.map((row) => artifacts.toArtifact(row));
  });
  const scopeOf = (share: Share) => Effect.gen(function* () {
    if (share.kind === "artifact") {
      const artifact = yield* artifacts.byId(share.targetId);
      return artifact ? [artifact] : [];
    }
    return yield* artifactsIn(yield* folders.subtreeIds(share.targetId));
  });
  const covers = (share: Share, artifact: Artifact | null | undefined) => Effect.gen(function* () {
    if (!artifact || artifact.ownerId !== share.ownerId) return false;
    if (share.kind === "artifact") return artifact.id === share.targetId;
    if (!artifact.folderId) return false;
    return (yield* ancestry(artifact.folderId)).includes(share.targetId);
  });
  const activeSharesOn = (kind: ShareKind, targetIds: string[]) => Effect.gen(function* () {
    if (!targetIds.length) return [];
    const { results } = yield* Effect.tryPromise({
      try: async () => db.prepare(`SELECT * FROM shares WHERE kind = ? AND target_id IN (SELECT value FROM json_each(?))
         AND revoked_at IS NULL AND expires_at > ?`).bind(kind, JSON.stringify(targetIds), nowIso()).all<ShareRow>(),
      catch: asCodeError,
    });
    return results.map(toShare);
  });

  const shareKeyOf = (share: Share) => Effect.gen(function* () {
    const key = (yield* unsealAES<{ k?: string }>(masterKeyHex, share.wrapMaster))?.k;
    if (!key || !/^[0-9a-f]{64}$/i.test(key)) return yield* Effect.fail(coded("secrets-auth", "share key could not be unwrapped"));
    return key;
  });
  const wrapRow = (shareId: unknown, artifactId: unknown) => Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT key_wrap FROM share_keys WHERE share_id = ? AND artifact_id = ?")
        .bind(String(shareId ?? ""), String(artifactId ?? "")).first<{ key_wrap: string }>(),
      catch: asCodeError,
    });
    return parseJson<SealRecord>(row?.key_wrap);
  });
  const writeWrap = (share: Share, artifact: Artifact, shareKeyHex: string) => Effect.gen(function* () {
    if (yield* wrapRow(share.id, artifact.id)) return;
    const sealed = yield* sealAES(shareKeyHex, { k: yield* artifacts.contentKey(artifact) });
    yield* Effect.tryPromise({
      try: async () => db.prepare("INSERT OR REPLACE INTO share_keys (share_id, artifact_id, key_wrap, updated_at) VALUES (?,?,?,?)")
        .bind(share.id, artifact.id, JSON.stringify(sealed), nowIso()).run(),
      catch: asCodeError,
    });
  });
  const dropWrap = (shareId: string, artifactId: string) => Effect.tryPromise({
    try: async () => db.prepare("DELETE FROM share_keys WHERE share_id = ? AND artifact_id = ?")
      .bind(String(shareId), String(artifactId)).run(),
    catch: asCodeError,
  });
  const syncShare = (share: Share) => Effect.gen(function* () {
    if (!gated(share)) {
      yield* Effect.tryPromise({ try: async () => db.prepare("DELETE FROM share_keys WHERE share_id = ?").bind(share.id).run(), catch: asCodeError });
      return;
    }
    const shareKeyHex = yield* shareKeyOf(share);
    const scope = (yield* scopeOf(share)).filter((artifact) => artifacts.live(artifact));
    const wanted = new Set(scope.map((artifact) => artifact.id));
    const { results } = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT artifact_id FROM share_keys WHERE share_id = ?").bind(share.id).all<{ artifact_id: string }>(),
      catch: asCodeError,
    });
    for (const row of results) if (!wanted.has(row.artifact_id)) yield* dropWrap(share.id, row.artifact_id);
    for (const artifact of scope) yield* writeWrap(share, artifact, shareKeyHex);
  });
  const syncArtifact = (artifactId: unknown) => Effect.gen(function* () {
    const id = String(artifactId ?? "");
    if (!id) return;
    const artifact = yield* artifacts.byId(id);
    if (!artifact) {
      yield* Effect.tryPromise({ try: async () => db.prepare("DELETE FROM share_keys WHERE artifact_id = ?").bind(id).run(), catch: asCodeError });
      return;
    }
    const candidates = [
      ...(yield* activeSharesOn("artifact", [id])),
      ...(artifact.folderId ? yield* activeSharesOn("folder", yield* ancestry(artifact.folderId)) : []),
    ];
    const keep = new Map<string, Share>();
    for (const share of candidates) if (gated(share)) keep.set(share.id, share);
    const { results } = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT share_id FROM share_keys WHERE artifact_id = ?").bind(id).all<{ share_id: string }>(),
      catch: asCodeError,
    });
    for (const row of results) if (!keep.has(row.share_id)) yield* dropWrap(row.share_id, id);
    const wrapped = new Set(results.map((row) => row.share_id));
    for (const share of keep.values()) if (!wrapped.has(share.id)) yield* writeWrap(share, artifact, yield* shareKeyOf(share));
  });
  const syncFolder = (folderId: unknown) => Effect.gen(function* () {
    for (const artifact of yield* artifactsIn(yield* folders.subtreeIds(folderId))) {
      if (artifacts.live(artifact)) yield* syncArtifact(artifact.id);
    }
  });

  const requireManage = (actorId: unknown, kind: unknown, targetId: unknown): Effect.Effect<ManagedTarget, CodeError> => Effect.gen(function* () {
    if (kind !== "artifact" && kind !== "folder") return yield* Effect.fail(coded("invalid-kind", "a share is of an artefact or a folder"));
    const id = String(targetId ?? "");
    if (kind === "artifact") {
      const artifact = yield* artifacts.byId(id);
      if (!artifact) return yield* Effect.fail(coded("not-found", "no such artefact"));
      if (!(yield* access.may(actorId, { ownerId: artifact.ownerId, folderId: artifact.folderId }, "manage"))) {
        return yield* Effect.fail(coded("forbidden", "you may not manage shares of this artefact"));
      }
      return { artifact };
    }
    const folder = yield* folders.byId(id);
    if (!folder) return yield* Effect.fail(coded("not-found", "no such folder"));
    if (!(yield* access.may(actorId, { ownerId: folder.ownerId, folderId: folder.id }, "manage"))) {
      return yield* Effect.fail(coded("forbidden", "you may not manage shares of this folder"));
    }
    return { folder };
  });
  const expiryFrom = (value: unknown, at = Date.now()): string => {
    if (value == null || String(value) === "") return new Date(at + DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString();
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) throw coded("invalid-expiry", "that is not a date");
    if (parsed <= at) throw coded("invalid-expiry", "a share must expire in the future");
    if (parsed > at + MAX_EXPIRY_DAYS * DAY_MS) throw coded("invalid-expiry", `a share may last at most ${MAX_EXPIRY_DAYS} days`);
    return new Date(parsed).toISOString();
  };
  const shareLabel = (value: unknown): string => {
    const name = String(value ?? "").trim();
    if (!name) throw coded("invalid-name", "a share needs a name");
    if (name.length > MAX_SHARE_NAME) throw coded("invalid-name", `a share name may be at most ${MAX_SHARE_NAME} characters`);
    return name;
  };
  const recipientAddress = (recipient: unknown): string => {
    const email = String(recipient ?? "").trim();
    if (!email) return "";
    if (email.length > 254 || !EMAIL_RE.test(email)) throw coded("invalid-recipient", "that is not an e-mail address");
    return email;
  };
  const write = (action: string, actorId: unknown, detail: unknown, artifactId: string | null = null) => Effect.gen(function* () {
    if (audit) yield* audit.write({ actorType: "user", actorId: String(actorId ?? ""), action, artifactId, detail });
  });
  const mailLink = (share: Share, email: string, target: ManagedTarget): Effect.Effect<ShareMailStatus, CodeError> => Effect.gen(function* () {
    if (!mailer) return "unavailable";
    const url = yield* urlOf(share);
    const targetName = target.artifact ? (yield* artifacts.title(target.artifact)) || "an artefact" : (yield* folders.name(target.folder)) || "a folder";
    const lines = [`You have been given access to ${targetName}.`, "", url, "",
      ...(gated(share) ? ["The link is password-protected; the password comes to you separately.", ""] : []),
      `The link stops working on ${String(share.expiresAt).slice(0, 10)}.`];
    return yield* Effect.catch(Effect.gen(function* () {
      const from = settings ? yield* settings.mailFrom() : "";
      const result = yield* mailer.send({ to: email, from, subject: `${targetName} — shared with you`, text: lines.join("\n") });
      if (result.ok !== true) return yield* Effect.fail(coded("mail-failed", result.error?.message || "the invitation could not be sent"));
      if (result.dryRun) return "dry-run" as const;
      yield* Effect.tryPromise({ try: async () => db.prepare("UPDATE shares SET last_sent_at = ? WHERE id = ?").bind(nowIso(), share.id).run(), catch: asCodeError });
      return "sent" as const;
    }), (error) => Effect.gen(function* () {
      // Losing the courier must not lose the already-created link.
      yield* write("share.mail-failed", share.createdBy, { shareId: share.id, error: error.code ?? "mail-failed" });
      return "failed" as const;
    }));
  });

  const create = ({ actorId, kind, targetId, name: rawName, recipient, password: rawPassword = null, expiresAt = null, sendMail = false }: CreateShareInput = {}): Effect.Effect<CreatedShare, CodeError> => Effect.gen(function* () {
    const target = yield* requireManage(actorId, kind, targetId);
    if (target.folder?.parentId) return yield* Effect.fail(coded("folder-not-top-level", "only a top-level folder can be shared"));
    const name = yield* Effect.try({ try: () => shareLabel(rawName), catch: asCodeError });
    const email = yield* Effect.try({ try: () => recipientAddress(recipient), catch: asCodeError });
    if (sendMail === true && !email) return yield* Effect.fail(coded("recipient-required", "sending the invitation needs an e-mail address"));
    const expires = yield* Effect.try({ try: () => expiryFrom(expiresAt), catch: asCodeError });
    const password = sharePassword(rawPassword);
    const id = yield* randomHex(8), token = yield* randomHex(TOKEN_BYTES);
    const verifier = password === null ? null : yield* makeVerifier(password);
    const shareKeyHex = password === null ? null : hex(yield* randomBytes(SHARE_KEY_BYTES));
    const ownerId = target.artifact ? target.artifact.ownerId : target.folder.ownerId;
    const at = nowIso();
    const tokenHash = yield* sha256hex(token);
    const tokenSealed = yield* scalarSeal(masterKeyHex, { t: token });
    const recipientSealed = yield* scalarSeal(masterKeyHex, { e: email, n: name });
    const wrapPassword = shareKeyHex === null ? null : JSON.stringify(yield* wrapUnderPassword(password, { k: shareKeyHex }, iterations));
    const wrapMaster = shareKeyHex === null ? null : JSON.stringify(yield* sealAES(masterKeyHex, { k: shareKeyHex }));
    yield* Effect.tryPromise({
      try: async () => db.prepare(
        "INSERT INTO shares (id, kind, target_id, owner_id, created_by, token_hash, token_prefix, token_sealed," +
        " recipient_sealed, password_salt, password_verifier, key_wrap_password, key_wrap_master," +
        " created_at, expires_at, allow_protected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(id, kind, String(targetId), ownerId, String(actorId ?? ""), tokenHash, token.slice(0, 8), tokenSealed,
        recipientSealed, verifier?.vsalt ?? null, verifier ? JSON.stringify({ viter: verifier.viter, vhash: verifier.vhash }) : null,
        wrapPassword, wrapMaster, at, expires, password === null ? 1 : 0).run(),
      catch: asCodeError,
    });
    const share = yield* load(id);
    if (!share) return yield* Effect.fail(coded("not-found", "no such share"));
    yield* Effect.catch(syncShare(share), (error) => Effect.gen(function* () {
      yield* Effect.tryPromise({ try: async () => db.prepare("DELETE FROM share_keys WHERE share_id = ?").bind(id).run(), catch: asCodeError });
      yield* Effect.tryPromise({ try: async () => db.prepare("DELETE FROM shares WHERE id = ?").bind(id).run(), catch: asCodeError });
      return yield* Effect.fail(error);
    }));
    yield* write("share.create", actorId, { shareId: id, kind, targetId: String(targetId), tokenPrefix: token.slice(0, 8), gated: password !== null, expiresAt: expires }, target.artifact?.id ?? null);
    const mailStatus = sendMail === true ? yield* mailLink(share, email, target) : "not-requested";
    const view = yield* byId(id);
    if (!view) return yield* Effect.fail(coded("not-found", "no such share"));
    return { ...view, mailStatus };
  });
  const listFor = ({ actorId, kind, targetId }: ShareTargetInput = {}) => Effect.gen(function* () {
    yield* requireManage(actorId, kind, targetId);
    const { results } = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT * FROM shares WHERE kind = ? AND target_id = ? ORDER BY created_at DESC")
        .bind(String(kind), String(targetId ?? "")).all<ShareRow>(), catch: asCodeError,
    });
    return yield* Effect.all(results.map((row) => safe(toShare(row))));
  });
  const revoke = ({ actorId, id }: { actorId?: unknown; id?: unknown } = {}) => Effect.gen(function* () {
    const share = yield* load(id);
    if (!share) return false;
    yield* requireManage(actorId, share.kind, share.targetId);
    if (share.revokedAt) return false;
    yield* Effect.tryPromise({ try: async () => db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), share.id).run(), catch: asCodeError });
    yield* Effect.tryPromise({ try: async () => db.prepare("DELETE FROM share_keys WHERE share_id = ?").bind(share.id).run(), catch: asCodeError });
    yield* write("share.revoke", actorId, { shareId: share.id, kind: share.kind, targetId: share.targetId }, share.kind === "artifact" ? share.targetId : null);
    return true;
  });

  // A missing gated wrap fails closed; ungated policy comes only from the persisted flag.
  const servable = (share: Share, artifact: Artifact | null | undefined, isGated: boolean) => Effect.gen(function* () {
    if (!artifact || !artifacts.live(artifact)) return false;
    if (!isGated) return share.allowProtected || !artifacts.gated(artifact);
    return Boolean(yield* wrapRow(share.id, artifact.id));
  });
  const resolve = ({ path, token, artifactId = null }: ResolveShareInput = {}): Effect.Effect<ResolvedShare | null, CodeError> => Effect.gen(function* () {
    const presented = String(token ?? "").toLowerCase();
    if (!SHARE_TOKEN_RE.test(presented)) return null;
    const clean = normalizePath(path);
    if (!clean) return null;
    const hash = yield* sha256hex(presented);
    const row = yield* Effect.tryPromise({ try: async () => db.prepare("SELECT * FROM shares WHERE token_hash = ?").bind(hash).first<ShareRow>(), catch: asCodeError });
    const share = row ? toShare(row) : null;
    if (!active(share)) return null;
    const isGated = gated(share);
    const view: VisitorShare = { id: share.id, kind: share.kind, targetId: share.targetId, ownerId: share.ownerId, gated: isGated, expiresAt: share.expiresAt, revokedAt: null };
    if (share.kind === "artifact") {
      const target = yield* artifacts.byPath(clean);
      if (!target || target.id !== share.targetId) return null;
      if (artifactId != null && String(artifactId) !== target.id) return null;
      if (!(yield* servable(share, target, isGated))) return null;
      return { share: view, artifact: target, folder: target.folderId ? yield* folders.byId(target.folderId) : null };
    }
    const folder = yield* folders.byPath(clean);
    if (!folder || folder.id !== share.targetId) return null;
    if (artifactId == null) return { share: view, folder };
    const artifact = yield* artifacts.byId(String(artifactId));
    if (!artifact || !(yield* covers(share, artifact)) || !(yield* servable(share, artifact, isGated))) return null;
    return { share: view, folder, artifact };
  });
  const contents = (shareId: unknown) => Effect.gen(function* () {
    const share = yield* load(shareId);
    if (!active(share) || share.kind !== "folder") return [];
    const out: Artifact[] = [];
    for (const artifact of yield* scopeOf(share)) if (yield* servable(share, artifact, gated(share))) out.push(artifact);
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  });
  const verifyPassword = (shareId: unknown, password: unknown) => Effect.gen(function* () {
    const share = yield* load(shareId);
    return share?.verifier ? yield* verifyVerifier(password, share.verifier) : false;
  });
  const gatePayload = ({ shareId, artifactId }: { shareId?: unknown; artifactId?: unknown } = {}): Effect.Effect<ShareGatePayload, CodeError> => Effect.gen(function* () {
    const share = yield* load(shareId);
    if (!active(share)) return yield* Effect.fail(coded("not-found", "no such share"));
    if (!share.wrapPassword) return yield* Effect.fail(coded("not-gated", "this share has no password"));
    const artifact = yield* artifacts.byId(String(artifactId ?? ""));
    if (!artifact || !(yield* covers(share, artifact)) || !artifacts.live(artifact)) return yield* Effect.fail(coded("not-found", "no such document"));
    const key = yield* wrapRow(share.id, artifact.id);
    if (!key) return yield* Effect.fail(coded("wrap-missing", "this document is not prepared for this share"));
    return { wrap: share.wrapPassword, key, content: yield* artifacts.ciphertext(artifact) };
  });
  return { gated, active, byId, syncArtifact, syncFolder, create, listFor, revoke, resolve, contents, verifyPassword, gatePayload };
}
