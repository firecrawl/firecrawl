/*
 * Module slots: the named interfaces a service calls directly.
 *
 * This file imports only types so creating or describing a service never loads
 * implementations, configuration, or clients.
 */
import type { RequestContext } from "./request-context";

/** Options for a blocklist check beyond the request context. */
export interface BlocklistCheckOptions {
  /** Caller origin recorded on blocklist hits when hit recording is enabled. */
  origin?: string | null;
  /** Set to false for a re-check whose hit should not be recorded again. */
  record?: boolean;
}

/**
 * URL blocklist module: preloaded at process startup and queried synchronously
 * on request and worker paths.
 */
export interface BlocklistModule {
  /** Loads any backing blocklist data at startup; a throw stops the process. */
  init(): Promise<void>;
  /** Returns whether `url` is blocked under `ctx`. */
  isBlocked(
    url: string,
    ctx: RequestContext,
    options?: BlocklistCheckOptions,
  ): boolean;
  /**
   * Returns whether `ctx` has caller-scoped blocklist rules beyond global
   * entries, so shared caches can bypass reuse safely.
   */
  hasScopedRules(ctx: RequestContext): boolean;
}

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
  blocklist: BlocklistModule;
  messages: MessagesModule;
  uploads: UploadsModule;
  idempotency: IdempotencyModule;
  webhooks: WebhooksModule;
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
  const { blocklist, messages, uploads, idempotency, webhooks } = modules;
  if (
    typeof blocklist !== "object" ||
    blocklist === null ||
    typeof blocklist.init !== "function" ||
    typeof blocklist.isBlocked !== "function" ||
    typeof blocklist.hasScopedRules !== "function"
  ) {
    throw new Error("Invalid blocklist module");
  }
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

  const frozenBlocklist: BlocklistModule = Object.freeze({
    init: blocklist.init.bind(blocklist),
    isBlocked: blocklist.isBlocked.bind(blocklist),
    hasScopedRules: blocklist.hasScopedRules.bind(blocklist),
  });
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
    blocklist: frozenBlocklist,
    messages: frozenMessages,
    uploads: frozenUploads,
    idempotency: frozenIdempotency,
    webhooks: frozenWebhooks,
  });
}
