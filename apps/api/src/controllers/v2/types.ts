export type AgentInteropStatus = "trusted" | "none" | "invalid";
import type { Request } from "express";
import { config } from "../../config";
import { z } from "zod";
import { protocolIncluded, checkUrl } from "../../lib/validateUrl";
import { hasReachableHost } from "../../lib/url-utils";
import { countries } from "../../lib/validate-country";
import { addPathRegexIssues, pathPatternsSchema } from "../../lib/crawl-regex";
import { addStrictSchemaIssue } from "../../lib/openai-strict-schema";
export { addStrictSchemaIssue };
import type { ScrapeActionContent, SearchV2Response } from "../../lib/entities";
import { jsonRecordSchema, jsonValueSchema } from "../../lib/json-types";
import type {
  JsonObject,
  JsonValue,
  StrictJsonValue,
} from "../../lib/json-types";
import type { TeamPlanClass } from "../../service/search-providers";
import type { JobCrawlerOptions, RateLimiterMode } from "../../types";
import type { ErrorCode } from "../../lib/error";
import { integrationSchema } from "../../utils/integration";
import { webhookSchema } from "../../services/webhook/schema";
import { installedService } from "../../service/service";
import { registerDefaultRequestSchemaBuilder } from "../../service/request";
import type {
  RequestKind,
  RequestSchemas,
  ResolvedRequestContributions,
  ScrapeOptionsRule,
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
    if (!protocolIncluded(x)) {
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
        /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?([/?#]|$)/i.test(
          x,
        )
      ) {
        return true;
      }
    }
    // Same TLD-shaped check as before, plus IP literals — which the old
    // inline regex accepted only when the last octet had 2+ digits, so
    // 8.8.8.8 was rejected while 169.254.169.254 passed.
    return hasReachableHost(x);
  }, "URL must have a valid top-level domain or be an IP address")
  .refine(x => {
    try {
      checkUrl(x);
      return true;
    } catch {
      return false;
    }
  }, "Invalid URL");
// .refine((x) => !isUrlBlocked(x as string), UNSUPPORTED_SITE_MESSAGE)

// In zod v4, .strict() returns a strict ZodObject without arguments; the custom
// error message for unrecognized keys is produced by the error handler in src/index.ts.
function strictWithMessage<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
): z.ZodObject<S, z.core.$strict> {
  return schema.strict();
}

const rootJsonSchema = z.union([jsonValueSchema, jsonRecordSchema]);
type ParsedJsonValue = z.infer<typeof jsonRecordSchema>[string];

function softOptional<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

function parseRootJsonInput(schema: unknown): ParsedJsonValue | undefined {
  const direct = rootJsonSchema.safeParse(schema);
  if (direct.success) {
    return direct.data;
  }
  try {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) {
      return undefined;
    }
    const roundTripped: unknown = JSON.parse(serialized);
    const parsed = rootJsonSchema.safeParse(roundTripped);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeSchemaForOpenAI(
  schema: unknown,
): JsonValue | undefined {
  if (schema === undefined) {
    return undefined;
  }
  const rootData = parseRootJsonInput(schema);
  if (rootData === undefined) {
    return undefined;
  }

  const seen = new WeakSet<object>();

  function normalizeNode(
    obj: ParsedJsonValue | undefined,
  ): JsonValue | undefined {
    if (obj === undefined || obj === null || typeof obj !== "object") {
      return obj;
    }
    if (Array.isArray(obj)) {
      if (seen.has(obj)) {
        return obj;
      }
      seen.add(obj);
      return obj.map(item => normalizeNode(item));
    }

    if (seen.has(obj)) {
      return obj;
    }
    seen.add(obj);

    const normalized: JsonObject = { ...obj };

    // Handle $ref recursion - preserve as-is for OpenAI compatibility
    if (Object.hasOwn(obj, "$ref")) {
      return normalized;
    }

    if (Object.hasOwn(obj, "$defs")) {
      const { $defs, ...rest } = obj;
      const processedRest: JsonObject = {};

      for (const [key, value] of Object.entries(rest)) {
        if (
          typeof value === "object" &&
          value !== null &&
          !Object.hasOwn(value, "$ref")
        ) {
          processedRest[key] = normalizeNode(value);
        } else {
          processedRest[key] = value;
        }
      }

      const defsEntries =
        typeof $defs === "object" && $defs !== null && !Array.isArray($defs)
          ? Object.entries($defs)
          : [];
      const normalizedDefs: JsonObject = Object.fromEntries(
        defsEntries.map(([key, value]) => [key, normalizeNode(value)]),
      );

      return { ...processedRest, $defs: normalizedDefs };
    }

    if (
      normalized.type === "object" &&
      Object.hasOwn(normalized, "properties") &&
      Object.hasOwn(normalized, "additionalProperties")
    ) {
      delete normalized.additionalProperties;
    }

    if (
      normalized.type === "object" &&
      Object.hasOwn(normalized, "required") &&
      Object.hasOwn(normalized, "properties")
    ) {
      const rawProperties = normalized.properties;
      if (
        Array.isArray(normalized.required) &&
        typeof rawProperties === "object" &&
        rawProperties !== null &&
        !Array.isArray(rawProperties)
      ) {
        const validRequired = normalized.required.filter(
          (field): field is string =>
            typeof field === "string" && Object.hasOwn(rawProperties, field),
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

    for (const [key, value] of Object.entries(obj)) {
      if (
        Object.hasOwn(normalized, key) &&
        !(key === "required" && Array.isArray(value)) &&
        typeof value === "object" &&
        value !== null &&
        !Object.hasOwn(value, "$ref")
      ) {
        normalized[key] = normalizeNode(value);
      }
    }

    return normalized;
  }

  return normalizeNode(rootData);
}

export function validateSchemaForOpenAI(schema: unknown): boolean {
  const parsedRoot = rootJsonSchema.safeParse(schema);
  if (!parsedRoot.success) {
    return true;
  }

  const visited = new WeakSet<object>();

  function hasInvalidStructure(obj: ParsedJsonValue | undefined): boolean {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }

    if (visited.has(obj)) {
      return false;
    }
    visited.add(obj);

    if (Array.isArray(obj)) {
      for (const value of obj) {
        if (
          typeof value === "object" &&
          value !== null &&
          !Object.hasOwn(value, "$ref")
        ) {
          if (hasInvalidStructure(value)) {
            return true;
          }
        }
      }
      return false;
    }

    if (Object.hasOwn(obj, "$ref")) {
      return false;
    }

    if (
      obj.type === "object" &&
      !Object.hasOwn(obj, "properties") &&
      !Object.hasOwn(obj, "patternProperties") &&
      obj.additionalProperties === true
    ) {
      return true;
    }

    for (const value of Object.values(obj)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Object.hasOwn(value, "$ref")
      ) {
        if (hasInvalidStructure(value)) {
          return true;
        }
      }
    }
    return false;
  }

  return !hasInvalidStructure(parsedRoot.data);
}

export const OPENAI_SCHEMA_ERROR_MESSAGE =
  "Schema contains invalid structure for OpenAI: object type with no 'properties' defined but 'additionalProperties: true' (schema-less dictionary not supported by OpenAI). Please define specific properties for your object. Note: Recursive schemas using '$ref' are supported.";

const ACTIONS_MAX_WAIT_TIME = 60;
const MAX_ACTIONS = 50;

interface WaitActionLike {
  type?: string;
  milliseconds?: number;
  selector?: string;
}

function calculateTotalWaitTime(
  actions: ReadonlyArray<WaitActionLike> = [],
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
  metadata?: JsonObject;
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
    .unknown()
    .optional()
    .transform(val => normalizeSchemaForOpenAI(val))
    .refine(val => validateSchemaForOpenAI(val), {
      message: OPENAI_SCHEMA_ERROR_MESSAGE,
    })
    .superRefine(addStrictSchemaIssue),
  prompt: z.string().max(10_000).optional(),
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
  question: z.string().min(1).max(10_000),
});

type QuestionFormatWithOptions = z.output<typeof questionFormatWithOptions>;

/** @deprecated Use `question` format instead. */
const queryFormatWithOptions = z.strictObject({
  type: z.literal("query"),
  prompt: z.string().max(10_000),
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
  maxPages: z.int().positive().finite().max(10_000).optional(),
});

const parsersSchema = z
  .array(z.union([z.literal("pdf"), pdfParserWithOptions]))
  .prefault(["pdf"]);

const pdfParserObjectSchema = z.object({
  type: z.literal("pdf"),
  mode: softOptional(pdfModeSchema),
  maxPages: softOptional(z.number()),
});

const pdfParserEntrySchema = z.union([z.literal("pdf"), pdfParserObjectSchema]);

export function shouldParsePDF(parsers?: ReadonlyArray<unknown>): boolean {
  if (!parsers) {
    return true;
  }
  return parsers.some(parser => pdfParserEntrySchema.safeParse(parser).success);
}

export function getPDFMaxPages(
  parsers?: ReadonlyArray<unknown>,
): number | undefined {
  if (!parsers) {
    return undefined;
  }
  for (const parser of parsers) {
    const parsed = pdfParserObjectSchema.safeParse(parser);
    if (parsed.success) {
      return parsed.data.maxPages;
    }
  }
  return undefined;
}

export function getPDFMode(parsers?: ReadonlyArray<unknown>): PDFMode {
  if (!parsers) {
    return "auto";
  }
  for (const parser of parsers) {
    if (parser === "pdf") {
      return "auto";
    }
    const parsed = pdfParserObjectSchema.safeParse(parser);
    if (parsed.success) {
      return parsed.data.mode ?? "auto";
    }
  }
  return "auto";
}

function transformIframeSelector(selector: string): string {
  return selector.replaceAll(/(?:^|[\s,])iframe(?=\s|$|[.#[:,])/g, match => {
    const prefix = match.match(/^[\s,]/)?.[0] || "";
    return prefix + 'div[data-original-tag="iframe"]';
  });
}

const SPECIAL_COUNTRIES = new Set(["us-generic", "us-whitelist"]);

const locationSchema = z
  .object({
    country: z
      .string()
      .optional()
      .refine(
        val =>
          !val ||
          Object.keys(countries).includes(val.toUpperCase()) ||
          SPECIAL_COUNTRIES.has(val.toLowerCase()),
        "Invalid country code. Use a valid ISO 3166-1 alpha-2 country code.",
      )
      .transform(val => {
        if (!val) {
          return "us-generic";
        }
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
      (val: unknown) => {
        if (!Array.isArray(val)) {
          return val;
        }
        return val.map((format: unknown) => {
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
  waitFor: z.int().nonnegative().max(60_000).prefault(0),
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
  T extends { formats?: Array<unknown>; checkPromptInjection?: unknown },
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

const extractTransformRequired = <T extends ScrapeOptionsBase>(obj: T): T => {
  let result = liftCheckPromptInjection(applyScrapeOptionsDefaults(obj));
  if (
    obj.formats.some(x => typeof x === "object" && x.type === "json") &&
    obj.timeout === 30_000
  ) {
    result = { ...result, timeout: 60_000 };
  }

  if (obj.proxy === "auto" && obj.timeout === 30_000) {
    result = { ...result, timeout: 120_000 };
  }

  return result;
};

export const extractTransform = (
  obj?: ScrapeOptionsBase,
): ScrapeOptionsBase | undefined => {
  if (!obj) {
    return undefined;
  }
  return extractTransformRequired(obj);
};

export const scrapeOptions = strictWithMessage(baseScrapeOptions)
  .refine(
    obj => {
      if (!obj.actions) {
        return true;
      }
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

const uploadedParseFileObjectSchema = z.object({
  buffer: z.custom<Buffer>(value => Buffer.isBuffer(value)),
  filename: z.string().refine(name => name.trim().length > 0),
  contentType: z.string().optional(),
  kind: z.enum(["html", "pdf", "document", "image"]).optional(),
});

const uploadedParseFileSchema = z.custom<UploadedParseFile>(
  value => uploadedParseFileObjectSchema.safeParse(value).success,
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
  urls: Array<z.input<typeof URL>>;
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
  limit: z.number().prefault(10_000), // default?
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
  limit: z.number().prefault(10_000),
  maxConcurrency: z.int().positive().optional(),
  zeroDataRetention: z.boolean().optional(),
  prompt: z.string().max(10_000).optional(),
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

export const MAX_MAP_LIMIT = 100_000;

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
  ogLocaleAlternate?: Array<string>;
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
  postprocessorsUsed?: Array<string>;
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
  links?: Array<string>;
  images?: Array<string>;
  screenshot?: string;
  extract?: StrictJsonValue;
  json?: StrictJsonValue;
  summary?: string;
  answer?: string;
  warning?: string;
  attributes?: Array<{
    selector: string;
    attribute: string;
    values: Array<string>;
  }>;
  actions?: {
    screenshots?: Array<string>;
    scrapes?: Array<ScrapeActionContent>;
    javascriptReturns?: Array<{
      type: string;
      value: unknown;
    }>;
    pdfs?: Array<string>;
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
  details?: unknown;
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
        tools?: Array<unknown>;
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
      invalidURLs?: Array<string>;
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
      links?: Array<MapDocument>;
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
      data: Array<Document>;
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
      data: Array<Document>;
    };

export type OngoingCrawlsResponse =
  | ErrorResponse
  | {
      success: true;
      crawls: Array<{
        id: string;
        teamId: string;
        url: string;
        created_at: string;
        options: CrawlerOptions;
      }>;
    };

export type CrawlErrorsResponse =
  | ErrorResponse
  | {
      errors: Array<{
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
          [key: string]: JsonValue | undefined;
        };
      }>;
      robotsBlocked: Array<string>;
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

  // api_keys.expires_at; null or absent means the key never expires. Checked
  // on every request, including cache hits.
  expires_at?: string | Date | null;

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
    allowlist?: Array<string>;
  };
  siemLogging?: boolean;
  unblockedDomains?: Array<string>;
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
  bypassCreditChecks?: boolean;
  debugBranding?: boolean;
  // grants the privileged large-PDF size cap
  largePdfs?: boolean;
  // POST /v2/search/:jobId/feedback returns 403 TEAM_OPTED_OUT when true.
  searchFeedbackOptOut?: boolean;
  menuBeta?: boolean;
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

export type DefaultRequestParams = Request["params"];

export interface RequestWithMaybeACUC<
  ReqParams = DefaultRequestParams,
  ReqBody = undefined,
  ResBody = undefined,
> extends Request<ReqParams, ReqBody, ResBody> {
  acuc?: AuthCreditUsageChunk;
  zdrPolicy?: unknown;
}

export interface RequestWithMaybeAuth<
  ReqParams = DefaultRequestParams,
  ReqBody = undefined,
  ResBody = undefined,
> extends RequestWithMaybeACUC<ReqParams, ReqBody, ResBody> {
  auth?: AuthObject;
  account?: Account;
}

export interface RequestWithAuth<
  ReqParams = DefaultRequestParams,
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

export function toV2CrawlerOptions(
  x: JobCrawlerOptions & {
    includes?: Array<string>;
    excludes?: Array<string>;
    limit?: number;
    allowBackwardCrawling?: boolean;
    allowExternalContentLinks?: boolean;
    allowSubdomains?: boolean;
    ignoreRobotsTxt?: boolean;
    robotsUserAgent?: string;
    sitemapOnly?: boolean;
    ignoreSitemap?: boolean;
    deduplicateSimilarURLs?: boolean;
    ignoreQueryParameters?: boolean;
    regexOnFullURL?: boolean;
    maxDiscoveryDepth?: number;
    delay?: number;
  },
): CrawlerOptions {
  return {
    includePaths: x.includes ?? [],
    excludePaths: x.excludes ?? [],
    limit: x.limit ?? 10_000,
    crawlEntireDomain: x.allowBackwardCrawling ?? false,
    allowExternalLinks: x.allowExternalContentLinks ?? false,
    allowSubdomains: x.allowSubdomains ?? false,
    ignoreRobotsTxt: x.ignoreRobotsTxt ?? false,
    robotsUserAgent: x.robotsUserAgent,
    sitemap: x.sitemapOnly ? "only" : x.ignoreSitemap ? "skip" : "include",
    deduplicateSimilarURLs: x.deduplicateSimilarURLs ?? false,
    ignoreQueryParameters: x.ignoreQueryParameters ?? false,
    regexOnFullURL: x.regexOnFullURL ?? false,
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
  timeout: z.int().positive().finite().prefault(60_000),
  ignoreInvalidURLs: z.boolean().prefault(false),
  asyncScraping: z.boolean().prefault(false),
  scrapeOptions: baseScrapeOptions
    .safeExtend({
      formats: z
        .preprocess(
          (val: unknown) => {
            if (!Array.isArray(val)) {
              return val;
            }
            return val.map((format: unknown) => {
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

type SearchSourceEntry =
  | z.infer<typeof webSearchSourceOptions>
  | z.infer<typeof imagesSearchSourceOptions>
  | (z.infer<typeof newsSearchSourceOptions> & {
      tbs?: string;
      lang?: string;
      country?: string;
      location?: string;
    })
  | { type: string };

type SearchCategoryEntry =
  | z.infer<typeof pdfCategoryOptions>
  | { type: string; sites?: Array<string> };

const transformSearchRequest = <
  T extends Omit<
    z.infer<typeof searchRequestSchemaBase>,
    "sources" | "categories" | "scrapeOptions"
  > & {
    sources?: ReadonlyArray<string | SearchSourceEntry>;
    categories?: ReadonlyArray<string | SearchCategoryEntry>;
    scrapeOptions?: ScrapeOptionsBase;
  },
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
  let sources: Array<SearchSourceEntry> | undefined;
  const rawSources: ReadonlyArray<string | SearchSourceEntry> | undefined =
    x.sources;
  if (rawSources && Array.isArray(rawSources)) {
    if (rawSources.length > 0 && typeof rawSources[0] === "string") {
      sources = rawSources
        .filter((s): s is string => typeof s === "string")
        .map((s): SearchSourceEntry => {
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
              return { type: s };
          }
        });
    } else {
      sources = rawSources.filter(
        (entry): entry is SearchSourceEntry => typeof entry !== "string",
      );
    }
  }

  // Transform string array categories to object format
  let categories: Array<SearchCategoryEntry> | undefined;
  const rawCategories: ReadonlyArray<string | SearchCategoryEntry> | undefined =
    x.categories;
  if (rawCategories) {
    categories = rawCategories.map((entry): SearchCategoryEntry => {
      if (typeof entry !== "string") {
        return entry;
      }
      return entry === "pdf" ? { type: "pdf" as const } : { type: entry };
    });
  }

  const {
    sources: _sources,
    categories: _categories,
    country: _country,
    location: _location,
    scrapeOptions: _scrapeOptions,
    ...rest
  } = x;

  return {
    ...rest,
    country,
    location,
    sources: sources ?? [
      {
        type: "web" as const,
        tbs: x.tbs,
        filter: x.filter,
        lang: x.lang,
        country,
        location,
      },
    ],
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
      data: Array<Document>;
      creditsUsed?: number;
      id: string;
    }
  | {
      success: true;
      warning?: string;
      data: SearchV2Response;
      creditsUsed?: number;
      id: string;
    }
  | {
      success: true;
      warning?: string;
      data: SearchV2Response;
      scrapeIds: {
        web?: Array<string>;
        news?: Array<string>;
        images?: Array<string>;
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

const coreScrapeFormatSchemas = {
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
} satisfies Record<string, z.ZodType>;

const coreSearchFormatSchemas = {
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
} satisfies Record<string, z.ZodType>;

const formatTypeSchema = z.object({ type: z.string() });

function hasFormatType(value: unknown, expected: string): boolean {
  const parsed = formatTypeSchema.safeParse(value);
  return parsed.success && parsed.data.type === expected;
}

function createFormatsUnion(
  baseFormats: Readonly<Record<string, z.ZodType>>,
  extraFormats: Readonly<Record<string, z.ZodType>>,
): z.ZodType {
  const members: Array<z.ZodType> = Object.values({
    ...baseFormats,
    ...extraFormats,
  });
  const [first, second, ...rest] = members;
  if (!first || !second) {
    throw new Error("Expected at least two format schemas");
  }
  return z.union([first, second, ...rest]);
}

function createScrapeFormatsSchema(
  extraFormats: Readonly<Record<string, z.ZodType>>,
) {
  return z
    .preprocess(
      (val: unknown) => {
        if (!Array.isArray(val)) {
          return val;
        }
        return val.map((format: unknown) => {
          if (typeof format === "string") {
            return { type: format };
          }
          return format;
        });
      },
      createFormatsUnion(coreScrapeFormatSchemas, extraFormats)
        .array()
        .prefault([{ type: "markdown" }]),
    )
    .refine(x => {
      return x.filter(f => hasFormatType(f, "screenshot")).length <= 1;
    }, "You may only specify one screenshot format")
    .refine(
      x => !x.some(f => hasFormatType(f, "rawBase64")) || x.length === 1,
      "The rawBase64 format cannot be combined with other formats",
    );
}

function createSearchFormatsSchema(
  extraFormats: Readonly<Record<string, z.ZodType>>,
) {
  return z
    .preprocess((val: unknown) => {
      if (!Array.isArray(val)) {
        return val;
      }
      return val.map((format: unknown) => {
        if (typeof format === "string") {
          return { type: format };
        }
        return format;
      });
    }, createFormatsUnion(coreSearchFormatSchemas, extraFormats).array().prefault([]))
    .refine(x => {
      return x.filter(f => hasFormatType(f, "screenshot")).length <= 1;
    }, "You may only specify one screenshot format");
}

interface CheckPromptInjectionCandidate {
  checkPromptInjection?: boolean;
  formats: ReadonlyArray<unknown>;
}

function applyBaseScrapeOptionsRefines<T extends CheckPromptInjectionCandidate>(
  schema: z.ZodType<T>,
): z.ZodType<T> {
  return schema.refine(
    options =>
      !(
        options.checkPromptInjection &&
        options.formats.some(f => hasFormatType(f, "rawBase64"))
      ),
    {
      message:
        "checkPromptInjection scans page markdown and cannot be used with the rawBase64 format.",
      path: ["checkPromptInjection"],
    },
  );
}

function applyScrapeOptionsRules<T extends ScrapeOptionsBase>(
  value: T,
  kind: RequestKind,
  rules: ReadonlyArray<ScrapeOptionsRule>,
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): T | typeof z.NEVER {
  const current: T = { ...value };
  for (const rule of rules) {
    const verdict = rule(current, { kind });
    if (!verdict) {
      continue;
    }
    if ("error" in verdict) {
      if (pathPrefix.length > 0 || verdict.path?.length) {
        ctx.addIssue({
          code: "custom",
          message: verdict.error,
          path: [...pathPrefix, ...(verdict.path ?? [])],
        });
      } else {
        ctx.addIssue({
          code: "custom",
          message: verdict.error,
        });
      }
      return z.NEVER;
    }
    if ("set" in verdict && verdict.set) {
      Object.assign(current, verdict.set);
    }
  }
  return current;
}

function applyExtractTransformAndRules<T extends ScrapeOptionsBase>(
  value: T,
  kind: RequestKind,
  rules: ReadonlyArray<ScrapeOptionsRule>,
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): T | typeof z.NEVER {
  const originalTimeout = value.timeout;
  let base: T = liftCheckPromptInjection(applyScrapeOptionsDefaults(value));
  if (base.proxy === "auto" && originalTimeout === 30_000) {
    base = { ...base, timeout: 120_000 };
  }
  const ruled =
    rules.length > 0
      ? applyScrapeOptionsRules(base, kind, rules, ctx, pathPrefix)
      : base;
  if (ruled === z.NEVER) {
    return z.NEVER;
  }
  let result = ruled;
  if (
    result.formats.some(x => hasFormatType(x, "json")) &&
    originalTimeout === 30_000 &&
    result.timeout === 30_000
  ) {
    result = { ...result, timeout: 60_000 };
  }
  return result;
}

// Core fields that extensions are explicitly allowed to widen.
const extensibleCoreFields = {
  scrapeOptions: new Set<string>(["parsers", "proxy"]),
  search: new Set<string>(["sources", "categories"]),
} satisfies Record<string, ReadonlySet<string>>;

function assertNoCoreCollision(
  bucket: string,
  contributed: Readonly<Record<string, z.ZodType>>,
  coreShape: Readonly<Record<string, z.ZodType>>,
): void {
  const allowed =
    bucket === "scrapeOptions"
      ? extensibleCoreFields.scrapeOptions
      : bucket === "search"
        ? extensibleCoreFields.search
        : undefined;
  for (const key of Object.keys(contributed)) {
    if (Object.hasOwn(coreShape, key) && !allowed?.has(key)) {
      throw new Error(
        `Request "${bucket}.${key}" collides with a built-in field or format`,
      );
    }
  }
}

const extendedOutputObjectSchema = z.object({});

function extendStrictObject<S extends z.ZodRawShape>(
  base: z.ZodObject<S>,
  extraEntries: ReadonlyArray<readonly [string, z.ZodType]>,
): z.ZodType<z.output<z.ZodObject<S>>> {
  const baseEntries: Array<[string, z.core.$ZodType]> = Object.entries(
    base.shape,
  );
  const merged = Object.fromEntries([...baseEntries, ...extraEntries]);
  return z
    .strictObject(merged)
    .refine(
      (value): value is z.output<z.ZodObject<S>> =>
        extendedOutputObjectSchema.safeParse(value).success,
    );
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
});

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

  const extraScrapeOptionEntries: Array<[string, z.ZodType]> = Object.entries(
    contributions.scrapeOptions,
  );
  if (hasFormats) {
    extraScrapeOptionEntries.push([
      "formats",
      createScrapeFormatsSchema(contributions.formats),
    ]);
  }

  const baseScrapeOpts: z.ZodType<ScrapeOptionsBase> =
    hasFormats || hasScrapeOptionsFields
      ? applyBaseScrapeOptionsRefines(
          extendStrictObject(scrapeOptionFields, extraScrapeOptionEntries),
        )
      : baseScrapeOptions;

  const scrape: z.ZodType<ScrapeRequest> =
    hasFormats || hasScrapeOptionsFields || hasScrapeFields || hasRules
      ? applyBaseScrapeOptionsRefines(
          extendStrictObject(scrapeRequestSchemaBase, [
            ...extraScrapeOptionEntries,
            ...Object.entries(contributions.scrape),
          ]),
        )
          .refine(x => waitForRefine(x), waitForRefineOpts)
          .transform((x, ctx) =>
            applyExtractTransformAndRules(
              x,
              "scrape",
              contributions.rules,
              ctx,
            ),
          )
      : scrapeRequestSchema;

  const parse: z.ZodType<ParseRequest> =
    hasFormats || hasScrapeOptionsFields || hasParseFields || hasRules
      ? applyBaseScrapeOptionsRefines(
          extendStrictObject(parseRequestSchemaBase, [
            ...extraScrapeOptionEntries,
            ...Object.entries(contributions.parse),
          ]),
        )
          .refine(
            x => !x.formats.some(format => hasFormatType(format, "rawBase64")),
            "The rawBase64 format is not supported for parse uploads",
          )
          .refine(x => waitForRefine(x), waitForRefineOpts)
          .transform((x, ctx) => {
            const { file, ...scrapeLike } = x;
            const ruled = applyExtractTransformAndRules(
              scrapeLike,
              "parse",
              contributions.rules,
              ctx,
            );
            if (ruled === z.NEVER) {
              return z.NEVER;
            }
            return { ...ruled, file };
          })
      : parseRequestSchema;

  const crawl: z.ZodType<CrawlRequest> =
    hasFormats || hasScrapeOptionsFields || hasCrawlFields || hasRules
      ? extendStrictObject(crawlRequestSchemaBase, [
          [
            "scrapeOptions",
            baseScrapeOpts.prefault(() => baseScrapeOpts.parse({})),
          ],
          ...Object.entries(contributions.crawl),
        ])
          .superRefine((x, ctx) => {
            addPathRegexIssues(x, ctx);
          })
          .refine(x => waitForRefine(x.scrapeOptions), waitForRefineOpts)
          .transform((x, ctx) => {
            const scrapeOptionsValue =
              x.scrapeOptions ?? baseScrapeOpts.parse({});
            const ruled = applyExtractTransformAndRules(
              scrapeOptionsValue,
              "crawl",
              contributions.rules,
              ctx,
              ["scrapeOptions"],
            );
            if (ruled === z.NEVER) {
              return z.NEVER;
            }
            return {
              ...x,
              url: x.url,
              scrapeOptions: ruled,
            };
          })
      : crawlRequestSchema;

  const map: z.ZodType<MapRequest> = hasMapFields
    ? extendStrictObject(
        mapRequestSchemaBase,
        Object.entries(contributions.map),
      ).superRefine((x, ctx) => {
        addPathRegexIssues(x, ctx);
      })
    : mapRequestSchema;

  const searchScrapeOpts: z.ZodType<ScrapeOptionsBase> | undefined =
    hasFormats || hasScrapeOptionsFields
      ? applyBaseScrapeOptionsRefines(
          extendStrictObject(scrapeOptionFields, [
            ...extraScrapeOptionEntries,
            ["formats", createSearchFormatsSchema(contributions.formats)],
          ]),
        )
      : undefined;

  const extraSearchEntries: Array<[string, z.ZodType]> = Object.entries(
    contributions.search,
  );
  if (searchScrapeOpts) {
    extraSearchEntries.push(["scrapeOptions", searchScrapeOpts.optional()]);
  }

  const search: z.ZodType<SearchRequest> =
    hasFormats || hasScrapeOptionsFields || hasSearchFields || hasRules
      ? extendStrictObject(searchRequestSchemaBase, extraSearchEntries)
          .refine(
            x => !(x.includeDomains?.length && x.excludeDomains?.length),
            "includeDomains and excludeDomains cannot both be specified",
          )
          .refine(x => waitForRefine(x.scrapeOptions), waitForRefineOpts)
          .transform((x, ctx) => {
            const rawScrapeOptions = x.scrapeOptions;
            const transformed = transformSearchRequest({
              ...x,
              scrapeOptions: undefined,
            });
            if (rawScrapeOptions === undefined) {
              return transformed;
            }
            const ruled = applyExtractTransformAndRules(
              rawScrapeOptions,
              "search",
              contributions.rules,
              ctx,
              ["scrapeOptions"],
            );
            if (ruled === z.NEVER) {
              return z.NEVER;
            }
            return {
              ...transformed,
              scrapeOptions: ruled,
            };
          })
      : searchRequestSchema;

  const buildBatchScrapeSchema = (
    baseSchema:
      | typeof batchScrapeRequestSchemaBase
      | typeof batchScrapeRequestSchemaNoURLValidationBase,
  ): z.ZodType<BatchScrapeRequest> =>
    applyBaseScrapeOptionsRefines(
      extendStrictObject(baseSchema, [
        ...extraScrapeOptionEntries,
        ...Object.entries(contributions.batchScrape),
      ]),
    )
      .refine(x => waitForRefine(x), waitForRefineOpts)
      .transform((x, ctx) =>
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
    ? buildBatchScrapeSchema(batchScrapeRequestSchemaBase)
    : batchScrapeRequestSchema;

  const batchScrapeNoURLValidation = hasBatchScrapeChanges
    ? buildBatchScrapeSchema(batchScrapeRequestSchemaNoURLValidationBase)
    : batchScrapeRequestSchemaNoURLValidation;

  const compiledScrapeOptions: z.ZodType<ScrapeOptions> =
    hasFormats || hasScrapeOptionsFields || hasRules
      ? baseScrapeOpts
          .refine(
            obj => {
              if (!obj.actions) {
                return true;
              }
              return (
                calculateTotalWaitTime(obj.actions, obj.waitFor) <=
                ACTIONS_MAX_WAIT_TIME * 1000
              );
            },
            {
              message: `Total wait time (waitFor + wait actions) cannot exceed ${ACTIONS_MAX_WAIT_TIME} seconds`,
            },
          )
          .refine(x => waitForRefine(x), waitForRefineOpts)
          .transform((x, ctx) =>
            applyExtractTransformAndRules(
              x,
              "scrape",
              contributions.rules,
              ctx,
            ),
          )
      : scrapeOptions;

  if (
    Object.hasOwn(contributions.scrapeOptions, "maxAge") ||
    Object.hasOwn(scrapeOptionFields.shape, "maxAge")
  ) {
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
  };
}

const maxAgeScrapeOptionsSchemas = new WeakSet<z.ZodType>();

/**
 * Returns whether the given compiled scrapeOptions schema accepts maxAge.
 */
export function scrapeOptionsAcceptsMaxAge(
  schema: z.ZodType = getV2RequestSchemas().scrapeOptions,
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

const ignoreInvalidURLsSchema = z.object({
  ignoreInvalidURLs: z.literal(true),
});

/**
 * Parses a v2 batch scrape request body through the active service schemas,
 * skipping upfront URL validation when `ignoreInvalidURLs` is explicitly true.
 */
export function parseBatchScrapeRequest(body: unknown): BatchScrapeRequest {
  const schemas = getV2RequestSchemas();
  if (ignoreInvalidURLsSchema.safeParse(body).success) {
    return schemas.batchScrapeNoURLValidation.parse(body);
  }
  return schemas.batchScrape.parse(body);
}
