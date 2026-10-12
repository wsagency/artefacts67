// Multi-user authentication (ADR 0012): owner bootstrap, invitations, password + second
// factor, absolute sessions and per-email lockout. Crypto and D1 operations stay in one fiber.

import * as Effect from "effect/Effect";
import {
  makeVerifier, verifyVerifier, b32encode, totpMatch, normCode, randomBytes,
  randomHex, scalarSeal, scalarUnseal, sha256hex,
} from "./crypto.js";
import { decide, status, hitResult, type CounterState, type RateLimiter, type RateResult } from "./ratelimit.js";
import { asCodeError, type CodeError } from "./types.js";
import type { Store, User, Session, StoredSession, Role, InviteRow, CreatedInvite, AuditEntry } from "./store.js";
import type { Mailer } from "./mail.js";
import type { WebAuthn } from "./webauthn.js";

const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
export const PASSWORD_MIN = 8;
const LOCK_THRESHOLD = 3;
const LOCK_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCKED_MESSAGE = "Too many failed attempts. Try again in a few minutes.";
const SUSPENDED_MESSAGE = "This account is suspended. Contact the owner.";
export const normEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function otpauthUrl(secret: string, { email, issuer = "Artefacts67" }: { email?: string; issuer?: string } = {}) {
  const label = encodeURIComponent(`${issuer}:${email || ""}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${q}`;
}

const RANK: Readonly<Record<Role, number>> = { member: 0, admin: 1, owner: 2 };
export interface LockState { locked: boolean; remaining: number; retryAfterSec: number }
export interface Me {
  id: string; email: string; name: string | null; role: Role; status: User["status"];
  csrf: string; totpEnrolled: boolean; passkeyCount: number; lastLoginAt: string | null;
}
export interface CurrentSession { session: StoredSession; user: User }
export interface Authenticated { user: User; session: Session }
export interface PasswordInput { name?: unknown; email?: unknown; password?: unknown; confirm?: unknown }
export interface InvitationInput { email?: unknown; role?: unknown; invitedBy: string }
export interface AcceptInvitationInput { token?: unknown; name?: unknown; password?: unknown; confirm?: unknown }
export interface TotpSetup { secret: string; otpauth: string }
export type TotpField = "totpSecretSealed" | "totpSecretPendingSealed";
export interface Auth {
  sessionCookie: string;
  passwordMin: number;
  rank: Readonly<Record<Role, number>>;
  userCount(): Effect.Effect<number, CodeError>;
  bootstrapAllowed(): Effect.Effect<boolean, CodeError>;
  meView(user: User, csrf: string): Me;
  counts(): Effect.Effect<{ users: number; active: number; suspended: number }, CodeError>;
  registerOwner(input: PasswordInput): Effect.Effect<Authenticated, CodeError>;
  invite(input: InvitationInput): Effect.Effect<{ invite: CreatedInvite; token: string; link: string }, CodeError>;
  findInvite(token: unknown): Effect.Effect<InviteRow | null, CodeError>;
  acceptInvite(input: AcceptInvitationInput): Effect.Effect<Authenticated, CodeError>;
  login(input: { email?: unknown; password?: unknown }): Effect.Effect<Authenticated, CodeError>;
  changePassword(user: User, current: unknown, next: unknown, confirm: unknown): Effect.Effect<void, CodeError>;
  currentSession(cookieToken: unknown): Effect.Effect<CurrentSession | null, CodeError>;
  pendingSession(userId: string): Effect.Effect<Session, CodeError>;
  elevate(session: Session): Effect.Effect<Session, CodeError>;
  /** Passkey-first (ADR 0034): a user-verified passkey proved both factors for `user`; `previous`
   * (the browser's existing session, if any) is destroyed as `elevate` does. */
  signInVerified(user: User, previous?: Session | null): Effect.Effect<Session, CodeError>;
  verifyTotp(user: User, code: unknown): Effect.Effect<boolean, CodeError>;
  beginTotpEnroll(user: User): Effect.Effect<TotpSetup, CodeError>;
  confirmTotpEnroll(user: User, code: unknown): Effect.Effect<boolean, CodeError>;
  secretOf(user: User | null, field: TotpField): Effect.Effect<string | null, CodeError>;
  canManage(actor: User | null, target: User | null): boolean;
  canSetRole(actor: User, target: User, newRole: unknown): boolean;
  wouldOrphanOwners(target: User, options?: { demoting?: boolean; suspending?: boolean }): Effect.Effect<boolean, CodeError>;
  lockState(email: unknown): Effect.Effect<LockState, CodeError>;
  loginFail(email: unknown): Effect.Effect<LockState, CodeError>;
  loginReset(email: unknown): Effect.Effect<void, CodeError>;
  audit(actorType: string, actorId: unknown, action: string, options?: Pick<AuditEntry, "artifactId" | "detail">): Effect.Effect<void, CodeError>;
}
export interface AuthOptions {
  store: Store; mailer: Mailer; masterKeyHex: string; origin: string;
  webauthn?: WebAuthn; rpName?: string; rpId?: string; sessionCookie?: string; rateLimiter?: RateLimiter;
}

/** Direct-module test adapter; production injects the strongly consistent RateLimit DO. */
function openLocalRateLimiter(): RateLimiter {
  const windows = new Map<string, CounterState>();
  const read = (key: string, windowMs: number, now: number) => {
    const stored = windows.get(key);
    if (!stored || now - stored.windowStart >= windowMs) {
      if (stored) windows.delete(key);
      return undefined;
    }
    return stored;
  };
  return {
    check: (key, { limit, windowMs }) => Effect.sync(() => {
      const now = Date.now();
      return status(read(key, windowMs, now), { limit, windowMs, now });
    }),
    hit: (key, { limit, windowMs }) => Effect.sync(() => {
      const now = Date.now();
      const decision = decide(read(key, windowMs, now), { limit, windowMs, now });
      windows.set(key, { count: decision.count, windowStart: decision.windowStart });
      return hitResult(decision, { windowMs, now });
    }),
    reset: key => Effect.sync(() => { windows.delete(key); }),
  };
}

export function openAuth({ store, mailer, masterKeyHex, origin, sessionCookie = "wsa_session", rateLimiter }: AuthOptions): Auth {
  const { users, sessions, invites } = store;
  const limiter = rateLimiter ?? openLocalRateLimiter();
  const lockResult = (state: RateResult & { retryAfterSec?: number }): LockState => {
    const remaining = Number.isFinite(state.remaining) ? state.remaining : 0;
    return {
      locked: Boolean(state.locked || !state.allowed || remaining === 0), remaining,
      retryAfterSec: Number(state.retryAfter ?? state.retryAfterSec ?? 0),
    };
  };
  const lockState = (email: unknown) => Effect.map(limiter.check(`lock:${normEmail(email)}`, { limit: LOCK_THRESHOLD, windowMs: LOCK_MS }), lockResult);
  const loginFail = (email: unknown) => Effect.map(limiter.hit(`lock:${normEmail(email)}`, { limit: LOCK_THRESHOLD, windowMs: LOCK_MS }), lockResult);
  const loginReset = (email: unknown) => limiter.reset(`lock:${normEmail(email)}`);
  const audit: Auth["audit"] = (actorType, actorId, action, options) => store.audit.write({ actorType, actorId, action, ...options });
  const meView: Auth["meView"] = (user, csrf) => ({
    id: user.id, email: user.email, name: user.name, role: user.role, status: user.status,
    csrf, totpEnrolled: !!user.totpSecretSealed, passkeyCount: (user.passkeys ?? []).length,
    lastLoginAt: user.lastLoginAt,
  });

  const checkPassword = (user: User | null, password: unknown) => Effect.gen(function* () {
    if (!user) { yield* makeVerifier(String(password ?? "") + "-dummy"); return false; }
    let verifier: unknown;
    try { verifier = JSON.parse(user.passwordHash || "{}"); } catch { verifier = {}; }
    return yield* verifyVerifier(String(password ?? ""), verifier);
  });
  const assertPasswordPolicy = (password: unknown, email: unknown) => {
    const pw = String(password ?? "");
    if (pw.length < PASSWORD_MIN) throw coded("weak-password", `Password must be at least ${PASSWORD_MIN} characters.`);
    if (normEmail(pw) === normEmail(email)) throw coded("weak-password", "Password cannot be the same as the e-mail address.");
  };
  const secretOf: Auth["secretOf"] = (user, sealedField) => Effect.gen(function* () {
    const sealed = user?.[sealedField];
    if (!sealed) return null;
    const obj = yield* scalarUnseal<{ secret?: string }>(masterKeyHex, sealed);
    return obj?.secret ?? null;
  });
  const beginTotpEnroll: Auth["beginTotpEnroll"] = user => Effect.gen(function* () {
    let secret = yield* secretOf(user, "totpSecretPendingSealed");
    if (!secret) {
      secret = b32encode(yield* randomBytes(20));
      yield* users.setTotpSecretPending(user.id, yield* scalarSeal(masterKeyHex, { secret }));
    }
    return { secret, otpauth: otpauthUrl(secret, { email: user.email }) };
  });
  const confirmTotpEnroll: Auth["confirmTotpEnroll"] = (user, code) => Effect.gen(function* () {
    const secret = yield* secretOf(user, "totpSecretPendingSealed");
    if (!secret) return yield* Effect.fail(coded("no-pending-totp", "No two-factor setup is in progress — refresh the page."));
    if (!(yield* totpMatch(secret, normCode(code)))) return false;
    yield* users.setTotpSecret(user.id, yield* scalarSeal(masterKeyHex, { secret }));
    yield* users.setTotpSecretPending(user.id, null);
    yield* audit("user", user.id, "user.totp_enroll");
    return true;
  });
  const verifyTotp: Auth["verifyTotp"] = (user, code) => Effect.gen(function* () {
    const secret = yield* secretOf(user, "totpSecretSealed");
    return secret ? yield* totpMatch(secret, normCode(code)) : false;
  });
  const pendingSession: Auth["pendingSession"] = userId => Effect.gen(function* () {
    return yield* sessions.create(userId, { csrf: yield* randomHex(16), pending2fa: true });
  });
  /** The one full-session issuance every factor path ends in. */
  const signIn = (userId: string) => Effect.gen(function* () {
    const fresh = yield* sessions.create(userId, { csrf: yield* randomHex(16), pending2fa: false });
    yield* users.setLastLogin(userId, new Date().toISOString());
    yield* audit("user", userId, "user.login");
    return fresh;
  });
  const elevate: Auth["elevate"] = session => Effect.gen(function* () {
    yield* sessions.destroy(session.id);
    const user = yield* users.byId(session.userId);
    if (!user) return yield* Effect.fail(coded("not-found", "User not found."));
    return yield* signIn(user.id);
  });
  // The same lockout and status gates password login applies, then the second-factor success path.
  const signInVerified: Auth["signInVerified"] = (user, previous) => Effect.gen(function* () {
    if ((yield* lockState(user.email)).locked) return yield* Effect.fail(coded("locked", LOCKED_MESSAGE));
    if (user.status !== "active") return yield* Effect.fail(coded("suspended", SUSPENDED_MESSAGE));
    yield* loginReset(user.email);
    if (previous) yield* sessions.destroy(previous.id);
    return yield* signIn(user.id);
  });
  const currentSession: Auth["currentSession"] = cookieToken => Effect.gen(function* () {
    if (!cookieToken) return null;
    const session = yield* sessions.get(cookieToken);
    if (!session) return null;
    const user = yield* users.byId(session.userId);
    if (!user) { yield* sessions.destroy(session.id); return null; }
    if (user.status !== "active") { yield* sessions.destroyUser(user.id); return null; }
    return { session, user };
  });
  const bootstrapAllowed = () => Effect.map(users.count(), count => count === 0);
  const registerOwner: Auth["registerOwner"] = ({ name, email, password, confirm }) => Effect.gen(function* () {
    const mail = normEmail(email);
    if (!mail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return yield* Effect.fail(coded("bad-email", "Enter a valid e-mail address."));
    if (password !== confirm) return yield* Effect.fail(coded("password-mismatch", "Passwords do not match."));
    yield* Effect.try({ try: () => assertPasswordPolicy(password, mail), catch: asCodeError });
    if (!(yield* bootstrapAllowed())) return yield* Effect.fail(coded("already-bootstrapped", "The platform already has users."));
    const id = yield* randomHex(8);
    const verifier = JSON.stringify(yield* makeVerifier(password));
    const now = new Date().toISOString();
    const res = yield* Effect.tryPromise({
      try: () => Promise.resolve(store.db.prepare(
        `INSERT INTO users (id, email, name, role, status, password_hash, passkeys, created_at)
         SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      ).bind(id, mail, String(name ?? "").trim() || null, "owner", "active", verifier, "[]", now).run()),
      catch: asCodeError,
    });
    const changes = Number(res.meta?.changes ?? res.changes ?? 0);
    if (!changes) return yield* Effect.fail(coded("already-bootstrapped", "The platform already has users."));
    const user = yield* users.byId(id);
    if (!user) return yield* Effect.fail(coded("not-found", "User not found."));
    yield* audit("user", id, "user.bootstrap");
    return { user, session: yield* pendingSession(id) };
  });
  const invite: Auth["invite"] = ({ email, role = "member", invitedBy }) => Effect.gen(function* () {
    const mail = normEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return yield* Effect.fail(coded("bad-email", "Enter a valid e-mail address."));
    if (role !== "admin" && role !== "member") return yield* Effect.fail(coded("bad-role", "An invitation can only be for a member or an admin."));
    const inviter = yield* users.byId(invitedBy);
    if (!inviter || inviter.status !== "active") return yield* Effect.fail(coded("forbidden", "Only active users can send invitations."));
    if (role === "admin" && inviter.role === "member") return yield* Effect.fail(coded("forbidden", "A member can only invite a new member."));
    if (yield* users.byEmail(mail)) return yield* Effect.fail(coded("email-taken", "A user with that address already exists."));
    const token = yield* randomHex(24);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const row = yield* invites.create({ email: mail, role, invitedBy, expiresAt, inviteToken: token });
    const link = `${origin}/invite/${token}`;
    const from = yield* store.settings.mailFrom();
    yield* mailer.send({
      to: mail, from, subject: "You are invited to Artefacts67",
      text: `${inviter.name || inviter.email} has invited you to Artefacts67.\n\n` +
        `Set up your account at: ${link}\n\nThe invitation is valid for 7 days.\n`,
    });
    yield* audit("user", invitedBy, "user.invite", { detail: { email: mail, role } });
    return { invite: row, token, link };
  });
  const findInvite: Auth["findInvite"] = token => Effect.gen(function* () {
    const hash = yield* sha256hex(String(token ?? ""));
    const row = yield* invites.byTokenHash(hash);
    if (!row || row.accepted_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  });
  const acceptInvite: Auth["acceptInvite"] = ({ token, name, password, confirm }) => Effect.gen(function* () {
    const row = yield* findInvite(token);
    if (!row) return yield* Effect.fail(coded("bad-invite", "This invitation is not valid, or it has already been used."));
    if (password !== confirm) return yield* Effect.fail(coded("password-mismatch", "Passwords do not match."));
    yield* Effect.try({ try: () => assertPasswordPolicy(password, row.email), catch: asCodeError });
    if (yield* users.byEmail(row.email)) return yield* Effect.fail(coded("email-taken", "A user with that address already exists."));
    const id = yield* randomHex(8);
    yield* users.create({
      id, email: row.email, name: String(name ?? "").trim() || null, role: row.role, status: "active",
      passwordHash: JSON.stringify(yield* makeVerifier(password)), invitedBy: row.invited_by,
    });
    yield* invites.markAccepted(row.id);
    yield* audit("user", id, "user.invite_accept", { detail: { email: row.email } });
    const user = yield* users.byId(id);
    if (!user) return yield* Effect.fail(coded("not-found", "User not found."));
    return { user, session: yield* pendingSession(id) };
  });
  const login: Auth["login"] = ({ email, password }) => Effect.gen(function* () {
    const mail = normEmail(email);
    if ((yield* lockState(mail)).locked) return yield* Effect.fail(coded("locked", LOCKED_MESSAGE));
    const user = yield* users.byEmail(mail);
    const ok = yield* checkPassword(user, password);
    if (!ok || !user) {
      const state = yield* loginFail(mail);
      yield* audit("system", mail || "unknown", "user.login_fail");
      return yield* Effect.fail(coded(state.locked ? "locked" : "invalid-credentials",
        state.locked ? LOCKED_MESSAGE : "Incorrect e-mail or password."));
    }
    if (user.status !== "active") return yield* Effect.fail(coded("suspended", SUSPENDED_MESSAGE));
    yield* loginReset(mail);
    return { user, session: yield* pendingSession(user.id) };
  });
  const changePassword: Auth["changePassword"] = (user, current, next, confirm) => Effect.gen(function* () {
    if (String(next ?? "") !== String(confirm ?? "")) return yield* Effect.fail(coded("password-mismatch", "Passwords do not match."));
    if (!(yield* checkPassword(user, current))) return yield* Effect.fail(coded("invalid-current-password", "The current password is incorrect."));
    yield* Effect.try({ try: () => assertPasswordPolicy(next, user.email), catch: asCodeError });
    yield* users.setPasswordHash(user.id, yield* makeVerifier(next));
    yield* audit("user", user.id, "user.password_change");
  });
  const canManage: Auth["canManage"] = (actor, target) => {
    if (!actor || !target || actor.id === target.id) return false;
    if (actor.role !== "owner" && actor.role !== "admin") return false;
    if (target.role === "owner") return actor.role === "owner";
    return RANK[actor.role] >= RANK[target.role];
  };
  const canSetRole: Auth["canSetRole"] = (actor, target, newRole) => {
    if (typeof newRole !== "string" || !Object.hasOwn(RANK, newRole) || !newRole || newRole === target.role) return false;
    if (newRole === "owner") return actor.role === "owner";
    return canManage(actor, target);
  };
  const wouldOrphanOwners: Auth["wouldOrphanOwners"] = (target, { demoting = false, suspending = false } = {}) => Effect.gen(function* () {
    if (target.role !== "owner" || (!demoting && !suspending)) return false;
    const owners = (yield* users.all()).filter(user => user.role === "owner" && user.status === "active");
    return owners.length <= 1;
  });
  const counts: Auth["counts"] = () => Effect.gen(function* () {
    const all = yield* users.all();
    return { users: all.length, active: all.filter(user => user.status === "active").length,
      suspended: all.filter(user => user.status === "suspended").length };
  });
  return {
    sessionCookie, passwordMin: PASSWORD_MIN, userCount: () => users.count(), bootstrapAllowed, meView, counts,
    registerOwner, invite, findInvite, acceptInvite, login, changePassword, currentSession, pendingSession,
    elevate, signInVerified, verifyTotp, beginTotpEnroll, confirmTotpEnroll, secretOf,
    canManage, canSetRole, wouldOrphanOwners, rank: RANK, lockState, loginFail, loginReset, audit,
  };
}
