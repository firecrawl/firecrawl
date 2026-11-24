/*
 * Request-schema contribution mechanism.
 *
 * `Formats` and the `*Fields` interfaces are open so packages built on the
 * service can add request formats and fields by declaration merging while
 * contributing matching Zod schemas through `Extension.request`.
 *
 * This file imports only types so creating or describing a service never loads
 * request schemas, configuration, or clients.
 */
import type { z } from "zod";
import type {
  BatchScrapeRequest as BaseBatchScrapeRequest,
  CrawlRequest as BaseCrawlRequest,
  FormatObject,
  MapRequest as BaseMapRequest,
  ParseRequest as BaseParseRequest,
  ScrapeOptions as BaseScrapeOptions,
  ScrapeRequest as BaseScrapeRequest,
  SearchRequest as BaseSearchRequest,
} from "../controllers/v2/types";

type BuiltInFormat<K extends FormatObject["type"]> = Extract<
  FormatObject,
  { type: K }
>;

/**
 * Every scrape output format, keyed by its `type` discriminator. Packages
 * built on this service may add formats by declaration merging.
 */
export interface Formats {
  markdown: BuiltInFormat<"markdown">;
  html: BuiltInFormat<"html">;
  rawHtml: BuiltInFormat<"rawHtml">;
  rawBase64: BuiltInFormat<"rawBase64">;
  links: BuiltInFormat<"links">;
  images: BuiltInFormat<"images">;
  summary: BuiltInFormat<"summary">;
  json: BuiltInFormat<"json">;
  deterministicJson: BuiltInFormat<"deterministicJson">;
  changeTracking: BuiltInFormat<"changeTracking">;
  screenshot: BuiltInFormat<"screenshot">;
  attributes: BuiltInFormat<"attributes">;
  question: BuiltInFormat<"question">;
  highlights: BuiltInFormat<"highlights">;
  query: BuiltInFormat<"query">;
  branding: BuiltInFormat<"branding">;
  product: BuiltInFormat<"product">;
  menu: BuiltInFormat<"menu">;
  audio: BuiltInFormat<"audio">;
  video: BuiltInFormat<"video">;
}

export type FormatName = keyof Formats;
export type Format = Formats[FormatName];

/** Fields accepted wherever scrape options are accepted: scrape, batch scrape, parse, crawl, and search scrapeOptions. */
export interface ScrapeOptionsFields {}
/** Top-level fields added to the scrape request body. */
export interface ScrapeRequestFields {}
/** Top-level fields added to the parse request body. */
export interface ParseRequestFields {}
/** Top-level fields added to the crawl request body. */
export interface CrawlRequestFields {}
/** Top-level fields added to the batch scrape request body. */
export interface BatchScrapeRequestFields {}
/** Top-level fields added to the map request body. */
export interface MapRequestFields {}
/** Top-level fields added to the search request body. */
export interface SearchRequestFields {}

/** Zod schemas matching the declaration-merged field interface `F`. */
export type FieldSchemas<F> = {
  readonly [K in keyof F]?: z.ZodType<F[K]>;
};

/** Zod schemas matching the declaration-merged `Formats` interface. */
export type FormatSchemas = {
  readonly [K in keyof Formats]?: z.ZodType<Formats[K]>;
};

export type ScrapeOptions = Omit<BaseScrapeOptions, "formats"> & {
  formats: Format[];
} & ScrapeOptionsFields;

export type ScrapeRequest = Omit<BaseScrapeRequest, "formats"> & {
  formats: Format[];
} & ScrapeOptionsFields &
  ScrapeRequestFields;

export type ParseRequest = Omit<BaseParseRequest, "formats"> & {
  formats: Format[];
} & ScrapeOptionsFields &
  ParseRequestFields;

export type CrawlRequest = Omit<BaseCrawlRequest, "scrapeOptions"> & {
  scrapeOptions: ScrapeOptions;
} & CrawlRequestFields;

export type BatchScrapeRequest = Omit<BaseBatchScrapeRequest, "formats"> & {
  formats: Format[];
} & ScrapeOptionsFields &
  BatchScrapeRequestFields;

export type MapRequest = BaseMapRequest & MapRequestFields;

export type SearchRequest = Omit<BaseSearchRequest, "scrapeOptions"> & {
  scrapeOptions?: ScrapeOptions;
} & SearchRequestFields;

/** Request body shapes keyed by request kind. */
export interface RequestBodies {
  scrape: ScrapeRequest;
  parse: ParseRequest;
  crawl: CrawlRequest;
  batchScrape: BatchScrapeRequest;
  map: MapRequest;
  search: SearchRequest;
}

export type RequestKind = keyof RequestBodies;

/** Request kinds that expose a compiled request schema on `service.schemas`. */
export const requestKinds: readonly RequestKind[] = Object.freeze([
  "scrape",
  "parse",
  "crawl",
  "batchScrape",
  "map",
  "search",
]);

/** Field-contribution buckets accepted on `Extension.request`. */
export const requestFieldBuckets = Object.freeze([
  "scrapeOptions",
  "scrape",
  "parse",
  "crawl",
  "batchScrape",
  "map",
  "search",
] as const);

export type RequestFieldBucket = (typeof requestFieldBuckets)[number];

/** Outcome returned by a `ScrapeOptionsRule`. */
export type ScrapeOptionsRuleResult =
  | { error: string; path?: (string | number)[] }
  | { set: Partial<ScrapeOptions> }
  | void;

/**
 * Cross-field validation and implied-default rule evaluated over scrape options
 * in extension order after schema parsing and core defaults.
 */
export type ScrapeOptionsRule = (
  options: ScrapeOptions,
  request: { kind: RequestKind },
) => ScrapeOptionsRuleResult;

/** Request-schema contributions provided by an extension. */
export interface RequestContributions {
  readonly scrapeOptions?: FieldSchemas<ScrapeOptionsFields>;
  readonly scrape?: FieldSchemas<ScrapeRequestFields>;
  readonly parse?: FieldSchemas<ParseRequestFields>;
  readonly crawl?: FieldSchemas<CrawlRequestFields>;
  readonly batchScrape?: FieldSchemas<BatchScrapeRequestFields>;
  readonly map?: FieldSchemas<MapRequestFields>;
  readonly search?: FieldSchemas<SearchRequestFields>;
  readonly formats?: FormatSchemas;
  readonly rules?: readonly ScrapeOptionsRule[];
}

/** Compiled Zod schemas for each API request kind and standalone scrape options. */
export type RequestSchemas = {
  readonly [K in RequestKind]: z.ZodType<RequestBodies[K]>;
} & {
  readonly batchScrapeNoURLValidation: z.ZodType<BatchScrapeRequest>;
  readonly scrapeOptions: z.ZodType<ScrapeOptions>;
};

/** Request-schema contributions recorded in `ServiceDescription`, by owner. */
export interface DescribedRequestSchemas {
  scrapeOptions: Record<string, string>;
  scrape: Record<string, string>;
  parse: Record<string, string>;
  crawl: Record<string, string>;
  batchScrape: Record<string, string>;
  map: Record<string, string>;
  search: Record<string, string>;
  formats: Record<string, string>;
  rules: string[];
}

/** Validated, snapshotted request-schema contributions passed to a schema builder. */
export interface ResolvedRequestContributions {
  readonly scrapeOptions: Readonly<Record<string, z.ZodType>>;
  readonly scrape: Readonly<Record<string, z.ZodType>>;
  readonly parse: Readonly<Record<string, z.ZodType>>;
  readonly crawl: Readonly<Record<string, z.ZodType>>;
  readonly batchScrape: Readonly<Record<string, z.ZodType>>;
  readonly map: Readonly<Record<string, z.ZodType>>;
  readonly search: Readonly<Record<string, z.ZodType>>;
  readonly formats: Readonly<Record<string, z.ZodType>>;
  readonly rules: readonly ScrapeOptionsRule[];
}

/** Builds compiled `RequestSchemas` from validated extension contributions. */
export type RequestSchemaBuilder = (
  contributions: ResolvedRequestContributions,
) => RequestSchemas;

/**
 * Returns the first format entry matching `type` with its narrowed type, or
 * undefined when not requested.
 */
export function hasFormatOfType<K extends FormatName>(
  formats: readonly Format[] | undefined,
  type: K,
): Formats[K] | undefined {
  if (!formats) return undefined;
  return formats.find((format): format is Formats[K] => format.type === type);
}

/** @internal */
export interface RequestSchemaSource {
  owner: string;
  request?: RequestContributions;
}

const allowedRequestKeys = new Set<string>([
  ...requestFieldBuckets,
  "formats",
  "rules",
]);

const isForbiddenSchemaKey = (key: string): boolean =>
  key.trim().length === 0 || key === "prototype" || key in Object.prototype;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isZodSchema = (value: unknown): value is z.ZodType =>
  typeof value === "object" &&
  value !== null &&
  "_zod" in value &&
  typeof (value as { safeParse?: unknown }).safeParse === "function";

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

const freezeNullProto = <T>(
  record: Record<string, T>,
): Readonly<Record<string, T>> => {
  const out: Record<string, T> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    out[key] = value;
  }
  return Object.freeze(out);
};

let registeredRequestSchemaBuilder: RequestSchemaBuilder | undefined;

/**
 * Registers the built-in v2 request-schema builder when the v2 types module
 * loads so lazy `service.schemas` resolution avoids a runtime `require()`.
 *
 * @internal
 */
export function registerDefaultRequestSchemaBuilder(
  builder: RequestSchemaBuilder,
): void {
  registeredRequestSchemaBuilder = builder;
}

/**
 * Resolves the built-in v2 request-schema builder, preferring one already
 * registered by the loaded v2 types module and falling back to lazy `require()`
 * so callers that never imported v2 types still work without eager loading.
 *
 * @internal
 */
export const defaultBuildRequestSchemas: RequestSchemaBuilder =
  contributions => {
    if (registeredRequestSchemaBuilder) {
      return registeredRequestSchemaBuilder(contributions);
    }
    return (
      require("../controllers/v2/types") as typeof import("../controllers/v2/types")
    ).buildV2RequestSchemas(contributions);
  };

function collectSchemaMap(
  targetSchemas: Record<string, z.ZodType>,
  targetOwners: Record<string, string>,
  raw: unknown,
  bucket: string,
  owner: string,
): void {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    throw new Error(
      `Request "${bucket}" contributions from "${owner}" must be a plain object`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (isForbiddenSchemaKey(key)) {
      throw new Error(
        `Invalid request "${bucket}" key "${key}" from "${owner}"`,
      );
    }
    const schema = raw[key];
    if (schema === undefined) continue;
    if (!isZodSchema(schema)) {
      throw new Error(
        `Request schema "${bucket}.${key}" from "${owner}" must be a Zod schema`,
      );
    }
    if (key in targetOwners) {
      throw new Error(
        `Request "${bucket}.${key}" is already registered by "${targetOwners[key]}" and cannot also be registered by "${owner}"`,
      );
    }
    targetSchemas[key] = schema;
    targetOwners[key] = owner;
  }
}

/**
 * Validates and snapshots all extension request-schema contributions and
 * returns a frozen lazy `RequestSchemas` facade alongside its ownership summary.
 *
 * @internal
 */
export function buildRequestSchemaRegistry(
  sources: readonly RequestSchemaSource[],
  buildSchemas?: RequestSchemaBuilder,
): {
  schemas: RequestSchemas;
  describedRequest: DescribedRequestSchemas;
} {
  if (buildSchemas !== undefined && typeof buildSchemas !== "function") {
    throw new Error("Request schema builder must be a function");
  }

  const fieldSchemas: Record<RequestFieldBucket, Record<string, z.ZodType>> = {
    scrapeOptions: Object.create(null),
    scrape: Object.create(null),
    parse: Object.create(null),
    crawl: Object.create(null),
    batchScrape: Object.create(null),
    map: Object.create(null),
    search: Object.create(null),
  };
  const fieldOwners: Record<RequestFieldBucket, Record<string, string>> = {
    scrapeOptions: Object.create(null),
    scrape: Object.create(null),
    parse: Object.create(null),
    crawl: Object.create(null),
    batchScrape: Object.create(null),
    map: Object.create(null),
    search: Object.create(null),
  };
  const formatSchemas: Record<string, z.ZodType> = Object.create(null);
  const formatOwners: Record<string, string> = Object.create(null);
  const rules: ScrapeOptionsRule[] = [];
  const ruleOwners: string[] = [];

  for (const source of sources) {
    const request = source.request;
    if (request === undefined) continue;
    if (!isPlainObject(request)) {
      throw new Error(
        `Request contributions from "${source.owner}" must be a plain object`,
      );
    }

    for (const key of Object.keys(request)) {
      if (!allowedRequestKeys.has(key)) {
        throw new Error(
          `Unknown request contribution key "${key}" from "${source.owner}"`,
        );
      }
    }

    for (const bucket of requestFieldBuckets) {
      collectSchemaMap(
        fieldSchemas[bucket],
        fieldOwners[bucket],
        request[bucket],
        bucket,
        source.owner,
      );
    }

    collectSchemaMap(
      formatSchemas,
      formatOwners,
      request.formats,
      "formats",
      source.owner,
    );

    if (request.rules !== undefined) {
      if (!Array.isArray(request.rules)) {
        throw new Error(
          `Request "rules" from "${source.owner}" must be an array`,
        );
      }
      for (let i = 0; i < request.rules.length; i++) {
        if (!(i in request.rules) || typeof request.rules[i] !== "function") {
          throw new Error(
            `Request rule at index ${i} from "${source.owner}" must be a function`,
          );
        }
        rules.push(request.rules[i]);
        ruleOwners.push(source.owner);
      }
    }
  }

  for (const target of ["scrape", "parse", "batchScrape"] as const) {
    for (const key of Object.keys(fieldOwners[target])) {
      if (key in fieldOwners.scrapeOptions) {
        throw new Error(
          `Request field "${key}" is registered in both "scrapeOptions" (by "${fieldOwners.scrapeOptions[key]}") and "${target}" (by "${fieldOwners[target][key]}")`,
        );
      }
    }
  }

  const snapshot: ResolvedRequestContributions = Object.freeze({
    scrapeOptions: freezeNullProto(fieldSchemas.scrapeOptions),
    scrape: freezeNullProto(fieldSchemas.scrape),
    parse: freezeNullProto(fieldSchemas.parse),
    crawl: freezeNullProto(fieldSchemas.crawl),
    batchScrape: freezeNullProto(fieldSchemas.batchScrape),
    map: freezeNullProto(fieldSchemas.map),
    search: freezeNullProto(fieldSchemas.search),
    formats: freezeNullProto(formatSchemas),
    rules: Object.freeze([...rules]),
  });

  const schemaKeys = [
    ...requestKinds,
    "batchScrapeNoURLValidation",
    "scrapeOptions",
  ] as const;

  const builder = buildSchemas ?? defaultBuildRequestSchemas;
  let compiled: RequestSchemas | undefined;
  const resolveSchemas = (): RequestSchemas => {
    if (compiled) return compiled;
    const built = builder(snapshot);
    if (typeof built !== "object" || built === null) {
      throw new Error("Request schema builder must return a schemas object");
    }
    const validated: Record<string, z.ZodType> = Object.create(null);
    for (const key of schemaKeys) {
      const schema = built[key];
      if (!isZodSchema(schema)) {
        throw new Error(
          `Request schema builder returned an invalid "${key}" schema`,
        );
      }
      validated[key] = schema;
    }
    compiled = Object.freeze({
      scrape: validated.scrape,
      parse: validated.parse,
      crawl: validated.crawl,
      batchScrape: validated.batchScrape,
      batchScrapeNoURLValidation: validated.batchScrapeNoURLValidation,
      map: validated.map,
      search: validated.search,
      scrapeOptions: validated.scrapeOptions,
    }) as unknown as RequestSchemas;
    return compiled;
  };

  const schemas: RequestSchemas = Object.freeze({
    get scrape() {
      return resolveSchemas().scrape;
    },
    get parse() {
      return resolveSchemas().parse;
    },
    get crawl() {
      return resolveSchemas().crawl;
    },
    get batchScrape() {
      return resolveSchemas().batchScrape;
    },
    get batchScrapeNoURLValidation() {
      return resolveSchemas().batchScrapeNoURLValidation;
    },
    get map() {
      return resolveSchemas().map;
    },
    get search() {
      return resolveSchemas().search;
    },
    get scrapeOptions() {
      return resolveSchemas().scrapeOptions;
    },
  });

  const describedRequest: DescribedRequestSchemas = {
    scrapeOptions: sortedByKey(fieldOwners.scrapeOptions),
    scrape: sortedByKey(fieldOwners.scrape),
    parse: sortedByKey(fieldOwners.parse),
    crawl: sortedByKey(fieldOwners.crawl),
    batchScrape: sortedByKey(fieldOwners.batchScrape),
    map: sortedByKey(fieldOwners.map),
    search: sortedByKey(fieldOwners.search),
    formats: sortedByKey(formatOwners),
    rules: [...ruleOwners],
  };

  return { schemas, describedRequest };
}

/**
 * Validates a list of `RequestContributions` and returns the lazy frozen
 * `RequestSchemas` facade built from them.
 */
export function buildRequestSchemas(
  contributions: readonly RequestContributions[],
  buildSchemas?: RequestSchemaBuilder,
): RequestSchemas {
  return buildRequestSchemaRegistry(
    contributions.map((request, index) => ({
      owner: `contribution[${index}]`,
      request,
    })),
    buildSchemas,
  ).schemas;
}
