// Content-blind observations: one signed opening, cumulative active time and scroll buckets.
// A proof is issued only once content access succeeds, and never authorizes content itself.
import * as Effect from "effect/Effect";
import { randomHex, scalarSeal, scalarUnseal } from "./crypto.js";
import { json, readJson } from "./http.js";
import type { ResolvedShare, ResolveShareInput, ShareAccess } from "./shares.js";
import { asCodeError, type CodeError, type DatabaseLike, type D1Result } from "./types.js";

const DAY = 86_400_000;
const PROOF_LIFETIME = 4 * 60 * 60 * 1000;
const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const totalsSql = `COUNT(*) AS opens, COALESCE(SUM(active_seconds),0) AS activeSeconds,
  COALESCE(SUM(scroll_bucket >= 25),0) AS scroll25, COALESCE(SUM(scroll_bucket >= 50),0) AS scroll50,
  COALESCE(SUM(scroll_bucket >= 75),0) AS scroll75, COALESCE(SUM(scroll_bucket >= 100),0) AS scroll100`;

export interface ObservationProof {
  purpose: "share-observation"; shareId: string; artifactId: string; visitId: string;
  issuedAt: number; expiresAt: number;
}
export interface ObservationBody {
  proof: string; path: string; token: string; artifactId: string;
  activeSeconds: number; scroll: 0 | 25 | 50 | 75 | 100;
}
export type AnalyticsTotals = {
  opens: number; activeSeconds: number; scroll25: number; scroll50: number; scroll75: number; scroll100: number;
};
export type ShareObservationSummary = {
  shareId: string; opens: number; activeSeconds: number; maxScroll: number; lastOpenedAt: string;
};
export type DailyObservationSummary = { day: string; opens: number; activeSeconds: number };
export interface AnalyticsSummary {
  totals: AnalyticsTotals; shares: ShareObservationSummary[]; days: DailyObservationSummary[];
}
export interface PlatformAnalyticsSummary {
  totals: { opens: number; activeSeconds: number; shares: number }; days: DailyObservationSummary[];
}
export interface ObservationLimiter {
  hit(key: string, options: { limit: number; windowMs: number }): Effect.Effect<{ allowed: boolean }, CodeError>;
}
export interface AnalyticsOptions {
  db: DatabaseLike;
  shares: { resolve(input?: ResolveShareInput): Effect.Effect<ResolvedShare | null, CodeError> };
  access: ShareAccess; masterKeyHex: string; limiter?: ObservationLimiter | null; now?: () => number;
}
export interface Analytics {
  retention(): Effect.Effect<number, CodeError>;
  setRetention(value: unknown): Effect.Effect<number, CodeError>;
  prune(): Effect.Effect<D1Result, CodeError>;
  proof(input: { shareId: string; artifactId: string }): Effect.Effect<string, CodeError>;
  record(body: unknown): Effect.Effect<boolean, CodeError>;
  summary(input: { actorId: unknown; kind: unknown; targetId: string }): Effect.Effect<AnalyticsSummary, CodeError>;
  platformSummary(): Effect.Effect<PlatformAnalyticsSummary, CodeError>;
}

function observationBody(body: unknown): body is ObservationBody {
  return body !== null && typeof body === "object" && !Array.isArray(body) &&
    "proof" in body && typeof body.proof === "string" && body.proof.length <= 2048 &&
    "path" in body && typeof body.path === "string" && body.path.length <= 130 &&
    "token" in body && typeof body.token === "string" && /^[a-f0-9]{40}$/.test(body.token) &&
    "artifactId" in body && typeof body.artifactId === "string" && body.artifactId.length <= 64 &&
    "activeSeconds" in body && typeof body.activeSeconds === "number" && Number.isInteger(body.activeSeconds) && body.activeSeconds >= 0 && body.activeSeconds <= 14400 &&
    "scroll" in body && typeof body.scroll === "number" && [0, 25, 50, 75, 100].includes(body.scroll);
}

export function openAnalytics({ db, shares, access, masterKeyHex, limiter, now = Date.now }: AnalyticsOptions): Analytics {
  const retention = () => Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: async () => db.prepare("SELECT analytics_retention_days AS days FROM platform_settings WHERE id = 'platform'").first<{ days: number }>(),
      catch: asCodeError,
    });
    const days = Number(row?.days);
    return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 90;
  });
  const cutoff = () => Effect.gen(function* () {
    return new Date(now() - (yield* retention()) * DAY).toISOString();
  });
  const prune = () => Effect.gen(function* () {
    const from = yield* cutoff();
    return yield* Effect.tryPromise({ try: async () => db.prepare("DELETE FROM share_visits WHERE opened_at < ?").bind(from).run(), catch: asCodeError });
  });
  const setRetention = (value: unknown) => Effect.gen(function* () {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 365) return yield* Effect.fail(fail("invalid-retention", "Analytics retention must be 1–365 whole days."));
    yield* Effect.tryPromise({
      try: async () => db.prepare("UPDATE platform_settings SET analytics_retention_days = ?, updated_at = ? WHERE id = 'platform'")
        .bind(days, new Date(now()).toISOString()).run(), catch: asCodeError,
    });
    yield* prune();
    return days;
  });
  const proof = ({ shareId, artifactId }: { shareId: string; artifactId: string }) => Effect.gen(function* () {
    const issuedAt = now();
    const envelope: ObservationProof = { purpose: "share-observation", shareId, artifactId, visitId: yield* randomHex(16), issuedAt, expiresAt: issuedAt + PROOF_LIFETIME };
    return yield* scalarSeal(masterKeyHex, envelope);
  });
  const record = (body: unknown) => Effect.gen(function* () {
    if (!observationBody(body)) return false;
    const envelope = yield* Effect.catch(scalarUnseal<ObservationProof>(masterKeyHex, body.proof), () => Effect.succeed(undefined));
    const at = now();
    if (envelope?.purpose !== "share-observation" || !/^[a-f0-9]{32}$/.test(envelope.visitId ?? "") ||
      envelope.artifactId !== body.artifactId || !Number.isFinite(envelope.issuedAt) ||
      envelope.issuedAt > at || envelope.expiresAt <= at || envelope.expiresAt - envelope.issuedAt !== PROOF_LIFETIME) return false;
    if (limiter) {
      const state = yield* limiter.hit(`ev:${envelope.shareId}`, { limit: 600, windowMs: 60000 });
      if (!state.allowed) return yield* Effect.fail(fail("rate-limited", "Observation rate exceeded."));
    }
    const resolved = yield* shares.resolve({ path: body.path, token: body.token, artifactId: body.artifactId });
    if (!resolved?.artifact || resolved.artifact.id !== envelope.artifactId || resolved.share.id !== envelope.shareId) return false;
    // Dwell cannot exceed elapsed server time; neither metric identifies a person.
    const seconds = Math.min(body.activeSeconds, Math.floor((at - envelope.issuedAt) / 1000));
    yield* Effect.tryPromise({
      try: async () => db.prepare(`INSERT INTO share_visits
      (visit_id, share_id, artifact_id, opened_at, updated_at, active_seconds, scroll_bucket)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(visit_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      active_seconds = MAX(share_visits.active_seconds, excluded.active_seconds),
      scroll_bucket = MAX(share_visits.scroll_bucket, excluded.scroll_bucket)`)
        .bind(envelope.visitId, envelope.shareId, envelope.artifactId, new Date(envelope.issuedAt).toISOString(), new Date(at).toISOString(), seconds, body.scroll).run(),
      catch: asCodeError,
    });
    return true;
  });
  const summary = ({ actorId, kind, targetId }: { actorId: unknown; kind: unknown; targetId: string }): Effect.Effect<AnalyticsSummary, CodeError> => Effect.gen(function* () {
    if (kind !== "artifact" && kind !== "folder") return yield* Effect.fail(fail("not-found", "No such analytics target."));
    const target = yield* Effect.tryPromise({
      try: async () => db.prepare(kind === "artifact"
        ? "SELECT owner_id AS ownerId, folder_id AS folderId FROM artifacts WHERE id = ?"
        : "SELECT owner_id AS ownerId, id AS folderId FROM folders WHERE id = ?")
        .bind(targetId).first<{ ownerId: string; folderId: string | null }>(), catch: asCodeError,
    });
    if (!target || !(yield* access.may(actorId, target, "manage"))) return yield* Effect.fail(fail("forbidden", "Analytics are not available for this target."));
    const scope = kind === "artifact" ? "v.artifact_id = ?" : `v.artifact_id IN (
      WITH RECURSIVE subtree(id) AS (SELECT id FROM folders WHERE id = ? UNION
        SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id)
      SELECT a.id FROM artifacts a JOIN subtree s ON a.folder_id = s.id)`;
    const where = `${scope} AND v.opened_at >= ?`;
    const args = [targetId, yield* cutoff()];
    const totals = yield* Effect.tryPromise({ try: async () => db.prepare(`SELECT ${totalsSql} FROM share_visits v WHERE ${where}`).bind(...args).first<AnalyticsTotals>(), catch: asCodeError });
    const perShare = yield* Effect.tryPromise({
      try: async () => db.prepare(`SELECT share_id AS shareId, COUNT(*) AS opens,
      SUM(active_seconds) AS activeSeconds, MAX(scroll_bucket) AS maxScroll, MAX(opened_at) AS lastOpenedAt
      FROM share_visits v WHERE ${where} GROUP BY share_id ORDER BY lastOpenedAt DESC`).bind(...args).all<ShareObservationSummary>(), catch: asCodeError,
    });
    const days = yield* Effect.tryPromise({
      try: async () => db.prepare(`SELECT substr(opened_at,1,10) AS day, COUNT(*) AS opens,
      SUM(active_seconds) AS activeSeconds FROM share_visits v WHERE ${where}
      GROUP BY day ORDER BY day DESC`).bind(...args).all<DailyObservationSummary>(), catch: asCodeError,
    });
    // COUNT without GROUP BY always returns one aggregate row, including an empty scope.
    return { totals: totals!, shares: perShare.results, days: days.results };
  });
  const platformSummary = (): Effect.Effect<PlatformAnalyticsSummary, CodeError> => Effect.gen(function* () {
    const from = yield* cutoff();
    const totals = yield* Effect.tryPromise({
      try: async () => db.prepare(`SELECT COUNT(*) AS opens, COALESCE(SUM(active_seconds),0) AS activeSeconds
      FROM share_visits WHERE opened_at >= ?`).bind(from).first<{ opens: number; activeSeconds: number }>(), catch: asCodeError,
    });
    const count = yield* Effect.tryPromise({ try: async () => db.prepare("SELECT COUNT(*) AS shares FROM shares").first<{ shares: number }>(), catch: asCodeError });
    const days = yield* Effect.tryPromise({
      try: async () => db.prepare(`SELECT substr(opened_at,1,10) AS day, COUNT(*) AS opens,
      SUM(active_seconds) AS activeSeconds FROM share_visits WHERE opened_at >= ?
      GROUP BY day ORDER BY day DESC`).bind(from).all<DailyObservationSummary>(), catch: asCodeError,
    });
    return { totals: { ...totals!, shares: count!.shares }, days: days.results };
  });
  return { retention, setRetention, prune, proof, record, summary, platformSummary };
}

export interface AnalyticsContext { analytics: Pick<Analytics, "record"> }
export function handleAnalytics(request: Request, ctx: AnalyticsContext): Effect.Effect<Response, CodeError> {
  return Effect.gen(function* () {
    if (request.method !== "POST") return json({ error: "method-not-allowed" }, 405, { Allow: "POST" });
    if (request.headers.get("Origin") !== new URL(request.url).origin ||
      !request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "forbidden" }, 403);
    const parsed = yield* Effect.catch(
      Effect.map(readJson(request, 4096), (body) => ({ ok: true as const, body })),
      () => Effect.succeed({ ok: false as const }),
    );
    if (!parsed.ok) return json({ error: "invalid-observation" }, 400);
    return yield* Effect.catch(Effect.gen(function* () {
      return (yield* ctx.analytics.record(parsed.body))
        ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })
        : json({ error: "invalid-observation" }, 400);
    }), (error) => error.code === "rate-limited"
      ? Effect.succeed(json({ error: "rate-limited" }, 429, { "Retry-After": "60" }))
      : Effect.fail(error));
  });
}
