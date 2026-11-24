/*
 * Module slots: the named interfaces a service calls directly.
 *
 * This file imports only types so creating or describing a service never loads
 * implementations, configuration, or clients.
 */
import type { Document, ScrapeOptions } from "../controllers/v2/types";
import type { JobKind } from "./hooks";
import type { RequestContext } from "./request-context";

export type FetchProxyFileKind = "PDF" | "document";

/**
 * Deployment-specific user-facing messages returned on errors and refusals.
 */
export interface MessagesModule {
  /** Message returned for an internal error, optionally including its identifier. */
  errorContact(errorId?: string): string;
  /** Guidance appended to the restricted-country refusal message. */
  restrictedCountryContact(): string;
  /** Guidance appended when every scraping engine fails to retrieve a URL. */
  allEnginesFailedContact(): string;
  /** Message for a failed proxy connection while downloading a PDF or document file. */
  fileFetchProxyError(kind: FetchProxyFileKind): string;
  /** Guidance appended when prefetching a PDF or document file is blocked. */
  filePrefetchFailedContact(): string;
}

/** Upload instructions returned to a client for a staged parse upload. */
export interface UploadTarget {
  uploadUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  fields?: Record<string, string>;
}

/** Input passed when preparing an upload target for a signed upload reference. */
export interface PrepareUploadInput {
  uploadId: string;
  teamId: string;
  objectPath: string;
  filename: string;
  contentType?: string;
  expiresAt: number;
  maxBytes: number;
  uploadRef: string;
  publicBaseUrl: string;
}

/**
 * Outcome of preparing an upload target. When `commit` is returned, it runs
 * after upload quota has been reserved; throwing from `commit` rolls back that
 * reservation.
 */
export type PrepareUploadResult =
  | {
      ok: true;
      target: UploadTarget;
      commit?(): Promise<void> | void;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
    };

/** Input passed when accepting a direct upload body on the API server. */
export interface DirectUploadInput {
  uploadId: string;
  teamId: string;
  body: Buffer;
}

/** Outcome of accepting a direct upload body on the API server. */
export type DirectUploadResult =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

/** Reference metadata identifying a staged parse upload object. */
export interface StoredUploadRef {
  uploadId: string;
  teamId: string;
  objectPath: string;
  maxBytes: number;
}

/** Storage driver for staged parse uploads. */
export interface UploadDriver {
  /** Stable identifier embedded in signed upload references (for example "local"). */
  readonly name: string;
  /** Prepares a client upload target before upload quota is reserved. */
  prepareUpload(input: PrepareUploadInput): Promise<PrepareUploadResult>;
  /**
   * Optional direct-upload handler used by `PUT /v2/parse/upload/:uploadId`.
   * When omitted, direct uploads to the API server are disabled.
   */
  receiveUpload?(input: DirectUploadInput): Promise<DirectUploadResult>;
  /** Reads the uploaded bytes and verifies they fit within `ref.maxBytes`. */
  read(ref: StoredUploadRef): Promise<Buffer>;
  /** Removes a stored upload object; missing objects should be ignored. */
  delete(ref: StoredUploadRef): Promise<void>;
}

/** Provides the storage driver for staged parse uploads. */
export interface UploadsModule {
  driver(): UploadDriver;
}

/** Metadata identifying a job registered or recorded in the job store. */
export interface JobRecord {
  id: string;
  kind: JobKind;
  ctx: RequestContext;
  /** Parent request id for multi-job requests (crawl or batch scrape children). */
  requestId?: string;
  /** Expiry timestamp in epoch milliseconds when the caller sets a custom TTL. */
  expiresAtMs?: number;
  /** Caller surface or origin recorded alongside the job access entry. */
  clientOrigin?: string | null;
  /**
   * Expected child job count for multi-job requests so metered stores can
   * initialize usage tracking. Zero indicates an open-ended request whose
   * total count is not known up front.
   */
  estimatedJobs?: number;
  /** False when the job must not receive a fetchable access record. */
  jobAccess?: boolean;
  /** Scraped URL, passed when recording terminal scrape state or result payloads. */
  url?: string;
  /** Scrape options, passed when recording terminal scrape state or result payloads. */
  options?: ScrapeOptions;
  /** Credits billed for this job, passed when recording terminal state and child usage. */
  creditsBilled?: number;
  /** Elapsed scrape time in seconds, passed when recording result metadata. */
  timeTakenSeconds?: number;
  /** True when the scrape ran inline without being enqueued in the job queue. */
  skipNuq?: boolean;
  /** True for parse jobs, which do not persist scrape state or result payloads. */
  isParse?: boolean;
}

/** Terminal outcome written to the job store when a job finishes. */
export type JobOutcome =
  | { state: "completed"; document: Document }
  | { state: "failed"; error: string };

/** Ownership and optional expiry metadata returned by `jobStore.owner`. */
export interface JobOwner {
  teamId: string;
  /** Expiry timestamp in epoch milliseconds when the store bounds fetchability. */
  expiresAtMs?: number;
  /**
   * Optional ownership predicate for stores that persist a normalized team id.
   * When omitted, callers compare `owner.teamId === teamId`.
   */
  matchesTeam?(teamId: string): boolean;
}

/** Terminal state and optional document read from the job store. */
export interface StoredJob {
  state: "completed" | "failed";
  document?: Document;
  error?: string;
  /** Epoch milliseconds when the job finished, if recorded by the store. */
  completedAtMs?: number;
}

/** Options for `jobStore.usage`. */
export interface JobUsageOptions {
  /**
   * When reading from an eventually consistent fallback store, resolve a
   * missing record to 0 instead of null. Defaults to false.
   */
  emptyAsZero?: boolean;
  /**
   * When reading at request finalization, retry transient empty reads before
   * returning null. Defaults to false.
   */
  finalize?: boolean;
}

/**
 * Job ownership, terminal state, result, and request-usage persistence.
 */
export interface JobStoreModule {
  /**
   * Returns true when finished job results are persisted outside the queue,
   * so workers omit inline queue return values and shed completed input data.
   */
  storesResultsExternally?(): boolean;
  /** Registers a job's ownership and initializes request usage tracking. */
  register(job: JobRecord): Promise<void>;
  /** Returns the owner and optional expiry of a job, or null when not found. */
  owner(id: string, kind: JobKind): Promise<JobOwner | null>;
  /** Reads stored terminal state and optional result document for a job. */
  read(id: string, kind: JobKind): Promise<StoredJob | null>;
  /**
   * Optional batch read for several job ids. Callers fall back to parallel
   * `read` calls when omitted.
   */
  readMany?(
    ids: readonly string[],
    kind: JobKind,
  ): Promise<Map<string, StoredJob>>;
  /**
   * Records a job's terminal state, result, and child usage. Awaited by the
   * worker so synchronous scrapes wait for readable terminal state.
   */
  record(job: JobRecord, outcome: JobOutcome): Promise<void>;
  /** Returns the metered usage total for a request, or null when unmetered. */
  usage(requestId: string, options?: JobUsageOptions): Promise<number | null>;
  /** Removes stored job artifacts; missing entries should be ignored. */
  remove(id: string, kind: JobKind): Promise<void>;
}

/** Request context passed to the idempotency module. */
export interface IdempotencyContext {
  teamId: string;
}

/** Tracks idempotency keys to reject duplicate requests. */
export interface IdempotencyModule {
  /**
   * Claims an idempotency key for a request. Returns true when this is the
   * first use of the key and false when it has already been used.
   */
  claim(key: string, ctx: IdempotencyContext): Promise<boolean>;
}

/** Request context passed to the webhooks module. */
export interface WebhookContext {
  teamId: string;
  zeroDataRetention: boolean;
}

/** Webhook payload and dispatch metadata passed to `WebhooksModule.deliver`. */
export interface WebhookDelivery {
  url: string;
  event: string;
  payload: unknown;
  /** Caller-configured headers (excluding signature headers). */
  headers: Record<string, string>;
  jobId: string;
  scrapeId?: string;
  timeoutMs: number;
}

/** HTTP response summary returned by the in-process webhook send callback. */
export interface WebhookResponse {
  ok: boolean;
  status: number;
}

/** Outcome returned by `WebhooksModule.deliver`. */
export interface WebhookDeliveryResult {
  delivered: boolean;
  queued?: boolean;
  skipped?: boolean;
  statusCode?: number;
}

/** Resolves webhook signing secrets and dispatches webhook deliveries. */
export interface WebhooksModule {
  /** Returns the HMAC signing secret for this request context, if configured. */
  signingSecret(ctx: WebhookContext): Promise<string | undefined>;
  /**
   * Dispatches a webhook delivery. Calling `send()` performs the signed
   * in-process HTTP POST with timeout and SSRF protection.
   */
  deliver(
    ctx: WebhookContext,
    delivery: WebhookDelivery,
    send: () => Promise<WebhookResponse>,
  ): Promise<WebhookDeliveryResult>;
  /** Optional graceful shutdown hook called when the server exits. */
  shutdown?(): Promise<void>;
}

/**
 * The module slots: one implementation for each piece of behaviour the service
 * calls by name.
 */
export interface Modules {
  messages: MessagesModule;
  uploads: UploadsModule;
  jobStore: JobStoreModule;
  idempotency: IdempotencyModule;
  webhooks: WebhooksModule;
}

function freezeJobStore(jobStore: JobStoreModule): Readonly<JobStoreModule> {
  if (
    typeof jobStore !== "object" ||
    jobStore === null ||
    typeof jobStore.register !== "function" ||
    typeof jobStore.owner !== "function" ||
    typeof jobStore.read !== "function" ||
    typeof jobStore.record !== "function" ||
    typeof jobStore.usage !== "function" ||
    typeof jobStore.remove !== "function" ||
    (jobStore.storesResultsExternally !== undefined &&
      typeof jobStore.storesResultsExternally !== "function") ||
    (jobStore.readMany !== undefined && typeof jobStore.readMany !== "function")
  ) {
    throw new Error("Invalid jobStore module");
  }

  const frozen: JobStoreModule = {
    ...(jobStore.storesResultsExternally !== undefined
      ? {
          storesResultsExternally:
            jobStore.storesResultsExternally.bind(jobStore),
        }
      : {}),
    register: jobStore.register.bind(jobStore),
    owner: jobStore.owner.bind(jobStore),
    read: jobStore.read.bind(jobStore),
    ...(jobStore.readMany !== undefined
      ? { readMany: jobStore.readMany.bind(jobStore) }
      : {}),
    record: jobStore.record.bind(jobStore),
    usage: jobStore.usage.bind(jobStore),
    remove: jobStore.remove.bind(jobStore),
  };
  return Object.freeze(frozen);
}

function freezeUploadDriver(driver: UploadDriver): Readonly<UploadDriver> {
  if (
    typeof driver !== "object" ||
    driver === null ||
    typeof driver.name !== "string" ||
    driver.name.trim().length === 0 ||
    typeof driver.prepareUpload !== "function" ||
    typeof driver.read !== "function" ||
    typeof driver.delete !== "function" ||
    (driver.receiveUpload !== undefined &&
      typeof driver.receiveUpload !== "function")
  ) {
    throw new Error("Invalid uploads driver");
  }

  const frozen: UploadDriver = {
    name: driver.name,
    prepareUpload: driver.prepareUpload.bind(driver),
    read: driver.read.bind(driver),
    delete: driver.delete.bind(driver),
    ...(driver.receiveUpload !== undefined
      ? { receiveUpload: driver.receiveUpload.bind(driver) }
      : {}),
  };
  return Object.freeze(frozen);
}

/**
 * Validates and freezes a resolved module slot table along with each slot's
 * bound methods and resolved upload driver, so mutating the input objects
 * later cannot alter the service.
 */
export function freezeModules(modules: Modules): Readonly<Modules> {
  const { messages, uploads, jobStore, idempotency, webhooks } = modules;
  if (
    typeof messages !== "object" ||
    messages === null ||
    typeof messages.errorContact !== "function" ||
    typeof messages.restrictedCountryContact !== "function" ||
    typeof messages.allEnginesFailedContact !== "function" ||
    typeof messages.fileFetchProxyError !== "function" ||
    typeof messages.filePrefetchFailedContact !== "function"
  ) {
    throw new Error("Invalid messages module");
  }
  if (
    typeof uploads !== "object" ||
    uploads === null ||
    typeof uploads.driver !== "function"
  ) {
    throw new Error("Invalid uploads module");
  }
  if (
    typeof idempotency !== "object" ||
    idempotency === null ||
    typeof idempotency.claim !== "function"
  ) {
    throw new Error("Invalid idempotency module");
  }
  if (
    typeof webhooks !== "object" ||
    webhooks === null ||
    typeof webhooks.signingSecret !== "function" ||
    typeof webhooks.deliver !== "function" ||
    (webhooks.shutdown !== undefined && typeof webhooks.shutdown !== "function")
  ) {
    throw new Error("Invalid webhooks module");
  }

  const frozenMessages: MessagesModule = Object.freeze({
    errorContact: messages.errorContact.bind(messages),
    restrictedCountryContact: messages.restrictedCountryContact.bind(messages),
    allEnginesFailedContact: messages.allEnginesFailedContact.bind(messages),
    fileFetchProxyError: messages.fileFetchProxyError.bind(messages),
    filePrefetchFailedContact:
      messages.filePrefetchFailedContact.bind(messages),
  });
  const frozenDriver = freezeUploadDriver(uploads.driver());
  const frozenUploads: UploadsModule = Object.freeze({
    driver: () => frozenDriver,
  });
  const frozenJobStore = freezeJobStore(jobStore);
  const frozenIdempotency: IdempotencyModule = Object.freeze({
    claim: idempotency.claim.bind(idempotency),
  });
  const frozenWebhooks: WebhooksModule = Object.freeze({
    signingSecret: webhooks.signingSecret.bind(webhooks),
    deliver: webhooks.deliver.bind(webhooks),
    ...(webhooks.shutdown !== undefined
      ? { shutdown: webhooks.shutdown.bind(webhooks) }
      : {}),
  });

  return Object.freeze({
    messages: frozenMessages,
    uploads: frozenUploads,
    jobStore: frozenJobStore,
    idempotency: frozenIdempotency,
    webhooks: frozenWebhooks,
  });
}
