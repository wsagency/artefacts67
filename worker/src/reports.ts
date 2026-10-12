import { Effect } from "effect";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";

import { randomHex, scalarSeal, scalarUnseal } from "./crypto.js";

export interface ReportRow {
  id: string;
  artifact_id: string;
  reason_sealed: string;
  created_at: string;
  resolved_at: string | null;
}
export interface Report {
  id: string;
  artifactId: string;
  createdAt: string;
  resolvedAt: string | null;
  reason: string;
}
export interface Reports {
  submit(input: { artifactId: string; actorKey: string; reason: unknown }): Effect.Effect<string, CodeError>;
  list(): Effect.Effect<Report[], CodeError>;
  resolve(id: string, actorId: string): Effect.Effect<boolean, CodeError>;
}
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

export function openReports({ db, masterKeyHex }: { db: DatabaseLike; masterKeyHex: string }): Reports {
  return {
    submit: Effect.fn(function* ({ artifactId, actorKey, reason }: { artifactId: string; actorKey: string; reason: unknown }) {
      if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
        return yield* Effect.fail(Object.assign(new Error("A report reason of 1–2000 characters is required."), { code: "invalid-report" }));
      }
      const id = yield* randomHex(16);
      const sealed = yield* scalarSeal(masterKeyHex, { reason: reason.trim() });
      yield* io(() => db.prepare(`INSERT INTO artifact_reports
        (id, artifact_id, reporter_key, reason_sealed, created_at) VALUES (?,?,?,?,?)`)
        .bind(id, artifactId, actorKey, sealed, new Date().toISOString()).run());
      return id;
    }),
    // Staff sees reported metadata only: no bearer URLs, titles, or document content.
    list: Effect.fn(function* () {
      const { results } = yield* io(() => db.prepare(`SELECT id, artifact_id, reason_sealed, created_at, resolved_at
        FROM artifact_reports ORDER BY resolved_at IS NOT NULL, created_at DESC`).all<ReportRow>());
      return yield* Effect.forEach(results, (row) => Effect.gen(function* () {
        const metadata = yield* scalarUnseal<{ reason: string }>(masterKeyHex, row.reason_sealed);
        if (!metadata) return yield* Effect.fail(Object.assign(new Error("report metadata could not be opened"), { code: "secrets-auth" }));
        return { id: row.id, artifactId: row.artifact_id, createdAt: row.created_at, resolvedAt: row.resolved_at, reason: metadata.reason };
      }));
    }),
    resolve: Effect.fn(function* (id: string, actorId: string) {
      const result = yield* io(() => db.prepare(`UPDATE artifact_reports SET resolved_at = ?, resolved_by = ?
        WHERE id = ? AND resolved_at IS NULL`).bind(new Date().toISOString(), actorId, id).run());
      return Boolean(result.meta?.changes);
    }),
  };
}
