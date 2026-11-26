/*
 * Module slots: the named interfaces a service calls directly.
 *
 * This file imports only types so creating or describing a service never loads
 * implementations, configuration, or clients.
 */
import type { Request } from "express";
import type { Document, ScrapeOptions } from "../controllers/v2/types";
import type { CostTracking } from "../lib/cost-tracking";
import type { RateLimiterMode } from "../types";
import type { JobKind, Refusal, ScrapeState } from "./hooks";
import type { RequestBodies, RequestKind } from "./request";
import type {
  BaseCaller,
  BaseRequestContext,
  Caller,
  RequestContext,
} from "./request-context";

/** Route kinds declared by the core API. */
export type CoreRouteKind = `${RateLimiterMode}`;

/**
 * The kind of route a request arrived on. Extensions may pass any string for
 * their own routes.
 */
export type RouteKind = CoreRouteKind | (string & {});

/**
 * Route metadata passed to `AuthModule.authenticate`. Extensions may add
 * optional route options by declaration merging.
 */
export interface AuthRoute {
  kind: RouteKind;
}

/** Outcome of authenticating a request. */
export type AuthResult<C extends BaseCaller = Caller> =
  | { ok: true; caller: C; headers?: Record<string, string> }
  | { ok: false; refusal: Refusal };

/**
 * Identifies the sender of a request. The type parameter keeps `openAuth()`
 * typed on `BaseCaller`, so widening `Caller` rejects the open default at
 * compile time.
 */
export interface AuthModule<C extends BaseCaller = Caller> {
  authenticate(req: Request, route: AuthRoute): Promise<AuthResult<C>>;
  /** Optional team lookup for background jobs that need fresh flags or limits by team id. */
  lookupTeam?(teamId: string): Promise<Partial<RequestContext> | null>;
}

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
  /** Optional hook invoked when a worker starts executing a job for priority accounting. */
  onJobStart?(teamId: string, jobId: string): Promise<void>;
  /** Optional hook invoked when a worker finishes executing a job for priority accounting. */
  onJobEnd?(teamId: string, jobId: string): Promise<void>;
  /** Queue backend override for this request, or `undefined` to use the configured default. */
  queueBackend(
    ctx: RequestContext,
  ):
    | QueueBackendOverride
    | undefined
    | Promise<QueueBackendOverride | undefined>;
}

/** Operations authorized by the billing module. */
export type BillingOperation =
  | "scrape"
  | "parse"
  | "search"
  | "map"
  | "crawl"
  | "batchScrape"
  | "other";

/**
 * Extensible per-request state carried on billing authorization calls.
 * Extensions may add optional fields through declaration merging.
 */
export interface AuthorizeState {}

/**
 * Extensible per-request state carried on search charge events.
 * Extensions may add optional fields through declaration merging.
 */
export interface SearchChargeState {}

/**
 * Extensible per-request state carried on map charge events.
 * Extensions may add optional fields through declaration merging.
 */
export interface MapChargeState {}

/**
 * Extensible per-request state carried on crawl or batch charge events.
 * Extensions may add optional fields through declaration merging.
 */
export interface CrawlChargeState {}

/** Input passed to `BillingModule.authorize` before accepting or starting work. */
export interface AuthorizeInput {
  caller: Caller;
  operation: BillingOperation;
  /**
   * `"preflight"` runs in route middleware before request parsing;
   * `"reserve"` runs in the controller after validation, right before work
   * starts, and may return a handle settled when the request finishes.
   */
  stage?: "preflight" | "reserve";
  /** Present for operations whose cost scales with a requested count. */
  requestedUnits?: number;
  /** Resolved request context when available. */
  ctx?: RequestContext;
  /** Optional per-request inputs carried through declaration merging. */
  state?: AuthorizeState;
}

/** Outcome of `BillingModule.authorize`. */
export type Authorization =
  | {
      ok: true;
      /** Maximum units the caller may consume (for example a crawl limit). */
      maxUnits?: number;
      /** Clamped request limit to write back onto the request body when allowed. */
      clampedLimit?: number;
      /** Opaque reservation handle passed to `settle` when the request ends. */
      handle?: unknown;
      /** When true, skip downstream charge calls for this request. */
      bypassBilling?: boolean;
    }
  | { ok: false; refusal: Refusal };

/** Facts the service knows about a finished unit of work. The billing module prices them. */
export type ChargeEvent =
  | {
      kind: "scrape";
      ctx: RequestContext;
      jobId: string;
      requestId?: string;
      options: ScrapeOptions;
      document: Document | null;
      costTracking: CostTracking;
      state: ScrapeState;
    }
  | {
      kind: "search";
      ctx: RequestContext;
      requestId: string;
      /** Billable search result count for this query. */
      results: number;
      /**
       * Scraped result documents for context. Each document is already charged
       * through a `{ kind: "scrape" }` event during search execution, so
       * `charge()` prices only the search itself and does not re-bill these
       * documents.
       */
      documents: Array<Document>;
      state?: SearchChargeState;
    }
  | {
      kind: "map";
      ctx: RequestContext;
      requestId: string;
      urls: number;
      state?: MapChargeState;
    }
  | {
      kind: "crawl";
      ctx: RequestContext;
      requestId?: string;
      urls: number;
      state?: CrawlChargeState;
    };

/** Final outcome of a reserved request passed to `BillingModule.settle`. */
export type SettleOutcome =
  | { ok: true; charged: number | undefined }
  | { ok: false };

/**
 * Meters and gates work performed by the service.
 * Returning `undefined` from `charge` means the deployment is unmetered and
 * leaves `creditsUsed` unset in responses.
 */
export interface BillingModule {
  authorize(input: AuthorizeInput): Promise<Authorization>;
  charge(event: ChargeEvent): Promise<number | undefined>;
  settle?(handle: unknown, outcome: SettleOutcome): Promise<void>;
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
    ids: ReadonlyArray<string>,
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

/** HTTP request metadata passed to `PolicyModule.admit` and `PolicyModule.context`. */
export interface PolicyHttpContext {
  ip?: string;
  headers: Request["headers"];
  path?: string;
  method?: string;
  rawBody?: unknown;
  req?: Request;
}

/** Input passed to `PolicyModule.admit` after schema validation. */
export interface AdmitInput<K extends RequestKind = RequestKind> {
  kind: K;
  caller: Caller;
  body: RequestBodies[K];
  http?: PolicyHttpContext;
}

/** Outcome of `PolicyModule.admit`. */
export type Admission<
  K extends RequestKind = RequestKind,
  X extends BaseRequestContext = RequestContext,
> =
  | {
      ok: true;
      ctx: X;
      body: RequestBodies[K];
      warnings?: Array<string>;
      headers?: Record<string, string>;
      /** True when the policy module already evaluated URL blocklist rules. */
      blocklistChecked?: boolean;
      /** URLs dropped during admission for partial-admission endpoints like batch scrape. */
      droppedUrls?: Array<string>;
    }
  | { ok: false; refusal: Refusal };

/** Background or internal work purposes for `PolicyModule.system`. */
export type SystemContextPurpose = "robots-txt" | "sitemap" | (string & {});

/** Input passed to `PolicyModule.context` for auxiliary authenticated routes. */
export interface PolicyContextInput {
  route: string;
  caller: Caller;
  http?: PolicyHttpContext;
}

/** Outcome of `PolicyModule.context`. */
export type PolicyContextResult<
  X extends BaseRequestContext = RequestContext,
> =
  | { ok: true; ctx: X; headers?: Record<string, string> }
  | { ok: false; refusal: Refusal };

/**
 * Request admission and context construction. The type parameter keeps
 * `unrestrictedPolicy()` typed on `BaseRequestContext`, so widening
 * `RequestContext` rejects the unrestricted default at compile time.
 */
export interface PolicyModule<X extends BaseRequestContext = RequestContext> {
  admit<K extends RequestKind>(input: AdmitInput<K>): Promise<Admission<K, X>>;
  /** Context for work core starts itself (robots.txt and sitemap fetches). */
  system(purpose: SystemContextPurpose, parent?: RequestContext): X;
  /** Optional context resolver for auxiliary routes outside the six request kinds. */
  context?(input: PolicyContextInput): Promise<PolicyContextResult<X>>;
}

/**
 * The module slots: one implementation for each piece of behaviour the service
 * calls by name.
 */
export interface Modules {
  auth: AuthModule;
  billing: BillingModule;
  blocklist: BlocklistModule;
  limits: LimitsModule;
  messages: MessagesModule;
  policy: PolicyModule;
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
    register: jobStore.register.bind(jobStore),
    owner: jobStore.owner.bind(jobStore),
    read: jobStore.read.bind(jobStore),
    record: jobStore.record.bind(jobStore),
    usage: jobStore.usage.bind(jobStore),
    remove: jobStore.remove.bind(jobStore),
  };
  if (jobStore.storesResultsExternally !== undefined) {
    frozen.storesResultsExternally =
      jobStore.storesResultsExternally.bind(jobStore);
  }
  if (jobStore.readMany !== undefined) {
    frozen.readMany = jobStore.readMany.bind(jobStore);
  }
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
  };
  if (driver.receiveUpload !== undefined) {
    frozen.receiveUpload = driver.receiveUpload.bind(driver);
  }
  return Object.freeze(frozen);
}

/**
 * Validates and freezes a resolved module slot table along with each slot's
 * bound methods and resolved upload driver, so mutating the input objects
 * later cannot alter the service.
 */
export function freezeModules(modules: Modules): Readonly<Modules> {
  const {
    auth,
    billing,
    blocklist,
    limits,
    messages,
    policy,
    uploads,
    jobStore,
    idempotency,
    webhooks,
  } = modules;
  if (
    typeof auth !== "object" ||
    auth === null ||
    typeof auth.authenticate !== "function" ||
    (auth.lookupTeam !== undefined && typeof auth.lookupTeam !== "function")
  ) {
    throw new Error("Invalid auth module");
  }
  if (
    typeof billing !== "object" ||
    billing === null ||
    typeof billing.authorize !== "function" ||
    typeof billing.charge !== "function" ||
    (billing.settle !== undefined && typeof billing.settle !== "function")
  ) {
    throw new Error("Invalid billing module");
  }
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
    typeof limits !== "object" ||
    limits === null ||
    typeof limits.concurrency !== "function" ||
    typeof limits.teamConcurrency !== "function" ||
    (limits.keyConcurrency !== undefined &&
      typeof limits.keyConcurrency !== "function") ||
    typeof limits.jobPriority !== "function" ||
    (limits.onJobStart !== undefined &&
      typeof limits.onJobStart !== "function") ||
    (limits.onJobEnd !== undefined && typeof limits.onJobEnd !== "function") ||
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
    typeof policy !== "object" ||
    policy === null ||
    typeof policy.admit !== "function" ||
    typeof policy.system !== "function" ||
    (policy.context !== undefined && typeof policy.context !== "function")
  ) {
    throw new Error("Invalid policy module");
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

  const authSlot: AuthModule = {
    authenticate: auth.authenticate.bind(auth),
  };
  if (auth.lookupTeam !== undefined) {
    authSlot.lookupTeam = auth.lookupTeam.bind(auth);
  }
  const frozenAuth: AuthModule = Object.freeze(authSlot);

  const billingSlot: BillingModule = {
    authorize: billing.authorize.bind(billing),
    charge: billing.charge.bind(billing),
  };
  if (billing.settle !== undefined) {
    billingSlot.settle = billing.settle.bind(billing);
  }
  const frozenBilling: BillingModule = Object.freeze(billingSlot);

  const frozenBlocklist: BlocklistModule = Object.freeze({
    init: blocklist.init.bind(blocklist),
    isBlocked: blocklist.isBlocked.bind(blocklist),
    hasScopedRules: blocklist.hasScopedRules.bind(blocklist),
  });

  const limitsSlot: LimitsModule = {
    concurrency: limits.concurrency.bind(limits),
    teamConcurrency: limits.teamConcurrency.bind(limits),
    jobPriority: limits.jobPriority.bind(limits),
    queueBackend: limits.queueBackend.bind(limits),
  };
  if (limits.keyConcurrency !== undefined) {
    limitsSlot.keyConcurrency = limits.keyConcurrency.bind(limits);
  }
  if (limits.onJobStart !== undefined) {
    limitsSlot.onJobStart = limits.onJobStart.bind(limits);
  }
  if (limits.onJobEnd !== undefined) {
    limitsSlot.onJobEnd = limits.onJobEnd.bind(limits);
  }
  const frozenLimits: LimitsModule = Object.freeze(limitsSlot);

  const frozenMessages: MessagesModule = Object.freeze({
    errorContact: messages.errorContact.bind(messages),
    restrictedCountryContact: messages.restrictedCountryContact.bind(messages),
    allEnginesFailedContact: messages.allEnginesFailedContact.bind(messages),
    fileFetchProxyError: messages.fileFetchProxyError.bind(messages),
    filePrefetchFailedContact:
      messages.filePrefetchFailedContact.bind(messages),
  });

  const policySlot: PolicyModule = {
    admit: policy.admit.bind(policy),
    system: policy.system.bind(policy),
  };
  if (policy.context !== undefined) {
    policySlot.context = policy.context.bind(policy);
  }
  const frozenPolicy: PolicyModule = Object.freeze(policySlot);

  const frozenDriver = freezeUploadDriver(uploads.driver());
  const frozenUploads: UploadsModule = Object.freeze({
    driver: () => frozenDriver,
  });
  const frozenJobStore = freezeJobStore(jobStore);
  const frozenIdempotency: IdempotencyModule = Object.freeze({
    claim: idempotency.claim.bind(idempotency),
  });

  const webhooksSlot: WebhooksModule = {
    signingSecret: webhooks.signingSecret.bind(webhooks),
    deliver: webhooks.deliver.bind(webhooks),
  };
  if (webhooks.shutdown !== undefined) {
    webhooksSlot.shutdown = webhooks.shutdown.bind(webhooks);
  }
  const frozenWebhooks: WebhooksModule = Object.freeze(webhooksSlot);

  return Object.freeze({
    auth: frozenAuth,
    billing: frozenBilling,
    blocklist: frozenBlocklist,
    limits: frozenLimits,
    messages: frozenMessages,
    policy: frozenPolicy,
    uploads: frozenUploads,
    jobStore: frozenJobStore,
    idempotency: frozenIdempotency,
    webhooks: frozenWebhooks,
  });
}
