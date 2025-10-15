import { Request, Response } from "express";
import { z } from "zod";
import { protocolIncluded, checkUrl } from "../../lib/validateUrl";
import { countries } from "../../lib/validate-country";
import {
  ExtractorOptions,
  PageOptions,
  ScrapeActionContent,
  Document as V0Document,
} from "../../lib/entities";
import { InternalOptions } from "../../scraper/scrapeURL";
import { getURLDepth } from "../../scraper/WebScraper/utils/maxDepthUtils";
import Ajv from "ajv";
import { ErrorCodes } from "../../lib/error";
import { integrationSchema } from "../../utils/integration";
import { webhookSchema } from "../../services/webhook/schema";

type Format =
  | "markdown"
  | "html"
  | "rawHtml"
  | "links"
  | "screenshot"
  | "screenshot@fullPage"
  | "extract"
  | "json"
  | "summary"
  | "changeTracking";

export const url = z.preprocess(
  x => {
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
  },
  z
    .string()
    .url()
    .regex(/^https?:\/\//i, "URL uses unsupported protocol")
    .refine(
      x =>
        /(\.[a-zA-Z0-9-\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]{2,}|\.xn--[a-zA-Z0-9-]{1,})(:\d+)?([\/?#]|$)/i.test(
          x,
        ),
      "URL must have a valid top-level domain or be a valid path",
    )
    .refine(x => {
      try {
        checkUrl(x as string);
        return true;
      } catch (_) {
        return false;
      }
    }, "Invalid URL"),
  // .refine((x) => !isUrlBlocked(x as string), BLOCKLISTED_URL_MESSAGE),
);

const strictMessage =
  "Unrecognized key in body -- please review the v1 API documentation for request body changes";

const agentExtractModelValue = "fire-1";
export const isAgentExtractModelValid = (x: string | undefined) =>
  x?.toLowerCase() === agentExtractModelValue;

function normalizeSchemaForOpenAI(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const visited = new WeakSet();

  function normalizeObject(obj: any): any {
    if (typeof obj !== "object" || obj === null) return obj;
    if (Array.isArray(obj)) return obj;

    if (visited.has(obj)) return obj;
    visited.add(obj);

    const normalized = { ...obj };

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
      if (typeof value === "object" && value !== null) {
        normalized[key] = normalizeObject(value);
      }
    }

    return normalized;
  }

  return normalizeObject(schema);
}
function validateSchemaForOpenAI(schema: any): boolean {
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const visited = new WeakSet();

  function hasInvalidStructure(obj: any): boolean {
    if (typeof obj !== "object" || obj === null) return false;

    if (visited.has(obj)) return false;
    visited.add(obj);

    if (
      obj.type === "object" &&
      !obj.hasOwnProperty("properties") &&
      !obj.hasOwnProperty("patternProperties") &&
      obj.additionalProperties === true
    ) {
      return true;
    }

    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null) {
        if (hasInvalidStructure(value)) return true;
      }
    }
    return false;
  }

  return !hasInvalidStructure(schema);
}

const OPENAI_SCHEMA_ERROR_MESSAGE =
  "Schema contains invalid structure for OpenAI: object type with no 'properties' defined but 'additionalProperties: true' (schema-less dictionary not supported by OpenAI). Please define specific properties for your object.";

export const agentOptionsExtract = z
  .object({
    model: z.string().default(agentExtractModelValue),
  })
  .strict(strictMessage);

export const extractOptions = z
  .object({
    mode: z.enum(["llm"]).default("llm"),
    schema: z
      .any()
      .optional()
      .refine(
        val => {
          if (!val) return true; // Allow undefined schema
          try {
            const validate = ajv.compile(val);
            return typeof validate === "function";
          } catch (e) {
            return false;
          }
        },
        {
          message: "Invalid JSON schema.",
        },
      )
      .transform(val => normalizeSchemaForOpenAI(val))
      .refine(val => validateSchemaForOpenAI(val), {
        message: OPENAI_SCHEMA_ERROR_MESSAGE,
      }),
    systemPrompt: z.string().max(10000).default(""),
    prompt: z.string().max(10000).optional(),
    temperature: z.number().optional(),
  })
  .strict(strictMessage)
  .transform(data => ({
    ...data,
    systemPrompt:
      "Based on the information on the page, extract all the information from the schema in JSON format. Try to extract all the fields even those that might not be marked as required.",
  }));

const extractOptionsWithAgent = z
  .object({
    mode: z.enum(["llm"]).default("llm"),
    schema: z
      .any()
      .optional()
      .refine(
        val => {
          if (!val) return true; // Allow undefined schema
          try {
            const validate = ajv.compile(val);
            return typeof validate === "function";
          } catch (e) {
            return false;
          }
        },
        {
          message: "Invalid JSON schema.",
        },
      )
      .transform(val => normalizeSchemaForOpenAI(val))
      .refine(val => validateSchemaForOpenAI(val), {
        message: OPENAI_SCHEMA_ERROR_MESSAGE,
      }),
    systemPrompt: z.string().max(10000).default(""),
    prompt: z.string().max(10000).optional(),
    temperature: z.number().optional(),
    agent: z
      .object({
        model: z.string().default(agentExtractModelValue),
        prompt: z.string().optional(),
      })
      .optional(),
  })
  .strict(strictMessage)
  .transform(data => ({
    ...data,
    systemPrompt: isAgentExtractModelValid(data.agent?.model)
      ? `You are an expert web data extractor. Your task is to analyze the provided markdown content from a web page and generate a JSON object based *strictly* on the provided schema.

Key Instructions:
1.  **Schema Adherence:** Populate the JSON object according to the structure defined in the schema.
2.  **Content Grounding:** Extract information *only* if it is explicitly present in the provided markdown. Do NOT infer or fabricate information.
3.  **Missing Information:** If a piece of information required by the schema cannot be found in the markdown, use \`null\` for that field's value.
4.  **SmartScrape Recommendation:**
    *   Assess if the *full* required data seems unavailable in the current markdown likely because:
        - Content requires user interaction to reveal (e.g., clicking buttons, hovering, scrolling)
        - Content uses pagination (e.g., "Load More" buttons, numbered pagination, infinite scroll)
        - Content is dynamically loaded after user actions
    *   If the content requires user interaction or pagination to be fully accessible, set \`shouldUseSmartscrape\` to \`true\` in your response and provide a clear \`reasoning\` and \`prompt\` for the SmartScrape tool.
    *   If the content is simply JavaScript rendered but doesn't require interaction, set \`shouldUseSmartscrape\` to \`false\`.
5.  **Output Format:** Your final output MUST be a single, valid JSON object conforming precisely to the schema. Do not include any explanatory text outside the JSON structure.`
      : "Based on the information on the page, extract all the information from the schema in JSON format. Try to extract all the fields even those that might not be marked as required.",
  }));

export type ExtractOptions = z.infer<typeof extractOptions>;

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
      milliseconds: z.number().int().positive().finite().optional(),
      selector: z.string().optional(),
    })
    .refine(
      data =>
        (data.milliseconds !== undefined || data.selector !== undefined) &&
        !(data.milliseconds !== undefined && data.selector !== undefined),
      {
        message:
          "Either 'milliseconds' or 'selector' must be provided, but not both.",
      },
    ),
  z.object({
    type: z.literal("click"),
    selector: z.string(),
    all: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("screenshot"),
    fullPage: z.boolean().default(false),
    quality: z.number().min(1).max(100).optional(),
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
    direction: z.enum(["up", "down"]).optional().default("down"),
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
    landscape: z.boolean().default(false),
    scale: z.number().default(1),
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
      .default("Letter"),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

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

function transformIframeSelector(selector: string): string {
  return selector.replace(/(?:^|[\s,])iframe(?=\s|$|[.#\[:,])/g, match => {
    const prefix = match.match(/^[\s,]/)?.[0] || "";
    return prefix + 'div[data-original-tag="iframe"]';
  });
}

const baseScrapeOptions = z
  .object({
    formats: z
      .enum([
        "markdown",
        "html",
        "rawHtml",
        "links",
        "screenshot",
        "screenshot@fullPage",
        "extract",
        "json",
        "summary",
        "changeTracking",
      ])
      .array()
      .optional()
      .default(["markdown"])
      .refine(
        x => !(x.includes("screenshot") && x.includes("screenshot@fullPage")),
        "You may only specify either screenshot or screenshot@fullPage",
      )
      .refine(
        x => !x.includes("changeTracking") || x.includes("markdown"),
        "The changeTracking format requires the markdown format to be specified as well",
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
    onlyMainContent: z.boolean().default(true),
    timeout: z.number().int().positive().finite().safe().optional(),
    waitFor: z
      .number()
      .int()
      .nonnegative()
      .finite()
      .safe()
      .max(60000)
      .default(0),
    // Deprecate this to jsonOptions
    extract: extractOptions.optional(),
    // New
    jsonOptions: extractOptions.optional(),
    changeTrackingOptions: z
      .object({
        prompt: z.string().optional(),
        schema: z
          .any()
          .optional()
          .refine(
            val => {
              if (!val) return true; // Allow undefined schema
              try {
                const validate = ajv.compile(val);
                return typeof validate === "function";
              } catch (e) {
                return false;
              }
            },
            {
              message: "Invalid JSON schema.",
            },
          )
          .transform(val => normalizeSchemaForOpenAI(val))
          .refine(val => validateSchemaForOpenAI(val), {
            message: OPENAI_SCHEMA_ERROR_MESSAGE,
          }),
        modes: z.enum(["json", "git-diff"]).array().optional().default([]),
        tag: z.string().or(z.null()).default(null),
      })
      .optional(),
    mobile: z.boolean().default(false),
    parsePDF: z.boolean().default(true),
    actions: actionsSchema.optional(),
    // New
    location: locationSchema,

    // Deprecated
    geolocation: z
      .object({
        country: z
          .string()
          .optional()
          .refine(
            val => !val || Object.keys(countries).includes(val.toUpperCase()),
            {
              message:
                "Invalid country code. Please use a valid ISO 3166-1 alpha-2 country code.",
            },
          )
          .transform(val => (val ? val.toUpperCase() : "US-generic")),
        languages: z.string().array().optional(),
      })
      .optional(),
    skipTlsVerification: z.boolean().optional(),
    removeBase64Images: z.boolean().default(true),
    fastMode: z.boolean().default(false),
    useMock: z.string().optional(),
    blockAds: z.boolean().default(true),
    proxy: z.enum(["basic", "stealth", "auto"]).default("basic"),
    maxAge: z.number().int().gte(0).safe().default(0),
    storeInCache: z.boolean().default(true),
    // @deprecated
    __experimental_cache: z.boolean().default(false).optional(),
    __searchPreviewToken: z.string().optional(),
    __experimental_omce: z.boolean().default(false).optional(),
    __experimental_omceDomain: z.string().optional(),
  })
  .strict(strictMessage);

const fire1Refine = obj => {
  if (
    obj.agent?.model?.toLowerCase() === "fire-1" &&
    obj.jsonOptions?.agent?.model?.toLowerCase() === "fire-1"
  ) {
    return false;
  }
  return true;
};
const fire1RefineOpts = {
  message:
    "You may only specify the FIRE-1 model in agent or jsonOptions.agent, but not both.",
};
const waitForRefine = obj => {
  if (obj.waitFor && obj.timeout) {
    if (typeof obj.timeout !== "number" || obj.timeout <= 0) {
      return false;
    }
    return obj.waitFor <= obj.timeout / 2;
  }
  return true;
};
const waitForRefineOpts = {
  message: "waitFor must not exceed half of timeout",
  path: ["waitFor"],
};
const extractRefine = obj => {
  const hasExtractFormat = obj.formats?.includes("extract");
  const hasExtractOptions = obj.extract !== undefined;
  const hasJsonFormat = obj.formats?.includes("json");
  const hasJsonOptions = obj.jsonOptions !== undefined;
  return (
    ((hasExtractFormat && hasExtractOptions) ||
      (!hasExtractFormat && !hasExtractOptions)) &&
    ((hasJsonFormat && hasJsonOptions) || (!hasJsonFormat && !hasJsonOptions))
  );
};
const extractRefineOpts = {
  message:
    "When 'extract' or 'json' format is specified, corresponding options must be provided, and vice versa",
};
const extractTransform = (obj: ScrapeOptions) => {
  // Handle timeout
  if (
    (obj.formats?.includes("extract") ||
      obj.extract ||
      obj.formats?.includes("json") ||
      obj.jsonOptions) &&
    obj.timeout === 30000
  ) {
    obj = { ...obj, timeout: 60000 };
  }

  if (
    obj.formats?.includes("changeTracking") &&
    (obj.waitFor === undefined || obj.waitFor < 5000)
  ) {
    obj = { ...obj, waitFor: 5000 };
  }

  if (obj.formats?.includes("changeTracking") && obj.timeout === 30000) {
    obj = { ...obj, timeout: 60000 };
  }

  if ((obj as ScrapeOptions).agent) {
    obj = { ...obj, timeout: 300000 };
  }

  if (
    (obj.proxy === "stealth" || obj.proxy === "auto") &&
    obj.timeout === 30000
  ) {
    obj = { ...obj, timeout: 120000 };
  }

  if (obj.formats?.includes("json")) {
    obj.formats.push("extract");
  }

  // Convert JSON options to extract options if needed
  if (obj.jsonOptions && !obj.extract) {
    obj = {
      ...obj,
      extract: obj.jsonOptions,
    };
  }

  return obj;
};

export const scrapeOptions = baseScrapeOptions
  .extend({
    agent: z
      .object({
        model: z.string().default(agentExtractModelValue),
        prompt: z.string(),
        sessionId: z.string().optional(),
        waitBeforeClosingMs: z.number().optional(),
      })
      .optional(),
    extract: extractOptionsWithAgent.optional(),
    jsonOptions: extractOptionsWithAgent.optional(),
  })
  .strict(strictMessage)
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
  .refine(extractRefine, extractRefineOpts)
  .refine(fire1Refine, fire1RefineOpts)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(obj => {
    return extractTransform(obj) as typeof obj;
  });

type BaseScrapeOptions = z.infer<typeof baseScrapeOptions>;

export type ScrapeOptions = BaseScrapeOptions & {
  extract?: z.infer<typeof extractOptionsWithAgent>;
  jsonOptions?: z.infer<typeof extractOptionsWithAgent>;
  agent?: {
    model: string;
    prompt: string;
    sessionId?: string;
    waitBeforeClosingMs?: number;
  };
};

const ajv = new Ajv();

const extractV1Options = z
  .object({
    urls: url
      .array()
      .max(10, "Maximum of 10 URLs allowed per request while in beta.")
      .optional(),
    prompt: z.string().max(10000).optional(),
    systemPrompt: z.string().max(10000).optional(),
    schema: z
      .any()
      .optional()
      .refine(
        val => {
          if (!val) return true; // Allow undefined schema
          try {
            const validate = ajv.compile(val);
            return typeof validate === "function";
          } catch (e) {
            return false;
          }
        },
        {
          message: "Invalid JSON schema.",
        },
      )
      .transform(val => normalizeSchemaForOpenAI(val))
      .refine(val => validateSchemaForOpenAI(val), {
        message: OPENAI_SCHEMA_ERROR_MESSAGE,
      }),
    limit: z.number().int().positive().finite().safe().optional(),
    ignoreSitemap: z.boolean().default(false),
    includeSubdomains: z.boolean().default(true),
    allowExternalLinks: z.boolean().default(false),
    enableWebSearch: z.boolean().default(false),
    scrapeOptions: baseScrapeOptions
      .default({ onlyMainContent: false })
      .optional(),
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    urlTrace: z.boolean().default(false),
    timeout: z.number().int().positive().finite().safe().default(60000),
    __experimental_streamSteps: z.boolean().default(false),
    __experimental_llmUsage: z.boolean().default(false),
    __experimental_showSources: z.boolean().default(false),
    showSources: z.boolean().default(false),
    __experimental_cacheKey: z.string().optional(),
    __experimental_cacheMode: z
      .enum(["direct", "save", "load"])
      .default("direct")
      .optional(),
    agent: agentOptionsExtract.optional(),
    __experimental_showCostTracking: z.boolean().default(false),
    ignoreInvalidURLs: z.boolean().default(false),
    webhook: webhookSchema.optional(),
  })
  .strict(strictMessage)
  .refine(obj => obj.urls || obj.prompt, {
    message: "Either 'urls' or 'prompt' must be provided.",
  })
  .transform(obj => ({
    ...obj,
    allowExternalLinks: obj.allowExternalLinks || obj.enableWebSearch,
  }))
  .refine(
    x => (x.scrapeOptions ? extractRefine(x.scrapeOptions) : true),
    extractRefineOpts,
  )
  .refine(
    x => (x.scrapeOptions ? fire1Refine(x.scrapeOptions) : true),
    fire1RefineOpts,
  )
  .refine(
    x => (x.scrapeOptions ? waitForRefine(x.scrapeOptions) : true),
    waitForRefineOpts,
  )
  .transform(x => ({
    ...x,
    scrapeOptions: x.scrapeOptions
      ? extractTransform(x.scrapeOptions)
      : x.scrapeOptions,
  }));

export const extractRequestSchema = extractV1Options;
export type ExtractRequest = z.infer<typeof extractRequestSchema>;
export type ExtractRequestInput = z.input<typeof extractRequestSchema>;

export const scrapeRequestSchema = baseScrapeOptions
  .omit({ timeout: true })
  .extend({
    url,
    agent: z
      .object({
        model: z.string().default(agentExtractModelValue),
        prompt: z.string(),
        sessionId: z.string().optional(),
        waitBeforeClosingMs: z.number().optional(),
      })
      .optional(),
    extract: extractOptionsWithAgent.optional(),
    jsonOptions: extractOptionsWithAgent.optional(),
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    timeout: z.number().int().positive().finite().safe().default(30000),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(extractRefine, extractRefineOpts)
  .refine(fire1Refine, fire1RefineOpts)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(obj => {
    return extractTransform(obj) as typeof obj;
  });

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;
export type ScrapeRequestInput = z.input<typeof scrapeRequestSchema>;

export const batchScrapeRequestSchema = baseScrapeOptions
  .extend({
    urls: url.array().min(1),
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    webhook: webhookSchema.optional(),
    appendToId: z.string().uuid().optional(),
    ignoreInvalidURLs: z.boolean().default(false),
    maxConcurrency: z.number().positive().int().optional(),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(extractRefine, extractRefineOpts)
  .refine(fire1Refine, fire1RefineOpts)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(obj => extractTransform(obj) as typeof obj);

export const batchScrapeRequestSchemaNoURLValidation = baseScrapeOptions
  .extend({
    urls: z.string().array().min(1),
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    webhook: webhookSchema.optional(),
    appendToId: z.string().uuid().optional(),
    ignoreInvalidURLs: z.boolean().default(false),
    maxConcurrency: z.number().positive().int().optional(),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(extractRefine, extractRefineOpts)
  .refine(fire1Refine, fire1RefineOpts)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(obj => extractTransform(obj) as typeof obj);

export type BatchScrapeRequest = z.infer<typeof batchScrapeRequestSchema>;
export type BatchScrapeRequestInput = z.input<typeof batchScrapeRequestSchema>;

const crawlerOptions = z
  .object({
    includePaths: z.string().array().default([]),
    excludePaths: z.string().array().default([]),
    maxDepth: z.number().default(10), // default?
    maxDiscoveryDepth: z.number().optional(),
    limit: z.number().default(10000), // default?
    allowBackwardLinks: z.boolean().default(false), // DEPRECATED: use crawlEntireDomain
    crawlEntireDomain: z.boolean().optional(),
    allowExternalLinks: z.boolean().default(false),
    allowSubdomains: z.boolean().default(false),
    ignoreRobotsTxt: z.boolean().default(false),
    ignoreSitemap: z.boolean().default(false),
    deduplicateSimilarURLs: z.boolean().default(true),
    ignoreQueryParameters: z.boolean().default(false),
    regexOnFullURL: z.boolean().default(false),
    delay: z.number().positive().optional(),
  })
  .strict(strictMessage);

// export type CrawlerOptions = {
//   includePaths?: string[];
//   excludePaths?: string[];
//   maxDepth?: number;
//   limit?: number;
//   allowBackwardLinks?: boolean; // DEPRECATED: use crawlEntireDomain
//   crawlEntireDomain?: boolean;
//   allowExternalLinks?: boolean;
//   ignoreSitemap?: boolean;
// };

type CrawlerOptions = z.infer<typeof crawlerOptions>;

export const crawlRequestSchema = crawlerOptions
  .extend({
    url,
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    scrapeOptions: baseScrapeOptions.default({}),
    webhook: webhookSchema.optional(),
    limit: z.number().default(10000),
    maxConcurrency: z.number().positive().int().optional(),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(x => extractRefine(x.scrapeOptions), extractRefineOpts)
  .refine(x => fire1Refine(x.scrapeOptions), fire1RefineOpts)
  .refine(x => waitForRefine(x.scrapeOptions), waitForRefineOpts)
  .refine(
    data => {
      try {
        const urlDepth = getURLDepth(data.url);
        return urlDepth <= data.maxDepth;
      } catch (e) {
        return false;
      }
    },
    {
      message: "URL depth exceeds the specified maxDepth",
      path: ["url"],
    },
  )
  .transform(x => {
    if (x.crawlEntireDomain !== undefined) {
      x.allowBackwardLinks = x.crawlEntireDomain;
    }
    return {
      ...x,
      scrapeOptions: extractTransform(x.scrapeOptions),
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

// Note: Map types have been transitioned to v2/types.ts while maintaining backwards compatibility
export const mapRequestSchema = crawlerOptions
  .omit({ ignoreQueryParameters: true })
  .extend({
    url,
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    includeSubdomains: z.boolean().default(true),
    search: z.string().optional(),
    ignoreQueryParameters: z.boolean().default(true),
    ignoreSitemap: z.boolean().default(false),
    sitemapOnly: z.boolean().default(false),
    limit: z.number().min(1).max(MAX_MAP_LIMIT).default(5000),
    timeout: z.number().positive().finite().optional(),
    useMock: z.string().optional(),
    filterByPath: z.boolean().default(true),
    useIndex: z.boolean().default(true),
    location: locationSchema,
  })
  .strict(strictMessage);

// export type MapRequest = {
//   url: string;
//   crawlerOptions?: CrawlerOptions;
// };

export type MapRequest = z.infer<typeof mapRequestSchema>;
export type MapRequestInput = z.input<typeof mapRequestSchema>;

export type Document = {
  title?: string;
  description?: string;
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  images?: string[];
  screenshot?: string;
  extract?: any;
  json?: any;
  summary?: string;
  warning?: string;
  actions?: {
    screenshots?: string[];
    scrapes?: ScrapeActionContent[];
    javascriptReturns?: {
      type: string;
      value: unknown;
    }[];
    pdfs?: string[];
  };
  changeTracking?: {
    previousScrapeAt: string | null;
    changeStatus: "new" | "same" | "changed" | "removed";
    visibility: "visible" | "hidden";
    diff?: {
      text: string;
      json: {
        files: Array<{
          from: string | null;
          to: string | null;
          chunks: Array<{
            content: string;
            changes: Array<{
              type: string;
              normal?: boolean;
              ln?: number;
              ln1?: number;
              ln2?: number;
              content: string;
            }>;
          }>;
        }>;
      };
    };
    json?: any;
  };
  metadata: {
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
    contentType?: string;
    proxyUsed: "basic" | "stealth";
    cacheState?: "hit" | "miss";
    cachedAt?: string;
    creditsUsed?: number;
    postprocessorsUsed?: string[];
    indexId?: string; // ID used to store the document in the index (GCS)
    // [key: string]: string | string[] | number | { smartScrape: number; other: number; total: number } | undefined;
  };
  serpResults?: {
    title: string;
    description: string;
    url: string;
  };
};

export type ErrorResponse = {
  success: false;
  code?: ErrorCodes;
  error: string;
  details?: any;
};

export type ScrapeResponse =
  | ErrorResponse
  | {
      success: true;
      warning?: string;
      data: Document;
      scrape_id?: string;
    };

export interface URLTrace {
  url: string;
  status: "mapped" | "scraped" | "error";
  timing: {
    discoveredAt: string;
    scrapedAt?: string;
    completedAt?: string;
  };
  error?: string;
  warning?: string;
  contentStats?: {
    rawContentLength: number;
    processedContentLength: number;
    tokensUsed: number;
  };
  relevanceScore?: number;
  usedInCompletion?: boolean;
  extractedFields?: string[];
}

export interface ExtractResponse {
  success: boolean;
  error?: string;
  data?: any;
  scrape_id?: string;
  id?: string;
  warning?: string;
  urlTrace?: URLTrace[];
  sources?: {
    [key: string]: string[];
  };
  tokensUsed?: number;
}

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

// Note: This type has been transitioned to v2/types.ts (see MapV2Response) while maintaining backwards compatibility
export type MapResponse =
  | ErrorResponse
  | {
      success: true;
      links: string[];
      scrape_id?: string;
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
      maxConcurrency: number;
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
      next?: string;
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
        error: string;
      }[];
      robotsBlocked: string[];
    };

type AuthObject = {
  team_id: string;
};

type Account = {
  remainingCredits: number;
};

export type AuthCreditUsageChunk = {
  api_key: string;
  api_key_id: number;
  team_id: string;
  sub_id: string | null;
  sub_current_period_start: string | null;
  sub_current_period_end: string | null;
  sub_user_id: string | null;
  price_id: string | null;
  price_credits: number; // credit limit with assoicated price, or free_credits (500) if free plan
  price_should_be_graceful: boolean;
  price_associated_auto_recharge_price_id: string | null;
  credits_used: number;
  coupon_credits: number; // do not rely on this number to be up to date after calling a billTeam
  adjusted_credits_used: number; // credits this period minus coupons used
  remaining_credits: number;
  total_credits_sum: number;
  plan_priority: {
    bucketLimit: number;
    planModifier: number;
  };
  rate_limits: {
    crawl: number;
    scrape: number;
    search: number;
    map: number;
    extract: number;
    preview: number;
    crawlStatus: number;
    extractStatus: number;
    extractAgentPreview?: number;
    scrapeAgentPreview?: number;
  };
  concurrency: number;
  flags: TeamFlags;

  // appended on JS-side
  is_extract?: boolean;
};

export type TeamFlags = {
  ignoreRobots?: boolean;
  unblockedDomains?: string[];
  forceZDR?: boolean;
  allowZDR?: boolean;
  zdrCost?: number;
  checkRobotsOnScrape?: boolean;
  allowTeammateInvites?: boolean;
  crawlTtlHours?: number;
  ipWhitelist?: boolean;
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
}

export interface RequestWithAuth<
  ReqParams = {},
  ReqBody = undefined,
  ResBody = undefined,
> extends Request<ReqParams, ReqBody, ResBody> {
  auth: AuthObject;
  account?: Account;
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

export interface ResponseWithSentry<ResBody = undefined>
  extends Response<ResBody> {
  sentry?: string;
}

export function toLegacyCrawlerOptions(x: CrawlerOptions) {
  return {
    includes: x.includePaths,
    excludes: x.excludePaths,
    maxCrawledLinks: x.limit,
    maxDepth: x.maxDepth,
    limit: x.limit,
    generateImgAltText: false,
    allowBackwardCrawling: x.crawlEntireDomain ?? x.allowBackwardLinks,
    allowExternalContentLinks: x.allowExternalLinks,
    allowSubdomains: x.allowSubdomains,
    ignoreRobotsTxt: x.ignoreRobotsTxt,
    ignoreSitemap: x.ignoreSitemap,
    deduplicateSimilarURLs: x.deduplicateSimilarURLs,
    ignoreQueryParameters: x.ignoreQueryParameters,
    regexOnFullURL: x.regexOnFullURL,
    maxDiscoveryDepth: x.maxDiscoveryDepth,
    currentDiscoveryDepth: 0,
    delay: x.delay,
  };
}

export function toNewCrawlerOptions(x: any): CrawlerOptions {
  return {
    includePaths: x.includes,
    excludePaths: x.excludes,
    limit: x.limit,
    maxDepth: x.maxDepth,
    allowBackwardLinks: x.allowBackwardCrawling,
    crawlEntireDomain: x.allowBackwardCrawling,
    allowExternalLinks: x.allowExternalContentLinks,
    allowSubdomains: x.allowSubdomains,
    ignoreRobotsTxt: x.ignoreRobotsTxt,
    ignoreSitemap: x.ignoreSitemap,
    deduplicateSimilarURLs: x.deduplicateSimilarURLs,
    ignoreQueryParameters: x.ignoreQueryParameters,
    regexOnFullURL: x.regexOnFullURL,
    maxDiscoveryDepth: x.maxDiscoveryDepth,
    delay: x.delay,
  };
}

function fromLegacyCrawlerOptions(
  x: any,
  teamId: string,
): {
  crawlOptions: CrawlerOptions;
  internalOptions: InternalOptions;
} {
  return {
    crawlOptions: crawlerOptions.parse({
      includePaths: x.includes,
      excludePaths: x.excludes,
      limit: x.maxCrawledLinks ?? x.limit,
      maxDepth: x.maxDepth,
      allowBackwardLinks: x.allowBackwardCrawling,
      crawlEntireDomain: x.allowBackwardCrawling,
      allowExternalLinks: x.allowExternalContentLinks,
      allowSubdomains: x.allowSubdomains,
      ignoreRobotsTxt: x.ignoreRobotsTxt,
      ignoreSitemap: x.ignoreSitemap,
      deduplicateSimilarURLs: x.deduplicateSimilarURLs,
      ignoreQueryParameters: x.ignoreQueryParameters,
      regexOnFullURL: x.regexOnFullURL,
      maxDiscoveryDepth: x.maxDiscoveryDepth,
      delay: x.delay,
    }),
    internalOptions: {
      v0CrawlOnlyUrls: x.returnOnlyUrls,
      teamId,
    },
  };
}

// Note: This interface has been transitioned to v2/types.ts while maintaining backwards compatibility
export interface MapDocument {
  url: string;
  title?: string;
  description?: string;
}
export function fromLegacyScrapeOptions(
  pageOptions: PageOptions,
  extractorOptions: ExtractorOptions | undefined,
  timeout: number | undefined,
  teamId: string,
): { scrapeOptions: ScrapeOptions; internalOptions: InternalOptions } {
  return {
    scrapeOptions: scrapeOptions.parse({
      formats: [
        (pageOptions.includeMarkdown ?? true) ? ("markdown" as const) : null,
        (pageOptions.includeHtml ?? false) ? ("html" as const) : null,
        (pageOptions.includeRawHtml ?? false) ? ("rawHtml" as const) : null,
        (pageOptions.screenshot ?? false) ? ("screenshot" as const) : null,
        (pageOptions.fullPageScreenshot ?? false)
          ? ("screenshot@fullPage" as const)
          : null,
        extractorOptions !== undefined &&
        extractorOptions.mode.includes("llm-extraction")
          ? ("extract" as const)
          : null,
        "links",
      ].filter(x => x !== null),
      waitFor: pageOptions.waitFor,
      headers: pageOptions.headers,
      includeTags:
        typeof pageOptions.onlyIncludeTags === "string"
          ? [pageOptions.onlyIncludeTags]
          : pageOptions.onlyIncludeTags,
      excludeTags:
        typeof pageOptions.removeTags === "string"
          ? [pageOptions.removeTags]
          : pageOptions.removeTags,
      onlyMainContent: pageOptions.onlyMainContent ?? false,
      timeout: timeout,
      parsePDF: pageOptions.parsePDF,
      actions: pageOptions.actions,
      location: pageOptions.geolocation,
      skipTlsVerification: pageOptions.skipTlsVerification,
      removeBase64Images: pageOptions.removeBase64Images,
      extract:
        extractorOptions !== undefined &&
        extractorOptions.mode.includes("llm-extraction")
          ? {
              systemPrompt: extractorOptions.extractionPrompt,
              prompt: extractorOptions.userPrompt,
              schema: extractorOptions.extractionSchema,
            }
          : undefined,
      mobile: pageOptions.mobile,
      fastMode: pageOptions.useFastMode,
    }),
    internalOptions: {
      atsv: pageOptions.atsv,
      v0DisableJsDom: pageOptions.disableJsDom,
      teamId,
    },
    // TODO: fallback, fetchPageContent, replaceAllPathsWithAbsolutePaths, includeLinks
  };
}

export function toLegacyDocument(
  document: Document,
  internalOptions: InternalOptions,
): V0Document | { url: string } {
  if (internalOptions.v0CrawlOnlyUrls) {
    return { url: document.metadata.sourceURL! };
  }

  return {
    content: document.markdown!,
    markdown: document.markdown!,
    html: document.html,
    rawHtml: document.rawHtml,
    linksOnPage: document.links,
    llm_extraction: document.extract,
    metadata: {
      ...document.metadata,
      error: undefined,
      statusCode: undefined,
      pageError: document.metadata.error,
      pageStatusCode: document.metadata.statusCode,
      screenshot: document.screenshot,
    },
    actions: document.actions,
    warning: document.warning,
  };
}

export const searchRequestSchema = z
  .object({
    query: z.string(),
    limit: z
      .number()
      .int()
      .positive()
      .finite()
      .safe()
      .max(100)
      .optional()
      .default(5),
    tbs: z.string().optional(),
    filter: z.string().optional(),
    lang: z.string().optional().default("en"),
    country: z.string().optional(),
    location: z.string().optional(),
    origin: z.string().optional().default("api"),
    integration: integrationSchema.optional().transform(val => val || null),
    timeout: z.number().int().positive().finite().safe().default(60000),
    ignoreInvalidURLs: z.boolean().optional().default(false),
    __searchPreviewToken: z.string().optional(),
    scrapeOptions: baseScrapeOptions
      .extend({
        formats: z
          .array(
            z.enum([
              "markdown",
              "html",
              "rawHtml",
              "links",
              "screenshot",
              "screenshot@fullPage",
              "extract",
              "json",
            ]),
          )
          .default([]),
      })
      .default({}),
  })
  .strict(
    "Unrecognized key in body -- please review the v1 API documentation for request body changes",
  )
  .refine(x => extractRefine(x.scrapeOptions), extractRefineOpts)
  .refine(x => fire1Refine(x.scrapeOptions), fire1RefineOpts)
  .refine(x => waitForRefine(x.scrapeOptions), waitForRefineOpts)
  .transform(x => ({
    ...x,
    country:
      x.country !== undefined ? x.country : x.location ? undefined : "us",
    scrapeOptions: extractTransform(x.scrapeOptions),
  }));

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchRequestInput = z.input<typeof searchRequestSchema>;

export type SearchResponse =
  | ErrorResponse
  | {
      success: true;
      warning?: string;
      data: Document[];
    };

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  step?: string;
  model?: string;
};

export const generateLLMsTextRequestSchema = z.object({
  url: url.describe("The URL to generate text from"),
  maxUrls: z
    .number()
    .min(1)
    .max(5000)
    .default(10)
    .describe("Maximum number of URLs to process"),
  showFullText: z
    .boolean()
    .default(false)
    .describe("Whether to show the full LLMs-full.txt in the response"),
  cache: z
    .boolean()
    .default(true)
    .describe("Whether to use cached content if available"),
  __experimental_stream: z.boolean().optional(),
});

export type GenerateLLMsTextRequest = z.infer<
  typeof generateLLMsTextRequestSchema
>;
