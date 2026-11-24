/*
 * Module slots: the named interfaces a service calls directly.
 *
 * This file imports only types so creating or describing a service never loads
 * implementations, configuration, or clients.
 */
import type { RequestContext } from "./request-context";

export type QueueBackendOverride = "postgres" | "fdb";

/** Secondary per-key concurrency gate for queue backends that enforce it. */
export interface ConcurrencyKeyGate {
  id: string;
  limit: number;
}

/** Input passed when computing queue scheduling priority for a job. */
export interface JobPriorityInput {
  ctx: RequestContext;
  base: number;
}

/**
 * Concurrency limits, job scheduling priority, and queue backend selection.
 */
export interface LimitsModule {
  /** Maximum concurrent jobs for a request. `null` means unlimited. */
  concurrency(ctx: RequestContext): Promise<number | null>;
  /** Maximum concurrent jobs for a team when only a team id is available. `null` means unlimited. */
  teamConcurrency(teamId: string): Promise<number | null>;
  /** Optional per-key concurrency gate for queue backends that enforce a secondary key cap. */
  keyConcurrency?(ctx: RequestContext): Promise<ConcurrencyKeyGate | null>;
  /** Queue priority for a new job. */
  jobPriority(input: JobPriorityInput): Promise<number>;
  /** Queue backend override for this request, or `undefined` to use the configured default. */
  queueBackend(
    ctx: RequestContext,
  ):
    | QueueBackendOverride
    | undefined
    | Promise<QueueBackendOverride | undefined>;
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

/**
 * The module slots: one implementation for each piece of behaviour the service
 * calls by name.
 */
export interface Modules {
  limits: LimitsModule;
  messages: MessagesModule;
  uploads: UploadsModule;
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
  const { limits, messages, uploads } = modules;
  if (
    typeof limits !== "object" ||
    limits === null ||
    typeof limits.concurrency !== "function" ||
    typeof limits.teamConcurrency !== "function" ||
    (limits.keyConcurrency !== undefined &&
      typeof limits.keyConcurrency !== "function") ||
    typeof limits.jobPriority !== "function" ||
    typeof limits.queueBackend !== "function"
  ) {
    throw new Error("Invalid limits module");
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

  const frozenLimits: LimitsModule = Object.freeze({
    concurrency: limits.concurrency.bind(limits),
    teamConcurrency: limits.teamConcurrency.bind(limits),
    ...(limits.keyConcurrency !== undefined
      ? { keyConcurrency: limits.keyConcurrency.bind(limits) }
      : {}),
    jobPriority: limits.jobPriority.bind(limits),
    queueBackend: limits.queueBackend.bind(limits),
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

  return Object.freeze({
    limits: frozenLimits,
    messages: frozenMessages,
    uploads: frozenUploads,
  });
}
