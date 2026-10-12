// /_health proves every binding is wired: one D1 query, one R2 list, one DO
// round-trip. 200 only when all three answer.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { json } from "./respond.js";
import { asCodeError, type WorkerEnv } from "./types.js";

type Check = "ok" | "unexpected" | "error";
type Checks = { db?: Check; r2?: Check; ratelimit?: Check };
type Probe = { status: Check; message?: string };
const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** Health is an Effect: each binding check recovers expected probe failures into a 503 payload. */
export const health = Effect.fn("health")(function* (env: WorkerEnv, version: string) {
    const started = Date.now();
    const checks: Checks = {};
    const failures: string[] = [];

    const dbCheck = yield* Effect.tryPromise({
      try: () => Promise.resolve(env.DB.prepare("SELECT 1 AS ok").first()),
      catch: asCodeError,
    }).pipe(
      Effect.map((row): Probe => ({ status: row?.ok === 1 ? "ok" : "unexpected" })),
      Effect.catchCause((cause) => Effect.succeed({ status: "error" as const, message: messageOf(cause) })),
    );
    checks.db = dbCheck.status;
    if (checks.db !== "ok") failures.push(`db: ${dbCheck.message ?? "unexpected result"}`);

    const r2Check = yield* Effect.tryPromise({
      try: () => Promise.resolve(env.ARTIFACTS.list({ limit: 1 })),
      catch: asCodeError,
    }).pipe(
      Effect.map((list): Probe => ({ status: Array.isArray(list.objects) ? "ok" : "unexpected" })),
      Effect.catchCause((cause) => Effect.succeed({ status: "error" as const, message: messageOf(cause) })),
    );
    checks.r2 = r2Check.status;
    if (checks.r2 !== "ok") failures.push(`r2: ${r2Check.message ?? "unexpected result"}`);

    const rateCheck = yield* Effect.tryPromise({
      try: async () => {
        const stub = env.RATELIMIT.get(env.RATELIMIT.idFromName("health"));
        return stub.fetch("https://rate-limit/", {
          method: "POST",
          body: JSON.stringify({ op: "hit", key: `health:${started}`, limit: 1e9, windowMs: 1000 }),
        });
      },
      catch: asCodeError,
    }).pipe(
      Effect.flatMap((response) => Effect.tryPromise({ try: () => response.json(), catch: asCodeError })),
      Effect.map((value): Probe => ({ status: (value && typeof value === "object" && "allowed" in value && value.allowed)
        ? "ok" : "unexpected" })),
      Effect.catchCause((cause) => Effect.succeed({ status: "error" as const, message: messageOf(cause) })),
    );
    checks.ratelimit = rateCheck.status;
    if (checks.ratelimit !== "ok") failures.push(`ratelimit: ${rateCheck.message ?? "unexpected result"}`);

    const ok = Object.values(checks).every((value) => value === "ok");
    const payload: { ok: boolean; checks: Checks; version: string; ms: number; failures?: string[] } = {
      ok, checks, version, ms: Date.now() - started,
    };
    if (failures.length) payload.failures = failures;
    return json(payload, ok ? 200 : 503);
  });
