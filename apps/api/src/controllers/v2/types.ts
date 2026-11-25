export type AgentInteropStatus = "trusted" | "none" | "invalid";
import { Request, Response } from "express";
import { config } from "../../config";
import { z } from "zod";
import { protocolIncluded, checkUrl } from "../../lib/validateUrl";
import { hasReachableHost } from "../../lib/url-utils";
import { countries } from "../../lib/validate-country";
import { addPathRegexIssues, pathPatternsSchema } from "../../lib/crawl-regex";
import { addStrictSchemaIssue } from "../../lib/openai-strict-schema";
export { addStrictSchemaIssue };
import { ScrapeActionContent } from "../../lib/entities";
import type { TeamPlanClass } from "../../service/search-providers";
import type { RateLimiterMode } from "../../types";
import { ErrorCode } from "../../lib/error";
import { integrationSchema } from "../../utils/integration";
import { webhookSchema } from "../../services/webhook/schema";
import { installedService } from "../../service/service";
import {
  registerDefaultRequestSchemaBuilder,
  type RequestKind,
  type RequestSchemas,
  type ResolvedRequestContributions,
  type ScrapeOptions as ServiceScrapeOptions,
  type ScrapeOptionsRule,
} from "../../service/request";

// Base URL schema with common validation logic
export const URL = z
  .string()
  // .overwrite must stay after .string(). It interpolates x into a template, so
  // a non-string url would become the string "http://undefined" — a valid URL
  // whose only failure is the TLD check below, which would blame a field the
  // caller never sent. Letting .string() reject it first gives the real error.
  // .overwrite rather than .transform, so this stays a ZodString and .url() /
  // .regex() can still chain onto it.
  .overwrite(x => {
    if (!protocolIncluded(x as string)) {
      x = `http://${x}`;
    }

    // transforming the query parameters is breaking certain sites, so we're not doing it - mogery
    // try {
    //   const urlObj = new URL(x as string);
    //   if (urlObj.search) {
    //     const searchParams = new URLSearchParams(urlObj.search.substring(1));
    //     return `${urlObj.origin}${urlObj.pathname}?${searchParams.toString()}`;
    //   }
    // } catch (e) {
    // }

    return x;
  })
  .url()
  .regex(/^https?:\/\//i, "URL uses unsupported protocol")
  .refine(x => {
    if (config.TEST_SUITE_SELF_HOSTED && config.ALLOW_LOCAL_WEBHOOKS) {
      if (
        /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?([\/?#]|$)/i.test(
          x as string,
        )
      ) {
        return true;
      }
    }
    // Same TLD-shaped check as before, plus IP literals — which the old
    // inline regex accepted only when the last octet had 2+ digits, so
    // 8.8.8.8 was rejected while 169.254.169.254 passed.
    return hasReachableHost(x as string);
  }, "URL must have a valid top-level domain or be an IP address")
  .refine(x => {
    try {
      checkUrl(x as string);
      return true;
    } catch (_) {
      return false;
    }
  }, "Invalid URL");
// .refine((x) => !isUrlBlocked(x as string), UNSUPPORTED_SITE_MESSAGE)

const strictMessage =
  "Unrecognized key in body -- please review the v2 API documentation for request body changes";

// Helper function to add strict validation
// In zod v4, .strict() doesn't accept arguments
// The custom error message is handled in the error handler (see src/index.ts)
// We use a type assertion to preserve the input type so optional fields with defaults remain optional
// The 'as any' is necessary because zod v4's .strict() changes type inference in a way that makes
// optional fields with defaults appear required, even though they're not at runtime
function strictWithMessage<T extends z.ZodObject<any>>(schema: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return schema.strict() as any as T;
}

export function normalizeSchemaForOpenAI(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const visited = new WeakSet();

  function normalizeObject(obj: any): any {
    if (typeof obj !== "object" || obj === null) return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => normalizeObject(item));
    }

    if (visited.has(obj)) return obj;
    visited.add(obj);

    const normalized = { ...obj };

    // Handle $ref recursion - preserve as-is for OpenAI compatibility
    if (normalized.hasOwnProperty("$ref")) {
      return normalized;
    }

    if (normalized.hasOwnProperty("$defs")) {
      const { $defs, ...rest } = normalized;
      const processedRest = {};

      for (const [key, value] of Object.entries(rest)) {
        if (
          typeof value === "object" &&
          value !== null &&
          !value.hasOwnProperty("$ref")
        ) {
          processedRest[key] = normalizeObject(value);
        } else {
          processedRest[key] = value;
        }
      }

      const normalizedDefs = Object.fromEntries(
        Object.entries($defs ?? {}).map(([key, value]) => [
          key,
          normalizeObject(value),
        ]),
      );

      return { ...processedRest, $defs: normalizedDefs };
    }

    if (
      normalized.type === "object" &&
      normalized.hasOwnProperty("properties") &&
      normalized.hasOwnProperty("additionalProperties")
    ) {
      delete normalized.additionalProperties;
    }

    if (
      normalized.type === "object" &&
      normalized.hasOwnProperty("required") &&
      normalized.hasOwnProperty("properties")
    ) {
      if (
        Array.isArray(normalized.required) &&
        typeof normalized.properties === "object" &&
        normalized.properties !== null
      ) {
        const validRequired = normalized.required.filter((field: string) =>
          normalized.properties.hasOwnProperty(field),
        );
        if (validRequired.length > 0) {
          normalized.required = validRequired;
        } else {
          delete normalized.required;
        }
      } else {
        delete normalized.required;
      }
    }

    for (const [key, value] of Object.entries(normalized)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !value.hasOwnProperty("$ref")
      ) {
        normalized[key] = normalizeObject(value);
      }
    }

    return normalized;
  }

  return normalizeObject(schema);
}

export function validateSchemaForOpenAI(schema: any): boolean {
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const visited = new WeakSet();

  function hasInvalidStructure(obj: any): boolean {
    if (typeof obj !== "object" || obj === null) return false;

    if (visited.has(obj)) return false;
    visited.add(obj);

    if (obj.hasOwnProperty("$ref")) {
      return false;
    }

    if (
      obj.type === "object" &&
      !obj.hasOwnProperty("properties") &&
      !obj.hasOwnProperty("patternProperties") &&
      obj.additionalProperties === true
    ) {
      return true;
    }

    for (const value of Object.values(obj)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !value.hasOwnProperty("$ref")
      ) {
        if (hasInvalidStructure(value)) return true;
      }
    }
    return false;
  }

  return !hasInvalidStructure(schema);
}

export const OPENAI_SCHEMA_ERROR_MESSAGE =
  "Schema contains invalid structure for OpenAI: object type with no 'properties' defined but 'additionalProperties: true' (schema-less dictionary not supported by OpenAI). Please define specific properties for your object. Note: Recursive schemas using '$ref' are supported.";

const ACTIONS_MAX_WAIT_TIME = 60;
const MAX_ACTIONS = 50;
function calculateTotalWaitTime(
  actions: any[] = [],
  waitFor: number = 0,
): number {
  const actionWaitTime = actions.reduce((acc, action) => {
    if (action.type === "wait") {
      if (action.milliseconds) {
        return acc + action.milliseconds;
      }
      // Consider selector actions as 1 second
      if (action.selector) {
        return acc + 1000;
      }
    }
    return acc;
  }, 0);

  return waitFor + actionWaitTime;
}

const actionSchema = z.union([
  z
    .object({
      type: z.literal("wait"),
      milliseconds: z.int().positive().finite().optional(),
      selector: z.string().optional(),
    })
    .refine(
      data =>
        (data.milliseconds !== undefined || data.selector !== undefined) &&
        !(data.milliseconds !== undefined && data.selector !== undefined),
      {
        error:
          "Either 'milliseconds' or 'selector' must be provided, but not both.",
      },
    ),
  z.object({
    type: z.literal("click"),
    selector: z.string(),
    all: z.boolean().prefault(false),
  }),
  z.object({
    type: z.literal("screenshot"),
    fullPage: z.boolean().prefault(false),
    quality: z.number().min(1).max(100).optional(),
    viewport: z
      .object({
        width: z.int().positive().finite().max(7680), // 8K resolution width
        height: z.int().positive().finite().max(4320), // 8K resolution height
      })
      .optional(),
  }),
  z.object({
    type: z.literal("write"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("press"),
    key: z.string(),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]).prefault("down"),
    selector: z.string().optional(),
  }),
  z.object({
    type: z.literal("scrape"),
  }),
  z.object({
    type: z.literal("executeJavascript"),
    script: z.string(),
  }),
  z.object({
    type: z.literal("pdf"),
    landscape: z.boolean().prefault(false),
    scale: z.number().prefault(1),
    format: z
      .enum([
        "A0",
        "A1",
        "A2",
        "A3",
        "A4",
        "A5",
        "A6",
        "Letter",
        "Legal",
        "Tabloid",
        "Ledger",
      ])
      .prefault("Letter"),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

export type InternalAction = Action & {
  metadata?: {
    [key: string]: unknown;
  };
  /** fire-engine, executeJavascript only. */
  realViewport?: boolean;
};

const actionsSchema = z
  .array(actionSchema)
  .refine(actions => actions.length <= MAX_ACTIONS, {
    message: `Number of actions cannot exceed ${MAX_ACTIONS}`,
  })
  .refine(
    actions => calculateTotalWaitTime(actions) <= ACTIONS_MAX_WAIT_TIME * 1000,
    {
      message: `Total wait time (waitFor + wait actions) cannot exceed ${ACTIONS_MAX_WAIT_TIME} seconds`,
    },
  );

const jsonFormatWithOptions = z.strictObject({
  type: z.literal("json"),
  schema: z
    .any()
    .optional()
    .transform(val => normalizeSchemaForOpenAI(val))
    .refine(val => validateSchemaForOpenAI(val), {
      message: OPENAI_SCHEMA_ERROR_MESSAGE,
    })
    .superRefine(addStrictSchemaIssue),
  prompt: z.string().max(10000).optional(),
  // Deprecated: lifted into the top-level checkPromptInjection at parse time.
  checkPromptInjection: z.boolean().optional(),
});

export type JsonFormatWithOptions = Omit<
  z.output<typeof jsonFormatWithOptions>,
  "checkPromptInjection"
>;

const screenshotFormatWithOptions = z.object({
  type: z.literal("screenshot"),
  fullPage: z.boolean().prefault(false),
  quality: z.number().min(1).max(100).optional(),
  viewport: z
    .object({
      width: z.int().positive().finite().max(7680), // 8K resolution width
      height: z.int().positive().finite().max(4320), // 8K resolution height
    })
    .optional(),
});

type ScreenshotFormatWithOptions = z.output<typeof screenshotFormatWithOptions>;

const attributesFormatWithOptions = z.strictObject({
  type: z.literal("attributes"),
  selectors: z
    .array(
      z.strictObject({
        selector: z.string().describe("CSS selector to find elements"),
        attribute: z
          .string()
          .describe(
            "Attribute name to extract (e.g., 'data-vehicle-name' or 'id')",
          ),
      }),
    )
    .describe("Extract specific attributes from elements"),
});

type AttributesFormatWithOptions = z.output<typeof attributesFormatWithOptions>;

const questionFormatWithOptions = z.strictObject({
  type: z.literal("question"),
  question: z.string().min(1).max(10000),
});

type QuestionFormatWithOptions = z.output<typeof questionFormatWithOptions>;

/** @deprecated Use `question` format instead. */
const queryFormatWithOptions = z.strictObject({
  type: z.literal("query"),
  prompt: z.string().max(10000),
  mode: z.enum(["freeform", "directQuote"]).optional().default("freeform"),
});

type QueryFormatWithOptions = z.output<typeof queryFormatWithOptions>;

export type FormatObject =
  | { type: "markdown" }
  | { type: "html" }
  | { type: "rawHtml" }
  | { type: "rawBase64" }
  | { type: "links" }
  | { type: "images" }
  | { type: "summary" }
  | JsonFormatWithOptions
  | ScreenshotFormatWithOptions
  | AttributesFormatWithOptions
  | QuestionFormatWithOptions
  | QueryFormatWithOptions;

const pdfModeSchema = z.enum(["fast", "auto"]);

export type PDFMode = z.infer<typeof pdfModeSchema>;

const pdfParserWithOptions = z.strictObject({
  type: z.literal("pdf"),
  mode: pdfModeSchema.optional(),
  maxPages: z.int().positive().finite().max(10000).optional(),
});

const parsersSchema = z
  .array(z.union([z.literal("pdf"), pdfParserWithOptions]))
  .prefault(["pdf"]);

type Parsers = z.infer<typeof parsersSchema>;

export function shouldParsePDF(parsers?: readonly unknown[]): boolean {
  if (!parsers) return true;
  return parsers.some(parser => {
    if (parser === "pdf") return true;
    if (typeof parser === "object" && parser !== null && "type" in parser) {
      return (parser as { type?: unknown }).type === "pdf";
    }
    return false;
  });
}

export function getPDFMaxPages(
  parsers?: readonly unknown[],
): number | undefined {
  if (!parsers) return undefined;
  const pdfParser = parsers.find(parser => {
    if (typeof parser === "object" && parser !== null && "type" in parser) {
      return (parser as { type?: unknown }).type === "pdf";
    }
    return false;
  });
  if (pdfParser && typeof pdfParser === "object" && "maxPages" in pdfParser) {
    return (pdfParser as { maxPages?: number }).maxPages;
  }
  return undefined;
}

export function getPDFMode(parsers?: readonly unknown[]): PDFMode {
  if (!parsers) return "auto";
  for (const parser of parsers) {
    if (parser === "pdf") return "auto";
    if (
      typeof parser === "object" &&
      parser !== null &&
      (parser as { type?: unknown }).type === "pdf"
    ) {
      return ((parser as { mode?: PDFMode }).mode ?? "auto") as PDFMode;
    }
  }
  return "auto";
}

function transformIframeSelector(selector: string): string {
  return selector.replace(/(?:^|[\s,])iframe(?=\s|$|[.#\[:,])/g, match => {
    const prefix = match.match(/^[\s,]/)?.[0] || "";
    return prefix + 'div[data-original-tag="iframe"]';
  });
}

const SPECIAL_COUNTRIES = ["us-generic", "us-whitelist"];

const locationSchema = z
  .object({
    country: z
      .string()
      .optional()
      .refine(
        val =>
          !val ||
          Object.keys(countries).includes(val.toUpperCase()) ||
          SPECIAL_COUNTRIES.includes(val.toLowerCase()),
        "Invalid country code. Use a valid ISO 3166-1 alpha-2 country code.",
      )
      .transform(val => {
        if (!val) return "us-generic";
        return val.toLowerCase();
      }),
    languages: z.array(z.string()).optional(),
  })
  .optional();

export const countryLocationSchema = z.strictObject({
  country: z
    .string()
    .refine(
      value => Object.keys(countries).includes(value.toUpperCase()),
      "Invalid country code. Use a valid ISO 3166-1 alpha-2 country code.",
    )
    .transform(value => value.toLowerCase()),
});

const scrapeOptionFields = z.strictObject({
  formats: z
    .preprocess(
      val => {
        if (!Array.isArray(val)) return val;
        return val.map(format => {
          if (typeof format === "string") {
            return { type: format };
          }
          return format;
        });
      },
      z
        .union([
          z.strictObject({ type: z.literal("markdown") }),
          z.strictObject({ type: z.literal("html") }),
          z.strictObject({ type: z.literal("rawHtml") }),
          z.strictObject({ type: z.literal("rawBase64") }),
          z.strictObject({ type: z.literal("links") }),
          z.strictObject({ type: z.literal("images") }),
          z.strictObject({ type: z.literal("summary") }),
          jsonFormatWithOptions,
          screenshotFormatWithOptions,
          attributesFormatWithOptions,
          questionFormatWithOptions,
          queryFormatWithOptions,
        ])
        .array()
        .prefault([{ type: "markdown" }]),
    )
    .refine(x => {
      return x.filter(f => f.type === "screenshot").length <= 1;
    }, "You may only specify one screenshot format")
    .refine(
      x => !x.some(f => f.type === "rawBase64") || x.length === 1,
      "The rawBase64 format cannot be combined with other formats",
    ),
  headers: z.record(z.string(), z.string()).optional(),
  includeTags: z
    .string()
    .array()
    .transform(tags => tags.map(transformIframeSelector))
    .optional(),
  excludeTags: z
    .string()
    .array()
    .transform(tags => tags.map(transformIframeSelector))
    .optional(),
  onlyMainContent: z.boolean().prefault(true),
  onlyCleanContent: z.boolean().prefault(false),
  timeout: z.int().positive().min(1000).optional(),
  waitFor: z.int().nonnegative().max(60000).prefault(0),
  mobile: z.boolean().prefault(false),
  parsers: parsersSchema.optional(),
  actions: actionsSchema.optional(),

  location: locationSchema,

  skipTlsVerification: z.boolean().optional(),
  removeBase64Images: z.boolean().prefault(true),
  fastMode: z.boolean().prefault(false),
  useMock: z.string().optional(),
  blockAds: z.boolean().prefault(true),
  proxy: z.enum(["basic", "auto"]).prefault("auto"),
  checkPromptInjection: z.boolean().prefault(false),
});

export const baseScrapeOptions = scrapeOptionFields.refine(
  options =>
    !(
      options.checkPromptInjection &&
      options.formats.some(f => f.type === "rawBase64")
    ),
  {
    message:
      "checkPromptInjection scans page markdown and cannot be used with the rawBase64 format.",
    path: ["checkPromptInjection"],
  },
);

type ScrapeOptionsBase = z.infer<typeof baseScrapeOptions>;

export const waitForRefine = (obj?: ScrapeOptionsBase): boolean => {
  if (obj && obj.waitFor && obj.timeout) {
    if (typeof obj.timeout !== "number" || obj.timeout <= 0) {
      return false;
    }
    return obj.waitFor <= obj.timeout / 2;
  }
  return true;
};
export const waitForRefineOpts = {
  message: "waitFor must not exceed half of timeout",
  path: ["waitFor"],
};

export const applyScrapeOptionsDefaults = <T extends ScrapeOptionsBase>(
  obj: T,
): T & { skipTlsVerification: boolean } => ({
  ...obj,
  skipTlsVerification: obj.skipTlsVerification ?? false,
});

/**
 * Folds the deprecated json-format checkPromptInjection into the top-level
 * flag and drops it from the format. Also accepts raw stored monitor options.
 */
export function liftCheckPromptInjection<
  T extends { formats?: unknown[]; checkPromptInjection?: unknown },
>(options: T): T {
  let requestedOnFormat = false;
  const formats = options.formats?.map(format => {
    if (
      typeof format !== "object" ||
      format === null ||
      !("checkPromptInjection" in format)
    ) {
      return format;
    }
    const { checkPromptInjection, ...rest } = format;
    requestedOnFormat ||= checkPromptInjection === true;
    return rest;
  });
  return {
    ...options,
    formats,
    checkPromptInjection:
      options.checkPromptInjection === true || requestedOnFormat,
  };
}

// Base transform function that handles both nullable and non-nullable cases
// Uses generic type to preserve all fields from extended schemas
const extractTransformImpl = <T extends ScrapeOptionsBase | undefined>(
  obj: T,
): T extends undefined ? undefined : T => {
  if (!obj) return obj as T extends undefined ? undefined : T;
  // Handle timeout
  let result = liftCheckPromptInjection(applyScrapeOptionsDefaults(obj));
  if (
    obj.formats.find(x => typeof x === "object" && x.type === "json") &&
    obj.timeout === 30000
  ) {
    result = { ...result, timeout: 60000 };
  }

  if (obj.proxy === "auto" && obj.timeout === 30000) {
    result = { ...result, timeout: 120000 };
  }

  return result as T extends undefined ? undefined : T;
};

// Type-safe wrapper for nullable cases (used in optional scrapeOptions)
export const extractTransform = (
  obj?: ScrapeOptionsBase,
): ScrapeOptionsBase | undefined => {
  return extractTransformImpl(obj);
};

// Type-safe wrapper for non-nullable cases (used in required scrapeOptions schema)
// This ensures TypeScript knows the output is always ScrapeOptionsBase, not undefined
const extractTransformRequired = <T extends ScrapeOptionsBase>(obj: T): T => {
  return extractTransformImpl(obj)! as T;
};

export const scrapeOptions = strictWithMessage(baseScrapeOptions)
  .refine(
    obj => {
      if (!obj.actions) return true;
      return (
        calculateTotalWaitTime(obj.actions, obj.waitFor) <=
        ACTIONS_MAX_WAIT_TIME * 1000
      );
    },
    {
      message: `Total wait time (waitFor + wait actions) cannot exceed ${ACTIONS_MAX_WAIT_TIME} seconds`,
    },
  )
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransformRequired);

export type BaseScrapeOptions = z.infer<typeof baseScrapeOptions>;

export type ScrapeOptions = BaseScrapeOptions;

export type UploadedParseFileKind = "html" | "pdf" | "document" | "image";

export type UploadedParseFile = {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  kind?: UploadedParseFileKind;
};

const scrapeRequestSchemaBase = baseScrapeOptions.safeExtend({
  url: URL,
  origin: z.string().prefault("api"),
  integration: integrationSchema.optional().transform(val => val || null),
  zeroDataRetention: z.boolean().optional(),
});

export const scrapeRequestSchema = strictWithMessage(scrapeRequestSchemaBase)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransformRequired);

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;
// Use z.input on the base schema before strict() to preserve optional fields with defaults
// This is needed because zod v4's .strict() changes type inference for optional fields
// We explicitly make formats optional since it has .prefault() which should make it optional
export type ScrapeRequestInput = Omit<
  z.input<typeof baseScrapeOptions>,
  "formats"
> & {
  formats?: z.input<typeof baseScrapeOptions>["formats"];
} & {
  url: z.input<typeof URL>;
  origin?: string;
  integration?: z.input<typeof integrationSchema> | null;
  zeroDataRetention?: boolean;
};

const uploadedParseFileSchema = z.custom<UploadedParseFile>(
  value =>
    typeof value === "object" &&
    value !== null &&
    "buffer" in value &&
    Buffer.isBuffer((value as any).buffer) &&
    "filename" in value &&
    typeof (value as any).filename === "string" &&
    (value as any).filename.trim().length > 0 &&
    (!("contentType" in value) ||
      (value as any).contentType === undefined ||
      typeof (value as any).contentType === "string") &&
    (!("kind" in value) ||
      (value as any).kind === undefined ||
      (value as any).kind === "html" ||
      (value as any).kind === "pdf" ||
      (value as any).kind === "document" ||
      (value as any).kind === "image"),
  {
    error: "A file upload is required.",
  },
);

const parseRequestSchemaBase = baseScrapeOptions.safeExtend({
  origin: z.string().prefault("api"),
  integration: integrationSchema.optional().transform(val => val || null),
  zeroDataRetention: z.boolean().optional(),
  file: uploadedParseFileSchema,
});

export const parseRequestSchema = strictWithMessage(parseRequestSchemaBase)
  .refine(
    x => !x.formats.some(format => format.type === "rawBase64"),
    "The rawBase64 format is not supported for parse uploads",
  )
  .refine(waitForRefine, waitForRefineOpts)
  .transform(x => {
    const { file, ...scrapeLike } = x;
    return {
      ...extractTransformRequired(scrapeLike),
      file,
    };
  });

export type ParseRequest = z.infer<typeof parseRequestSchema>;
export type ParseRequestInput = z.input<typeof parseRequestSchemaBase>;

const batchScrapeRequestSchemaBase = baseScrapeOptions.safeExtend({
  urls: URL.array().min(1),
  origin: z.string().prefault("api"),
  integration: integrationSchema.optional().transform(val => val || null),
  webhook: webhookSchema.optional(),
  appendToId: z.uuid().optional(),
  ignoreInvalidURLs: z.boolean().prefault(true),
  maxConcurrency: z.int().positive().optional(),
  zeroDataRetention: z.boolean().optional(),
});

export const batchScrapeRequestSchema = strictWithMessage(
  batchScrapeRequestSchemaBase,
)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransformRequired);

const batchScrapeRequestSchemaNoURLValidationBase =
  baseScrapeOptions.safeExtend({
    urls: z.string().array().min(1),
    origin: z.string().prefault("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    webhook: webhookSchema.optional(),
    appendToId: z.uuid().optional(),
    ignoreInvalidURLs: z.boolean().prefault(true),
    maxConcurrency: z.int().positive().optional(),
    zeroDataRetention: z.boolean().optional(),
  });

export const batchScrapeRequestSchemaNoURLValidation = strictWithMessage(
  batchScrapeRequestSchemaNoURLValidationBase,
)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransformRequired);

export type BatchScrapeRequest = z.infer<typeof batchScrapeRequestSchema>;
// Use z.input on the base schema before strict() to preserve optional fields with defaults
// We explicitly make formats optional since it has .prefault() which should make it optional
export type BatchScrapeRequestInput = Omit<
  z.input<typeof baseScrapeOptions>,
  "formats"
> & {
  formats?: z.input<typeof baseScrapeOptions>["formats"];
} & {
  urls: z.input<typeof URL>[];
  origin?: string;
  integration?: z.input<typeof integrationSchema> | null;
  webhook?: z.input<typeof webhookSchema>;
  appendToId?: string;
  ignoreInvalidURLs?: boolean;
  maxConcurrency?: number;
  zeroDataRetention?: boolean;
};

export const crawlerOptions = z.strictObject({
  includePaths: pathPatternsSchema.prefault([]),
  excludePaths: pathPatternsSchema.prefault([]),
  maxDiscoveryDepth: z.number().optional(),
  limit: z.number().prefault(10000), // default?
  crawlEntireDomain: z.boolean().optional(),
  allowExternalLinks: z.boolean().prefault(false),
  allowSubdomains: z.boolean().prefault(false),
  ignoreRobotsTxt: z.boolean().prefault(false),
  robotsUserAgent: z.string().optional(),
  sitemap: z.enum(["skip", "include", "only"]).prefault("include"),
  deduplicateSimilarURLs: z.boolean().prefault(true),
  ignoreQueryParameters: z.boolean().prefault(false),
  regexOnFullURL: z.boolean().prefault(false),
  delay: z
    .number()
    .positive()
    .max(
      60,
      "The delay parameter is measured in seconds and cannot exceed 60 seconds.",
    )
    .optional(),
});

// export type CrawlerOptions = {
//   includePaths?: string[];
//   excludePaths?: string[];
//   maxDepth?: number;
//   limit?: number;
//   crawlEntireDomain?: boolean;
//   allowExternalLinks?: boolean;
//   ignoreSitemap?: boolean;
// };

export type CrawlerOptions = z.infer<typeof crawlerOptions>;

const crawlRequestSchemaBase = crawlerOptions.extend({
  url: URL,
  origin: z.string().prefault("api"),
  integration: integrationSchema.optional().transform(val => val || null),
  scrapeOptions: baseScrapeOptions.prefault(() => baseScrapeOptions.parse({})),
  webhook: webhookSchema.optional(),
  limit: z.number().prefault(10000),
  maxConcurrency: z.int().positive().optional(),
  zeroDataRetention: z.boolean().optional(),
  prompt: z.string().max(10000).optional(),
});

export const crawlRequestSchema = strictWithMessage(crawlRequestSchemaBase)
  .superRefine((x, ctx) => {
    addPathRegexIssues(x, ctx);
  })
  .refine(x => waitForRefine(x.scrapeOptions), waitForRefineOpts)
  .transform(x => {
    const scrapeOptionsValue = x.scrapeOptions ?? baseScrapeOptions.parse({});
    return {
      ...x,
      url: x.url,
      scrapeOptions: extractTransformRequired(scrapeOptionsValue),
    };
  });

// export type CrawlRequest = {
//   url: string;
//   crawlerOptions?: CrawlerOptions;
//   scrapeOptions?: Exclude<ScrapeRequest, "url">;
// };

// export type ExtractorOptions = {
//   mode: "markdown" | "llm-extraction" | "llm-extraction-from-markdown" | "llm-extraction-from-raw-html";
//   extractionPrompt?: string;
//   extractionSchema?: Record<string, any>;
// }

export type CrawlRequest = z.infer<typeof crawlRequestSchema>;
export type CrawlRequestInput = z.input<typeof crawlRequestSchema>;

export const MAX_MAP_LIMIT = 100000;

const mapRequestSchemaBase = crawlerOptions
  .omit({ sitemap: true, ignoreQueryParameters: true })
  .extend({
    url: URL,
    origin: z.string().prefault("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    includeSubdomains: z.boolean().prefault(true),
    ignoreQueryParameters: z.boolean().prefault(true),
    search: z.string().optional(),
    sitemap: z.enum(["only", "include", "skip"]).prefault("include"),
    limit: z.number().min(1).max(MAX_MAP_LIMIT).prefault(5000),
    timeout: z.number().positive().finite().optional(),
    useMock: z.string().optional(),
    filterByPath: z.boolean().prefault(true),
    location: locationSchema,
    headers: z.record(z.string(), z.string()).optional(),
  });

export const mapRequestSchema = strictWithMessage(
  mapRequestSchemaBase,
).superRefine((x, ctx) => {
  addPathRegexIssues(x, ctx);
});

// export type MapRequest = {
//   url: string;
//   crawlerOptions?: CrawlerOptions;
// };

export type MapRequest = z.infer<typeof mapRequestSchema>;
export type MapRequestInput = z.input<typeof mapRequestSchema>;

export interface DocumentMetadata {
  title?: string;
  description?: string;
  language?: string;
  keywords?: string;
  robots?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
  ogImage?: string;
  ogAudio?: string;
  ogDeterminer?: string;
  ogLocale?: string;
  ogLocaleAlternate?: string[];
  ogSiteName?: string;
  ogVideo?: string;
  favicon?: string;
  dcTermsCreated?: string;
  dcDateCreated?: string;
  dcDate?: string;
  dcTermsType?: string;
  dcType?: string;
  dcTermsAudience?: string;
  dcTermsSubject?: string;
  dcSubject?: string;
  dcDescription?: string;
  dcTermsKeywords?: string;
  modifiedTime?: string;
  publishedTime?: string;
  articleTag?: string;
  articleSection?: string;
  url?: string;
  sourceURL?: string;
  statusCode: number;
  scrapeId?: string;
  error?: string;
  numPages?: number;
  totalPages?: number;
  contentType?: string;
  timezone?: string;
  proxyUsed: "basic" | "stealth";
  cacheState?: "hit" | "miss";
  cachedAt?: string;
  creditsUsed?: number;
  postprocessorsUsed?: string[];
  indexId?: string; // ID used to store the document in the index (GCS)
  concurrencyLimited?: boolean;
  concurrencyQueueDurationMs?: number;
}

export interface Document {
  title?: string;
  description?: string;
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  rawBase64?: string;
  links?: string[];
  images?: string[];
  screenshot?: string;
  extract?: any;
  json?: any;
  summary?: string;
  answer?: string;
  warning?: string;
  attributes?: {
    selector: string;
    attribute: string;
    values: string[];
  }[];
  actions?: {
    screenshots?: string[];
    scrapes?: ScrapeActionContent[];
    javascriptReturns?: {
      type: string;
      value: unknown;
    }[];
    pdfs?: string[];
  };
  metadata: DocumentMetadata;
  serpResults?: {
    title: string;
    description: string;
    url: string;
  };
}

export type ErrorResponse = {
  success: false;
  code?: ErrorCode;
  error: string;
  details?: any;
  sponsor_status?: string;
  login_url?: string;
  replacement?: string;
  documentation_url?: string;
  retry_after_seconds?: number;
  /** The job the failed request created, when it got far enough to have one. */
  jobId?: string;
};

export type ScrapeResponse =
  | ErrorResponse
  | {
      success: true;
      warning?: string;
      data: Document & {
        tools?: unknown[];
      };
      scrape_id?: string;
    };

export type CrawlResponse =
  | ErrorResponse
  | {
      success: true;
      id: string;
      url: string;
    };

export type BatchScrapeResponse =
  | ErrorResponse
  | {
      success: true;
      id: string;
      url: string;
      invalidURLs?: string[];
    };

// Map document interface (transitioned from v1)
export interface MapDocument {
  url: string;
  title?: string;
  description?: string;
}

// V2 Map Response with dictionary format
export type MapResponse =
  | (ErrorResponse & { id?: string })
  | {
      success: true;
      id: string;
      links?: MapDocument[];
      warning?: string;
    };

export type CrawlStatusParams = {
  jobId: string;
};

export type ConcurrencyCheckParams = {
  teamId: string;
};

export type ConcurrencyCheckResponse =
  | ErrorResponse
  | {
      success: true;
      concurrency: number;
      maxConcurrency: number | null;
    };

export type CrawlStatusResponse =
  | ErrorResponse
  | {
      success: true;
      status: "scraping" | "completed" | "failed" | "cancelled";
      completed: number;
      total: number;
      creditsUsed: number;
      expiresAt: string;
      createdAt?: string;
      completedAt?: string;
      duration?: number;
      next?: string;
      data: Document[];
      warning?: string;
    }
  | {
      success: false;
      status: "failed";
      error: string;
      completed: number;
      total: number;
      creditsUsed: number;
      expiresAt: string;
      createdAt?: string;
      completedAt?: string;
      duration?: number;
      data: Document[];
    };

export type OngoingCrawlsResponse =
  | ErrorResponse
  | {
      success: true;
      crawls: {
        id: string;
        teamId: string;
        url: string;
        created_at: string;
        options: CrawlerOptions;
      }[];
    };

export type CrawlErrorsResponse =
  | ErrorResponse
  | {
      errors: {
        id: string;
        timestamp?: string;
        url: string;
        code?: ErrorCode;
        error: string;
        requiresAction?: {
          type: string;
          terms?: string;
          version?: string;
          url?: string;
          [key: string]: unknown;
        };
      }[];
      robotsBlocked: string[];
    };

type AuthObject = {
  team_id: string;
  org_id?: string | null;
  // Set only by authMiddleware from the raw request; controllers may re-parse
  // the body and drop `__agentInterop`, so read this instead.
  agentInterop?: AgentInteropStatus;
  // Set only by authMiddleware, from the hosted MCP verification in
  // supaAuthenticateUser, or from a trusted agent interop block for an agent
  // run that verification started; never from an untrusted body or header.
  hostedMcp?: boolean;
};

type Account = {
  remainingCredits: number;
};

export type AuthCreditUsageChunk = {
  api_key: string;
  api_key_id: number;
  api_key_id_text?: string;
  team_id: string;
  org_id: string;
  flags: TeamFlags;

  // teams.banned surfaced from auth_chunk_2: banned teams are rejected (403)
  // in supaAuthenticateUser. Optional because pre-rollout cached ACUC entries
  // and the bypass/preview mocks omit it (treated as not banned).
  is_banned?: boolean;

  // appended on JS-side
  is_extract?: boolean;

  // The team's effective Autumn limits and plan, always set by
  // getACUC/getACUCTeam.
  concurrency_limit: number;
  rate_limit_multiplier: number;
  is_paid_plan: boolean;
  // The team's plan class before team flags are applied (see teamPlanClass):
  // what planClassOf made of the org's billing record, or the keyless class
  // on the chunk keyless auth builds.
  plan_class?: TeamPlanClass;

  // Agent signup: populated when the key is agent-provisioned
  _agentSponsor?: {
    status: "pending" | "verified" | "blocked";
    verification_deadline: string;
    email: string;
  } | null;
};

export type TeamFlags = {
  exchangeRetrieve?: boolean;
  alexandriaAutoTools?: boolean;
  alexandriaToolFusion?: boolean;
  // Search skips highlights entirely, including their index lookups.
  skipSearchHighlights?: boolean;
  ignoreRobots?: "disabled" | "allowed" | "forced";
  customRobotsAgent?: "disabled" | "allowed";
  threatProtection?: "disabled" | "allowed" | "forced";
  safeMode?: boolean;
  safeModeConfig?: {
    allowBypassSafeMode?: boolean;
    lockdown?: boolean;
    domainControls?: boolean;
    enforceRobots?: boolean;
    disableStealthProxy?: boolean;
    disableAuthentication?: boolean;
    disableSiteHandling?: boolean;
    exposeWebdriver?: boolean;
    useHeadlessUserAgent?: boolean;
    disablePlatformSelection?: boolean;
    disableCountrySelection?: boolean;
    disableAutomaticReferrer?: boolean;
    respectPaywalls?: boolean;
    allowlist?: string[];
  };
  siemLogging?: boolean;
  unblockedDomains?: string[];
  forceZDR?: boolean;
  allowZDR?: boolean;
  scrapeZDR?: "disabled" | "allowed" | "forced";
  // Zero data retention for Alexandria provider tools and the Exchange proxy.
  // Forced scrape ZDR implies it. Exchange is told per call by header.
  alexandriaZDR?: "disabled" | "allowed" | "forced";
  searchZDR?: "disabled" | "allowed" | "forced" | "forced-zdr" | "forced-anon";
  zdrCost?: number;
  /** How long an agent run's ZDR result is kept, in minutes. Unset is the default (24 hours). */
  agentZdrRetentionMinutes?: number;
  checkRobotsOnScrape?: boolean;
  crawlTtlHours?: number;
  ipWhitelist?: boolean;
  // gates the per-team API key IP allowlist (ip_restriction_config table)
  ipRestriction?: boolean;
  // gates the per-key scope/format lockdown (key_restriction_config table)
  keyRestriction?: boolean;
  skipCountryCheck?: boolean;
  browserBeta?: boolean;
  bypassCreditChecks?: boolean;
  debugBranding?: boolean;
  maxBrowserSessions?: number;
  // grants the privileged large-PDF size cap
  largePdfs?: boolean;
  // POST /v2/search/:jobId/feedback returns 403 TEAM_OPTED_OUT when true.
  searchFeedbackOptOut?: boolean;
  researchBeta?: boolean;
  menuBeta?: boolean;
  enrichBeta?: boolean;
  labsSearch?: boolean;
  freshFeed?: boolean;
  freshFeedCreditsPerRecord?: number;
  freshFeedUpstream?: string;
  freshFeedCollection?: string;
  freshFeedFilters?: Record<string, string | undefined>;
  professionalProfileCompanyDataBeta?: boolean;
  // The org's DPA (or partner amendment) restricts how its data may be
  // handled. Informational only: the API does not change behavior on it.
  dpaRestricted?: boolean;
  // The org's contract bars training on its data: FirePDF never captures its
  // documents (buildFirePdfTrainingCapture).
  trainingRestricted?: boolean;
  // Every request is processed by US-based vendors only. A route with no US
  // vendor is refused or skipped with a warning.
  usOnly?: boolean;
  // Staff-set: the org has a signed contract on file.
  signedContract?: boolean;
  // Staff-set: the date range of the org's enterprise pilot, as ISO 8601
  // strings. No endDate means the pilot has no end.
  enterprisePilot?: { startDate?: string; endDate?: string } | null;
  // Alexandria Verified: the dashboard's Verified pages open, and Exchange
  // providers marked verifiedOnly (Yelp) execute. Org flag, overridable per team.
  alexandriaVerified?: boolean;
  // PDF and image parsing runs only on reserved processing capacity. A parse
  // that cannot be kept there is refused.
  reservedCapacity?: boolean;
  // Per-team extensions past a deprecation's sunset (lib/deprecations.ts):
  // surface or entry key to the YYYY-MM-DD or UTC timestamp it runs until.
  deprecationExtensions?: Record<string, string>;
  organizationDataSourceAccess?: Record<
    string,
    {
      status?: "enabled" | "disabled" | "suspended" | string | null;
      termsKey?: string | null;
      termsVersion?: string | null;
      termsAcceptedAt?: string | null;
      enabledAt?: string | null;
      disabledAt?: string | null;
      disabledReason?: string | null;
    }
  >;
  // routes the team's new queue work to the FoundationDB backend
  nuqFdb?: boolean;
  /**
   * Per-endpoint rate-limit overrides, in requests per minute. A value here
   * replaces the computed limit for that mode, so the Autumn multiplier is
   * not applied.
   */
  rateLimitOverrides?: Partial<Record<RateLimiterMode, number>>;
} | null;

export type AuthCreditUsageChunkFromTeam = Omit<
  AuthCreditUsageChunk,
  "api_key"
>;

export interface RequestWithMaybeACUC<
  ReqParams = {},
  ReqBody = undefined,
  ResBody = undefined,
> extends Request<ReqParams, ReqBody, ResBody> {
  acuc?: AuthCreditUsageChunk;
  zdrPolicy?: unknown;
}

export interface RequestWithMaybeAuth<
  ReqParams = {},
  ReqBody = undefined,
  ResBody = undefined,
> extends RequestWithMaybeACUC<ReqParams, ReqBody, ResBody> {
  auth?: AuthObject;
  account?: Account;
}

export interface RequestWithAuth<
  ReqParams = {},
  ReqBody = undefined,
  ResBody = undefined,
> extends RequestWithMaybeACUC<ReqParams, ReqBody, ResBody> {
  auth: AuthObject;
  account?: Account;
}

export function toV0CrawlerOptions(x: CrawlerOptions) {
  return {
    includes: x.includePaths,
    excludes: x.excludePaths,
    maxCrawledLinks: x.limit,
    maxDepth: 9999,
    limit: x.limit,
    generateImgAltText: false,
    allowBackwardCrawling: x.crawlEntireDomain,
    allowExternalContentLinks: x.allowExternalLinks,
    allowSubdomains: x.allowSubdomains,
    ignoreRobotsTxt: x.ignoreRobotsTxt,
    robotsUserAgent: x.robotsUserAgent,
    ignoreSitemap: x.sitemap === "skip",
    sitemapOnly: x.sitemap === "only",
    deduplicateSimilarURLs: x.deduplicateSimilarURLs,
    ignoreQueryParameters: x.ignoreQueryParameters,
    regexOnFullURL: x.regexOnFullURL,
    maxDiscoveryDepth: x.maxDiscoveryDepth,
    currentDiscoveryDepth: 0,
    delay: x.delay,
  };
}

export function toV2CrawlerOptions(x: any): CrawlerOptions {
  return {
    includePaths: x.includes,
    excludePaths: x.excludes,
    limit: x.limit,
    crawlEntireDomain: x.allowBackwardCrawling,
    allowExternalLinks: x.allowExternalContentLinks,
    allowSubdomains: x.allowSubdomains,
    ignoreRobotsTxt: x.ignoreRobotsTxt,
    robotsUserAgent: x.robotsUserAgent,
    sitemap: x.sitemapOnly ? "only" : x.ignoreSitemap ? "skip" : "include",
    deduplicateSimilarURLs: x.deduplicateSimilarURLs,
    ignoreQueryParameters: x.ignoreQueryParameters,
    regexOnFullURL: x.regexOnFullURL,
    maxDiscoveryDepth: x.maxDiscoveryDepth,
    delay: x.delay,
  };
}

export interface MapDocument {
  url: string;
  title?: string;
  description?: string;
}

// Search source type definitions
// These allow fine-grained control over each search source type
// Similar to how scrape formats work with jsonFormatWithOptions, etc.

const webSearchSourceOptions = z.strictObject({
  type: z.literal("web"),
  tbs: z.string().optional(), // Time-based search (e.g., "qdr:d" for past day)
  filter: z.string().optional(), // Search filter
  lang: z.string().optional(), // Language override for this source
  country: z.string().optional(), // Country override for this source
  location: z.string().optional(), // Location override for this source
});

const imagesSearchSourceOptions = z.strictObject({
  type: z.literal("images"),
});

const newsSearchSourceOptions = z.strictObject({
  type: z.literal("news"),
});

// Category source type definitions
const pdfCategoryOptions = z.strictObject({
  type: z.literal("pdf"),
});

const searchDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    value =>
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(
        value,
      ),
    "Domain must be a valid hostname without protocol or path",
  );

const searchRequestSchemaBase = z.strictObject({
  query: z.string(),
  limit: z.int().positive().finite().max(100).prefault(10),
  tbs: z.string().optional(),
  filter: z.string().optional(),
  sources: z
    .union([
      z.array(z.enum(["web", "images", "news"])),
      z.array(
        z.union([
          webSearchSourceOptions,
          imagesSearchSourceOptions,
          newsSearchSourceOptions,
        ]),
      ),
    ])
    .prefault(["web"]),
  categories: z
    .union([z.array(z.enum(["pdf"])), z.array(pdfCategoryOptions)])
    .optional(),
  includeDomains: z.array(searchDomainSchema).optional(),
  excludeDomains: z.array(searchDomainSchema).optional(),
  lang: z.string().prefault("en"),
  safe: z.boolean().optional(),
  country: z.string().optional(),
  location: z.string().optional(),
  origin: z.string().prefault("api"),
  integration: integrationSchema.optional().transform(val => val || null),
  timeout: z.int().positive().finite().prefault(60000),
  ignoreInvalidURLs: z.boolean().prefault(false),
  asyncScraping: z.boolean().prefault(false),
  scrapeOptions: baseScrapeOptions
    .safeExtend({
      formats: z
        .preprocess(
          val => {
            if (!Array.isArray(val)) return val;
            return val.map(format => {
              if (typeof format === "string") {
                return { type: format };
              }
              return format;
            });
          },
          z
            .union([
              z.strictObject({ type: z.literal("markdown") }),
              z.strictObject({ type: z.literal("html") }),
              z.strictObject({ type: z.literal("rawHtml") }),
              z.strictObject({ type: z.literal("links") }),
              z.strictObject({ type: z.literal("images") }),
              z.strictObject({ type: z.literal("summary") }),
              jsonFormatWithOptions,
              questionFormatWithOptions,
              queryFormatWithOptions,
              screenshotFormatWithOptions,
            ])
            .array()
            .prefault([]),
        )
        .refine(x => {
          return x.filter(f => f.type === "screenshot").length <= 1;
        }, "You may only specify one screenshot format"),
    })
    .optional(),
});

const transformSearchRequest = <
  T extends z.infer<typeof searchRequestSchemaBase>,
>(
  x: T,
) => {
  // Providers read the country (gl) and the location separately and default
  // each to the US, so fill in whichever one the caller left out. Georgia is
  // never inferred because it is also a US state.
  const locationCountry = x.location?.split(",").at(-1)?.trim().toLowerCase();
  const country =
    x.country ??
    Object.entries(countries)
      .find(
        ([code, c]) =>
          code !== "GE" && c.name.toLowerCase() === locationCountry,
      )?.[0]
      .toLowerCase() ??
    (x.location ? undefined : "us");
  const location =
    x.location ??
    Object.entries(countries).find(
      ([code]) => code === x.country?.toUpperCase(),
    )?.[1].name;

  // Transform string array sources to object format
  let sources = x.sources;
  if (sources && Array.isArray(sources) && sources.length > 0) {
    // Check if it's a string array by checking the first element
    if (typeof sources[0] === "string") {
      // It's a string array, transform to object array
      sources = (sources as string[]).map(s => {
        switch (s) {
          case "web":
            return {
              type: "web" as const,
              tbs: x.tbs,
              filter: x.filter,
              lang: x.lang,
              country,
              location,
            };
          case "images":
            return {
              type: "images" as const,
              // Images don't inherit global params in the simple format
            };
          case "news":
            return {
              type: "news" as const,
              tbs: x.tbs,
              lang: x.lang,
              country,
              location,
            };
          default:
            return { type: s as any };
        }
      });
    }
    // Otherwise it's already an object array, keep as is
  }

  // Transform string array categories to object format
  let categories = x.categories;
  if (categories && Array.isArray(categories) && categories.length > 0) {
    // Check if it's a string array by checking the first element
    if (typeof categories[0] === "string") {
      // It's a string array, transform to object array
      categories = (categories as string[]).map(c => {
        switch (c) {
          case "pdf":
            return {
              type: "pdf" as const,
            };
          default:
            return { type: c as any };
        }
      });
    }
    // Otherwise it's already an object array, keep as is
  }

  return {
    ...x,
    country,
    location,
    sources,
    categories,
    scrapeOptions: extractTransform(x.scrapeOptions),
  };
};

export const searchRequestSchema = searchRequestSchemaBase
  .refine(
    x => !(x.includeDomains?.length && x.excludeDomains?.length),
    "includeDomains and excludeDomains cannot both be specified",
  )
  .refine(x => waitForRefine(x.scrapeOptions), waitForRefineOpts)
  .transform(transformSearchRequest);

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchRequestInput = z.input<typeof searchRequestSchema>;

export type SearchResponse =
  | ErrorResponse
  | {
      success: true;
      warning?: string;
      data: Document[];
      creditsUsed?: number;
      id: string;
    }
  | {
      success: true;
      warning?: string;
      data: import("../../lib/entities").SearchV2Response;
      creditsUsed?: number;
      id: string;
    }
  | {
      success: true;
      warning?: string;
      data: import("../../lib/entities").SearchV2Response;
      scrapeIds: {
        web?: string[];
        news?: string[];
        images?: string[];
      };
      creditsUsed?: number;
      id: string;
    };

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  step?: string;
  model?: string;
};

const generateLLMsTextRequestSchema = z.object({
  url: URL.describe("The URL to generate text from"),
  maxUrls: z
    .number()
    .min(1)
    .max(5000)
    .prefault(10)
    .describe("Maximum number of URLs to process"),
  showFullText: z
    .boolean()
    .prefault(false)
    .describe("Whether to show the full LLMs-full.txt in the response"),
  cache: z
    .boolean()
    .prefault(true)
    .describe("Whether to use cached content if available"),
  __experimental_stream: z.boolean().optional(),
});

type GenerateLLMsTextRequest = z.infer<typeof generateLLMsTextRequestSchema>;

const coreScrapeFormatSchemas: Record<string, z.ZodType> = {
  markdown: z.strictObject({ type: z.literal("markdown") }),
  html: z.strictObject({ type: z.literal("html") }),
  rawHtml: z.strictObject({ type: z.literal("rawHtml") }),
  rawBase64: z.strictObject({ type: z.literal("rawBase64") }),
  links: z.strictObject({ type: z.literal("links") }),
  images: z.strictObject({ type: z.literal("images") }),
  summary: z.strictObject({ type: z.literal("summary") }),
  json: jsonFormatWithOptions,
  screenshot: screenshotFormatWithOptions,
  attributes: attributesFormatWithOptions,
  question: questionFormatWithOptions,
  query: queryFormatWithOptions,
};

const coreSearchFormatSchemas: Record<string, z.ZodType> = {
  markdown: coreScrapeFormatSchemas.markdown,
  html: coreScrapeFormatSchemas.html,
  rawHtml: coreScrapeFormatSchemas.rawHtml,
  links: coreScrapeFormatSchemas.links,
  images: coreScrapeFormatSchemas.images,
  summary: coreScrapeFormatSchemas.summary,
  json: jsonFormatWithOptions,
  question: questionFormatWithOptions,
  query: queryFormatWithOptions,
  screenshot: screenshotFormatWithOptions,
};

function createScrapeFormatsSchema(
  extraFormats: Readonly<Record<string, z.ZodType>>,
) {
  const members = Object.values({
    ...coreScrapeFormatSchemas,
    ...extraFormats,
  }) as [z.ZodType, z.ZodType, ...z.ZodType[]];

  return z
    .preprocess(
      val => {
        if (!Array.isArray(val)) return val;
        return val.map(format => {
          if (typeof format === "string") {
            return { type: format };
          }
          return format;
        });
      },
      z
        .union(members)
        .array()
        .prefault([{ type: "markdown" }]),
    )
    .refine(x => {
      return x.filter((f: any) => f.type === "screenshot").length <= 1;
    }, "You may only specify one screenshot format")
    .refine(
      x => !x.some((f: any) => f.type === "rawBase64") || x.length === 1,
      "The rawBase64 format cannot be combined with other formats",
    );
}

function createSearchFormatsSchema(
  extraFormats: Readonly<Record<string, z.ZodType>>,
) {
  const members = Object.values({
    ...coreSearchFormatSchemas,
    ...extraFormats,
  }) as [z.ZodType, z.ZodType, ...z.ZodType[]];

  return z
    .preprocess(val => {
      if (!Array.isArray(val)) return val;
      return val.map(format => {
        if (typeof format === "string") {
          return { type: format };
        }
        return format;
      });
    }, z.union(members).array().prefault([]))
    .refine(x => {
      return x.filter((f: any) => f.type === "screenshot").length <= 1;
    }, "You may only specify one screenshot format");
}

function applyBaseScrapeOptionsRefines<T extends z.ZodType<any>>(schema: T) {
  return schema.refine(
    (options: any) =>
      !(
        options.checkPromptInjection &&
        options.formats.some((f: any) => f.type === "rawBase64")
      ),
    {
      message:
        "checkPromptInjection scans page markdown and cannot be used with the rawBase64 format.",
      path: ["checkPromptInjection"],
    },
  );
}

function applyScrapeOptionsRules<T extends Record<string, unknown>>(
  value: T,
  kind: RequestKind,
  rules: readonly ScrapeOptionsRule[],
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): T | typeof z.NEVER {
  let current = value;
  for (const rule of rules) {
    const verdict = rule(current as unknown as ServiceScrapeOptions, { kind });
    if (!verdict) continue;
    if ("error" in verdict) {
      ctx.addIssue({
        code: "custom",
        message: verdict.error,
        ...(pathPrefix.length > 0 || verdict.path?.length
          ? { path: [...pathPrefix, ...(verdict.path ?? [])] }
          : {}),
      });
      return z.NEVER;
    }
    if ("set" in verdict && verdict.set) {
      current = { ...current, ...verdict.set };
    }
  }
  return current;
}

function applyExtractTransformAndRules<T extends Record<string, unknown>>(
  value: T,
  kind: RequestKind,
  rules: readonly ScrapeOptionsRule[],
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): T | typeof z.NEVER {
  const originalTimeout = (value as { timeout?: unknown }).timeout;
  let base = liftCheckPromptInjection(
    applyScrapeOptionsDefaults(value as unknown as ScrapeOptionsBase),
  ) as unknown as T & {
    formats?: unknown[];
    timeout?: number;
    proxy?: string;
  };
  if (base.proxy === "auto" && originalTimeout === 30000) {
    base = { ...base, timeout: 120000 };
  }
  const ruled =
    rules.length > 0
      ? applyScrapeOptionsRules(base, kind, rules, ctx, pathPrefix)
      : base;
  if (ruled === z.NEVER) return z.NEVER;
  let result = ruled as T & {
    formats?: unknown[];
    timeout?: number;
    proxy?: string;
  };
  if (
    result.formats?.find(
      x =>
        typeof x === "object" &&
        x !== null &&
        (x as { type?: unknown }).type === "json",
    ) &&
    originalTimeout === 30000 &&
    result.timeout === 30000
  ) {
    result = { ...result, timeout: 60000 };
  }
  return result;
}

// Core fields that extensions are explicitly allowed to widen.
const extensibleCoreFields: Readonly<Record<string, ReadonlySet<string>>> = {
  scrapeOptions: new Set(["parsers", "proxy"]),
  search: new Set(["sources", "categories"]),
};

function assertNoCoreCollision(
  bucket: string,
  contributed: Readonly<Record<string, unknown>>,
  coreShape: Record<string, unknown>,
): void {
  const allowed = extensibleCoreFields[bucket];
  for (const key of Object.keys(contributed)) {
    if (Object.hasOwn(coreShape, key) && !allowed?.has(key)) {
      throw new Error(
        `Request "${bucket}.${key}" collides with a built-in field or format`,
      );
    }
  }
}

const defaultV2RequestSchemas: RequestSchemas = Object.freeze({
  scrape: scrapeRequestSchema,
  parse: parseRequestSchema,
  crawl: crawlRequestSchema,
  batchScrape: batchScrapeRequestSchema,
  batchScrapeNoURLValidation: batchScrapeRequestSchemaNoURLValidation,
  map: mapRequestSchema,
  search: searchRequestSchema,
  scrapeOptions,
}) as unknown as RequestSchemas;

/**
 * Builds the v2 request and scrape-options schemas with extension-contributed
 * fields, formats, and cross-field scrape-options rules applied.
 */
export function buildV2RequestSchemas(
  contributions: ResolvedRequestContributions,
): RequestSchemas {
  assertNoCoreCollision(
    "formats",
    contributions.formats,
    coreScrapeFormatSchemas,
  );
  assertNoCoreCollision(
    "scrapeOptions",
    contributions.scrapeOptions,
    scrapeOptionFields.shape,
  );
  assertNoCoreCollision(
    "scrapeOptions",
    contributions.scrapeOptions,
    scrapeRequestSchemaBase.shape,
  );
  assertNoCoreCollision(
    "scrapeOptions",
    contributions.scrapeOptions,
    parseRequestSchemaBase.shape,
  );
  assertNoCoreCollision(
    "scrapeOptions",
    contributions.scrapeOptions,
    batchScrapeRequestSchemaBase.shape,
  );
  assertNoCoreCollision(
    "scrape",
    contributions.scrape,
    scrapeRequestSchemaBase.shape,
  );
  assertNoCoreCollision(
    "parse",
    contributions.parse,
    parseRequestSchemaBase.shape,
  );
  assertNoCoreCollision(
    "crawl",
    contributions.crawl,
    crawlRequestSchemaBase.shape,
  );
  assertNoCoreCollision(
    "batchScrape",
    contributions.batchScrape,
    batchScrapeRequestSchemaBase.shape,
  );
  assertNoCoreCollision("map", contributions.map, mapRequestSchemaBase.shape);
  assertNoCoreCollision(
    "search",
    contributions.search,
    searchRequestSchemaBase.shape,
  );

  const hasScrapeOptionsFields =
    Object.keys(contributions.scrapeOptions).length > 0;
  const hasScrapeFields = Object.keys(contributions.scrape).length > 0;
  const hasParseFields = Object.keys(contributions.parse).length > 0;
  const hasCrawlFields = Object.keys(contributions.crawl).length > 0;
  const hasBatchScrapeFields =
    Object.keys(contributions.batchScrape).length > 0;
  const hasMapFields = Object.keys(contributions.map).length > 0;
  const hasSearchFields = Object.keys(contributions.search).length > 0;
  const hasFormats = Object.keys(contributions.formats).length > 0;
  const hasRules = contributions.rules.length > 0;

  if (
    !hasScrapeOptionsFields &&
    !hasScrapeFields &&
    !hasParseFields &&
    !hasCrawlFields &&
    !hasBatchScrapeFields &&
    !hasMapFields &&
    !hasSearchFields &&
    !hasFormats &&
    !hasRules
  ) {
    return defaultV2RequestSchemas;
  }

  const scrapeOptionsShape: z.ZodRawShape = {
    ...scrapeOptionFields.shape,
    ...(hasFormats
      ? { formats: createScrapeFormatsSchema(contributions.formats) }
      : {}),
    ...contributions.scrapeOptions,
  };
  const baseScrapeOpts: z.ZodType<any> =
    hasFormats || hasScrapeOptionsFields
      ? applyBaseScrapeOptionsRefines(z.strictObject(scrapeOptionsShape))
      : baseScrapeOptions;

  const scrape =
    hasFormats || hasScrapeOptionsFields || hasScrapeFields || hasRules
      ? applyBaseScrapeOptionsRefines(
          z.strictObject({
            ...scrapeRequestSchemaBase.shape,
            ...scrapeOptionsShape,
            ...contributions.scrape,
          }),
        )
          .refine((x: any) => waitForRefine(x), waitForRefineOpts)
          .transform((x: any, ctx) =>
            applyExtractTransformAndRules(
              x,
              "scrape",
              contributions.rules,
              ctx,
            ),
          )
      : scrapeRequestSchema;

  const parse =
    hasFormats || hasScrapeOptionsFields || hasParseFields || hasRules
      ? applyBaseScrapeOptionsRefines(
          z.strictObject({
            ...parseRequestSchemaBase.shape,
            ...scrapeOptionsShape,
            ...contributions.parse,
          }),
        )
          .refine(
            (x: any) =>
              !x.formats.some((format: any) => format.type === "rawBase64"),
            "The rawBase64 format is not supported for parse uploads",
          )
          .refine((x: any) => waitForRefine(x), waitForRefineOpts)
          .transform((x: any, ctx) => {
            const { file, ...scrapeLike } = x;
            const ruled = applyExtractTransformAndRules(
              scrapeLike,
              "parse",
              contributions.rules,
              ctx,
            );
            if (ruled === z.NEVER) return z.NEVER;
            return { ...ruled, file };
          })
      : parseRequestSchema;

  const crawl =
    hasFormats || hasScrapeOptionsFields || hasCrawlFields || hasRules
      ? z
          .strictObject({
            ...crawlRequestSchemaBase.shape,
            scrapeOptions: baseScrapeOpts.prefault(() =>
              baseScrapeOpts.parse({}),
            ),
            ...contributions.crawl,
          })
          .superRefine((x: any, ctx) => {
            addPathRegexIssues(x, ctx);
          })
          .refine((x: any) => waitForRefine(x.scrapeOptions), waitForRefineOpts)
          .transform((x: any, ctx) => {
            const scrapeOptionsValue =
              x.scrapeOptions ?? baseScrapeOpts.parse({});
            const ruled = applyExtractTransformAndRules(
              scrapeOptionsValue,
              "crawl",
              contributions.rules,
              ctx,
              ["scrapeOptions"],
            );
            if (ruled === z.NEVER) return z.NEVER;
            return {
              ...x,
              url: x.url,
              scrapeOptions: ruled,
            };
          })
      : crawlRequestSchema;

  const map = hasMapFields
    ? z
        .strictObject({
          ...mapRequestSchemaBase.shape,
          ...contributions.map,
        })
        .superRefine((x: any, ctx) => {
          addPathRegexIssues(x, ctx);
        })
    : mapRequestSchema;

  const searchScrapeOpts =
    hasFormats || hasScrapeOptionsFields
      ? applyBaseScrapeOptionsRefines(
          z.strictObject({
            ...scrapeOptionsShape,
            formats: createSearchFormatsSchema(contributions.formats),
          }),
        )
      : undefined;

  const search =
    hasFormats || hasScrapeOptionsFields || hasSearchFields || hasRules
      ? z
          .strictObject({
            ...searchRequestSchemaBase.shape,
            ...(searchScrapeOpts
              ? { scrapeOptions: searchScrapeOpts.optional() }
              : {}),
            ...contributions.search,
          })
          .refine(
            (x: any) => !(x.includeDomains?.length && x.excludeDomains?.length),
            "includeDomains and excludeDomains cannot both be specified",
          )
          .refine((x: any) => waitForRefine(x.scrapeOptions), waitForRefineOpts)
          .transform((x: any, ctx) => {
            const rawScrapeOptions = x.scrapeOptions;
            const transformed = transformSearchRequest({
              ...x,
              scrapeOptions: undefined,
            });
            if (rawScrapeOptions === undefined) {
              return transformed;
            }
            const ruled = applyExtractTransformAndRules(
              rawScrapeOptions as unknown as Record<string, unknown>,
              "search",
              contributions.rules,
              ctx,
              ["scrapeOptions"],
            );
            if (ruled === z.NEVER) return z.NEVER;
            return {
              ...transformed,
              scrapeOptions: ruled,
            };
          })
      : searchRequestSchema;

  const buildBatchScrapeSchema = (baseShape: z.ZodRawShape) =>
    applyBaseScrapeOptionsRefines(
      z.strictObject({
        ...baseShape,
        ...scrapeOptionsShape,
        ...contributions.batchScrape,
      }),
    )
      .refine((x: any) => waitForRefine(x), waitForRefineOpts)
      .transform((x: any, ctx) =>
        applyExtractTransformAndRules(
          x,
          "batchScrape",
          contributions.rules,
          ctx,
        ),
      );

  const hasBatchScrapeChanges =
    hasFormats || hasScrapeOptionsFields || hasBatchScrapeFields || hasRules;

  const batchScrape = hasBatchScrapeChanges
    ? buildBatchScrapeSchema(batchScrapeRequestSchemaBase.shape)
    : batchScrapeRequestSchema;

  const batchScrapeNoURLValidation = hasBatchScrapeChanges
    ? buildBatchScrapeSchema(batchScrapeRequestSchemaNoURLValidationBase.shape)
    : batchScrapeRequestSchemaNoURLValidation;

  const compiledScrapeOptions =
    hasFormats || hasScrapeOptionsFields || hasRules
      ? baseScrapeOpts
          .refine(
            (obj: any) => {
              if (!obj.actions) return true;
              return (
                calculateTotalWaitTime(obj.actions, obj.waitFor) <=
                ACTIONS_MAX_WAIT_TIME * 1000
              );
            },
            {
              message: `Total wait time (waitFor + wait actions) cannot exceed ${ACTIONS_MAX_WAIT_TIME} seconds`,
            },
          )
          .refine((x: any) => waitForRefine(x), waitForRefineOpts)
          .transform((x: any, ctx) =>
            applyExtractTransformAndRules(
              x,
              "scrape",
              contributions.rules,
              ctx,
            ),
          )
      : scrapeOptions;

  if (Object.hasOwn(scrapeOptionsShape, "maxAge")) {
    maxAgeScrapeOptionsSchemas.add(compiledScrapeOptions);
  }

  return {
    scrape,
    parse,
    crawl,
    batchScrape,
    batchScrapeNoURLValidation,
    map,
    search,
    scrapeOptions: compiledScrapeOptions,
  } as unknown as RequestSchemas;
}

const maxAgeScrapeOptionsSchemas = new WeakSet<object>();

/**
 * Returns whether the given compiled scrapeOptions schema accepts maxAge.
 */
export function scrapeOptionsAcceptsMaxAge(
  schema: object = getV2RequestSchemas().scrapeOptions,
): boolean {
  return maxAgeScrapeOptionsSchemas.has(schema);
}

registerDefaultRequestSchemaBuilder(buildV2RequestSchemas);

/**
 * Returns the installed service's compiled v2 request schemas, falling back to
 * the built-in static schemas when no service is installed.
 */
export function getV2RequestSchemas(): RequestSchemas {
  return installedService()?.schemas ?? defaultV2RequestSchemas;
}

/**
 * Parses a v2 batch scrape request body through the active service schemas,
 * skipping upfront URL validation when `ignoreInvalidURLs` is explicitly true.
 */
export function parseBatchScrapeRequest(body: unknown): BatchScrapeRequest {
  const schemas = getV2RequestSchemas();
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { ignoreInvalidURLs?: unknown }).ignoreInvalidURLs === true
  ) {
    return schemas.batchScrapeNoURLValidation.parse(body);
  }
  return schemas.batchScrape.parse(body);
}
