// Test-only D1 adapter over node:sqlite. Native SQLite validates binding values;
// callers provide typed row schemas at the same query boundary as Cloudflare D1.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { DatabaseLike, D1Result, D1Statement, Row } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "../migrations");

export interface TestStatement extends D1Statement {
  sql: string;
  params: unknown[];
  bind(...values: unknown[]): TestStatement;
  run(...values: unknown[]): D1Result & { results: never[] };
  first<A = Row>(...values: unknown[]): A | null;
  all<A = Row>(...values: unknown[]): { results: A[]; meta: object };
}
export interface TestDatabase extends DatabaseLike {
  prepare(sql: string): TestStatement;
  batch(statements: D1Statement[]): D1Result[];
  exec(sql: string): DatabaseSync;
  close(): void;
}

/** A migrated, in-memory D1 adapter; the native methods are synchronous. */
export function openD1Shim(): TestDatabase {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return makeD1(db);
}

/** Bind native SQLite to the positional D1 statement and transactional batch surface. */
export function makeD1(db: DatabaseSync): TestDatabase {
  const makeBound = (sql: string, params: unknown[] = []): TestStatement => ({
    sql,
    params,
    bind(...values: unknown[]) {
      const bindings = values.length === 1 && typeof values[0] === "object" && values[0] !== null
        ? Object.values(values[0]) : values;
      return makeBound(sql, bindings);
    },
    run(...values: unknown[]) {
      // Leave invalid binding rejection to SQLite rather than changing the test driver's policy.
      const result = db.prepare(sql).run(...(values.length ? values : params) as SQLInputValue[]);
      return {
        results: [], success: true,
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    },
    first<A = Row>(...values: unknown[]): A | null {
      return (db.prepare(sql).get(...(values.length ? values : params) as SQLInputValue[]) as A | undefined) ?? null;
    },
    all<A = Row>(...values: unknown[]) {
      return { results: db.prepare(sql).all(...(values.length ? values : params) as SQLInputValue[]) as A[], meta: {} };
    },
  });

  return {
    prepare: sql => makeBound(sql),
    batch(statements) {
      // D1 batches commit together or roll back together, including trigger failures.
      db.exec("SAVEPOINT d1_batch");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) {
          const bound = statement as TestStatement;
          if (typeof bound.sql !== "string") throw new Error("test D1 batch() only takes bound statements");
          const result = db.prepare(bound.sql).run(...(bound.params ?? []) as SQLInputValue[]);
          results.push({
            success: true,
            meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
          });
        }
        db.exec("RELEASE d1_batch");
        return results;
      } catch (error) {
        db.exec("ROLLBACK TO d1_batch; RELEASE d1_batch");
        throw error;
      }
    },
    exec(sql) { db.exec(sql); return db; },
    close() { db.close(); },
  };
}
