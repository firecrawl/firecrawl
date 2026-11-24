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
import type { Document } from "../controllers/v2/types";
import type { ErrorCode } from "../lib/error";
import type { EngineScrapeResult } from "../scraper/scrapeURL/engines";
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
}

/**
 * Options passed to HTML cleaning alongside the raw HTML. A hook handler may
 * populate `dropSignatures` with element signatures to remove during cleaning.
 */
export interface HtmlCleaning {
  url: string;
  includeTags: string[];
  excludeTags: string[];
  onlyMainContent: boolean;
  dropSignatures?: string[];
}

/** Ordered list of candidate scrape engines to attempt. */
export interface EnginePlan {
  /** Candidate engines to try, best first. */
  candidates: EngineName[];
}

/** HTTP refusal payload returned when a request is rejected. */
export interface Refusal {
  status: number;
  body: {
    success: false;
    error: string;
    code?: ErrorCode;
  } & Record<string, unknown>;
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
export type ResponseInfo = RequestEvent & { documents: Document[] };

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
}

/** Completion payload delivered when a crawl or batch scrape finishes. */
export interface CrawlFinished {
  id: string;
  kind: "crawl" | "batchScrape";
  ctx: RequestContext;
  completed: number;
  cancelled: boolean;
}

/** Plan transformed before executing a search request. */
export interface SearchPlan {
  query: string;
  limit: number;
  sources: string[];
}

/** Individual search result transformed by `search.results` hooks. */
export interface SearchHit {
  url: string;
  title?: string;
  description?: string;
}

/**
 * The service's 25 typed hook points, grouped by lifecycle area.
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
  "request.responding": Transform<Record<string, unknown>, ResponseInfo>;
  // queue
  "job.enqueued": Observe<{
    jobId: string;
    kind: JobKind;
    ctx: RequestContext;
  }>;
  "concurrency.limited": Observe<{ ctx: RequestContext; limit: number }>;
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
  "scrape.document.derived": Transform<Document, ScrapeMeta>;
  "scrape.document.extracted": Transform<Document, ScrapeMeta>;
  "scrape.document.final": Transform<Document, ScrapeMeta>;
  "scrape.finished": Await<ScrapeFinished>;
  // crawl
  "crawl.kickoff": Transform<
    string[],
    { id: string; ctx: RequestContext; url: string }
  >;
  "crawl.links": Transform<
    string[],
    { id: string; ctx: RequestContext; from: string }
  >;
  "crawl.finished": Await<CrawlFinished>;
  // map and search
  "map.collect": Transform<
    string[],
    { ctx: RequestContext; url: string; limit: number }
  >;
  "map.finished": Observe<{ id: string; ctx: RequestContext; urls: number }>;
  "search.plan": Transform<
    SearchPlan,
    { ctx: RequestContext; body: RequestBodies["search"] }
  >;
  "search.results": Transform<
    SearchHit[],
    { ctx: RequestContext; body: RequestBodies["search"] }
  >;
  "search.finished": Observe<{
    id: string;
    ctx: RequestContext;
    results: number;
    charged: number | undefined;
  }>;
}

type Point = Observe<any> | Await<any> | Transform<any, any>;

type PointNamesOfKind<Points, Kind extends Point["kind"]> = {
  [Name in keyof Points]: Points[Name] extends { kind: Kind } ? Name : never;
}[keyof Points];

type PointPayloadOf<P> = P extends Observe<infer Payload> | Await<infer Payload>
  ? Payload
  : never;

type PointValueOf<P> = P extends Transform<infer Value, any> ? Value : never;

type PointInfoOf<P> = P extends Transform<any, infer Info> ? Info : never;

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

/** One handler or several per hook point. */
export type HandlersOf<Points> = {
  [Name in keyof Points]?:
    | PointHandlerOf<Points[Name]>
    | readonly PointHandlerOf<Points[Name]>[];
};

/** How hook points are invoked. The method must match the point's kind. */
export interface HooksOf<Points> {
  /** Whether at least one handler is registered on `name`. */
  has(name: keyof Points): boolean;
  observe<Name extends PointNamesOfKind<Points, "observe">>(
    name: Name,
    payload: PointPayloadOf<Points[Name]>,
  ): void;
  run<Name extends PointNamesOfKind<Points, "await">>(
    name: Name,
    payload: PointPayloadOf<Points[Name]>,
  ): Promise<void>;
  /** With no handler registered, returns `value` synchronously without allocating a promise. */
  transform<Name extends PointNamesOfKind<Points, "transform">>(
    name: Name,
    value: PointValueOf<Points[Name]>,
    info: PointInfoOf<Points[Name]>,
  ): PointValueOf<Points[Name]> | Promise<PointValueOf<Points[Name]>>;
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

const rawHookPoints: {
  readonly [N in HookName]: HookPointSpec<HookPoints[N]["kind"]>;
} = {
  "process.start": Object.freeze({ kind: "await" }),
  "process.stop": Object.freeze({
    kind: "await",
    timeoutMs: 10_000,
    isolate: true,
    reverse: true,
  }),
  "request.accepted": Object.freeze({ kind: "await" }),
  "request.rejected": Object.freeze({ kind: "observe" }),
  "request.responding": Object.freeze({ kind: "transform" }),
  "job.enqueued": Object.freeze({ kind: "observe" }),
  "concurrency.limited": Object.freeze({ kind: "observe" }),
  "scrape.start": Object.freeze({ kind: "transform" }),
  "scrape.engines.select": Object.freeze({ kind: "transform" }),
  "scrape.engine.fallback": Object.freeze({ kind: "transform" }),
  "scrape.fetched": Object.freeze({ kind: "transform" }),
  "scrape.html.clean": Object.freeze({ kind: "transform" }),
  "scrape.document.markdown": Object.freeze({ kind: "transform" }),
  "scrape.document.derived": Object.freeze({ kind: "transform" }),
  "scrape.document.extracted": Object.freeze({ kind: "transform" }),
  "scrape.document.final": Object.freeze({ kind: "transform" }),
  "scrape.finished": Object.freeze({ kind: "await" }),
  "crawl.kickoff": Object.freeze({ kind: "transform" }),
  "crawl.links": Object.freeze({ kind: "transform" }),
  "crawl.finished": Object.freeze({ kind: "await" }),
  "map.collect": Object.freeze({ kind: "transform" }),
  "map.finished": Object.freeze({ kind: "observe" }),
  "search.plan": Object.freeze({ kind: "transform" }),
  "search.results": Object.freeze({ kind: "transform" }),
  "search.finished": Object.freeze({ kind: "observe" }),
};

/**
 * Static metadata for every hook point, keyed by name on a null-prototype
 * frozen object so prototype keys cannot match.
 */
export const hookPoints: Readonly<{
  [N in HookName]: HookPointSpec<HookPoints[N]["kind"]>;
}> = Object.freeze(Object.assign(Object.create(null), rawHookPoints));

/** All known hook point names. */
export const hookPointNames: readonly HookName[] = Object.freeze(
  Object.keys(hookPoints) as HookName[],
);

/** @internal */
export interface HookRegistrySource {
  owner: string;
  hooks?: HookHandlers;
}

type AnyHandler = (first: unknown, second?: unknown) => unknown;

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Builds the frozen hook dispatcher and its ownership description from
 * extensions in registration order. Validates hook names and handler functions
 * up front and snapshots handler lists so later mutations have no effect.
 *
 * @internal
 */
export function buildHookRegistry(
  sources: readonly HookRegistrySource[],
  report: (hook: string, error: unknown) => void,
): {
  hooks: Hooks;
  describedHooks: Record<string, string[]>;
} {
  if (typeof report !== "function") {
    throw new Error("Hook error reporter must be a function");
  }

  const entriesByName = new Map<
    HookName,
    Array<{ owner: string; handler: AnyHandler }>
  >();

  for (const source of sources) {
    const set = source.hooks;
    if (set === undefined) continue;
    if (!isPlainObject(set)) {
      throw new Error(
        `Extension "${source.owner}" hooks must be a plain object`,
      );
    }

    for (const name of Object.keys(set)) {
      if (!Object.hasOwn(hookPoints, name)) {
        throw new Error(`Unknown hook point "${name}"`);
      }
      const hookName = name as HookName;
      const listed = set[name];
      if (listed === undefined) continue;

      const normalized: AnyHandler[] = [];
      if (Array.isArray(listed)) {
        for (let i = 0; i < listed.length; i++) {
          const handler = listed[i];
          if (typeof handler !== "function") {
            throw new Error(
              `Hook "${name}" handler at index ${i} must be a function`,
            );
          }
          normalized.push(handler as AnyHandler);
        }
      } else if (typeof listed === "function") {
        normalized.push(listed as AnyHandler);
      } else {
        throw new Error(`Hook "${name}" handler must be a function`);
      }

      if (normalized.length === 0) continue;

      let bucket = entriesByName.get(hookName);
      if (!bucket) {
        bucket = [];
        entriesByName.set(hookName, bucket);
      }
      for (const handler of normalized) {
        bucket.push({ owner: source.owner, handler });
      }
    }
  }

  const table = new Map<HookName, readonly AnyHandler[]>();
  const ownerTable: Record<string, string[]> = Object.create(null);

  for (const [name, entries] of entriesByName) {
    const ordered = hookPoints[name].reverse ? [...entries].reverse() : entries;
    table.set(name, Object.freeze(ordered.map(entry => entry.handler)));
    ownerTable[name] = ordered.map(entry => entry.owner);
  }

  const reportFailure = (hook: string, error: unknown) => {
    try {
      report(hook, error);
    } catch {
      // Nothing is left to report it to.
    }
  };

  const invoke = async (
    name: HookName,
    call: () => unknown,
  ): Promise<unknown> => {
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
      if (!isolate) throw error;
      reportFailure(name, error);
      return undefined;
    }
  };

  const hooks: Hooks = Object.freeze({
    has(name) {
      return table.has(name);
    },
    observe(name, payload) {
      const handlers = table.get(name);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          const result = handler(payload);
          if (isPromiseLike(result)) {
            Promise.resolve(result).catch(error =>
              reportFailure(String(name), error),
            );
          }
        } catch (error) {
          reportFailure(String(name), error);
        }
      }
    },
    async run(name, payload) {
      const handlers = table.get(name);
      if (!handlers) return;
      for (const handler of handlers) {
        await invoke(name, () => handler(payload));
      }
    },
    transform(name, value, info) {
      const handlers = table.get(name);
      // Hot path: with no handler installed, return synchronously with no
      // promise allocation.
      if (!handlers) return value;
      return (async () => {
        let current: unknown = value;
        for (const handler of handlers) {
          const next = await invoke(name, () => handler(current, info));
          if (next !== undefined) current = next;
        }
        return current as typeof value;
      })();
    },
  });

  return { hooks, describedHooks: sortedByKey(ownerTable) };
}

/**
 * Builds the frozen hook dispatcher for a list of handler sets. Validates hook
 * names and handler functions up front and snapshots handler lists.
 *
 * @internal
 */
export function buildHooks(
  sets: readonly HookHandlers[],
  report: (hook: string, error: unknown) => void,
): Hooks {
  return buildHookRegistry(
    sets.map((hooks, index) => ({ owner: `set-${index}`, hooks })),
    report,
  ).hooks;
}
