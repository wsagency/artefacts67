// Project application data (ADR 0032): declarative collections and sealed records owned by a
// project, which is an artefact's top-level folder. Every write decides existence, kind and
// quota in one SQL statement (the runtime-state pattern), so concurrent writers cannot both
// take the last slot. This model imports no other model.

import { Effect } from "effect";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike } from "./types.js";
import type { JsonValue } from "./runtime-state.js";

import { randomHex, scalarSeal, scalarUnseal } from "./crypto.js";

export type CollectionKind = "records" | "responses";
export type FieldType = "text" | "email" | "number" | "boolean" | "date" | "choice" | "file";
export interface FieldSpec { type: FieldType; required?: boolean; maxLength?: number; min?: number; max?: number; integer?: boolean; options?: string[]; multiple?: boolean; maxBytes?: number; accept?: string[] }
export interface Collection { name: string; kind: CollectionKind; fields: Record<string, FieldSpec>; visitors: boolean; createdAt: string; updatedAt: string }
export type SubmittedBy = { type: "user"; userId: string; email: string; name: string } | { type: "share"; shareId: string; shareName: string };
export interface Submission { submittedAt: string; artifactId: string; artifactVersion: number; submittedBy: SubmittedBy }
export interface ProjectRecord { id: string; collection: string; version: number; data: Record<string, JsonValue>; createdAt: string; updatedAt: string; submission?: Submission }
export interface RecordPage { records: ProjectRecord[]; cursor: string | null }
export interface Issue { field: string; message: string }
export interface ProjectLimits { collections: number; fields: number; recordBytes: number; records: number; projectBytes: number; pageDefault: number; pageMax: number }

export const PROJECT_LIMITS: ProjectLimits = {
  collections: 50, fields: 64, recordBytes: 65_536, records: 20_000, projectBytes: 64 * 1024 * 1024, pageDefault: 100, pageMax: 500,
};

export interface ProjectData {
  projectOf(folderId: string | null | undefined): Effect.Effect<string | null, CodeError>;
  collections(folderId: string): Effect.Effect<Collection[], CodeError>;
  collection(folderId: string, name: string): Effect.Effect<Collection | null, CodeError>;
  define(folderId: string, name: unknown, input: unknown): Effect.Effect<{ collection: Collection; created: boolean }, CodeError>;
  removeCollection(folderId: string, name: string, kind: CollectionKind): Effect.Effect<boolean, CodeError>;
  list(folderId: string, name: string, options?: { limit?: unknown; cursor?: unknown; actorKey?: string }): Effect.Effect<RecordPage, CodeError>;
  get(folderId: string, name: string, id: string): Effect.Effect<ProjectRecord | null, CodeError>;
  create(folderId: string, name: string, data: unknown, submission?: { actorKey: string; meta: Submission }, fileActor?: string): Effect.Effect<ProjectRecord, CodeError>;
  update(folderId: string, name: string, id: string, data: unknown, ifVersion?: unknown, fileActor?: string): Effect.Effect<ProjectRecord, CodeError>;
  remove(folderId: string, name: string, id: string, ifVersion?: unknown): Effect.Effect<boolean, CodeError>;
}

const fail = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const invalid = (issues: Issue[], message = "Record rejected by validation."): CodeError =>
  Object.assign(new Error(message), { code: "validation", issues: issues as unknown as Array<Record<string, unknown>> });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES: Record<string, true> = { text: true, email: true, number: true, boolean: true, date: true, choice: true, file: true };
// File field caps (ADR 0035); the upload limits themselves live in project-files.ts.
const FILE_MAX_BYTES = 104_857_600;
const FILE_MULTIPLE = 10;
const ACCEPT_MAX = 50;
const FILE_ID = /^[0-9a-f]{32}$/;
const ACCEPT_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;
const ACCEPT_EXT = /^\.[a-z0-9][a-z0-9.+-]{0,15}$/;
const TEXT_DEFAULT = 2000;
const encoder = new TextEncoder();
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validateField(name: string, spec: unknown): { value: FieldSpec } | { issue: Issue } {
  const field = `fields.${name}`;
  const bad = (message: string) => ({ issue: { field, message } });
  if (!FIELD_NAME.test(name)) return bad("Field names start with a letter and use letters, digits, - or _ (max 64).");
  if (!isObject(spec) || typeof spec.type !== "string" || !TYPES[spec.type]) return bad("Unknown field type.");
  const type = spec.type as FieldType;
  const out: FieldSpec = { type };
  if (spec.required !== undefined) {
    if (typeof spec.required !== "boolean") return bad("required must be a boolean.");
    if (spec.required) out.required = true;
  }
  if (type === "text" && spec.maxLength !== undefined) {
    if (!Number.isInteger(spec.maxLength) || (spec.maxLength as number) < 1 || (spec.maxLength as number) > 10_000) return bad("maxLength must be 1–10000.");
    out.maxLength = spec.maxLength as number;
  }
  if (type === "number") {
    for (const key of ["min", "max"] as const) {
      if (spec[key] === undefined) continue;
      if (!finite(spec[key])) return bad(`${key} must be a number.`);
      out[key] = spec[key];
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) return bad("min must not exceed max.");
    if (spec.integer !== undefined) {
      if (typeof spec.integer !== "boolean") return bad("integer must be a boolean.");
      if (spec.integer) out.integer = true;
    }
  }
  if (type === "choice") {
    const options = spec.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > 100) return bad("choice needs 1–100 options.");
    if (options.some((option) => typeof option !== "string" || option.length < 1 || option.length > 200)) return bad("Options are strings of 1–200 characters.");
    if (new Set(options).size !== options.length) return bad("Options must be unique.");
    out.options = options as string[];
  }
  if (type === "file") {
    if (spec.maxBytes !== undefined) {
      if (!Number.isInteger(spec.maxBytes) || (spec.maxBytes as number) < 1 || (spec.maxBytes as number) > FILE_MAX_BYTES) return bad("maxBytes must be 1–104857600.");
      out.maxBytes = spec.maxBytes as number;
    }
    if (spec.accept !== undefined) {
      const accept = spec.accept;
      if (!Array.isArray(accept) || accept.length < 1 || accept.length > ACCEPT_MAX || new Set(accept).size !== accept.length
        || accept.some((entry) => typeof entry !== "string" || !(ACCEPT_MIME.test(entry) || ACCEPT_EXT.test(entry)))) {
        return bad("accept lists 1–50 unique MIME types (type/subtype, type/*) or .extensions.");
      }
      out.accept = accept as string[];
    }
  }
  if ((type === "choice" || type === "file") && spec.multiple !== undefined) {
    if (typeof spec.multiple !== "boolean") return bad("multiple must be a boolean.");
    if (spec.multiple) out.multiple = true;
  }
  return { value: out };
}

/** Validate a collection definition `{ kind, fields, visitors? }`. */
export function validateCollection(input: unknown, limits: ProjectLimits = PROJECT_LIMITS):
  { value: { kind: CollectionKind; fields: Record<string, FieldSpec>; visitors: boolean } } | { issues: Issue[] } {
  if (!isObject(input)) return { issues: [{ field: "collection", message: "A collection definition is an object." }] };
  const issues: Issue[] = [];
  const kind = input.kind;
  if (kind !== "records" && kind !== "responses") issues.push({ field: "kind", message: "kind is records or responses." });
  const visitors = input.visitors ?? false;
  if (typeof visitors !== "boolean") issues.push({ field: "visitors", message: "visitors must be a boolean." });
  const fields: Record<string, FieldSpec> = {};
  const entries = isObject(input.fields) ? Object.entries(input.fields) : [];
  if (entries.length < 1 || entries.length > limits.fields) {
    issues.push({ field: "fields", message: `A collection has 1–${limits.fields} fields.` });
  } else {
    for (const [name, spec] of entries) {
      const result = validateField(name, spec);
      if ("issue" in result) issues.push(result.issue);
      else fields[name] = result.value;
    }
  }
  if (issues.length) return { issues };
  return { value: { kind: kind as CollectionKind, fields, visitors: visitors as boolean } };
}

const realDate = (value: string) => {
  const match = DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

function coerce(spec: FieldSpec, raw: unknown): { value: JsonValue } | { message: string } {
  switch (spec.type) {
    case "text": {
      if (typeof raw !== "string") return { message: "Expected text." };
      const max = spec.maxLength ?? TEXT_DEFAULT;
      return raw.length > max ? { message: `At most ${max} characters.` } : { value: raw };
    }
    case "email":
      if (typeof raw !== "string" || raw.length > 254 || !EMAIL.test(raw)) return { message: "Expected an email address." };
      return { value: raw };
    case "number": {
      const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (!finite(number)) return { message: "Expected a number." };
      if (spec.integer && !Number.isInteger(number)) return { message: "Expected a whole number." };
      if (spec.min !== undefined && number < spec.min) return { message: `At least ${spec.min}.` };
      if (spec.max !== undefined && number > spec.max) return { message: `At most ${spec.max}.` };
      return { value: number };
    }
    case "boolean": {
      const value = raw === true || raw === "on" || raw === "true" ? true : raw === false || raw === "false" ? false : null;
      if (value === null) return { message: "Expected true or false." };
      if (spec.required && !value) return { message: "This confirmation is required." };
      return { value };
    }
    case "date":
      return typeof raw === "string" && realDate(raw) ? { value: raw } : { message: "Expected a date (YYYY-MM-DD)." };
    case "choice": {
      const options = spec.options ?? [];
      if (spec.multiple) {
        const list = typeof raw === "string" ? [raw] : raw;
        if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !options.includes(item))) return { message: "Choose from the listed options." };
        return { value: list as string[] };
      }
      return typeof raw === "string" && options.includes(raw) ? { value: raw } : { message: "Choose one of the listed options." };
    }
    case "file": {
      const idOf = (entry: unknown) => typeof entry === "string" ? entry : isObject(entry) && typeof entry.id === "string" ? entry.id : null;
      if (!spec.multiple && Array.isArray(raw)) return { message: "Expected one file." };
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.length > FILE_MULTIPLE) return { message: `At most ${FILE_MULTIPLE} files.` };
      const ids = list.map(idOf);
      if (ids.some((id) => id === null || !FILE_ID.test(id))) return { message: "Expected a file id." };
      if (new Set(ids).size !== ids.length) return { message: "This file is listed twice." };
      return { value: spec.multiple ? ids as string[] : ids[0] as string };
    }
  }
}

/**
 * Validate and coerce one record against a collection's fields. An empty string (or empty
 * multiple choice) is "absent"; an absent optional boolean is stored as false.
 */
export function validateRecord(fields: Record<string, FieldSpec>, input: unknown):
  { value: Record<string, JsonValue> } | { issues: Issue[] } {
  if (!isObject(input)) return { issues: [{ field: "data", message: "Record data is an object." }] };
  const issues: Issue[] = [];
  const value: Record<string, JsonValue> = {};
  const fileIds = new Set<string>();
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(fields, name)) issues.push({ field: name, message: "Unknown field." });
  }
  for (const [name, spec] of Object.entries(fields)) {
    const raw = Object.hasOwn(input, name) ? input[name] : undefined;
    const absent = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (absent) {
      if (spec.required) issues.push({ field: name, message: spec.type === "boolean" ? "This confirmation is required." : "This field is required." });
      else if (spec.type === "boolean") value[name] = false;
      continue;
    }
    const result = coerce(spec, raw);
    if ("message" in result) issues.push({ field: name, message: result.message });
    else if (spec.type === "file" && [result.value].flat().some((id) => fileIds.has(id as string))) issues.push({ field: name, message: "This file is used twice." });
    else {
      value[name] = result.value;
      if (spec.type === "file") for (const id of [result.value].flat()) fileIds.add(id as string);
    }
  }
  return issues.length ? { issues } : { value };
}

interface CollectionRow { name: string; kind: CollectionKind; schema_json: string; visitors: number; created_at: string; updated_at: string }
interface RecordRow { id: string; collection: string; version: number; data_sealed: string; submission_sealed: string | null; created_at: string; updated_at: string }
interface FileRow { id: string; field: string; status: string; record_id: string | null; actor_key: string; expires_at: string | null; size: number; meta_sealed: string }
interface FileRefInput { id: string; field: string }
const NOT_AVAILABLE = "File is not available. Upload it again.";
// A write's referenced files are all attachable: on their field, either ready, unexpired and
// uploaded by the file actor, or already attached to this record. Bindings: refs JSON, folder,
// collection, file actor, now, record id (NULL on create), refs JSON.
const FILES_ATTACHABLE = `(SELECT COUNT(*) FROM json_each(?) AS r JOIN project_files AS f
    ON f.id = json_extract(r.value, '$.id') AND f.field = json_extract(r.value, '$.field')
  WHERE f.folder_id = ? AND f.collection = ?
    AND ((f.status = 'ready' AND f.record_id IS NULL AND f.actor_key = ? AND f.expires_at > ?)
      OR (f.status = 'attached' AND f.record_id = ?))) = json_array_length(?)`;
// Both run in the record's batch and act only if that write landed (its fresh last_write).
const ATTACH = `UPDATE project_files SET status = 'attached', record_id = ?1, expires_at = NULL
  WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
    AND EXISTS (SELECT 1 FROM project_records WHERE id = ?1 AND last_write = ?3)`;
const DROP = `UPDATE project_files SET status = 'deleted', deleted_at = ?4
  WHERE record_id = ?1 AND status = 'attached'
    AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
    AND EXISTS (SELECT 1 FROM project_records WHERE id = ?1 AND last_write = ?3)`;

const toCollection = (row: CollectionRow): Collection => ({
  name: row.name, kind: row.kind, fields: JSON.parse(row.schema_json) as Record<string, FieldSpec>,
  visitors: Boolean(row.visitors), createdAt: row.created_at, updatedAt: row.updated_at,
});

const encodeCursor = (createdAt: string, id: string) =>
  btoa(JSON.stringify([createdAt, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decodeCursor = (cursor: string): [string, string] | null => {
  try {
    const parsed: unknown = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((item) => typeof item === "string") ? parsed as [string, string] : null;
  } catch {
    return null;
  }
};

/** A positive integer, accepting the numeric strings query parameters carry. */
const positiveInt = (value: unknown): number | null => {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && (number as number) > 0 ? number as number : null;
};

export function openProjectData({ db, masterKeyHex, now = Date.now, limits = PROJECT_LIMITS }: {
  db: DatabaseLike; masterKeyHex: string; now?: () => number; limits?: ProjectLimits;
}): ProjectData {
  const nowIso = () => new Date(now()).toISOString();
  const bytesOf = "(SELECT COALESCE(SUM(LENGTH(data_sealed) + COALESCE(LENGTH(submission_sealed), 0)), 0) FROM project_records WHERE folder_id = ?)";

  const toRecord = (row: RecordRow) => Effect.gen(function* () {
    const data = yield* scalarUnseal<Record<string, JsonValue>>(masterKeyHex, row.data_sealed);
    if (!data) return yield* Effect.fail(fail("secrets-auth", "record could not be opened"));
    const record: ProjectRecord = {
      id: row.id, collection: row.collection, version: Number(row.version), data,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    if (row.submission_sealed) {
      const submission = yield* scalarUnseal<Submission>(masterKeyHex, row.submission_sealed);
      if (!submission) return yield* Effect.fail(fail("secrets-auth", "submission could not be opened"));
      record.submission = submission;
    }
    return record;
  });

  const collection = Effect.fn(function* (folderId: string, name: string) {
    const row = yield* io(() => db.prepare(
      "SELECT name, kind, schema_json, visitors, created_at, updated_at FROM project_collections WHERE folder_id = ? AND name = ?",
    ).bind(folderId, name).first<CollectionRow>());
    return row ? toCollection(row) : null;
  });
  const requireCollection = (folderId: string, name: string) => Effect.flatMap(collection(folderId, name),
    (found) => found ? Effect.succeed(found) : Effect.fail(fail("not-found", "No such collection in this project.")));

  const readRow = (folderId: string, name: string, id: string) => io(() => db.prepare(
    "SELECT id, collection, version, data_sealed, submission_sealed, created_at, updated_at FROM project_records WHERE id = ? AND folder_id = ? AND collection = ?",
  ).bind(id, folderId, name).first<RecordRow>());

  /** Swap each referenced file id for its { id, name, type, size } descriptor, refusing any not attachable. */
  const resolveFiles = Effect.fn(function* (folderId: string, collection: string, fields: Record<string, FieldSpec>,
    value: Record<string, JsonValue>, recordId: string | null, fileActor: string | undefined) {
    const files = Object.keys(fields).filter((field) => fields[field]!.type === "file" && Object.hasOwn(value, field));
    const refs: FileRefInput[] = files.flatMap((field) => [value[field]].flat().map((id) => ({ id: id as string, field })));
    if (!refs.length) return { value, refs };
    const { results } = yield* io(() => db.prepare(
      "SELECT id, field, status, record_id, actor_key, expires_at, size, meta_sealed FROM project_files WHERE folder_id = ? AND collection = ? AND id IN (SELECT value FROM json_each(?))",
    ).bind(folderId, collection, JSON.stringify(refs.map((ref) => ref.id))).all<FileRow>());
    const rows = new Map(results.map((row) => [row.id, row]));
    const at = nowIso();
    const issues: Issue[] = [];
    const descriptors = new Map<string, JsonValue>();
    for (const ref of refs) {
      const row = rows.get(ref.id);
      const attachable = row !== undefined && row.field === ref.field && (
        (row.status === "ready" && row.record_id === null && fileActor !== undefined && row.actor_key === fileActor && row.expires_at !== null && row.expires_at > at)
        || (row.status === "attached" && row.record_id === recordId));
      if (!attachable) {
        if (!issues.some((issue) => issue.field === ref.field)) issues.push({ field: ref.field, message: NOT_AVAILABLE });
        continue;
      }
      const meta = yield* scalarUnseal<{ name: string; type: string }>(masterKeyHex, row.meta_sealed);
      if (!meta) return yield* Effect.fail(fail("secrets-auth", "file metadata could not be opened"));
      descriptors.set(ref.id, { id: ref.id, name: meta.name, type: meta.type, size: Number(row.size) });
    }
    if (issues.length) return yield* Effect.fail(invalid(issues));
    const swapped = { ...value };
    for (const field of files) {
      const ids = value[field];
      swapped[field] = Array.isArray(ids) ? ids.map((id) => descriptors.get(id as string)!) : descriptors.get(ids as string)!;
    }
    return { value: swapped, refs };
  });

  const sealData = Effect.fn(function* (folderId: string, collection: string, fields: Record<string, FieldSpec>, input: unknown,
    recordId: string | null, fileActor: string | undefined) {
    const checked = validateRecord(fields, input);
    if ("issues" in checked) return yield* Effect.fail(invalid(checked.issues));
    const { value, refs } = yield* resolveFiles(folderId, collection, fields, checked.value, recordId, fileActor);
    if (encoder.encode(JSON.stringify(value)).length > limits.recordBytes) return yield* Effect.fail(fail("too-large", "A record may not exceed 64 KiB."));
    return { sealed: yield* scalarSeal(masterKeyHex, value), refs: JSON.stringify(refs) };
  });

  const versionOf = (ifVersion: unknown) => {
    if (ifVersion === undefined || ifVersion === null || ifVersion === "") return Effect.succeed(null);
    const version = positiveInt(ifVersion);
    return version === null ? Effect.fail(invalid([{ field: "ifVersion", message: "ifVersion is a positive integer." }], "ifVersion is a positive integer.")) : Effect.succeed(version);
  };

  return {
    projectOf: Effect.fn(function* (folderId: string | null | undefined) {
      if (!folderId) return null;
      const row = yield* io(() => db.prepare(
        "WITH RECURSIVE chain(id, parent_id, visited) AS (" +
        "  SELECT id, parent_id, '|' || id || '|' FROM folders WHERE id = ?" +
        "  UNION ALL" +
        "  SELECT f.id, f.parent_id, c.visited || f.id || '|' FROM folders f JOIN chain c ON f.id = c.parent_id" +
        "   WHERE instr(c.visited, '|' || f.id || '|') = 0)" +
        " SELECT id FROM chain WHERE parent_id IS NULL LIMIT 1",
      ).bind(folderId).first<{ id: string }>());
      return row?.id ?? null;
    }),

    collections: Effect.fn(function* (folderId: string) {
      const { results } = yield* io(() => db.prepare(
        "SELECT name, kind, schema_json, visitors, created_at, updated_at FROM project_collections WHERE folder_id = ? ORDER BY name",
      ).bind(folderId).all<CollectionRow>());
      return results.map(toCollection);
    }),

    collection,

    define: Effect.fn(function* (folderId: string, name: unknown, input: unknown) {
      const issues: Issue[] = [];
      if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
        issues.push({ field: "name", message: "Collection names start with a lowercase letter and use a-z, 0-9, - or _ (max 64)." });
      }
      const checked = validateCollection(input, limits);
      if ("issues" in checked) issues.push(...checked.issues);
      if (issues.length || "issues" in checked) return yield* Effect.fail(invalid(issues, "Collection rejected by validation."));
      const { kind, fields, visitors } = checked.value;
      // Only the 201/200 answer depends on this; a racing first define may both report created.
      const existed = Boolean(yield* collection(folderId, name as string));
      const at = nowIso();
      // One statement: top-level folder, collection budget and immutable kind.
      const result = yield* io(() => db.prepare(`INSERT INTO project_collections
        (folder_id, name, kind, schema_json, visitors, created_at, updated_at)
        SELECT ?,?,?,?,?,?,? WHERE
          EXISTS (SELECT 1 FROM folders WHERE id = ? AND parent_id IS NULL)
          AND (EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ? AND name = ?)
            OR (SELECT COUNT(*) FROM project_collections WHERE folder_id = ?) < ${limits.collections})
        ON CONFLICT(folder_id, name) DO UPDATE SET
          schema_json = excluded.schema_json, visitors = excluded.visitors, updated_at = excluded.updated_at
          WHERE project_collections.kind = excluded.kind`)
        .bind(folderId, name, kind, JSON.stringify(fields), visitors ? 1 : 0, at, at,
          folderId, folderId, name, folderId).run());
      const saved = yield* collection(folderId, name as string);
      if (!result.meta?.changes || !saved) {
        const folder = yield* io(() => db.prepare("SELECT parent_id FROM folders WHERE id = ?").bind(folderId).first<{ parent_id: string | null }>());
        if (!folder) return yield* Effect.fail(fail("not-found", "No such folder."));
        if (folder.parent_id !== null) return yield* Effect.fail(fail("not-top-level", "Only a top-level folder is a project."));
        if (saved && saved.kind !== kind) return yield* Effect.fail(fail("conflict", "A collection's kind cannot change."));
        return yield* Effect.fail(fail("quota-exceeded", `A project holds at most ${limits.collections} collections.`));
      }
      return { collection: saved, created: !existed };
    }),

    removeCollection: Effect.fn(function* (folderId: string, name: string, kind: CollectionKind) {
      const at = nowIso();
      // Every delete is conditional on the kind the caller authorized against; the collection's
      // files (in any state) are marked for the sweep only once the collection is gone.
      const [, removed] = yield* io(() => db.batch([
        db.prepare(`DELETE FROM project_records WHERE folder_id = ? AND collection = ?
          AND EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ? AND name = ? AND kind = ?)`).bind(folderId, name, folderId, name, kind),
        db.prepare("DELETE FROM project_collections WHERE folder_id = ? AND name = ? AND kind = ?").bind(folderId, name, kind),
        db.prepare(`UPDATE project_files SET status = 'deleted', deleted_at = ? WHERE folder_id = ? AND collection = ? AND status <> 'deleted'
          AND NOT EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ? AND name = ?)`).bind(at, folderId, name, folderId, name),
      ]));
      return Boolean(removed?.meta?.changes);
    }),

    list: Effect.fn(function* (folderId: string, name: string, options: { limit?: unknown; cursor?: unknown; actorKey?: string } = {}) {
      const limit = options.limit === undefined || options.limit === "" ? limits.pageDefault : positiveInt(options.limit);
      if (limit === null || limit > limits.pageMax) {
        return yield* Effect.fail(invalid([{ field: "limit", message: `limit is 1–${limits.pageMax}.` }], `limit is 1–${limits.pageMax}.`));
      }
      let after: [string, string] | null = null;
      if (options.cursor !== undefined && options.cursor !== "") {
        after = typeof options.cursor === "string" ? decodeCursor(options.cursor) : null;
        if (!after) return yield* Effect.fail(invalid([{ field: "cursor", message: "Unknown cursor." }], "Unknown cursor."));
      }
      yield* requireCollection(folderId, name);
      const where = ["folder_id = ?", "collection = ?"];
      const args: unknown[] = [folderId, name];
      if (options.actorKey !== undefined) { where.push("actor_key = ?"); args.push(options.actorKey); }
      if (after) { where.push("(created_at > ? OR (created_at = ? AND id > ?))"); args.push(after[0], after[0], after[1]); }
      const { results } = yield* io(() => db.prepare(
        `SELECT id, collection, version, data_sealed, submission_sealed, created_at, updated_at FROM project_records
          WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ${limit + 1}`,
      ).bind(...args).all<RecordRow>());
      const page = results.slice(0, limit);
      const records = yield* Effect.forEach(page, toRecord);
      const last = page.at(-1);
      return { records, cursor: results.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
    }),

    get: Effect.fn(function* (folderId: string, name: string, id: string) {
      const row = yield* readRow(folderId, name, id);
      return row ? yield* toRecord(row) : null;
    }),

    create: Effect.fn(function* (folderId: string, name: string, data: unknown, submission?: { actorKey: string; meta: Submission }, fileActor?: string) {
      const found = yield* requireCollection(folderId, name);
      if ((found.kind === "responses") !== Boolean(submission)) {
        return yield* Effect.fail(fail("wrong-kind", found.kind === "responses"
          ? "Responses are submitted by readers, not written directly."
          : "Only responses collections take submissions."));
      }
      const actor = submission?.actorKey ?? fileActor;
      const { sealed, refs } = yield* sealData(folderId, name, found.fields, data, null, actor);
      const submissionSealed = submission ? yield* scalarSeal(masterKeyHex, submission.meta) : null;
      const id = yield* randomHex(16);
      const lastWrite = yield* randomHex(16);
      const at = nowIso();
      const [result] = yield* io(() => db.batch([
        db.prepare(`INSERT INTO project_records
          (id, folder_id, collection, version, data_sealed, submission_sealed, actor_key, artifact_id, created_at, updated_at, last_write)
          SELECT ?,?,?,1,?,?,?,?,?,?,? WHERE
            EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ? AND name = ? AND kind = ?)
            AND (SELECT COUNT(*) FROM project_records WHERE folder_id = ?) < ${limits.records}
            AND ${bytesOf} + LENGTH(?) + COALESCE(LENGTH(?), 0) <= ${limits.projectBytes}
            AND ${FILES_ATTACHABLE}`)
          .bind(id, folderId, name, sealed, submissionSealed, submission?.actorKey ?? null, submission?.meta.artifactId ?? null, at, at, lastWrite,
            folderId, name, found.kind,
            folderId,
            folderId, sealed, submissionSealed,
            refs, folderId, name, actor ?? null, at, null, refs),
        db.prepare(ATTACH).bind(id, refs, lastWrite),
      ]));
      if (!result?.meta?.changes) {
        yield* requireCollection(folderId, name);
        yield* sealData(folderId, name, found.fields, data, null, actor);   // a file lost to a racing write fails here
        return yield* Effect.fail(fail("quota-exceeded", "This project's data storage is full."));
      }
      const row = yield* readRow(folderId, name, id);
      if (!row) return yield* Effect.fail(fail("not-found", "The record was removed."));
      return yield* toRecord(row);
    }),

    update: Effect.fn(function* (folderId: string, name: string, id: string, data: unknown, ifVersion?: unknown, fileActor?: string) {
      const expected = yield* versionOf(ifVersion);
      const found = yield* requireCollection(folderId, name);
      if (found.kind !== "records") return yield* Effect.fail(fail("wrong-kind", "Responses cannot be edited."));
      const { sealed, refs } = yield* sealData(folderId, name, found.fields, data, id, fileActor);
      const lastWrite = yield* randomHex(16);
      const at = nowIso();
      const [result] = yield* io(() => db.batch([
        db.prepare(`UPDATE project_records
          SET data_sealed = ?, version = version + 1, updated_at = ?, last_write = ?
          WHERE id = ? AND folder_id = ? AND collection = ? AND (? IS NULL OR version = ?)
            AND EXISTS (SELECT 1 FROM project_collections WHERE folder_id = ? AND name = ? AND kind = 'records')
            AND ${bytesOf} - LENGTH(data_sealed) + LENGTH(?) <= ${limits.projectBytes}
            AND ${FILES_ATTACHABLE}`)
          .bind(sealed, at, lastWrite, id, folderId, name, expected, expected, folderId, name, folderId, sealed,
            refs, folderId, name, fileActor ?? null, at, id, refs),
        db.prepare(ATTACH).bind(id, refs, lastWrite),
        db.prepare(DROP).bind(id, refs, lastWrite, at),
      ]));
      if (!result?.meta?.changes) {
        const row = yield* readRow(folderId, name, id);
        if (!row) return yield* Effect.fail(fail("not-found", "No such record."));
        if (expected !== null && Number(row.version) !== expected) return yield* Effect.fail(fail("conflict", "The record changed since that version."));
        yield* sealData(folderId, name, found.fields, data, id, fileActor);   // a file lost to a racing write fails here
        return yield* Effect.fail(fail("quota-exceeded", "This project's data storage is full."));
      }
      const row = yield* readRow(folderId, name, id);
      if (!row) return yield* Effect.fail(fail("not-found", "No such record."));
      return yield* toRecord(row);
    }),

    remove: Effect.fn(function* (folderId: string, name: string, id: string, ifVersion?: unknown) {
      const expected = yield* versionOf(ifVersion);
      const [result] = yield* io(() => db.batch([
        db.prepare("DELETE FROM project_records WHERE id = ? AND folder_id = ? AND collection = ? AND (? IS NULL OR version = ?)")
          .bind(id, folderId, name, expected, expected),
        db.prepare(`UPDATE project_files SET status = 'deleted', deleted_at = ? WHERE record_id = ? AND folder_id = ? AND collection = ?
          AND status = 'attached' AND NOT EXISTS (SELECT 1 FROM project_records WHERE id = ?)`).bind(nowIso(), id, folderId, name, id),
      ]));
      if (result?.meta?.changes) return true;
      if (expected !== null && (yield* readRow(folderId, name, id))) return yield* Effect.fail(fail("conflict", "The record changed since that version."));
      return false;
    }),
  };
}
