/** Shared structural types used by Cloudflare and Node test adapters. */
export type Awaitable<A> = A | PromiseLike<A>;
export type Row = Record<string, unknown>;

export interface D1Result {
  changes?: number;
  success?: boolean;
  meta?: { changes?: number; [key: string]: unknown };
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<A = Row>(): Awaitable<A | null>;
  all<A = Row>(): Awaitable<{ results: A[] }>;
  run(): Awaitable<D1Result>;
}

export interface DatabaseLike {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Awaitable<D1Result[]>;
}

export interface R2ObjectLike {
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
  httpEtag?: string;
}

export interface R2PutOptions { onlyIf?: { etagDoesNotMatch?: string } }
export interface R2MultipartLike {
  uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView | string): Promise<{ partNumber: number; etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
  abort(): Promise<void>;
}
export interface R2BucketLike {
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated?: boolean; cursor?: string }>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectLike | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, options?: R2PutOptions): Promise<unknown>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string | string[]): Promise<unknown>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartLike;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface WorkerEnv {
  DB: DatabaseLike;
  ARTIFACTS: R2BucketLike;
  RATELIMIT: DurableObjectNamespaceLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ARTEFACTS_MASTER_KEY?: string;
  PUBLIC_ORIGIN?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_RP_ID?: string;
  OPERATOR_NAME?: string;
  DESIGN_TEMPLATE_URL?: string;
  LEGACY_HOSTS?: string;
  WEB_ANALYTICS_TOKEN?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string | number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  GATE_THRESHOLD?: string | number;
  GATE_LOCK_SECONDS?: string | number;
  [name: string]: unknown;
}

export interface CodeError extends Error {
  code?: string;
  issues?: Array<Record<string, unknown>>;
  status?: number;
  retryAfter?: number;
}

export const asCodeError = (value: unknown): CodeError => {
  if (value instanceof Error) return value as CodeError;
  return Object.assign(new Error(String(value)), { code: undefined });
};
