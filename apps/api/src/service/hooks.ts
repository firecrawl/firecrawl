/*
 * Hook points: places where the service lets zero or more handlers take part
 * in what it is doing. Each hook point has a fixed kind:
 *
 *   observe    The caller does not wait and cannot fail. Handler errors are
 *              reported and isolated.
 *   await      The caller waits for handlers sequentially. A handler error
 *              propagates to the caller unless the hook point isolates errors.
 *   transform  Like await, and each handler may return a replacement value.
 *
 * This file imports only types so creating or describing a service never loads
 * request schemas, scrape engines, configuration, or clients.
 */
import type { Logger } from "winston";
import type { Document, MapDocument } from "../controllers/v2/types";
import type {
  SearchResultCategoriesBySource,
  SearchV2Response,
} from "../lib/entities";
import type { ErrorCode } from "../lib/error";
import type { JsonObject, JsonValue } from "../lib/json-types";
import type { EngineScrapeResult } from "../scraper/scrapeURL/engines";
import type { JobCrawlerOptions } from "../types";
import type { EngineFeatureName, EngineName } from "./engines";
import type { RequestContext } from "./request-context";
import type { RequestBodies, RequestKind, ScrapeOptions } from "./request";

export type { RequestBodies, RequestKind } from "./request";

export interface Observe<Payload> {
  kind: "observe";
  payload: Payload;
}

export interface Await<Payload> {
  kind: "await";
  payload: Payload;
}

export interface Transform<Value, Info> {
  kind: "transform";
  value: Value;
  info: Info;
}

/**
 * Per-scrape scratch space created empty by the pipeline and passed to hooks.
 * Extensions may add optional fields through declaration merging.
 */
export interface ScrapeState {}

/**
 * Per-map scratch space shared across map hooks for one map execution.
 * Extensions may add optional fields through declaration merging.
 */
export interface MapState {}

/**
 * Per-search scratch space shared across search hooks for one search execution.
 * Extensions may add optional fields through declaration merging.
 */
export interface SearchState {}

/**
 * Optional metadata attached to `scrape.finished` events.
 * Extensions may add optional fields through declaration merging.
 */
export interface ScrapeFinishedMetadata {}

/** Map request options reported on `map.finished`. */
export interface MapFinishedOptions {
  search?: string;
  sitemap?: "skip" | "include" | "only";
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  limit?: number;
  timeout?: number;
  location?: {
    country?: string;
    languages?: Array<string>;
  };
}

/** Context shared across scrape-stage hooks for one scrape execution. */
export interface ScrapeMeta {
  id: string;
  url: string;
  ctx: RequestContext;
  options: ScrapeOptions;
  state: ScrapeState;
  logger: Logger;
  abort: AbortSignal;
}

/** Mutable options and required engine features for a scrape attempt. */
export interface ScrapePlan {
  options: ScrapeOptions;
  /** Engine features the waterfall must satisfy. */
  features: Set<EngineFeatureName>;
  /** Require markdown derivation even when no built-in format needs it. */
  needsMarkdown?: boolean;
  /** Top-level document keys kept during final format coercion. */
  keepDocumentFields?: Set<string>;
  /** Optional rewritten URL to scrape (for example, stripped of embedded credentials). */
  url?: string;
  /** Optional rewritten unnormalized source URL. */
  unnormalizedSourceURL?: string;
  /** Optional override for whether robots.txt should be checked for this scrape. */
  checkRobots?: boolean;
}

/**
 * Options passed to HTML cleaning alongside the raw HTML. A hook handler may
 * populate `dropSignatures` with element signatures to remove during cleaning.
 */
export interface HtmlCleaning {
  url: string;
  includeTags: Array<string>;
  excludeTags: Array<string>;
  onlyMainContent: boolean;
  dropSignatures?: Array<string>;
}

/** Ordered list of candidate scrape engines to attempt. */
export interface EnginePlan {
  /** Candidate engines to try, best first. */
  candidates: Array<EngineName>;
  /** When true, resolved candidates carry no unsupported-feature warnings. */
  suppressUnsupportedWarnings?: boolean;
  /**
   * On `scrape.engine.fallback`: when true, continue waterfalling to remaining
   * candidates even when the failed engine's error would otherwise stop the loop.
   */
  continueWaterfall?: boolean;
}

/** HTTP refusal payload returned when a request is rejected. */
export interface Refusal {
  status: number;
  body: {
    success: false;
    error: string;
    code?: ErrorCode | (string & {});
    [key: string]: JsonValue | undefined;
  };
  headers?: Record<string, string>;
}

/** Job kinds tracked across queue and completion hooks. */
export type JobKind = "scrape" | "crawl" | "batchScrape";

/** Discriminated event describing an admitted API request. */
export type RequestEvent = {
  [K in RequestKind]: {
    kind: K;
    id: string;
    ctx: RequestContext;
    body: RequestBodies[K];
  };
}[RequestKind];

/** Request event paired with the documents produced for the response. */
export type ResponseInfo = RequestEvent & { documents: Array<Document> };

/** Completion payload delivered when a scrape job finishes. */
export interface ScrapeFinished {
  jobId: string;
  requestId?: string;
  kind: JobKind;
  ctx: RequestContext;
  url: string;
  options: ScrapeOptions;
  state: ScrapeState;
  document: Document | null;
  error?: unknown;
  /** Metered usage charged for this scrape, or undefined when unmetered. */
  charged: number | undefined;
  timeTakenMs: number;
  startedAt?: number;
  completedAt?: number;
  origin?: string;
  crawlId?: string;
  skipNuq?: boolean;
  isParse?: boolean;
  costTracking?: JsonObject;
  /** Opaque per-job metadata passed through to completion hooks. */
  metadata?: ScrapeFinishedMetadata;
}

/** Completion payload delivered when a crawl or batch scrape finishes. */
export interface CrawlFinished {
  id: string;
  kind: "crawl" | "batchScrape";
  ctx: RequestContext;
  completed: number;
  cancelled: boolean;
  requestId?: string;
  origin?: string;
  originUrl?: string;
  crawlerOptions?: JobCrawlerOptions | null;
  charged?: number | null;
  isV1?: boolean;
  metadata?: JsonObject;
}

/** Plan transformed before executing a search request. */
export interface SearchPlan {
  query: string;
  limit: number;
  sources: Array<string>;
}

/** Individual search result transformed by `search.results` hooks. */
export interface SearchHit {
  url: string;
  title?: string;
  description?: string;
  group?: "web" | "news" | "images";
  category?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
}

/** Response payload value transformed by `request.responding` hooks. */
type ResponsePayloadValue =
  | JsonValue
  | Document
  | SearchV2Response
  | MapDocument
  | RequestContext
  | undefined;

/** Response payload transformed by `request.responding` hooks. */
export type ResponsePayload = {
  [key: string]: ResponsePayloadValue | ReadonlyArray<ResponsePayloadValue>;
};

/**
 * The service's 26 typed hook points, grouped by lifecycle area.
 */
export interface HookPoints {
  // process
  "process.start": Await<{ role: string }>;
  "process.stop": Await<{ role: string }>;
  // request
  "request.accepted": Await<RequestEvent>;
  "request.rejected": Observe<{
    kind: RequestKind;
    teamId: string | undefined;
    refusal: Refusal;
  }>;
  "request.responding": Transform<ResponsePayload, ResponseInfo>;
  // queue
  "job.enqueued": Observe<{
    jobId: string;
    kind: JobKind;
    ctx: RequestContext;
    url?: string;
    options?: ScrapeOptions;
    jobData?: unknown;
  }>;
  "concurrency.limited": Observe<{
    ctx: RequestContext;
    limit: number;
    exceededBacklog?: boolean;
    isCrawlOrBatch?: boolean;
  }>;
  // scrape, in pipeline order
  "scrape.start": Transform<ScrapePlan, ScrapeMeta>;
  "scrape.engines.select": Transform<EnginePlan, ScrapeMeta>;
  "scrape.engine.fallback": Transform<
    EnginePlan,
    ScrapeMeta & { failed: EngineName; error: unknown }
  >;
  "scrape.fetched": Transform<EngineScrapeResult, ScrapeMeta>;
  "scrape.html.clean": Transform<HtmlCleaning, ScrapeMeta>;
  "scrape.document.markdown": Transform<Document, ScrapeMeta>;
  /**
   * Runs after standard document derivation (markdown and metadata) completes.
   * Internal sitemap fetches (`ctx.teamId === "sitemap"`) skip HTML/markdown
   * derivation and invoke this hook with only `rawHtml` and `metadata.scrapeId`
   * populated.
   */
  "scrape.document.derived": Transform<Document, ScrapeMeta>;
  "scrape.document.extracted": Transform<Document, ScrapeMeta>;
  "scrape.document.final": Transform<Document, ScrapeMeta>;
  "scrape.finished": Await<ScrapeFinished>;
  // crawl
  "crawl.kickoff": Transform<
    Array<string>,
    {
      id: string;
      ctx: RequestContext;
      url: string;
      crawlerOptions?: JobCrawlerOptions;
    }
  >;
  "crawl.links": Transform<
    Array<string>,
    {
      id: string;
      ctx: RequestContext;
      from: string;
      crawlerOptions?: JobCrawlerOptions | null;
      bypassBilling?: boolean;
    }
  >;
  "crawl.finished": Await<CrawlFinished>;
  // map and search
  "map.collect": Transform<
    Array<string>,
    {
      ctx: RequestContext;
      url: string;
      limit: number;
      search?: string;
      includeSubdomains?: boolean;
      allowExternalLinks?: boolean;
      ignoreCache?: boolean;
      sitemap?: "skip" | "include" | "only";
      useIndex?: boolean;
      maxSearchResults?: number;
      abort?: AbortSignal;
      documents?: Map<string, MapDocument>;
      state?: MapState;
      logger?: Logger;
    }
  >;
  "map.filter": Transform<
    Array<MapDocument>,
    {
      ctx: RequestContext;
      url: string;
      limit: number;
      state?: MapState;
      logger?: Logger;
    }
  >;
  "map.finished": Observe<{
    id: string;
    requestId?: string;
    ctx: RequestContext;
    urls: number;
    url?: string;
    options?: MapFinishedOptions;
    links?: Array<MapDocument>;
    charged?: number;
    timeTakenMs?: number;
    state?: MapState;
  }>;
  "search.plan": Transform<
    SearchPlan,
    {
      ctx: RequestContext;
      body: RequestBodies["search"];
      state?: SearchState;
      logger?: Logger;
    }
  >;
  "search.results": Transform<
    Array<SearchHit>,
    {
      ctx: RequestContext;
      body: RequestBodies["search"];
      state?: SearchState;
      response?: SearchV2Response;
      logger?: Logger;
    }
  >;
  "search.finished": Observe<{
    id: string;
    requestId?: string;
    ctx: RequestContext;
    results: number;
    charged: number | undefined;
    scrapeCredits?: number;
    totalCredits?: number;
    body?: RequestBodies["search"];
    response?: SearchV2Response;
    timeTakenMs?: number;
    resultCountsBySource?: Record<string, number>;
    resultCategories?: SearchResultCategoriesBySource;
    searchTypes?: Array<string>;
    scrapeFormats?: Array<string>;
    shouldScrape?: boolean;
    isSuccessful?: boolean;
    error?: string;
    state?: SearchState;
  }>;
}

type Point = Observe<unknown> | Await<unknown> | Transform<unknown, unknown>;

type PointNamesOfKind<Points, Kind extends Point["kind"]> = {
  [Name in keyof Points]: Points[Name] extends { kind: Kind } ? Name : never;
}[keyof Points];

type PointPayloadOf<P> = P extends Observe<infer Payload> | Await<infer Payload>
  ? Payload
  : never;

type PointValueOf<P> =
  P extends Transform<infer Value, infer _Info> ? Value : never;

type PointInfoOf<P> =
  P extends Transform<infer _Value, infer Info> ? Info : never;

type PointHandlerOf<P> =
  P extends Transform<infer Value, infer Info>
    ? (value: Value, info: Info) => Value | void | Promise<Value | void>
    : (payload: PointPayloadOf<P>) => void | Promise<void>;

export type HookName = keyof HookPoints;
export type HookKind = HookPoints[HookName]["kind"];
export type NamesOfKind<K extends HookKind> = PointNamesOfKind<HookPoints, K>;
export type PayloadOf<N extends HookName> = PointPayloadOf<HookPoints[N]>;
export type ValueOf<N extends HookName> = PointValueOf<HookPoints[N]>;
export type InfoOf<N extends HookName> = PointInfoOf<HookPoints[N]>;
export type HookHandler<N extends HookName> = PointHandlerOf<HookPoints[N]>;

type PayloadsOf<Points, Kind extends "observe" | "await"> = {
  [Name in PointNamesOfKind<Points, Kind>]: PointPayloadOf<Points[Name]>;
};

type ValuesOf<Points> = {
  [Name in PointNamesOfKind<Points, "transform">]: PointValueOf<Points[Name]>;
};

type InfosOf<Points> = {
  [Name in PointNamesOfKind<Points, "transform">]: PointInfoOf<Points[Name]>;
};

type ObserveHandlerFn<
  Points,
  Name extends PointNamesOfKind<Points, "observe">,
> = (payload: PayloadsOf<Points, "observe">[Name]) => void | Promise<void>;

type AwaitHandlerFn<Points, Name extends PointNamesOfKind<Points, "await">> = (
  payload: PayloadsOf<Points, "await">[Name],
) => void | Promise<void>;

type TransformHandlerFn<
  Points,
  Name extends PointNamesOfKind<Points, "transform">,
> = (
  value: ValuesOf<Points>[Name],
  info: InfosOf<Points>[Name],
) => ValuesOf<Points>[Name] | void | Promise<ValuesOf<Points>[Name] | void>;

type ObserveHandlers<Points> = {
  [Name in PointNamesOfKind<Points, "observe">]?:
    | ObserveHandlerFn<Points, Name>
    | ReadonlyArray<ObserveHandlerFn<Points, Name>>;
};

type AwaitHandlers<Points> = {
  [Name in PointNamesOfKind<Points, "await">]?:
    | AwaitHandlerFn<Points, Name>
    | ReadonlyArray<AwaitHandlerFn<Points, Name>>;
};

type TransformHandlers<Points> = {
  [Name in PointNamesOfKind<Points, "transform">]?:
    | TransformHandlerFn<Points, Name>
    | ReadonlyArray<TransformHandlerFn<Points, Name>>;
};

/** One handler or several per hook point. */
export type HandlersOf<Points> = ObserveHandlers<Points> &
  AwaitHandlers<Points> &
  TransformHandlers<Points>;

/** How hook points are invoked. The method must match the point's kind. */
export interface HooksOf<Points> {
  /** Whether at least one handler is registered on `name`. */
  has(name: keyof Points): boolean;
  observe<Name extends PointNamesOfKind<Points, "observe">>(
    name: Name,
    payload: PayloadsOf<Points, "observe">[Name],
  ): void;
  run<Name extends PointNamesOfKind<Points, "await">>(
    name: Name,
    payload: PayloadsOf<Points, "await">[Name],
  ): Promise<void>;
  /** With no handler registered, returns `value` synchronously without allocating a promise. */
  transform<Name extends PointNamesOfKind<Points, "transform">>(
    name: Name,
    value: ValuesOf<Points>[Name],
    info: InfosOf<Points>[Name],
  ): ValuesOf<Points>[Name] | Promise<ValuesOf<Points>[Name]>;
}

export type HookHandlers = HandlersOf<HookPoints>;
export type Hooks = HooksOf<HookPoints>;

/** Static execution rules fixed per hook point. */
export interface HookPointSpec<Kind extends HookKind = HookKind> {
  readonly kind: Kind;
  readonly timeoutMs?: number;
  readonly isolate?: boolean;
  readonly reverse?: boolean;
}

const rawHookPoints = {
  "process.start": Object.freeze({ kind: "await" as const }),
  "process.stop": Object.freeze({
    kind: "await" as const,
    timeoutMs: 45_000,
    isolate: true,
    reverse: true,
  }),
  "request.accepted": Object.freeze({ kind: "await" as const }),
  "request.rejected": Object.freeze({ kind: "observe" as const }),
  "request.responding": Object.freeze({ kind: "transform" as const }),
  "job.enqueued": Object.freeze({ kind: "observe" as const }),
  "concurrency.limited": Object.freeze({ kind: "observe" as const }),
  "scrape.start": Object.freeze({ kind: "transform" as const }),
  "scrape.engines.select": Object.freeze({ kind: "transform" as const }),
  "scrape.engine.fallback": Object.freeze({ kind: "transform" as const }),
  "scrape.fetched": Object.freeze({ kind: "transform" as const }),
  "scrape.html.clean": Object.freeze({ kind: "transform" as const }),
  "scrape.document.markdown": Object.freeze({ kind: "transform" as const }),
  "scrape.document.derived": Object.freeze({ kind: "transform" as const }),
  "scrape.document.extracted": Object.freeze({ kind: "transform" as const }),
  "scrape.document.final": Object.freeze({ kind: "transform" as const }),
  "scrape.finished": Object.freeze({ kind: "await" as const }),
  "crawl.kickoff": Object.freeze({ kind: "transform" as const }),
  "crawl.links": Object.freeze({ kind: "transform" as const }),
  "crawl.finished": Object.freeze({ kind: "await" as const }),
  "map.collect": Object.freeze({ kind: "transform" as const }),
  "map.filter": Object.freeze({ kind: "transform" as const }),
  "map.finished": Object.freeze({ kind: "observe" as const }),
  "search.plan": Object.freeze({ kind: "transform" as const }),
  "search.results": Object.freeze({ kind: "transform" as const }),
  "search.finished": Object.freeze({ kind: "observe" as const }),
} satisfies {
  readonly [N in HookName]: HookPointSpec<HookPoints[N]["kind"]>;
};

/**
 * Static metadata for every hook point, keyed by name on a null-prototype
 * frozen object so prototype keys cannot match.
 */
const nullProtoHookPoints = { ...rawHookPoints };
Object.setPrototypeOf(nullProtoHookPoints, null);

export const hookPoints: Readonly<{
  [N in HookName]: HookPointSpec<HookPoints[N]["kind"]>;
}> = Object.freeze(nullProtoHookPoints);

function isHookName(name: string): name is HookName {
  return Object.hasOwn(hookPoints, name);
}

/** All known hook point names. */
export const hookPointNames: ReadonlyArray<HookName> = Object.freeze(
  Object.keys(hookPoints).filter(isHookName),
);

/** @internal */
export interface HookRegistrySource {
  owner: string;
  hooks?: HookHandlers;
}

type ObserveHookName = NamesOfKind<"observe">;
type AwaitHookName = NamesOfKind<"await">;
type TransformHookName = NamesOfKind<"transform">;

function isObserveHook(name: HookName): name is ObserveHookName {
  return hookPoints[name].kind === "observe";
}

function isAwaitHook(name: HookName): name is AwaitHookName {
  return hookPoints[name].kind === "await";
}

function isTransformHook(name: HookName): name is TransformHookName {
  return hookPoints[name].kind === "transform";
}

function isPlainHookObject(value: unknown): value is HookHandlers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type MutableObserveBuckets = {
  [N in ObserveHookName]?: Array<{
    owner: string;
    handler: ObserveHandlerFn<HookPoints, N>;
  }>;
};

type MutableAwaitBuckets = {
  [N in AwaitHookName]?: Array<{
    owner: string;
    handler: AwaitHandlerFn<HookPoints, N>;
  }>;
};

type MutableTransformBuckets = {
  [N in TransformHookName]?: Array<{
    owner: string;
    handler: TransformHandlerFn<HookPoints, N>;
  }>;
};

type FrozenObserveTable = {
  [N in ObserveHookName]?: ReadonlyArray<ObserveHandlerFn<HookPoints, N>>;
};

type FrozenAwaitTable = {
  [N in AwaitHookName]?: ReadonlyArray<AwaitHandlerFn<HookPoints, N>>;
};

type FrozenTransformTable = {
  [N in TransformHookName]?: ReadonlyArray<TransformHandlerFn<HookPoints, N>>;
};

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

interface BuiltHookRegistry {
  hooks: Hooks;
  describedHooks: Record<string, Array<string>>;
}

function normalizeHandlers<Fn>(
  name: string,
  listed: Fn | ReadonlyArray<Fn> | undefined,
): Array<Fn> {
  if (listed === undefined) {
    return [];
  }
  const normalized: Array<Fn> = [];
  if (Array.isArray(listed)) {
    const items: ReadonlyArray<Fn> = listed;
    for (let i = 0; i < items.length; i++) {
      const handler = items[i];
      if (typeof handler !== "function") {
        throw new Error(
          `Hook "${name}" handler at index ${i} must be a function`,
        );
      }
      normalized.push(handler);
    }
  } else if (typeof listed === "function") {
    normalized.push(listed);
  } else {
    throw new Error(`Hook "${name}" handler must be a function`);
  }
  return normalized;
}

function appendBucket<
  Name extends HookName,
  Buckets extends {
    [K in Name]?: Array<{ owner: string; handler: Fn }>;
  },
  Fn,
>(
  buckets: Buckets,
  name: Name,
  listed: Fn | ReadonlyArray<Fn> | undefined,
  owner: string,
): void {
  const normalized = normalizeHandlers(name, listed);
  if (normalized.length === 0) {
    return;
  }
  let bucket: Array<{ owner: string; handler: Fn }> | undefined = buckets[name];
  if (!bucket) {
    bucket = [];
    Object.defineProperty(buckets, name, {
      value: bucket,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const handler of normalized) {
    bucket.push({ owner, handler });
  }
}

function freezeBucketEntries<Fn>(
  entries: ReadonlyArray<{ owner: string; handler: Fn }> | undefined,
  name: HookName,
  registered: Set<HookName>,
  ownerEntries: Array<[string, Array<string>]>,
): ReadonlyArray<Fn> | undefined {
  if (!entries) {
    return undefined;
  }
  const ordered = hookPoints[name].reverse
    ? entries.slice().reverse()
    : entries;
  registered.add(name);
  ownerEntries.push([name, ordered.map(entry => entry.owner)]);
  return Object.freeze(ordered.map(entry => entry.handler));
}

function freezeObserveEntry<N extends ObserveHookName>(
  table: FrozenObserveTable,
  buckets: MutableObserveBuckets,
  name: N,
  registered: Set<HookName>,
  ownerEntries: Array<[string, Array<string>]>,
): void {
  const frozen = freezeBucketEntries(
    buckets[name],
    name,
    registered,
    ownerEntries,
  );
  if (frozen) {
    Object.defineProperty(table, name, { value: frozen, enumerable: true });
  }
}

function freezeAwaitEntry<N extends AwaitHookName>(
  table: FrozenAwaitTable,
  buckets: MutableAwaitBuckets,
  name: N,
  registered: Set<HookName>,
  ownerEntries: Array<[string, Array<string>]>,
): void {
  const frozen = freezeBucketEntries(
    buckets[name],
    name,
    registered,
    ownerEntries,
  );
  if (frozen) {
    Object.defineProperty(table, name, { value: frozen, enumerable: true });
  }
}

function freezeTransformEntry<N extends TransformHookName>(
  table: FrozenTransformTable,
  buckets: MutableTransformBuckets,
  name: N,
  registered: Set<HookName>,
  ownerEntries: Array<[string, Array<string>]>,
): void {
  const frozen = freezeBucketEntries(
    buckets[name],
    name,
    registered,
    ownerEntries,
  );
  if (frozen) {
    Object.defineProperty(table, name, { value: frozen, enumerable: true });
  }
}

/**
 * Builds the frozen hook dispatcher and its ownership description from
 * extensions in registration order. Validates hook names and handler functions
 * up front and snapshots handler lists so later mutations have no effect.
 *
 * @internal
 */
export function buildHookRegistry(
  sources: ReadonlyArray<HookRegistrySource>,
  report: (hook: string, error: unknown) => void,
): BuiltHookRegistry {
  if (typeof report !== "function") {
    throw new Error("Hook error reporter must be a function");
  }

  const observeBuckets: MutableObserveBuckets = {};
  const awaitBuckets: MutableAwaitBuckets = {};
  const transformBuckets: MutableTransformBuckets = {};

  for (const source of sources) {
    const set = source.hooks;
    if (set === undefined) {
      continue;
    }
    if (!isPlainHookObject(set)) {
      throw new Error(
        `Extension "${source.owner}" hooks must be a plain object`,
      );
    }

    for (const name of Object.keys(set)) {
      if (!isHookName(name)) {
        throw new Error(`Unknown hook point "${name}"`);
      }
      if (isObserveHook(name)) {
        appendBucket(observeBuckets, name, set[name], source.owner);
      } else if (isAwaitHook(name)) {
        appendBucket(awaitBuckets, name, set[name], source.owner);
      } else if (isTransformHook(name)) {
        appendBucket(transformBuckets, name, set[name], source.owner);
      }
    }
  }

  const registered = new Set<HookName>();
  const ownerEntries: Array<[string, Array<string>]> = [];

  const observeTable: FrozenObserveTable = {};
  Object.setPrototypeOf(observeTable, null);
  const awaitTable: FrozenAwaitTable = {};
  Object.setPrototypeOf(awaitTable, null);
  const transformTable: FrozenTransformTable = {};
  Object.setPrototypeOf(transformTable, null);

  for (const name of hookPointNames) {
    if (isObserveHook(name)) {
      freezeObserveEntry(
        observeTable,
        observeBuckets,
        name,
        registered,
        ownerEntries,
      );
    } else if (isAwaitHook(name)) {
      freezeAwaitEntry(
        awaitTable,
        awaitBuckets,
        name,
        registered,
        ownerEntries,
      );
    } else if (isTransformHook(name)) {
      freezeTransformEntry(
        transformTable,
        transformBuckets,
        name,
        registered,
        ownerEntries,
      );
    }
  }

  const reportFailure = (hook: string, error: unknown) => {
    try {
      report(hook, error);
    } catch {
      // Nothing is left to report it to.
    }
  };

  const invoke = async <T>(
    name: HookName,
    call: () => T | PromiseLike<T>,
  ): Promise<T | undefined> => {
    const spec = Object.hasOwn(hookPoints, name) ? hookPoints[name] : undefined;
    const timeoutMs = spec?.timeoutMs;
    const isolate = spec?.isolate === true;
    try {
      if (timeoutMs === undefined) {
        return await call();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = call();
        if (!isPromiseLike(result)) {
          return result;
        }
        return await Promise.race([
          result,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(`Hook "${name}" timed out after ${timeoutMs}ms`),
              );
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      if (!isolate) {
        throw error;
      }
      reportFailure(name, error);
      return undefined;
    }
  };

  const hooksImpl: Hooks = {
    has(name) {
      return registered.has(name);
    },
    observe(name, payload) {
      const handlers = observeTable[name];
      if (!handlers) {
        return;
      }
      for (const handler of handlers) {
        try {
          const result = handler(payload);
          if (isPromiseLike(result)) {
            Promise.resolve(result).catch((error: unknown) =>
              reportFailure(String(name), error),
            );
          }
        } catch (error) {
          reportFailure(String(name), error);
        }
      }
    },
    async run(name, payload) {
      const handlers = awaitTable[name];
      if (!handlers) {
        return;
      }
      for (const handler of handlers) {
        await invoke(name, () => handler(payload));
      }
    },
    transform(name, value, info) {
      const handlers = transformTable[name];
      // Hot path: with no handler installed, return synchronously with no
      // promise allocation.
      if (!handlers) {
        return value;
      }
      return (async () => {
        let current = value;
        for (const handler of handlers) {
          const next = await invoke(name, () => handler(current, info));
          if (next !== undefined) {
            current = next;
          }
        }
        return current;
      })();
    },
  };
  const hooks: Hooks = Object.freeze(hooksImpl);

  return {
    hooks,
    describedHooks: sortedByKey(Object.fromEntries(ownerEntries)),
  };
}

/**
 * Builds the frozen hook dispatcher for a list of handler sets. Validates hook
 * names and handler functions up front and snapshots handler lists.
 *
 * @internal
 */
export function buildHooks(
  sets: ReadonlyArray<HookHandlers>,
  report: (hook: string, error: unknown) => void,
): Hooks {
  return buildHookRegistry(
    sets.map((hooks, index) => ({ owner: `set-${index}`, hooks })),
    report,
  ).hooks;
}
