// RateLimit Durable Object (ADR 0013): strongly consistent counters for the
// gate lockout and API rate limits. Per-isolate memory would make lockouts
// cosmetic across Cloudflare's colos — hence a DO.
//
// Semantics: `hit` increments and allows while count <= limit, so a caller
// that wants "the 4th wrong attempt locks out" passes limit: 3.

export interface CounterState {
  count: number;
  windowStart: number;
  expiresAt?: number;
}
export interface WindowOptions {
  limit: number;
  windowMs: number;
  now: number;
}
export interface WindowDecision {
  count: number;
  windowStart: number;
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

import * as Effect from "effect/Effect";
import type { CodeError, WorkerEnv } from "./types.js";

export interface RateResult {
  allowed: boolean;
  locked: boolean;
  remaining: number;
  retryAfter: number;
}
export interface RateLimiter {
  check(key: string, options: { limit: number; windowMs: number }): Effect.Effect<RateResult, CodeError>;
  hit(key: string, options: { limit: number; windowMs: number }): Effect.Effect<RateResult, CodeError>;
  reset(key: string): Effect.Effect<void, CodeError>;
}

// Pure window decision so plain `node --test` can exercise it outside workerd.
export function decide(stored: CounterState | undefined, { limit, windowMs, now }: WindowOptions): WindowDecision {
  const prior = stored && Number.isFinite(stored.count) ? stored : { count: 0, windowStart: now };
  const expired = now - prior.windowStart >= windowMs;
  const count = (expired ? 0 : prior.count) + 1;
  const windowStart = expired ? now : prior.windowStart;
  const allowed = count <= limit;
  return {
    count,
    windowStart,
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfter: allowed ? 0 : Math.ceil((windowStart + windowMs - now) / 1000),
  };
}
/** Inspect a window without consuming a hit. Lockout callers treat an exhausted window
 * as locked; generic callers can continue to use `decide()`'s inclusive hit semantics. */
export function status(stored: CounterState | undefined, { limit, windowMs, now }: WindowOptions) {
  const valid = stored && Number.isFinite(stored.count) && Number.isFinite(stored.windowStart);
  if (!valid || now - stored.windowStart >= windowMs) {
    return { allowed: true, locked: false, remaining: limit, retryAfter: 0 };
  }
  const count = Math.max(0, stored.count);
  const locked = count >= limit;
  return {
    allowed: !locked,
    locked,
    remaining: Math.max(0, limit - count),
    retryAfter: locked ? Math.ceil((stored.windowStart + windowMs - now) / 1000) : 0,
  };
}

/** Map an increment decision to the public hit response shared by the DO and local tests. */
export function hitResult(decision: WindowDecision, { windowMs, now }: Pick<WindowOptions, "windowMs" | "now">): RateResult {
  const locked = !decision.allowed || decision.remaining === 0;
  return {
    allowed: decision.allowed,
    locked,
    remaining: decision.remaining,
    retryAfter: locked ? Math.ceil((decision.windowStart + windowMs - now) / 1000) : decision.retryAfter,
  };
}


type WindowRow = CounterState;
interface RateStorage {
  get<A = unknown>(key: string): Promise<A | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  list(options: { prefix: string; limit: number; startAfter?: string }): Promise<Map<string, WindowRow>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<unknown>;
  deleteAlarm(): Promise<unknown>;
}
interface DurableRateState { storage: RateStorage }

const storageFailure = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export class RateLimit {
  private readonly state: DurableRateState;

  constructor(state: DurableRateState, _env?: unknown) {
    this.state = state;
  }

  private scheduleEffect(expiresAt: number): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: RateLimit) {
      const alarm = yield* Effect.tryPromise({
        try: () => this.state.storage.getAlarm(),
        catch: storageFailure,
      });
      const when = Math.max(Date.now() + 1, expiresAt);
      if (alarm === null || alarm > when) {
        yield* Effect.tryPromise({
          try: () => this.state.storage.setAlarm(when),
          catch: storageFailure,
        });
      }
    }.bind(this));
  }

  /** Sweep a bounded page per alarm. Legacy rows with no recorded duration stay intact. */
  private alarmEffect(): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: RateLimit) {
      const storage = this.state.storage;
      const cursor = yield* Effect.tryPromise({
        try: () => storage.get<string>("sweep:cursor"),
        catch: storageFailure,
      });
      let next = yield* Effect.tryPromise({
        try: () => storage.get<number>("sweep:next"),
        catch: storageFailure,
      });
      const rows = yield* Effect.tryPromise({
        try: () => storage.list({ prefix: "w:", limit: 128, ...(cursor ? { startAfter: cursor } : {}) }),
        catch: storageFailure,
      });
      const now = Date.now();
      const expired: string[] = [];
      for (const [key, row] of rows) {
        if (!Number.isFinite(row?.expiresAt)) continue;
        if ((row.expiresAt as number) <= now) expired.push(key);
        else next = Number.isFinite(next) ? Math.min(next as number, row.expiresAt as number) : row.expiresAt;
      }
      if (expired.length) {
        yield* Effect.tryPromise({ try: () => storage.delete(expired), catch: storageFailure });
      }
      if (rows.size === 128) {
        const last = [...rows.keys()].at(-1);
        if (last) yield* Effect.tryPromise({ try: () => storage.put("sweep:cursor", last), catch: storageFailure });
        if (Number.isFinite(next)) {
          yield* Effect.tryPromise({ try: () => storage.put("sweep:next", next), catch: storageFailure });
        }
        yield* Effect.tryPromise({ try: () => storage.setAlarm(now + 1000), catch: storageFailure });
      } else {
        yield* Effect.tryPromise({ try: () => storage.delete(["sweep:cursor", "sweep:next"]), catch: storageFailure });
        if (Number.isFinite(next)) {
          yield* Effect.tryPromise({
            try: () => storage.setAlarm(Math.max(now + 1000, next as number)),
            catch: storageFailure,
          });
        } else {
          yield* Effect.tryPromise({ try: () => storage.deleteAlarm(), catch: storageFailure });
        }
      }
    }.bind(this));
  }

  /** Cloudflare alarm lifecycle edge. */
  async alarm(): Promise<void> {
    return Effect.runPromise(this.alarmEffect());
  }

  private fetchEffect(request: Request): Effect.Effect<Response, Error> {
    return Effect.gen(function* (this: RateLimit) {
      const raw = yield* Effect.tryPromise({ try: () => request.json(), catch: storageFailure });
      const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const op = body.op;
      const key = String(body.key ?? "");
      if (op === "reset") {
        if (!key) return Response.json({ error: "bad_request" }, { status: 400 });
        yield* Effect.tryPromise({
          try: () => this.state.storage.delete(`w:${key}`),
          catch: storageFailure,
        });
        return Response.json({ ok: true });
      }
      const limit = Number(body.limit);
      const windowMs = Number(body.windowMs);
      if (!key || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      const storageKey = `w:${key}`;
      const stored = yield* Effect.tryPromise({
        try: () => this.state.storage.get<WindowRow>(storageKey),
        catch: storageFailure,
      });
      if (op === "check") {
        // A later caller supplies the old row's actual window duration; never infer it
        // from a default or remove an old lockout merely because it predates this field.
        if (stored && Number.isFinite(stored.windowStart)) {
          const expiresAt = stored.windowStart + windowMs;
          if (stored.expiresAt !== expiresAt) {
            yield* Effect.tryPromise({
              try: () => this.state.storage.put(storageKey, { ...stored, expiresAt }),
              catch: storageFailure,
            });
          }
          yield* this.scheduleEffect(expiresAt);
        }
        const decision = status(stored, { limit, windowMs, now: Date.now() });
        return Response.json({
          allowed: decision.allowed,
          locked: decision.locked,
          remaining: decision.remaining,
          retryAfter: decision.retryAfter,
        });
      }
      if (op !== "hit") return Response.json({ error: "unsupported_op" }, { status: 400 });
      const now = Date.now();
      const decision = decide(stored, { limit, windowMs, now });
      yield* Effect.tryPromise({
        try: () => this.state.storage.put(storageKey, {
          count: decision.count,
          windowStart: decision.windowStart,
          expiresAt: decision.windowStart + windowMs,
        }),
        catch: storageFailure,
      });
      yield* this.scheduleEffect(decision.windowStart + windowMs);
      return Response.json(hitResult(decision, { windowMs, now }));
    }.bind(this));
  }

  /** Public fetch lifecycle edge executes the composed Effect exactly once. */
  async fetch(request: Request): Promise<Response> {
    return Effect.runPromise(this.fetchEffect(request));
  }
}
function rateLimitUnavailable(error: unknown): CodeError {
  const detail = error instanceof Error ? error.message : "request failed";
  return Object.assign(new Error(`RateLimit Durable Object unavailable: ${detail}`), {
    code: "rate-limit-unavailable",
  });
}
/** The platform adapter speaks the real Durable Object protocol without Promise callers. */
export function openRateLimiter(env: Pick<WorkerEnv, "RATELIMIT">): RateLimiter {
  const binding = env.RATELIMIT;
  if (!binding || typeof binding.idFromName !== "function" || typeof binding.get !== "function") {
    throw new Error("RATELIMIT binding is required for platform routes");
  }
  type Payload = { op: "check" | "hit" | "reset"; key: string; limit?: number; windowMs?: number };
  const call = (payload: Payload): Effect.Effect<unknown, CodeError> => Effect.tryPromise({
    try: async () => {
      const stub = binding.get(binding.idFromName("global"));
      if (!stub || typeof stub.fetch !== "function") throw new Error("RATELIMIT binding returned an invalid Durable Object stub");
      const response = await stub.fetch("https://rate-limit/", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status || 0}`);
      return response.json();
    },
    catch: rateLimitUnavailable,
  });
  const window = (payload: Payload): Effect.Effect<RateResult, CodeError> => Effect.flatMap(call(payload), raw => Effect.try({
    try: () => {
      if (!raw || typeof raw !== "object") throw new Error("invalid Durable Object response");
      const result = raw as Record<string, unknown>;
      if (typeof result.allowed !== "boolean" || typeof result.locked !== "boolean"
        || typeof result.remaining !== "number" || typeof result.retryAfter !== "number") {
        throw new Error("invalid Durable Object response");
      }
      return { allowed: result.allowed, locked: result.locked, remaining: result.remaining, retryAfter: result.retryAfter };
    },
    catch: rateLimitUnavailable,
  }));
  return {
    check: (key, options) => window({ op: "check", key, ...options }),
    hit: (key, options) => window({ op: "hit", key, ...options }),
    reset: key => Effect.asVoid(call({ op: "reset", key })),
  };
}
