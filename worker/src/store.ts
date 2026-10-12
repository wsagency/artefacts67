// Typed D1 adapters over the existing relational tables (ADR 0013).
// Factories and row projections stay pure; every binding operation is lazy.

import * as Effect from "effect/Effect";
import { randomHex, sha256hex, type Verifier } from "./crypto.js";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike, type D1Result } from "./types.js";

const nowIso = () => new Date().toISOString();
const io = <A>(operation: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(operation()), catch: asCodeError });
const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });

export const newId = (): Effect.Effect<string, CodeError> => randomHex(8);
export type Role = "member" | "admin" | "owner";
export type InviteRole = "member" | "admin";
export type UserStatus = "active" | "suspended";
export type PasskeyKey =
  | { alg: -8; kty: 1; crv: 6; x: string }
  | { alg: -7; kty: 2; crv: 1; x: string; y: string };
export type PasskeyRecord = PasskeyKey & {
  id: string;
  name: string;
  signCount: number;
  createdAt: string;
  lastUsedAt: string | null;
};
export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  passwordHash: string;
  totpSecretSealed: string | null;
  totpSecretPendingSealed: string | null;
  passkeys: PasskeyRecord[];
  invitedBy: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}
export type UserRow = {
  id: string; email: string; name: string | null; role: Role; status: UserStatus;
  password_hash: string; totp_secret_sealed: string | null; totp_secret_pending_sealed: string | null;
  passkeys: string; invited_by: string | null; created_at: string; last_login_at: string | null;
};
export interface CreateUser {
  id: string; email: string; name?: string | null; role: Role; status?: UserStatus;
  passwordHash: string | Verifier; passkeys?: PasskeyRecord[]; invitedBy?: string | null;
}

export function openUsers(db: DatabaseLike): Users {
  const toRow = (r: UserRow | null): User | null => {
    if (!r) return null;
    let passkeys: PasskeyRecord[] = [];
    try { passkeys = (JSON.parse(r.passkeys || "[]") as PasskeyRecord[] | null) || []; } catch { /* retain the existing corrupt-JSON fallback */ }
    return {
      id: r.id, email: r.email, name: r.name, role: r.role, status: r.status,
      passwordHash: r.password_hash,
      totpSecretSealed: r.totp_secret_sealed ?? null,
      totpSecretPendingSealed: r.totp_secret_pending_sealed ?? null,
      passkeys, invitedBy: r.invited_by ?? null,
      createdAt: r.created_at, lastLoginAt: r.last_login_at ?? null,
    };
  };
  const byEmail = (email: string) => Effect.map(
    io(() => db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>()), toRow);
  const byId = (id: unknown) => Effect.map(
    io(() => db.prepare("SELECT * FROM users WHERE id = ?").bind(String(id ?? "")).first<UserRow>()), toRow);
  const all = () => Effect.map(
    io(() => db.prepare("SELECT * FROM users ORDER BY created_at").all<UserRow>()),
    ({ results }) => results.map(r => toRow(r)!));
  const count = () => Effect.map(
    io(() => db.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>()), row => row!.c);
  const create = (input: CreateUser): Effect.Effect<User, CodeError> => Effect.gen(function* () {
    const { id, email, name, role, status, passwordHash, passkeys, invitedBy } = input;
    yield* io(() => db.prepare(
      "INSERT INTO users (id, email, name, role, status, password_hash, passkeys, invited_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(id, email, name ?? null, role, status ?? "active",
      typeof passwordHash === "string" ? passwordHash : JSON.stringify(passwordHash),
      JSON.stringify(passkeys ?? []), invitedBy ?? null, nowIso()).run());
    const user = yield* byId(id);
    if (!user) return yield* Effect.fail(coded("not-found", "User not found."));
    return user;
  });
  const setPasswordHash = (id: string, verifier: string | Verifier) => Effect.asVoid(io(() =>
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(typeof verifier === "string" ? verifier : JSON.stringify(verifier), id).run()));
  const setPasskeys = (id: string, passkeys: PasskeyRecord[]) => Effect.asVoid(io(() =>
    db.prepare("UPDATE users SET passkeys = ? WHERE id = ?").bind(JSON.stringify(passkeys ?? []), id).run()));
  const upsertPasskey = (id: string, passkeyId: string, record: PasskeyRecord) => Effect.gen(function* () {
    const list = (yield* byId(id))?.passkeys ?? [];
    const i = list.findIndex(p => p.id === passkeyId);
    if (i === -1) list.push(record); else list[i] = record;
    yield* setPasskeys(id, list);
    return record;
  });
  const removePasskey = (id: string, passkeyId: string) => Effect.gen(function* () {
    const list = (yield* byId(id))?.passkeys ?? [];
    const next = list.filter(p => p.id !== passkeyId);
    if (next.length === list.length) return false;
    yield* setPasskeys(id, next);
    return true;
  });
  return {
    toRow, byEmail, byId, all, count, create, setPasswordHash, setPasskeys, upsertPasskey, removePasskey,
    setRole: (id: string, role: Role) => io(() => db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, id).run()),
    setStatus: (id: string, status: UserStatus) => io(() => db.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, id).run()),
    setName: (id: string, name: string | null) => io(() => db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name || null, id).run()),
    setLastLogin: (id: string, iso: string) => io(() => db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(iso, id).run()),
    setTotpSecret: (id: string, sealed: string | null) => io(() => db.prepare("UPDATE users SET totp_secret_sealed = ? WHERE id = ?").bind(sealed, id).run()),
    setTotpSecretPending: (id: string, sealed: string | null) => io(() => db.prepare("UPDATE users SET totp_secret_pending_sealed = ? WHERE id = ?").bind(sealed, id).run()),
  };
}
export interface Users {
  toRow(row: UserRow | null): User | null;
  byEmail(email: string): Effect.Effect<User | null, CodeError>;
  byId(id: unknown): Effect.Effect<User | null, CodeError>;
  all(): Effect.Effect<User[], CodeError>;
  count(): Effect.Effect<number, CodeError>;
  create(input: CreateUser): Effect.Effect<User, CodeError>;
  setPasswordHash(id: string, verifier: string | Verifier): Effect.Effect<void, CodeError>;
  setPasskeys(id: string, passkeys: PasskeyRecord[]): Effect.Effect<void, CodeError>;
  upsertPasskey(id: string, passkeyId: string, record: PasskeyRecord): Effect.Effect<PasskeyRecord, CodeError>;
  removePasskey(id: string, passkeyId: string): Effect.Effect<boolean, CodeError>;
  setRole(id: string, role: Role): Effect.Effect<D1Result, CodeError>;
  setStatus(id: string, status: UserStatus): Effect.Effect<D1Result, CodeError>;
  setName(id: string, name: string | null): Effect.Effect<D1Result, CodeError>;
  setLastLogin(id: string, iso: string): Effect.Effect<D1Result, CodeError>;
  setTotpSecret(id: string, sealed: string | null): Effect.Effect<D1Result, CodeError>;
  setTotpSecretPending(id: string, sealed: string | null): Effect.Effect<D1Result, CodeError>;
}

export interface Session {
  id: string; userId: string; csrf: string; pending2fa: boolean;
  createdAt?: string; expiresAt?: string;
}
export interface StoredSession extends Session { createdAt: string; expiresAt: string }
type SessionRow = {
  id: string; user_id: string; csrf: string; pending2fa: number;
  created_at: string; expires_at: string;
};

export function openSessions(db: DatabaseLike): Sessions {
  return {
    create: (userId: string, { csrf, pending2fa }: { csrf?: string; pending2fa?: boolean } = {}): Effect.Effect<Session, CodeError> => Effect.gen(function* () {
      const id = yield* randomHex(32);
      const csrfToken = csrf ?? (yield* randomHex(16));
      const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      yield* io(() => db.prepare(
        "INSERT INTO sessions (id, user_id, kind, csrf, pending2fa, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(id, userId, "platform", csrfToken, pending2fa ? 1 : 0, nowIso(), expires).run());
      return { id, userId, csrf: csrfToken, pending2fa: !!pending2fa };
    }),
    get: (cookieToken: unknown): Effect.Effect<StoredSession | null, CodeError> => Effect.gen(function* () {
      const r = yield* io(() => db.prepare("SELECT * FROM sessions WHERE id = ?").bind(String(cookieToken ?? "")).first<SessionRow>());
      if (!r) return null;
      if (new Date(r.expires_at).getTime() <= Date.now()) {
        yield* io(() => db.prepare("DELETE FROM sessions WHERE id = ?").bind(r.id).run());
        return null;
      }
      return {
        id: r.id, userId: r.user_id, csrf: r.csrf, pending2fa: !!r.pending2fa,
        createdAt: r.created_at, expiresAt: r.expires_at,
      };
    }),
    setPending2fa: (id: string, flag: boolean) => Effect.gen(function* () {
      const r = yield* io(() => db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>());
      if (!r) return false;
      yield* io(() => db.prepare("UPDATE sessions SET pending2fa = ? WHERE id = ?").bind(flag ? 1 : 0, id).run());
      return true;
    }),
    destroyUser: (userId: string) => Effect.asVoid(io(() => db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run())),
    destroy: (id: string) => io(() => db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run()),
    purgeExpired: () => io(() => db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso()).run()),
  };
}
export interface Sessions {
  create(userId: string, options?: { csrf?: string; pending2fa?: boolean }): Effect.Effect<Session, CodeError>;
  get(cookieToken: unknown): Effect.Effect<StoredSession | null, CodeError>;
  setPending2fa(id: string, flag: boolean): Effect.Effect<boolean, CodeError>;
  destroyUser(userId: string): Effect.Effect<void, CodeError>;
  destroy(id: string): Effect.Effect<D1Result, CodeError>;
  purgeExpired(): Effect.Effect<D1Result, CodeError>;
}

/** 'login' challenges (passkey-first, ADR 0034) are issued before the user is known. */
export type PendingChallenge = { challenge: string; rpId: string; origin: string; createdAt: string } & (
  | { kind: "reg"; userId: string } | { kind: "auth"; userId: string } | { kind: "login"; userId: null });
type PendingRow = {
  challenge: string; kind: PendingChallenge["kind"]; user_id: string | null; rp_id: string; origin: string; created_at: string;
};

/** One-shot challenges; callers `take` (atomic delete) before checking TTL or validating proof. */
export function openWebAuthnPending(db: DatabaseLike): WebAuthnPending {
  // The table CHECK pairs kind 'login' with a NULL user_id, so the row narrows as stored.
  const fromRow = (r: PendingRow | null) =>
    r ? { challenge: r.challenge, kind: r.kind, userId: r.user_id, rpId: r.rp_id, origin: r.origin, createdAt: r.created_at } as PendingChallenge : null;
  return {
    set: (token: string, rec: PendingChallenge) => io(() => db.prepare(
      "INSERT OR REPLACE INTO webauthn_pending (token, challenge, kind, user_id, rp_id, origin, created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(token, rec.challenge, rec.kind, rec.userId, rec.rpId, rec.origin, rec.createdAt).run()),
    get: (token: unknown) => Effect.map(
      io(() => db.prepare("SELECT * FROM webauthn_pending WHERE token = ?").bind(String(token ?? "")).first<PendingRow>()), fromRow),
    take: (token: unknown) => Effect.map(
      io(() => db.prepare("DELETE FROM webauthn_pending WHERE token = ? RETURNING *").bind(String(token ?? "")).first<PendingRow>()), fromRow),
    sweep: (before: string) => io(() => db.prepare("DELETE FROM webauthn_pending WHERE created_at < ?").bind(before).run()),
    overwrite: (token: string, rec: PendingChallenge) => io(() => db.prepare(
      "UPDATE webauthn_pending SET challenge = ?, kind = ?, user_id = ?, rp_id = ?, origin = ?, created_at = ? WHERE token = ?",
    ).bind(rec.challenge, rec.kind, rec.userId, rec.rpId, rec.origin, rec.createdAt, token).run()),
  };
}
export interface WebAuthnPending {
  set(token: string, record: PendingChallenge): Effect.Effect<D1Result, CodeError>;
  get(token: unknown): Effect.Effect<PendingChallenge | null, CodeError>;
  /** Delete and return in one statement, so a challenge is consumed at most once. */
  take(token: unknown): Effect.Effect<PendingChallenge | null, CodeError>;
  /** Drop every challenge staged before `before` (ISO); expired rows are unusable anyway. */
  sweep(before: string): Effect.Effect<D1Result, CodeError>;
  overwrite(token: string, record: PendingChallenge): Effect.Effect<D1Result, CodeError>;
}

export type InviteRow = {
  id: string; email: string; role: InviteRole; token_hash: string; invited_by: string;
  created_at: string; expires_at: string; accepted_at: string | null;
};
export interface CreatedInvite {
  id: string; email: string; role: InviteRole; tokenHash: string; invitedBy: string; createdAt: string; expiresAt: string;
}
export interface CreateInvite {
  email: string; role?: InviteRole; invitedBy: string; expiresAt: string; inviteToken: string;
}

export function openInvites(db: DatabaseLike): Invites {
  return {
    create: ({ email, role, invitedBy, expiresAt, inviteToken }: CreateInvite): Effect.Effect<CreatedInvite, CodeError> => Effect.gen(function* () {
      const id = yield* newId();
      const tokenHash = yield* sha256hex(inviteToken);
      yield* io(() => db.prepare(
        "INSERT INTO invites (id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(id, email, role ?? "member", tokenHash, invitedBy, nowIso(), expiresAt).run());
      return { id, email, role: role ?? "member", tokenHash, invitedBy, createdAt: nowIso(), expiresAt };
    }),
    byTokenHash: (tokenHash: string) => io(() => db.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(tokenHash).first<InviteRow>()),
    byEmail: (email: string) => io(() => db.prepare("SELECT * FROM invites WHERE email = ?").bind(email).first<InviteRow>()),
    markAccepted: (id: string) => io(() => db.prepare("UPDATE invites SET accepted_at = ? WHERE id = ?").bind(nowIso(), id).run()),
    pending: () => Effect.map(io(() => db.prepare(
      "SELECT * FROM invites WHERE accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    ).bind(nowIso()).all<InviteRow>()), ({ results }) => results),
    cancel: (id: string) => io(() => db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(nowIso(), id).run()),
  };
}
export interface Invites {
  create(input: CreateInvite): Effect.Effect<CreatedInvite, CodeError>;
  byTokenHash(tokenHash: string): Effect.Effect<InviteRow | null, CodeError>;
  byEmail(email: string): Effect.Effect<InviteRow | null, CodeError>;
  markAccepted(id: string): Effect.Effect<D1Result, CodeError>;
  pending(): Effect.Effect<InviteRow[], CodeError>;
  cancel(id: string): Effect.Effect<D1Result, CodeError>;
}

export interface AuditEntry {
  actorType: string; actorId: unknown; action: string; artifactId?: string | null; detail?: unknown;
}
export type AuditRow = {
  at: string; actor_type: string; actor_id: string; action: string; artifact_id: string | null; detail: string | null;
};

/** Best-effort writes must never fail the mutation they record. */
export function openAudit(db: DatabaseLike): Audit {
  return {
    write: ({ actorType, actorId, action, artifactId = null, detail = null }: AuditEntry): Effect.Effect<void> =>
      Effect.catch(Effect.asVoid(io(() => db.prepare(
        "INSERT INTO audit_log (at, actor_type, actor_id, action, artifact_id, detail) VALUES (?,?,?,?,?,?)",
      ).bind(nowIso(), actorType, String(actorId ?? ""), action, artifactId, detail ? JSON.stringify(detail) : null).run())),
      () => Effect.void),
    recent: (limit: unknown = 50) => Effect.map(io(() => db.prepare(
      "SELECT at, actor_type, actor_id, action, artifact_id, detail FROM audit_log ORDER BY at DESC LIMIT ?",
    ).bind(Math.max(1, Math.min(200, Number(limit) || 50))).all<AuditRow>()), ({ results }) => results),
  };
}
export interface Audit {
  write(entry: AuditEntry): Effect.Effect<void, CodeError>;
  recent(limit?: unknown): Effect.Effect<AuditRow[], CodeError>;
}

export const DEFAULT_RETENTION = 100;

export function openSettings(db: DatabaseLike): Settings {
  return {
    retention: () => Effect.map(io(() => db.prepare("SELECT retention FROM platform_settings WHERE id = 'platform'").first<{ retention: number }>()), row => {
      const value = Number(row?.retention);
      return Number.isInteger(value) && value >= 1 ? value : DEFAULT_RETENTION;
    }),
    setRetention: (versions: unknown) => Effect.gen(function* () {
      const value = Number(versions);
      if (!Number.isInteger(value) || value < 1)
        return yield* Effect.fail(coded("invalid-retention", "Retention must be a whole number of versions, at least 1."));
      yield* io(() => db.prepare(
        "INSERT INTO platform_settings (id, retention, updated_at) VALUES ('platform', ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET retention = excluded.retention, updated_at = excluded.updated_at",
      ).bind(value, nowIso()).run());
      return value;
    }),
    mailFrom: () => Effect.map(io(() => db.prepare("SELECT mail_from FROM platform_settings WHERE id = 'platform'").first<{ mail_from: string | null }>()), row => String(row?.mail_from ?? "")),
    setMailFrom: (address: unknown) => Effect.gen(function* () {
      const value = String(address ?? "").trim();
      if (value && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(value) && !/^.+<[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+>$/.test(value))
        return yield* Effect.fail(coded("invalid-mail-from", "That sender address is not valid."));
      yield* io(() => db.prepare(
        "INSERT INTO platform_settings (id, retention, mail_from, updated_at) VALUES ('platform', ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET mail_from = excluded.mail_from, updated_at = excluded.updated_at",
      ).bind(DEFAULT_RETENTION, value, nowIso()).run());
      return value;
    }),
  };
}
export interface Settings {
  retention(): Effect.Effect<number, CodeError>;
  setRetention(versions: unknown): Effect.Effect<number, CodeError>;
  mailFrom(): Effect.Effect<string, CodeError>;
  setMailFrom(address: unknown): Effect.Effect<string, CodeError>;
}

export function openStore(db: DatabaseLike): Store {
  return {
    db, users: openUsers(db), sessions: openSessions(db), pending: openWebAuthnPending(db),
    invites: openInvites(db), audit: openAudit(db), settings: openSettings(db),
  };
}
export interface Store {
  db: DatabaseLike;
  users: Users;
  sessions: Sessions;
  pending: WebAuthnPending;
  invites: Invites;
  audit: Audit;
  settings: Settings;
}
