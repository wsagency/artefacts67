// The artefact model (ADR 0013: content in R2, state in D1; ADR 0014: crypto tiering).
//
// Two tiers, both from ADR 0014:
//   * CONTENT — one random 256-bit key per artefact seals every version's bytes, held as one
//     R2 object per version under `art/<artifactId>/` (a unique key per write attempt, so an
//     interrupted attempt can never wedge the next one; the version row's `r2_key` rules).
//     The key itself is never stored
//     raw; it is wrapped twice, both wraps in D1: under the artefact password (visitor path,
//     unwrapped in the browser) and under the platform master key (owner path: preview,
//     export, password rotation).
//   * METADATA — title and gate verifier are sealed rows under the master key, so a D1/R2
//     dump on its own is inert.
//
// The content key belongs to the ARTEFACT, not to the version. That is what makes rotation
// cheap (a new password re-wraps one small row; the multi-megabyte object is never touched,
// ADR 0014) and what lets a new version be published without the password at all.
//
// Write order: the R2 object always lands before the rows that make it live. `create` writes
// the metadata row first (version 0 — a draft that serves 404), then the object, then the
// version row and the `current_version` bump in one batch; `publish` writes the object and then
// that same batch. Any interruption therefore leaves an artefact serving 404 or its previous
// version — never half a document (ADR 0013).

import { Cause, Effect } from "effect";
import type { PasswordWrap, SealRecord, Verifier } from "./crypto.js";
import type { ArtifactService, FontFetcher, PreparationOptions, PreparedArtifactHtml } from "./fonts.js";
import type { Settings } from "./store.js";
import type { ValidationIssue } from "./validate.js";
import { asCodeError, type Awaitable, type CodeError, type DatabaseLike, type D1Statement, type R2BucketLike } from "./types.js";

import {
  PBKDF2_ITER, hex, makeVerifier, openBlob, randomHex, scalarSeal, scalarUnseal,
  sealAES, sealBlob, sha256, splitBlob, unsealAES, utf8, verifyVerifier, wrapUnderPassword,
} from "./crypto.js";
import { artifactObject } from "./r2keys.js";
import { mintPathId, normalizePath, pathTaken } from "./paths.js";
import { FONT_LIMITS, openArtifactService, prepareArtifactHtml } from "./fonts.js";

const enc = new TextEncoder();
const nowIso = () => new Date().toISOString();
const KEY_BYTES = 32;
/** The daily purge of withdrawn artefacts (ADR 0038): `batches` rounds of `batch` per run, each
 *  artefact withdrawn at least `graceMs` ago so an in-flight publication finishes first. */
export const PURGE_LIMITS = { batch: 10, batches: 10, graceMs: 3_600_000 } as const;

const coded = (code: string, message: string): CodeError => Object.assign(new Error(message), { code });
const io = <A>(run: () => Awaitable<A>): Effect.Effect<A, CodeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(run()), catch: asCodeError });

const parseJson = <A>(value: string | null | undefined): A | null => {
  if (!value) return null;
  try { return JSON.parse(value) as A; } catch { return null; }
};

export type AuthorType = "user" | "api_key";
export interface ArtifactRow {
  id: string; owner_id: string; folder_id: string | null; slug: string | null; lang: string;
  title_sealed: string; header_ui: number; current_version: number;
  password_salt: string | null; password_verifier: string | null;
  key_wrap_password: string | null; key_wrap_master: string | null; max_versions: number | null;
  created_at: string; updated_at: string; deleted_at: string | null; purged_at: string | null;
}
export interface Artifact {
  id: string; ownerId: string; folderId: string | null; slug: string | null; lang: string;
  titleSealed: string; headerUi: boolean; currentVersion: number; verifier: Verifier | null;
  wrapPassword: PasswordWrap | null; wrapMaster: SealRecord | null; maxVersions: number | null;
  createdAt: string; updatedAt: string; deletedAt: string | null; purgedAt: string | null;
}
export interface ArtifactVersionRow {
  artifact_id: string; version: number; r2_key: string; size: number; sha256: string;
  author_type: AuthorType; author_id: string; note: string | null; created_at: string;
}
export interface ArtifactVersion {
  artifactId: string; version: number; r2Key: string; size: number; sha256: string;
  authorType: AuthorType; authorId: string; note: string | null; createdAt: string;
}
export interface ArtifactCiphertext { v: 1; iv: string; ct: string }
export interface GatePayload { wrap: PasswordWrap; content: ArtifactCiphertext }
export interface CreateArtifact {
  ownerId: string; folderId?: string | null; title?: unknown; lang?: unknown; html: unknown;
  password?: unknown; slug?: string | null; authorType?: AuthorType; authorId: string;
  note?: string | null; prepared?: unknown;
}
export interface PublishArtifact {
  artifactId: string; html: unknown; authorType?: AuthorType; authorId: string;
  note?: string | null; password?: unknown; title?: unknown; lang?: unknown; prepared?: unknown;
}
export interface DuplicateArtifact extends Omit<CreateArtifact, "html" | "prepared"> { artifactId: string }
export interface RestoreArtifact { artifactId: string; version: unknown; authorType?: AuthorType; authorId: string; note?: string | null }
export interface PublishedVersion { version: number; size: number; createdAt: string; warnings: ValidationIssue[] }
export type ArtifactChange = (artifactId: string) => Effect.Effect<unknown, CodeError>;
export interface Artifacts {
  setOnChange(fn: ArtifactChange | null): void;
  toArtifact(row: ArtifactRow): Artifact;
  toArtifact(row: ArtifactRow | null | undefined): Artifact | null;
  byId(id: unknown): Effect.Effect<Artifact | null, CodeError>;
  bySlug(slug: unknown): Effect.Effect<Artifact | null, CodeError>;
  aliasOf(path: string): Effect.Effect<Artifact | null, CodeError>;
  aliasesFor(artifactId: unknown): Effect.Effect<string[], CodeError>;
  byPath(path: unknown): Effect.Effect<Artifact | null, CodeError>;
  pathTaken(path: string, options?: { except?: string | null }): Effect.Effect<boolean, CodeError>;
  listByFolder(folderId: string): Effect.Effect<Artifact[], CodeError>;
  listByOwner(ownerId: string): Effect.Effect<Artifact[], CodeError>;
  listForEstate(ownerId: string, folderIds: string[]): Effect.Effect<Artifact[], CodeError>;
  setMeta(artifactId: string, meta?: { title?: unknown; lang?: unknown }): Effect.Effect<Artifact, CodeError>;
  versions(artifactId: string): Effect.Effect<ArtifactVersion[], CodeError>;
  title(artifact: Artifact | null | undefined): Effect.Effect<string, CodeError>;
  gated(artifact: Artifact | null | undefined): boolean;
  live(artifact: Artifact | null | undefined): boolean;
  verifyPassword(artifact: Artifact | null | undefined, password: unknown): Effect.Effect<boolean, CodeError>;
  contentKey(artifact: Artifact | null | undefined): Effect.Effect<string, CodeError>;
  prepare(html: unknown, options?: PreparationOptions): Effect.Effect<object, CodeError>;
  create(input: CreateArtifact): Effect.Effect<Artifact, CodeError>;
  publish(input: PublishArtifact): Effect.Effect<PublishedVersion, CodeError>;
  setPassword(artifactId: string, password: unknown): Effect.Effect<Artifact, CodeError>;
  rename(artifactId: string, slug: unknown): Effect.Effect<Artifact, CodeError>;
  moveTo(artifactId: string, folderId: string): Effect.Effect<Artifact, CodeError>;
  alias(path: unknown, artifactId: string): Effect.Effect<string, CodeError>;
  duplicate(input: DuplicateArtifact): Effect.Effect<Artifact, CodeError>;
  restore(input: RestoreArtifact): Effect.Effect<PublishedVersion, CodeError>;
  remove(artifactId: string, options?: { authorId?: string }): Effect.Effect<Artifact, CodeError>;
  /** Purges withdrawn artefacts past their grace; returns how many. A storage failure ends the run. */
  sweep(): Effect.Effect<number, CodeError>;
  document(artifact: Artifact | null | undefined, version?: unknown): Effect.Effect<string, CodeError>;
  gatePayload(artifact: Artifact | null | undefined): Effect.Effect<GatePayload, CodeError>;
  ciphertext(artifact: Artifact): Effect.Effect<ArtifactCiphertext, CodeError>;
  path(artifact: Pick<Artifact, "slug" | "id">): string;
  url(artifact: Pick<Artifact, "slug" | "id">, origin: unknown): string;
}
interface Capture extends PreparedArtifactHtml { exact?: boolean }
interface Provenance { size: number; sha256: string }
interface WriteVersion {
  keyHex: string; authorType: AuthorType; authorId: string; note: string | null;
  captured?: Capture; provenance?: Provenance | null; changes?: D1Statement[];
}

function toArtifact(row: ArtifactRow): Artifact;
function toArtifact(row: ArtifactRow | null | undefined): Artifact | null;
function toArtifact(row: ArtifactRow | null | undefined): Artifact | null {
  if (!row) return null;
  const verifier = parseJson<Pick<Verifier, "viter" | "vhash">>(row.password_verifier);
  return {
    id: row.id, ownerId: row.owner_id, folderId: row.folder_id ?? null, slug: row.slug ?? null,
    lang: row.lang ?? "en", titleSealed: row.title_sealed, headerUi: Boolean(row.header_ui),
    currentVersion: Number(row.current_version),
    verifier: verifier && row.password_salt ? { vsalt: row.password_salt, viter: verifier.viter, vhash: verifier.vhash } : null,
    wrapPassword: parseJson<PasswordWrap>(row.key_wrap_password), wrapMaster: parseJson<SealRecord>(row.key_wrap_master),
    maxVersions: row.max_versions ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null, purgedAt: row.purged_at ?? null,
  };
}

/** `null`/`""` means "no password" — the artefact is secret-link only (1.x truthiness). */
const gatePassword = (password: unknown): string | null => (password == null || String(password) === "" ? null : String(password));


export function openArtifacts({ db, bucket, masterKeyHex, settings, iterations = PBKDF2_ITER, onChange = null,
  prepareDocument = null, fontFetch = fetch, artifactService = null }: {
  db: DatabaseLike; bucket: R2BucketLike; masterKeyHex: string; settings: Pick<Settings, "retention">;
  iterations?: number; onChange?: ArtifactChange | null; prepareDocument?: ((html: string) => string) | null;
  fontFetch?: FontFetcher; artifactService?: ArtifactService | null;
}): Artifacts {
  if (!settings) throw coded("invalid-settings", "the artefact model requires the platform settings adapter");
  const service = artifactService ?? openArtifactService({ fetcher: fontFetch });
  let changedHook = onChange;
  // Best-effort after commit: missing share wraps fail closed without losing a publish.
  const changed = (artifactId: string) => Effect.gen(function* () {
    if (changedHook) yield* changedHook(artifactId);
  }).pipe(Effect.catchCause(cause =>
    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void));
  const required = Effect.fn(function* (id: unknown) {
    const artifact = yield* self.byId(id);
    if (!artifact) return yield* Effect.fail(coded("not-found", "no such artefact"));
    return artifact;
  });
  const retained = Effect.fn(function* (artifact: Artifact | null | undefined, version: unknown) {
    const current = yield* self.byId(artifact?.id);
    if (!current || !self.live(current)) return yield* Effect.fail(coded("not-found", "no such live artefact"));
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      return yield* Effect.fail(coded("invalid-version", "version must be a positive integer"));
    }
    const row = yield* io(() => db.prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?")
      .bind(current.id, version).first<ArtifactVersionRow>());
    if (!row) return yield* Effect.fail(coded("not-found", "no such retained version"));
    return { artifact: current, row };
  });
  const readObject = Effect.fn(function* (artifact: Artifact | null | undefined, version: unknown) {
    const { artifact: current, row } = yield* retained(artifact, version);
    const object = yield* io(() => bucket.get(row.r2_key));
    if (!object) return yield* Effect.fail(coded("content-missing", `R2 object missing for ${current.id}@${String(version)}`));
    return new Uint8Array(yield* io(() => object.arrayBuffer()));
  });
  const resolvePrepared = Effect.fn(function* (html: unknown, prepared: unknown, gated = false) {
    if (prepared != null) {
      const opened = yield* service.open(prepared, html);
      if (opened && opened.gated === Boolean(gated)) return opened;
    }
    return yield* prepareArtifactHtml(html, { fetcher: fontFetch, gated });
  });
  // Stored sources bypass publication validation and document instrumentation only.
  const storedCapture = (html: string): Capture => {
    if (enc.encode(html).byteLength > FONT_LIMITS.documentBytes) {
      throw coded("font-limit", "Expanded document exceeds its stored byte limit");
    }
    return { html, warnings: [], exact: true };
  };

  /** Maintenance failures must not turn a committed publish into a failed publication. */
  const prune = (artifactId: string, versions: ArtifactVersion[]): Effect.Effect<void> => Effect.gen(function* () {
    const keep = Math.max(1, yield* settings.retention());
    const stale = versions.slice(keep);
    if (!stale.length) return;
    yield* io(() => db.batch(stale.map((v) =>
      db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?").bind(artifactId, v.version))));
    for (const version of stale) yield* io(() => bucket.delete(version.r2Key));
  }).pipe(Effect.catch(() => Effect.void));

  /** The physical half of a withdrawal, for a withdrawn artefact only: every object under art/<id>/
   *  (one delete per list page), then the version and runtime rows, then purged_at. A failure leaves
   *  purged_at NULL for the sweep. Withdrawal is terminal (0010), so one check up front covers it all. */
  const purge = Effect.fn(function* (artifactId: string) {
    const withdrawn = yield* io(() => db.prepare("SELECT 1 AS withdrawn FROM artifacts WHERE id = ? AND deleted_at IS NOT NULL").bind(artifactId).first());
    if (!withdrawn) return yield* Effect.fail(coded("not-withdrawn", "only a withdrawn artefact is purged"));
    let cursor: string | undefined;
    do {
      const page = yield* io(() => bucket.list({ prefix: `art/${artifactId}/`, ...(cursor ? { cursor } : {}) }));
      if (page.objects.length) yield* io(() => bucket.delete(page.objects.map(object => object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    yield* io(() => db.batch([
      db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ?").bind(artifactId),
      db.prepare("DELETE FROM artifact_runtime_state WHERE artifact_id = ?").bind(artifactId),
      db.prepare("UPDATE artifacts SET purged_at = ? WHERE id = ? AND deleted_at IS NOT NULL").bind(nowIso(), artifactId),
    ]));
  });

  /** R2 first, then the atomic rows/trigger that decide the winning publication. */
  const writeVersion = Effect.fn(function* (artifact: Artifact, html: unknown,
    { keyHex, authorType, authorId, note, captured, provenance = null, changes = [] }: WriteVersion) {
    if (typeof html !== "string") return yield* Effect.fail(coded("invalid-content", "artefact content must be a string"));
    const authored = enc.encode(html);
    const ready: Capture = captured ?? (yield* prepareArtifactHtml(html, { fetcher: fontFetch }));
    const prepared = ready.exact === true ? ready.html : prepareDocument ? String(prepareDocument(ready.html)) : ready.html;
    const bytes = enc.encode(prepared);
    if (bytes.byteLength > FONT_LIMITS.documentBytes) return yield* Effect.fail(coded("font-limit", "Expanded document exceeds its stored byte limit"));
    const version = artifact.currentVersion + 1;
    // One object per write attempt; the committed row remains the authoritative key.
    const key = `${artifactObject(artifact.id, version).slice(0, -".enc".length)}-${yield* randomHex(8)}.enc`;
    const sealed = yield* sealBlob(keyHex, bytes);
    const written = yield* io(() => bucket.put(key, sealed, { onlyIf: { etagDoesNotMatch: "*" } }));
    if (written === null) return yield* Effect.fail(coded("publish-conflict", "another publication already owns this version; retry"));
    const at = nowIso(), size = provenance?.size ?? authored.byteLength;
    const digest = provenance?.sha256 ?? hex(yield* sha256(authored));
    yield* io(() => db.batch([
      db.prepare(
        "INSERT INTO artifact_versions (artifact_id, version, r2_key, size, sha256, author_type, author_id, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(artifact.id, version, key, size, digest, authorType, authorId, note ?? null, at),
      ...changes,
      db.prepare("UPDATE artifacts SET current_version = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(version, at, artifact.id),
    ])).pipe(Effect.catch((error) => Effect.gen(function* () {
      // A failed attempt owns only its unique object; never delete the winning version.
      yield* io(() => bucket.delete(key)).pipe(Effect.catch(() => Effect.gen(function* () {
        yield* io(() => db.prepare("UPDATE artifacts SET purged_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").bind(artifact.id).run());
        return yield* Effect.fail(coded("purge-failed", "Publication failed and its content could not be removed; if the artefact is withdrawn, the daily cleanup removes it"));
      })));
      if (error.message.includes("publish-conflict:")) return yield* Effect.fail(coded("publish-conflict", "artefact withdrawn or version changed"));
      return yield* Effect.fail(error);
    })));
    yield* prune(artifact.id, yield* self.versions(artifact.id));
    return { version, size, createdAt: at, warnings: ready.warnings };
  });

  const create = Effect.fn(function* ({ ownerId, folderId = null, title = "", lang = "en", html,
    password: rawPassword = null, slug = null, authorType = "user", authorId, note = null, prepared = null }: CreateArtifact,
    captured: Capture | null = null, provenance: Provenance | null = null) {
    if (!ownerId) return yield* Effect.fail(coded("invalid-owner", "an artefact needs an owner"));
    if (folderId != null) {
      const folder = yield* io(() => db.prepare("SELECT id, owner_id FROM folders WHERE id = ?")
        .bind(folderId).first<{ id: string; owner_id: string }>());
      if (!folder) return yield* Effect.fail(coded("not-found", "no such folder"));
      if (folder.owner_id !== ownerId) return yield* Effect.fail(coded("forbidden", "destination folder belongs to another owner"));
    }
    const clean = slug == null ? null : normalizePath(slug);
    if (slug != null && (!clean || clean.includes("/"))) return yield* Effect.fail(coded("invalid-slug", "slug must be one lowercase path segment"));
    if (clean && (yield* self.pathTaken(clean))) return yield* Effect.fail(coded("slug-taken", "that slug is already in use"));
    const ready = captured ?? (yield* resolvePrepared(html, prepared, gatePassword(rawPassword) != null));
    const id = yield* mintPathId(db), keyHex = yield* randomHex(KEY_BYTES), password = gatePassword(rawPassword);
    const verifier = password === null ? null : yield* makeVerifier(password);
    const at = nowIso(), titleSealed = yield* scalarSeal(masterKeyHex, { t: String(title ?? "") });
    const wrapPassword = password === null ? null : JSON.stringify(yield* wrapUnderPassword(password, { k: keyHex }, iterations));
    const wrapMaster = JSON.stringify(yield* sealAES(masterKeyHex, { k: keyHex }));
    yield* io(() => db.prepare(
      "INSERT INTO artifacts (id, owner_id, folder_id, slug, lang, title_sealed, current_version, password_salt, password_verifier, key_wrap_password, key_wrap_master, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, ownerId, folderId, clean, String(lang ?? "en"), titleSealed, 0, verifier?.vsalt ?? null,
      verifier ? JSON.stringify({ viter: verifier.viter, vhash: verifier.vhash }) : null, wrapPassword, wrapMaster, at, at).run());
    yield* writeVersion(yield* required(id), html, { keyHex, authorType, authorId, note, captured: ready, provenance });
    yield* changed(id);
    return yield* required(id);
  });

  const self: Artifacts = {
    setOnChange: (fn) => { changedHook = fn; },
    toArtifact,
    byId: Effect.fn(function* (id: unknown) {
      return toArtifact(yield* io(() => db.prepare("SELECT * FROM artifacts WHERE id = ?").bind(String(id ?? "")).first<ArtifactRow>()));
    }),
    bySlug: Effect.fn(function* (slug: unknown) {
      return toArtifact(yield* io(() => db.prepare("SELECT * FROM artifacts WHERE slug = ?").bind(String(slug ?? "")).first<ArtifactRow>()));
    }),
    aliasOf: Effect.fn(function* (path: string) {
      const row = yield* io(() => db.prepare("SELECT artifact_id FROM slug_redirects WHERE old_slug = ?").bind(path).first<{ artifact_id: string }>());
      return row ? yield* self.byId(row.artifact_id) : null;
    }),
    aliasesFor: Effect.fn(function* (artifactId: unknown) {
      const { results } = yield* io(() => db.prepare("SELECT old_slug FROM slug_redirects WHERE artifact_id = ? ORDER BY old_slug")
        .bind(String(artifactId ?? "")).all<{ old_slug: string }>());
      return results.map((row) => row.old_slug);
    }),
    byPath: Effect.fn(function* (path: unknown) {
      const clean = normalizePath(path);
      if (!clean) return null;
      if (clean.includes("/")) return yield* self.aliasOf(clean);
      return (yield* self.bySlug(clean)) ?? (yield* self.byId(clean)) ?? (yield* self.aliasOf(clean));
    }),
    pathTaken: (path, options) => pathTaken(db, path, options),
    listByFolder: Effect.fn(function* (folderId: string) {
      const { results } = yield* io(() => db.prepare(
        "SELECT * FROM artifacts WHERE folder_id = ? AND current_version > 0 AND deleted_at IS NULL ORDER BY created_at DESC",
      ).bind(folderId).all<ArtifactRow>());
      return results.map(row => toArtifact(row));
    }),
    listByOwner: Effect.fn(function* (ownerId: string) {
      const { results } = yield* io(() => db.prepare(
        "SELECT * FROM artifacts WHERE owner_id = ? AND current_version > 0 AND deleted_at IS NULL ORDER BY created_at DESC",
      ).bind(ownerId).all<ArtifactRow>());
      return results.map(row => toArtifact(row));
    }),
    // Callers supply folders selected by the live access model, never client-supplied ids.
    // json_each uses one binding for the whole selection, including estates over D1's 100-variable limit.
    listForEstate: Effect.fn(function* (ownerId: string, folderIds: string[]) {
      const { results } = yield* io(() => db.prepare(
        `SELECT * FROM artifacts WHERE current_version > 0 AND deleted_at IS NULL
         AND (folder_id IN (SELECT value FROM json_each(?)) OR (owner_id = ? AND folder_id IS NULL))
         ORDER BY created_at DESC`,
      ).bind(JSON.stringify(folderIds), ownerId).all<ArtifactRow>());
      return results.map(row => toArtifact(row));
    }),
    setMeta: Effect.fn(function* (artifactId: string, { title = null, lang = null }: { title?: unknown; lang?: unknown } = {}) {
      const artifact = yield* required(artifactId);
      if (artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      const sets: string[] = [], params: string[] = [];
      if (title != null) { sets.push("title_sealed = ?"); params.push(yield* scalarSeal(masterKeyHex, { t: String(title) })); }
      if (lang != null) { sets.push("lang = ?"); params.push(String(lang)); }
      if (!sets.length) return artifact;
      sets.push("updated_at = ?"); params.push(nowIso(), artifactId);
      yield* io(() => db.prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run());
      return yield* required(artifactId);
    }),
    versions: Effect.fn(function* (artifactId: string) {
      const { results } = yield* io(() => db.prepare(
        "SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC",
      ).bind(artifactId).all<ArtifactVersionRow>());
      return results.map((r) => ({ artifactId: r.artifact_id, version: Number(r.version), r2Key: r.r2_key,
        size: Number(r.size), sha256: r.sha256, authorType: r.author_type, authorId: r.author_id, note: r.note ?? null, createdAt: r.created_at }));
    }),
    title: Effect.fn(function* (artifact: Artifact | null | undefined) {
      return String((yield* scalarUnseal<{ t: string }>(masterKeyHex, artifact?.titleSealed))?.t ?? "");
    }),
    gated: (artifact) => Boolean(artifact?.wrapPassword),
    live: (artifact) => !artifact?.deletedAt && Number(artifact?.currentVersion ?? 0) > 0,
    verifyPassword: (artifact, password) => artifact?.verifier ? verifyVerifier(password, artifact.verifier) : Effect.succeed(false),
    contentKey: Effect.fn(function* (artifact: Artifact | null | undefined) {
      if (!artifact || artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      const key = (yield* unsealAES<{ k: string }>(masterKeyHex, artifact.wrapMaster))?.k;
      if (typeof key !== "string" || !/^[0-9a-f]{64}$/i.test(key)) {
        return yield* Effect.fail(coded("secrets-auth", "artefact content key could not be unwrapped"));
      }
      return key;
    }),
    prepare: (html, options) => service.prepare(html, options),
    create: (input) => create(input),
    publish: Effect.fn(function* ({ artifactId, html, authorType = "user", authorId, note = null,
      password: rawPassword, title, lang, prepared = null }: PublishArtifact) {
      const artifact = yield* required(artifactId);
      if (artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      const keyHex = yield* self.contentKey(artifact), changes: D1Statement[] = [];
      if (rawPassword !== undefined) {
        const password = gatePassword(rawPassword), verifier = password === null ? null : yield* makeVerifier(password);
        const wrap = password === null ? null : JSON.stringify(yield* wrapUnderPassword(password, { k: keyHex }, iterations));
        changes.push(db.prepare("UPDATE artifacts SET password_salt = ?, password_verifier = ?, key_wrap_password = ? WHERE id = ?")
          .bind(verifier?.vsalt ?? null, verifier ? JSON.stringify({ viter: verifier.viter, vhash: verifier.vhash }) : null, wrap, artifact.id));
      }
      if (title != null) changes.push(db.prepare("UPDATE artifacts SET title_sealed = ? WHERE id = ?")
        .bind(yield* scalarSeal(masterKeyHex, { t: String(title) }), artifact.id));
      if (lang != null) changes.push(db.prepare("UPDATE artifacts SET lang = ? WHERE id = ?").bind(String(lang), artifact.id));
      const gated = rawPassword !== undefined ? gatePassword(rawPassword) != null : self.gated(artifact);
      const captured = yield* resolvePrepared(html, prepared, gated);
      const result = yield* writeVersion(artifact, html, { keyHex, authorType, authorId, note, captured, changes });
      yield* changed(artifact.id);
      return result;
    }),
    setPassword: Effect.fn(function* (artifactId: string, rawPassword: unknown) {
      const artifact = yield* required(artifactId);
      if (artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      const password = gatePassword(rawPassword), verifier = password === null ? null : yield* makeVerifier(password);
      const wrap = password === null ? null : JSON.stringify(yield* wrapUnderPassword(password, { k: yield* self.contentKey(artifact) }, iterations));
      yield* io(() => db.prepare(
        "UPDATE artifacts SET password_salt = ?, password_verifier = ?, key_wrap_password = ?, updated_at = ? WHERE id = ?",
      ).bind(verifier?.vsalt ?? null, verifier ? JSON.stringify({ viter: verifier.viter, vhash: verifier.vhash }) : null,
        wrap, nowIso(), artifactId).run());
      yield* changed(artifactId);
      return yield* required(artifactId);
    }),
    rename: Effect.fn(function* (artifactId: string, slug: unknown) {
      const artifact = yield* required(artifactId);
      if (artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      const clean = normalizePath(slug);
      if (!clean || clean.includes("/")) return yield* Effect.fail(coded("invalid-slug", "slug must be one lowercase path segment"));
      if (clean === artifact.slug) return artifact;
      if (yield* self.pathTaken(clean, { except: artifactId })) return yield* Effect.fail(coded("slug-taken", "that slug is already in use"));
      const at = nowIso();
      yield* io(() => db.batch([
        db.prepare("INSERT OR REPLACE INTO slug_redirects (old_slug, artifact_id, created_at) VALUES (?,?,?)")
          .bind(artifact.slug ?? artifact.id, artifactId, at),
        db.prepare("UPDATE artifacts SET slug = ?, updated_at = ? WHERE id = ?").bind(clean, at, artifactId),
      ]));
      return yield* required(artifactId);
    }),
    moveTo: Effect.fn(function* (artifactId: string, folderId: string) {
      const artifact = yield* required(artifactId);
      if (artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      const folder = yield* io(() => db.prepare("SELECT id, owner_id FROM folders WHERE id = ?")
        .bind(String(folderId ?? "")).first<{ id: string; owner_id: string }>());
      if (!folder) return yield* Effect.fail(coded("not-found", "no such folder"));
      if (folder.owner_id !== artifact.ownerId) return yield* Effect.fail(coded("forbidden", "an artefact moves only within its owner's estate"));
      yield* io(() => db.prepare("UPDATE artifacts SET folder_id = ?, updated_at = ? WHERE id = ?")
        .bind(folder.id, nowIso(), artifact.id).run());
      yield* changed(artifact.id);
      return yield* required(artifact.id);
    }),
    alias: Effect.fn(function* (path: unknown, artifactId: string) {
      const clean = normalizePath(path);
      if (!clean) return yield* Effect.fail(coded("invalid-path", "an alias must be one or two path segments"));
      const artifact = yield* required(artifactId);
      if (artifact.deletedAt) return yield* Effect.fail(coded("not-found", "no such artefact"));
      if (yield* pathTaken(db, clean, { except: artifactId })) return yield* Effect.fail(coded("slug-taken", "that path is already in use"));
      yield* io(() => db.prepare("INSERT OR REPLACE INTO slug_redirects (old_slug, artifact_id, created_at) VALUES (?,?,?)")
        .bind(clean, artifactId, nowIso()).run());
      return clean;
    }),
    duplicate: Effect.fn(function* ({ artifactId, ownerId, folderId = null, title, slug = null, password = null,
      authorType = "user", authorId, note = null }: DuplicateArtifact) {
      const source = yield* required(artifactId);
      const { row } = yield* retained(source, source.currentVersion);
      const html = yield* self.document(source);
      return yield* create({ ownerId, folderId, title: title ?? (yield* self.title(source)), slug, password,
        lang: source.lang, html, authorType, authorId, note }, yield* Effect.try({ try: () => storedCapture(html), catch: asCodeError }), row);
    }),
    restore: Effect.fn(function* ({ artifactId, version, authorType = "user", authorId, note = null }: RestoreArtifact) {
      const { artifact, row } = yield* retained(yield* self.byId(artifactId), version);
      const html = yield* self.document(artifact, version);
      const result = yield* writeVersion(artifact, html, { keyHex: yield* self.contentKey(artifact),
        authorType, authorId, note, captured: yield* Effect.try({ try: () => storedCapture(html), catch: asCodeError }), provenance: row });
      yield* changed(artifact.id);
      return result;
    }),
    remove: Effect.fn(function* (artifactId: string, { authorId }: { authorId?: string } = {}) {
      const artifact = yield* required(artifactId), at = nowIso();
      yield* io(() => db.batch([
        db.prepare("UPDATE artifacts SET deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, ?), purged_at = NULL, current_version = 0, password_salt = NULL, password_verifier = NULL, key_wrap_password = NULL, key_wrap_master = NULL, updated_at = ? WHERE id = ?")
          .bind(at, authorId ?? null, at, artifact.id),
        db.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE artifact_id = ?").bind(at, artifact.id),
        db.prepare("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?) WHERE kind = 'artifact' AND target_id = ?").bind(at, artifact.id),
        db.prepare("DELETE FROM share_keys WHERE artifact_id = ?").bind(artifact.id),
        db.prepare("DELETE FROM artifact_runtime_state WHERE artifact_id = ?").bind(artifact.id),
      ]));
      yield* purge(artifact.id).pipe(Effect.catch(() =>
        Effect.fail(coded("purge-failed", "Artefact withdrawn; removing its content failed, and the daily cleanup will finish it"))));
      return yield* required(artifact.id);
    }),
    sweep: Effect.fn(function* () {
      const cutoff = new Date(Date.now() - PURGE_LIMITS.graceMs).toISOString();
      let purged = 0;
      const failed: string[] = [];
      for (let round = 0; round < PURGE_LIMITS.batches; round++) {
        // ponytail: full scan of artifacts; add a partial index on deleted_at WHERE purged_at IS NULL past ~10^5 rows.
        const { results } = yield* io(() => db.prepare("SELECT id FROM artifacts WHERE deleted_at IS NOT NULL AND purged_at IS NULL" +
          ` AND deleted_at <= ? AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY deleted_at, id LIMIT ${PURGE_LIMITS.batch}`)
          .bind(cutoff, JSON.stringify(failed)).all<{ id: string }>());
        for (const { id } of results) {
          if (yield* purge(id).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))) { purged++; continue; }
          // One stuck artefact must not hold back the rest: log its id (nothing else) and go on; the next run retries it.
          console.error("artefacts67 purge failed", id);
          failed.push(id);
        }
        if (results.length < PURGE_LIMITS.batch) break;
      }
      return purged;
    }),
    document: Effect.fn(function* (artifact: Artifact | null | undefined, version: unknown = artifact?.currentVersion) {
      const current = (yield* retained(artifact, version)).artifact;
      return utf8(yield* openBlob(yield* self.contentKey(current), yield* readObject(current, version)));
    }),
    gatePayload: Effect.fn(function* (artifact: Artifact | null | undefined) {
      const current = (yield* retained(artifact, artifact?.currentVersion)).artifact;
      if (!current.wrapPassword) return yield* Effect.fail(coded("not-gated", "this artefact has no password"));
      return { wrap: current.wrapPassword, content: splitBlob(yield* readObject(current, current.currentVersion)) };
    }),
    ciphertext: Effect.fn(function* (artifact: Artifact) {
      return splitBlob(yield* readObject(artifact, artifact.currentVersion));
    }),
    path: (artifact) => `/${artifact.slug ?? artifact.id}/`,
    url: (artifact, origin) => `${String(origin ?? "").replace(/\/+$/, "")}${self.path(artifact)}`,
  };
  return self;
}