import { Effect } from "effect";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";

import { scalarSeal, scalarUnseal, sha256hex } from "./crypto.js";

const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StateScope = "personal" | "shared";
export interface StateContext { artifactId: string; actorKey: string; canWriteShared: boolean; anonymous?: boolean }
export interface StateInput { op: unknown; scope?: unknown; key?: unknown; prefix?: unknown; value?: unknown }
export interface StateLimits {
  keyChars: number; valueBytes: number; namespaceKeys: number;
  artifactKeys: number; artifactBytes: number; anonymousKeys: number; anonymousBytes: number;
  anonymousTtlDays: number; pruneBatch: number; pruneBatches: number;
}
export interface RuntimeState {
  execute(context: StateContext, input: StateInput): Effect.Effect<JsonValue, CodeError>;
  pruneExpired(): Effect.Effect<number, CodeError>;
}
interface StateRecord { key: string; value: JsonValue }
const encoder = new TextEncoder();
const DAY_MS = 86_400_000;

/**
 * Storage bounds, shared by the write predicates below and the parent-facing docs. Per
 * artefact, three concentric budgets apply at once:
 *
 *   namespace   per actor/scope (one reader's personal, or the artefact's shared space)
 *   aggregate   every row of the artefact, all actors and both scopes together
 *   anonymous   the anonymous personal subset, which also expires after a year idle
 *
 * The anonymous ceilings are what keep anonymous exhaustion from consuming the reserved
 * registered-user/shared capacity: anonymous rows can never hold more than half the key
 * slots or a quarter of the sealed bytes, so signed-in personal and shared state always
 * retain at least the remainder.
 */
export const STATE_LIMITS: StateLimits = {
  keyChars: 128,
  valueBytes: 64 * 1024,
  namespaceKeys: 128,
  artifactKeys: 4096,
  artifactBytes: 32 * 1024 * 1024,
  anonymousKeys: 2048,
  anonymousBytes: 8 * 1024 * 1024,
  anonymousTtlDays: 365,
  pruneBatch: 500,
  pruneBatches: 20,
};

/**
 * Sealed artifact key/value storage. The caller supplies the immutable, freshly authorized
 * artifact and actor context; `anonymous` marks a cookie-identity reader so personal rows
 * carry the idle expiry (signed-in personal and shared rows are permanent).
 */
export function openRuntimeState({ db, masterKeyHex, now = Date.now, limits = STATE_LIMITS }: {
  db: DatabaseLike; masterKeyHex: string; now?: () => number; limits?: StateLimits;
}): RuntimeState {
  // Live reads on purpose: tests shrink budgets between phases, and a future caller may
  // retune them without reopening the model.
  const rowExpiry = (anonymous: boolean | number, scope: StateScope) =>
    anonymous && scope === "personal" ? new Date(now() + limits.anonymousTtlDays * DAY_MS).toISOString() : null;

  return {
    execute: Effect.fn(function* ({ artifactId, actorKey, canWriteShared, anonymous = false }: StateContext, input: StateInput) {
      const { op, scope = "personal", key, prefix = "" } = input;
      if ((scope !== "personal" && scope !== "shared") || (op !== "get" && op !== "set" && op !== "delete" && op !== "list")) {
        return yield* Effect.fail(fail("invalid-state", "Unknown storage operation or scope."));
      }
      if (scope === "shared" && (op === "set" || op === "delete") && !canWriteShared) {
        return yield* Effect.fail(fail("forbidden", "Shared storage is read-only for this reader."));
      }
      const validKey = (value: unknown, empty = false): value is string => typeof value === "string" && (empty || value.length > 0) &&
        value.length <= limits.keyChars && !/[\u0000-\u001f\u007f]/.test(value);
      if (op === "list" ? !validKey(prefix, true) : !validKey(key)) return yield* Effect.fail(fail("invalid-state", "Storage keys must contain 1–128 printable characters."));
      const actor = scope === "shared" ? "shared" : actorKey;
      const args = [artifactId, scope, actor];
      const where = "artifact_id = ? AND scope = ? AND actor_key = ?";
      // Expired anonymous rows answer nothing and hold nothing: every predicate below counts
      // only live rows, so expiry takes effect without waiting for physical cleanup.
      const live = "AND (expires_at IS NULL OR expires_at > ?)";
      const cutoff = new Date(now()).toISOString();
      if (op === "list") {
        const { results } = yield* io(() => db.prepare(
          `SELECT value_sealed FROM artifact_runtime_state WHERE ${where} ${live}`).bind(...args, cutoff).all<{ value_sealed: string }>());
        const keys = yield* Effect.forEach(results, (row) => Effect.gen(function* () {
          const record = yield* scalarUnseal<StateRecord>(masterKeyHex, row.value_sealed);
          if (!record) return yield* Effect.fail(fail("secrets-auth", "storage value could not be opened"));
          return record.key;
        }));
        return keys.filter((item) => item.startsWith(String(prefix))).sort();
      }
      const hash = yield* sha256hex(key);
      if (op === "get") {
        const row = yield* io(() => db.prepare(
          `SELECT value_sealed FROM artifact_runtime_state WHERE ${where} AND key_hash = ? ${live}`)
          .bind(...args, hash, cutoff).first<{ value_sealed: string }>());
        if (!row) return null;
        // A successful read is activity: the entry's idle lifetime restarts from this read.
        if (anonymous && scope === "personal") {
          yield* io(() => db.prepare(`UPDATE artifact_runtime_state SET expires_at = ?
            WHERE ${where} AND key_hash = ? AND expires_at IS NOT NULL`)
            .bind(rowExpiry(true, scope), ...args, hash).run());
        }
        const record = yield* scalarUnseal<StateRecord>(masterKeyHex, row.value_sealed);
        if (!record) return yield* Effect.fail(fail("secrets-auth", "storage value could not be opened"));
        return record.value;
      }
      if (op === "delete") {
        yield* io(() => db.prepare(`DELETE FROM artifact_runtime_state WHERE ${where} AND key_hash = ?`).bind(...args, hash).run());
        return null;
      }
      const serialized = yield* Effect.try({
        try: () => JSON.stringify(input.value),
        catch: () => fail("invalid-state", "Value must be JSON."),
      });
      if (serialized === undefined) return yield* Effect.fail(fail("invalid-state", "Value must be JSON."));
      if (encoder.encode(serialized).length > limits.valueBytes) return yield* Effect.fail(fail("too-large", "Storage values may not exceed 64 KiB."));
      const sealed = yield* scalarSeal(masterKeyHex, { key, value: JSON.parse(serialized) as JsonValue });
      const anonFlag = anonymous && scope === "personal" ? 1 : 0;
      // One SQLite statement decides everything, so concurrent writers serialize around the
      // committed row rather than a read they each took earlier: no two inserts can both
      // consume the same slot or the same bytes. The byte ceilings subtract the row being
      // replaced (only its live bytes were ever counted), so a replacement that shrinks
      // always fits and one that grows is judged like the insert it really is. The
      // `artifacts` predicate is the write-side deletion guard: a set that races remove()
      // cannot resurrect state on a tombstone, matching the 0010 version triggers.
      const result = yield* io(() => db.prepare(`INSERT INTO artifact_runtime_state
        (artifact_id, scope, actor_key, key_hash, value_sealed, updated_at, expires_at, anonymous)
        SELECT ?,?,?,?,?,?,?,? WHERE
          EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND deleted_at IS NULL AND current_version > 0)
          AND (
            (SELECT COALESCE(SUM(LENGTH(value_sealed)), 0) FROM artifact_runtime_state
              WHERE artifact_id = ? ${live})
            - COALESCE((SELECT LENGTH(value_sealed) FROM artifact_runtime_state
              WHERE ${where} AND key_hash = ? ${live}), 0)
            + LENGTH(?) <= ${limits.artifactBytes}
            AND (? = 0 OR (
              (SELECT COALESCE(SUM(LENGTH(value_sealed)), 0) FROM artifact_runtime_state
                WHERE artifact_id = ? AND scope = 'personal' AND anonymous = 1 ${live})
              - COALESCE((SELECT LENGTH(value_sealed) FROM artifact_runtime_state
                WHERE ${where} AND key_hash = ? ${live}), 0)
              + LENGTH(?) <= ${limits.anonymousBytes}
            ))
            AND (
              EXISTS (SELECT 1 FROM artifact_runtime_state
                WHERE ${where} AND key_hash = ? ${live})
              OR (
                (SELECT COUNT(*) FROM artifact_runtime_state WHERE ${where} ${live})
                  < ${limits.namespaceKeys}
                AND (SELECT COUNT(*) FROM artifact_runtime_state WHERE artifact_id = ? ${live})
                  < ${limits.artifactKeys}
                AND (? = 0 OR (SELECT COUNT(*) FROM artifact_runtime_state
                  WHERE artifact_id = ? AND scope = 'personal' AND anonymous = 1 ${live})
                  < ${limits.anonymousKeys})
              )
            )
          )
        ON CONFLICT(artifact_id, scope, actor_key, key_hash) DO UPDATE SET
          value_sealed = excluded.value_sealed, updated_at = excluded.updated_at,
          expires_at = excluded.expires_at, anonymous = excluded.anonymous`)
        .bind(artifactId, scope, actor, hash, sealed, new Date().toISOString(), rowExpiry(anonFlag, scope), anonFlag,
          artifactId,
          artifactId, cutoff,
          artifactId, scope, actor, hash, cutoff, sealed,
          anonFlag,
          artifactId, cutoff,
          artifactId, scope, actor, hash, cutoff, sealed,
          artifactId, scope, actor, hash, cutoff,
          artifactId, scope, actor, cutoff,
          artifactId, cutoff,
          anonFlag,
          artifactId, cutoff)
        .run());
      if (!result.meta?.changes) {
        // Distinguish a full budget from a dead artefact without leaking internals.
        const row = yield* io(() => db.prepare("SELECT deleted_at, current_version FROM artifacts WHERE id = ?")
          .bind(artifactId).first<{ deleted_at: string | null; current_version: number }>());
        if (!row || row.deleted_at || Number(row.current_version) < 1) {
          return yield* Effect.fail(fail("not-found", "This artefact was deleted; its storage no longer accepts writes."));
        }
        return yield* Effect.fail(fail("quota-exceeded", "This artefact's storage is full. Delete a key first."));
      }
      return null;
    }),

    /**
     * Physically remove expired anonymous rows. Bounded per invocation (at most
     * pruneBatches × pruneBatch rows), ordered by expiry, so a scheduled call makes
     * progress without ever scanning the whole table; the partial index keeps each batch
     * cheap. Expired rows already stopped counting the moment they expired.
     */
    pruneExpired: Effect.fn(function* () {
      const cutoff = new Date(now()).toISOString();
      let removed = 0;
      for (let round = 0; round < limits.pruneBatches; round++) {
        const result = yield* io(() => db.prepare(`DELETE FROM artifact_runtime_state WHERE rowid IN
          (SELECT rowid FROM artifact_runtime_state
            WHERE expires_at IS NOT NULL AND expires_at <= ?
            ORDER BY expires_at LIMIT ${limits.pruneBatch})`).bind(cutoff).run());
        const changes = Number(result.meta?.changes ?? 0);
        removed += changes;
        if (changes < limits.pruneBatch) break;
      }
      return removed;
    }),
  };
}
