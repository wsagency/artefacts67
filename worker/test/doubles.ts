import { RateLimit, openRateLimiter, type CounterState, type RateLimiter } from "../src/ratelimit.js";
import type { DurableObjectNamespaceLike, R2BucketLike, R2PutOptions } from "../src/types.js";
import { openStore, type Store } from "../src/store.js";
import { openAuth, type Auth } from "../src/auth.js";
import { openWebAuthn, type WebAuthn } from "../src/webauthn.js";
import { openMailer, type Mailer } from "../src/mail.js";
import { openArtifacts, type Artifacts, type GatePayload } from "../src/artifacts.js";
import { openFolders, type Folders } from "../src/folders.js";
import { openAccess, type Access } from "../src/access.js";
import { openKeys, type Keys } from "../src/keys.js";
import { openShares, type Shares } from "../src/shares.js";
import { openAnalytics, type Analytics } from "../src/analytics.js";
import { openArtifactRuntime, type ArtifactRuntime } from "../src/artifact-runtime.js";
import { openRuntimeState, type RuntimeState } from "../src/runtime-state.js";
import { openReports, type Reports } from "../src/reports.js";
import { openProjectData, type ProjectData } from "../src/project-data.js";
import { openProjectFiles, type ProjectFiles } from "../src/project-files.js";
import { ANALYTICS_CLIENT, instrumentDocument } from "../src/analytics-client.js";
import { contract } from "../src/contract.js";
import { html } from "../src/http.js";
import { homeView } from "../src/views.js";
import { openD1Shim, type TestDatabase } from "./db.js";

// Authored content remains intact; platform-owned observation code is not authored content.
export const authoredDocument = (source: string) => source.replace(/<script data-wsa-analytics>[\s\S]*?<\/script>/g, "");
export interface MemoryBucket extends R2BucketLike {
  objects: Map<string, Uint8Array<ArrayBuffer>>;
  uploads: Map<string, { key: string; parts: Map<number, { bytes: Uint8Array<ArrayBuffer>; etag: string }> }>;
}

const R2_MIN_PART = 5 * 1024 * 1024;
const bytesOf = (value: ArrayBuffer | ArrayBufferView | string): Uint8Array<ArrayBuffer> => typeof value === "string" ? new TextEncoder().encode(value)
  : ArrayBuffer.isView(value) ? Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  : Uint8Array.from(new Uint8Array(value));

/** Snapshot bytes exactly as an R2 object, including conditional publication writes, ranged reads
 *  and the binding's multipart rules (non-final parts ≥ 5 MiB and uniform). */
export function memoryBucket(): MemoryBucket {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const uploads: MemoryBucket["uploads"] = new Map();
  let counter = 0;
  const store = (key: string, bytes: Uint8Array<ArrayBuffer>) => {
    objects.set(key, bytes);
    return { key, size: bytes.byteLength };
  };
  const open = (uploadId: string) => {
    const upload = uploads.get(uploadId);
    if (!upload) throw new Error("multipart upload not found");
    return upload;
  };
  return {
    objects, uploads,
    async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, options: R2PutOptions = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      return store(key, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : bytesOf(value));
    },
    async get(key, options) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options?.range;
      const view = range ? bytes.slice(range.offset, range.offset + range.length) : bytes.slice();
      return { arrayBuffer: async () => view.buffer };
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength } : null;
    },
    async delete(key) { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item); },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix) && (cursor === undefined || key > cursor)).sort();
      const page = keys.slice(0, limit);
      const truncated = page.length < keys.length;
      return { objects: page.map(key => ({ key })), truncated, ...(truncated ? { cursor: page.at(-1) } : {}) };
    },
    async createMultipartUpload(key) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(_key, uploadId) {
      return {
        async uploadPart(partNumber, value) {
          const etag = String(++counter);
          open(uploadId).parts.set(partNumber, { bytes: bytesOf(value), etag });
          return { partNumber, etag };
        },
        async complete(parts) {
          const upload = open(uploadId);
          const listed = parts.map(({ partNumber, etag }) => {
            const part = upload.parts.get(partNumber);
            if (!part || part.etag !== etag) throw new Error("part etag mismatch");
            return part.bytes;
          });
          const head = listed.slice(0, -1);
          if (head.some(bytes => bytes.byteLength < R2_MIN_PART || bytes.byteLength !== head[0].byteLength)) throw new Error("non-final parts must be ≥ 5 MiB and uniform");
          const out = new Uint8Array(listed.reduce((sum, bytes) => sum + bytes.byteLength, 0));
          let offset = 0;
          for (const bytes of listed) { out.set(bytes, offset); offset += bytes.byteLength; }
          uploads.delete(uploadId);
          return store(upload.key, out);
        },
        async abort() { open(uploadId); uploads.delete(uploadId); },
      };
    },
  };
}

/** Window keys contain counters; the same DO storage also holds sweep cursor metadata. */
export interface RateValues extends Map<string, unknown> {
  get(key: `w:${string}`): CounterState | undefined;
  get(key: string): unknown;
}
export interface RateBinding extends DurableObjectNamespaceLike {
  values: RateValues;
  readonly alarmAt: number | null;
  fireAlarm(): Promise<void>;
}
export function rateLimitBinding(): RateBinding {
  const values = new Map<string, unknown>() as RateValues;
  let alarmAt: number | null = null;
  const object = new RateLimit({ storage: {
    get: async <A = unknown>(key: string): Promise<A | undefined> => values.get(key) as A | undefined,
    put: async (key, value) => { values.set(key, value); },
    delete: async key => {
      if (!Array.isArray(key)) return values.delete(key);
      let deleted = 0;
      for (const item of key) deleted += Number(values.delete(item));
      return deleted;
    },
    list: async ({ prefix, startAfter, limit }) => new Map([...values.keys()].sort()
      .filter(key => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
      .slice(0, limit).map(key => [key, values.get(key) as CounterState])),
    getAlarm: async () => alarmAt,
    setAlarm: async at => { alarmAt = at; },
    deleteAlarm: async () => { alarmAt = null; },
  } });
  const stub = { fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input, init)) };
  return {
    values, idFromName: (_name: string) => "test-global", get: (_id: unknown) => stub,
    get alarmAt() { return alarmAt; },
    async fireAlarm() { alarmAt = null; await object.alarm(); },
  };
}

export const TEST_MASTER = "00".repeat(32);
export interface TestConsoleContext {
  db: TestDatabase; bucket: MemoryBucket; binding: RateBinding;
  store: Store; auth: Auth; webauthn: WebAuthn; mailer: Mailer; limiter: RateLimiter;
  artifacts: Artifacts; folders: Folders; access: Access; keys: Keys; shares: Shares;
  analytics: Analytics; artifactRuntime: ArtifactRuntime; runtimeState: RuntimeState; reports: Reports; projectData: ProjectData; projectFiles: ProjectFiles;
  analyticsClient: { ANALYTICS_CLIENT: string; instrumentDocument: typeof instrumentDocument };
  publicOrigin: string; requestOrigin: string; secureCookies: boolean; rpId: string; rpName: string;
  gate: { threshold: number; lockMs: number }; contract(): Response; neutral(): Response;
}
/** One real platform fixture; suites override only the behavior their consumer exercises. */
export function openConsoleContext(db: TestDatabase = openD1Shim(), masterKeyHex = TEST_MASTER): TestConsoleContext {
  const store = openStore(db), bucket = memoryBucket(), binding = rateLimitBinding();
  const limiter = openRateLimiter({ RATELIMIT: binding });
  const publicOrigin = "https://example.test", rpId = "example.test", rpName = "Artefacts67";
  const mailer = openMailer();
  const access = openAccess({ db, audit: store.audit });
  let shares: Shares;
  const artifacts = openArtifacts({ db, bucket, masterKeyHex, settings: store.settings,
    onChange: id => shares.syncArtifact(id), prepareDocument: instrumentDocument });
  const folders = openFolders({ db, masterKeyHex, onChange: id => shares.syncFolder(id) });
  shares = openShares({ db, masterKeyHex, artifacts, folders, access, audit: store.audit, publicOrigin, mailer, settings: store.settings });
  return {
    db, bucket, binding, store, mailer, limiter, artifacts, folders, access, shares,
    auth: openAuth({ store, mailer, masterKeyHex, origin: publicOrigin, rateLimiter: limiter, rpId, rpName }),
    webauthn: openWebAuthn(store), keys: openKeys({ db, audit: store.audit, access }),
    analytics: openAnalytics({ db, shares, access, masterKeyHex, limiter }),
    artifactRuntime: openArtifactRuntime({ db, masterKeyHex }), runtimeState: openRuntimeState({ db, masterKeyHex }),
    projectData: openProjectData({ db, masterKeyHex }), projectFiles: openProjectFiles({ db, bucket, masterKeyHex }),
    reports: openReports({ db, masterKeyHex }), analyticsClient: { ANALYTICS_CLIENT, instrumentDocument },
    publicOrigin, requestOrigin: publicOrigin, secureCookies: true, rpId, rpName,
    gate: { threshold: 4, lockMs: 3_600_000 }, contract, neutral: () => html(homeView()),
  };
}

const b64 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(value, "base64"));
const join = (left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(left.length + right.length); out.set(left); out.set(right, left.length); return out;
};
/** Independently decrypt the actual gate envelope using browser-compatible WebCrypto. */
export async function openAsVisitor({ wrap, content }: GatePayload, password: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: b64(wrap.ksalt), iterations: wrap.iter, hash: "SHA-256" }, material, 256);
  const kek = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(wrap.iv) }, kek, join(b64(wrap.ct), b64(wrap.tag)));
  const keyBox = JSON.parse(new TextDecoder().decode(opened)) as { k: string };
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(Buffer.from(keyBox.k, "hex")), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(content.iv) }, key, b64(content.ct));
  return new TextDecoder().decode(plaintext);
}
