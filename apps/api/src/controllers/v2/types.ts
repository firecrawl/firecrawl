import { Request, Response } from "express";
import { z } from "zod";
import { protocolIncluded, checkUrl } from "../../lib/validateUrl";
import { countries } from "../../lib/validate-country";
import {
  ExtractorOptions,
  PageOptions,
  ScrapeActionContent,
  Document as V0Document,
  WebSearchResult,
} from "../../lib/entities";
import { agentOptionsExtract, ScrapeOptions as V1ScrapeOptions } from "../v1/types";
import type { InternalOptions } from "../../scraper/scrapeURL";
import { ErrorCodes } from "../../lib/error";
import Ajv from "ajv";

export enum IntegrationEnum {
  DIFY = "dify",
  ZAPIER = "zapier",
  PIPEDREAM = "pipedream",
  RAYCAST = "raycast",
  LANGCHAIN = "langchain",
  CREWAI = "crewai",
  LLAMAINDEX = "llamaindex",
  N8N = "n8n",
  CAMELAI = "camelai",
  MAKE = "make",
  FLOWISE = "flowise",
  METAGPT = "metagpt",
  RELEVANCEAI = 'relevanceai',
}

export type Format =
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
  (x) => {
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
      (x) =>
        /(\.[a-zA-Z0-9-\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]{2,}|\.xn--[a-zA-Z0-9-]{1,})(:\d+)?([\/?#]|$)/i.test(
          x,
        ),
      "URL must have a valid top-level domain or be a valid path",
    )
    .refine((x) => {
      try {
        checkUrl(x as string);
        return true;
      } catch (_) {
        return false;
      }
    }, "Invalid URL")
  // .refine((x) => !isUrlBlocked(x as string), BLOCKLISTED_URL_MESSAGE),
);

const strictMessage =
  "Unrecognized key in body -- please review the v2 API documentation for request body changes";

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

export const actionSchema = z
  .union([
    z
      .object({
        type: z.literal("wait"),
        milliseconds: z.number().int().positive().finite().optional(),
        selector: z.string().optional(),
      })
      .refine(
        (data) =>
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
      viewport: z.object({
        width: z.number().int().positive().finite().max(7680), // 8K resolution width
        height: z.number().int().positive().finite().max(4320), // 8K resolution height
      }).optional(),
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
      format: z.enum(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid', 'Ledger']).default("Letter"),
    }),
  ]);

export type Action = z.infer<typeof actionSchema>;

export const actionsSchema = z
  .array(actionSchema)
  .refine((actions) => actions.length <= MAX_ACTIONS, {
    message: `Number of actions cannot exceed ${MAX_ACTIONS}`,
  })
  .refine(
    (actions) =>
      calculateTotalWaitTime(actions) <= ACTIONS_MAX_WAIT_TIME * 1000,
    {
      message: `Total wait time (waitFor + wait actions) cannot exceed ${ACTIONS_MAX_WAIT_TIME} seconds`,
    },
  );

export const jsonFormatWithOptions = z.object({
  type: z.literal("json"),
  schema: z.any().optional(),
  prompt: z.string().max(10000).optional(),
}).strict();

export type JsonFormatWithOptions = z.output<typeof jsonFormatWithOptions>;

export const changeTrackingFormatWithOptions = z.object({
  type: z.literal("changeTracking"),
  prompt: z.string().optional(),
  schema: z.any().optional(),
  modes: z.enum(["json", "git-diff"]).array().optional().default([]),
  tag: z.string().or(z.null()).default(null),
}).strict();

export type ChangeTrackingFormatWithOptions = z.output<typeof changeTrackingFormatWithOptions>;

export const screenshotFormatWithOptions = z.object({
  type: z.literal("screenshot"),
  fullPage: z.boolean().default(false),
  quality: z.number().min(1).max(100).optional(),
  viewport: z.object({
    width: z.number().int().positive().finite().max(7680), // 8K resolution width
    height: z.number().int().positive().finite().max(4320), // 8K resolution height
  }).optional(),
});

export type ScreenshotFormatWithOptions = z.output<typeof screenshotFormatWithOptions>;

export const attributesFormatWithOptions = z.object({
  type: z.literal("attributes"),
  selectors: z.array(z.object({
    selector: z.string().describe("CSS selector to find elements"),
    attribute: z.string().describe("Attribute name to extract (e.g., 'data-vehicle-name' or 'id')")
  })).describe("Extract specific attributes from elements"),
}).strict();

export type AttributesFormatWithOptions = z.output<typeof attributesFormatWithOptions>;


export type FormatObject = 
  | { type: "markdown" }
  | { type: "html" }
  | { type: "rawHtml" }
  | { type: "links" }
  | { type: "summary" }
  | JsonFormatWithOptions
  | ChangeTrackingFormatWithOptions
  | ScreenshotFormatWithOptions
  | AttributesFormatWithOptions

export const parsersSchema = z.array(z.enum(["pdf"])).default(["pdf"]);

export type Parsers = z.infer<typeof parsersSchema>;

function transformIframeSelector(selector: string): string {
  return selector.replace(/(?:^|[\s,])iframe(?=\s|$|[.#\[:,])/g, (match) => {
    const prefix = match.match(/^[\s,]/)?.[0] || '';
    return prefix + 'div[data-original-tag="iframe"]';
  });
}

const baseScrapeOptions = z
  .object({
    formats: z.preprocess(
      (val) => {
        if (!Array.isArray(val)) return val;
        return val.map(format => {
          if (typeof format === 'string') {
            return { type: format };
          }
          return format;
        });
      },
      z
        .union([
          z.object({ type: z.literal("markdown") }),
          z.object({ type: z.literal("html") }),
          z.object({ type: z.literal("rawHtml") }),
          z.object({ type: z.literal("links") }),
          z.object({ type: z.literal("summary") }),
          jsonFormatWithOptions,
          changeTrackingFormatWithOptions,
          screenshotFormatWithOptions,
          attributesFormatWithOptions,
        ])
        .array()
        .optional()
        .default([{ type: "markdown" }])
    )
      .refine(
        (x) => {
          return x.filter(f => f.type === "screenshot").length <= 1;
        },
        "You may only specify one screenshot format",
      )
      .refine(
        (x) => {
          const hasChangeTracking = x.find(f => f.type === "changeTracking");
          const hasMarkdown = x.find(f => f.type === "markdown");
          return !hasChangeTracking || hasMarkdown;
        },
        "The changeTracking format requires the markdown format to be specified as well",
      ),
    headers: z.record(z.string(), z.string()).optional(),
    includeTags: z.string().array()
      .transform(tags => tags.map(transformIframeSelector))
      .optional(),
    excludeTags: z.string().array()
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
    mobile: z.boolean().default(false),
    parsers: parsersSchema.optional(),
    actions: actionsSchema.optional(),
    
    location: z
      .object({
        country: z
          .string()
          .optional()
          .refine(
            (val) =>
              !val ||
              Object.keys(countries).includes(val.toUpperCase()) ||
              val === "US-generic",
            {
              message:
                "Invalid country code. Please use a valid ISO 3166-1 alpha-2 country code.",
            },
          )
          .transform((val) => (val ? val.toUpperCase() : "US-generic")),
        languages: z.string().array().optional(),
      })
      .optional(),

    skipTlsVerification: z.boolean().default(true),
    removeBase64Images: z.boolean().default(true),
    fastMode: z.boolean().default(false),
    useMock: z.string().optional(),
    blockAds: z.boolean().default(true),
    proxy: z.enum(["basic", "stealth", "auto"]).default("auto"),
    maxAge: z.number().int().gte(0).safe().optional(),
    storeInCache: z.boolean().default(true),
    // @deprecated
    __searchPreviewToken: z.string().optional(),
    __experimental_omce: z.boolean().default(false).optional(),
    __experimental_omceDomain: z.string().optional(),
  })
  .strict(strictMessage);

const waitForRefine = (obj) => {
  if (obj.waitFor && obj.timeout) {
    if (typeof obj.timeout !== 'number' || obj.timeout <= 0) {
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
const extractTransform = (obj) => {
  // Handle timeout
  if (
    (obj.formats.find(x => typeof x === "object" && x.type === "json")) &&
    obj.timeout === 30000
  ) {
    obj = { ...obj, timeout: 60000 };
  }

  if (obj.formats?.includes("changeTracking") && (obj.waitFor === undefined || obj.waitFor < 5000)) {
    obj = { ...obj, waitFor: 5000 };
  }

  if (obj.formats?.includes("changeTracking") && obj.timeout === 30000) {
    obj = { ...obj, timeout: 60000 };
  }


  if ((obj.proxy === "stealth" || obj.proxy === "auto") && obj.timeout === 30000) {
    obj = { ...obj, timeout: 120000 };
  }

  return obj;
};

export const scrapeOptions = baseScrapeOptions
  .strict(strictMessage)
  .refine(
    (obj) => {
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
  .transform(extractTransform);

export type BaseScrapeOptions = z.infer<typeof baseScrapeOptions>;

export type ScrapeOptions = BaseScrapeOptions;

const ajv = new Ajv();

export const extractOptions = z
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
        (val) => {
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
      ),
    limit: z.number().int().positive().finite().safe().optional(),
    ignoreSitemap: z.boolean().default(false),
    includeSubdomains: z.boolean().default(true),
    allowExternalLinks: z.boolean().default(false),
    enableWebSearch: z.boolean().default(false),
    scrapeOptions: baseScrapeOptions.default({ onlyMainContent: false }).optional(),
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    urlTrace: z.boolean().default(false),
    timeout: z.number().int().positive().finite().safe().optional(),
    agent: agentOptionsExtract.optional(),
    __experimental_streamSteps: z.boolean().default(false),
    __experimental_llmUsage: z.boolean().default(false),
    __experimental_showSources: z.boolean().default(false),
    showSources: z.boolean().default(false),
    __experimental_cacheKey: z.string().optional(),
    __experimental_cacheMode: z
      .enum(["direct", "save", "load"])
      .default("direct")
      .optional(),
    __experimental_showCostTracking: z.boolean().default(false),
    ignoreInvalidURLs: z.boolean().default(true),
  })
  .strict(strictMessage)
  .refine((obj) => obj.urls || obj.prompt, {
    message: "Either 'urls' or 'prompt' must be provided.",
  })
  .transform((obj) => ({
    ...obj,
    allowExternalLinks: obj.allowExternalLinks || obj.enableWebSearch,
  }))
  .refine(
    (x) => (x.scrapeOptions ? waitForRefine(x.scrapeOptions) : true),
    waitForRefineOpts,
  )
  .transform((x) => ({
    ...x,
    scrapeOptions: x.scrapeOptions
      ? extractTransform(x.scrapeOptions)
      : x.scrapeOptions,
  }));

export type ExtractOptions = z.infer<typeof extractOptions>;
export const extractRequestSchema = extractOptions;
export type ExtractRequest = z.infer<typeof extractRequestSchema>;
export type ExtractRequestInput = z.input<typeof extractRequestSchema>;

export const scrapeRequestSchema = baseScrapeOptions
  .extend({
    url,
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransform);

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;
export type ScrapeRequestInput = z.input<typeof scrapeRequestSchema>;

export const webhookSchema = z.preprocess(
  (x) => {
    if (typeof x === "string") {
      return { url: x };
    } else {
      return x;
    }
  },
  z
    .object({
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).default({}),
      metadata: z.record(z.string(), z.string()).default({}),
      events: z
        .array(z.enum(["completed", "failed", "page", "started"]))
        .default(["completed", "failed", "page", "started"]),
    })
    .strict(strictMessage),
);

export const batchScrapeRequestSchema = baseScrapeOptions
  .extend({
    urls: url.array(),
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    webhook: webhookSchema.optional(),
    appendToId: z.string().uuid().optional(),
    ignoreInvalidURLs: z.boolean().default(true),
    maxConcurrency: z.number().positive().int().optional(),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransform);

export const batchScrapeRequestSchemaNoURLValidation = baseScrapeOptions
  .extend({
    urls: z.string().array(),
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    webhook: webhookSchema.optional(),
    appendToId: z.string().uuid().optional(),
    ignoreInvalidURLs: z.boolean().default(true),
    maxConcurrency: z.number().positive().int().optional(),
    zeroDataRetention: z.boolean().optional(),
  })
  .strict(strictMessage)
  .refine(waitForRefine, waitForRefineOpts)
  .transform(extractTransform);

export type BatchScrapeRequest = z.infer<typeof batchScrapeRequestSchema>;
export type BatchScrapeRequestInput = z.input<typeof batchScrapeRequestSchema>;

const crawlerOptions = z
  .object({
    includePaths: z.string().array().default([]),
    excludePaths: z.string().array().default([]),
    maxDiscoveryDepth: z.number().optional(),
    limit: z.number().default(10000), // default?
    crawlEntireDomain: z.boolean().optional(),
    allowExternalLinks: z.boolean().default(false),
    allowSubdomains: z.boolean().default(false),
    ignoreRobotsTxt: z.boolean().default(false),
    sitemap: z.enum(["skip", "include"]).default("include"),
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
//   crawlEntireDomain?: boolean;
//   allowExternalLinks?: boolean;
//   ignoreSitemap?: boolean;
// };

export type CrawlerOptions = z.infer<typeof crawlerOptions>;

export const crawlRequestSchema = crawlerOptions
  .extend({
    url,
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    scrapeOptions: baseScrapeOptions.default({}),
    webhook: webhookSchema.optional(),
    limit: z.number().default(10000),
    maxConcurrency: z.number().positive().int().optional(),
    zeroDataRetention: z.boolean().optional(),
    prompt: z.string().max(10000).optional(),
  })
  .strict(strictMessage)
  .refine((x) => waitForRefine(x.scrapeOptions), waitForRefineOpts)
  .transform((x) => {
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

export const mapRequestSchema = crawlerOptions
  .omit({ sitemap: true, ignoreQueryParameters: true })
  .extend({
    url,
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    includeSubdomains: z.boolean().default(true),
    ignoreQueryParameters: z.boolean().default(true),
    search: z.string().optional(),
    sitemap: z.enum(["only", "include", "skip"]).default("include"),
    limit: z.number().min(1).max(30000).default(5000),
    timeout: z.number().positive().finite().optional(),
    useMock: z.string().optional(),
    filterByPath: z.boolean().default(true),
    useIndex: z.boolean().default(true),
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
  screenshot?: string;
  extract?: any;
  json?: any;
  summary?: string;
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
  }
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

export interface ScrapeResponseRequestTest {
  statusCode: number;
  body: ScrapeResponse;
  error?: string;
}

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

export interface ExtractResponseRequestTest {
  statusCode: number;
  body: ExtractResponse;
  error?: string;
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

// Map document interface (transitioned from v1)
export interface MapDocument {
  url: string;
  title?: string;
  description?: string;
}

// V2 Map Response with dictionary format
export type MapResponse =
  | ErrorResponse
  | {
    success: true;
    links?: MapDocument[];
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
      code?: ErrorCodes;
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
  team_id: string;
  sub_id: string | null;
  sub_current_period_start: string | null;
  sub_current_period_end: string | null;
  sub_user_id: string | null;
  price_id: string | null;
  price_credits: number; // credit limit with assoicated price, or free_credits (500) if free plan
  price_should_be_graceful: boolean;
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
} | null;

export type AuthCreditUsageChunkFromTeam = Omit<AuthCreditUsageChunk, "api_key">;

export interface RequestWithMaybeACUC<
  ReqParams = {},
  ReqBody = undefined,
  ResBody = undefined,
> extends Request<ReqParams, ReqBody, ResBody> {
  acuc?: AuthCreditUsageChunk;
}

export interface RequestWithACUC<
  ReqParams = {},
  ReqBody = undefined,
  ResBody = undefined,
> extends Request<ReqParams, ReqBody, ResBody> {
  acuc: AuthCreditUsageChunk;
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
> extends RequestWithACUC<ReqParams, ReqBody, ResBody> {
  auth: AuthObject;
  account?: Account;
}

export interface ResponseWithSentry<ResBody = undefined>
  extends Response<ResBody> {
  sentry?: string;
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
    ignoreSitemap: x.sitemap === "skip",
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
    sitemap: x.ignoreSitemap ? "skip" : "include",
    deduplicateSimilarURLs: x.deduplicateSimilarURLs,
    ignoreQueryParameters: x.ignoreQueryParameters,
    regexOnFullURL: x.regexOnFullURL,
    maxDiscoveryDepth: x.maxDiscoveryDepth,
    delay: x.delay,
  }
}

export function fromV0CrawlerOptions(x: any, teamId: string): {
  crawlOptions: CrawlerOptions;
  internalOptions: InternalOptions;
} {
  return {
    crawlOptions: crawlerOptions.parse({
      includePaths: x.includes,
      excludePaths: x.excludes,
      limit: x.maxCrawledLinks ?? x.limit,
      crawlEntireDomain: x.allowBackwardCrawling,
      allowExternalLinks: x.allowExternalContentLinks,
      allowSubdomains: x.allowSubdomains,
      ignoreRobotsTxt: x.ignoreRobotsTxt,
      sitemap: x.ignoreSitemap ? "skip" : "include",
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

export interface MapDocument {
  url: string;
  title?: string;
  description?: string;
}
export function fromV0ScrapeOptions(
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
          ? ({ type: "screenshot" as const, fullPage: true })
          : null,
        extractorOptions !== undefined &&
          extractorOptions.mode.includes("llm-extraction")
          ? ({
            type: "json" as const,
            prompt: extractorOptions.userPrompt,
            schema: extractorOptions.extractionSchema,
          })
          : null,
        "links",
      ].filter((x) => x !== null),
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
      parsers: pageOptions.parsePDF !== undefined ? (pageOptions.parsePDF ? ["pdf"] : []) : undefined,
      actions: pageOptions.actions,
      location: pageOptions.geolocation,
      skipTlsVerification: pageOptions.skipTlsVerification,
      removeBase64Images: pageOptions.removeBase64Images,
      mobile: pageOptions.mobile,
      fastMode: pageOptions.useFastMode,
    }),
    internalOptions: {
      atsv: pageOptions.atsv,
      v0DisableJsDom: pageOptions.disableJsDom,
      teamId,
      ...(extractorOptions !== undefined && extractorOptions.mode.includes("llm-extraction") ? {
        v1JSONSystemPrompt: extractorOptions.extractionPrompt
      } : {})
    },
    // TODO: fallback, fetchPageContent, replaceAllPathsWithAbsolutePaths, includeLinks
  };
}

export function fromV1ScrapeOptions(
  v1ScrapeOptions: V1ScrapeOptions,
  timeout: number | undefined,
  teamId: string,
): { scrapeOptions: ScrapeOptions; internalOptions: InternalOptions } {
  const spreadScrapeOptions = { ...v1ScrapeOptions };
  delete (spreadScrapeOptions as any).urls;
  delete (spreadScrapeOptions as any).ignoreInvalidURLs;
  delete (spreadScrapeOptions as any).url;
  delete (spreadScrapeOptions as any).origin;
  delete (spreadScrapeOptions as any).integration;
  delete (spreadScrapeOptions as any).webhook;
  delete (spreadScrapeOptions as any).zeroDataRetention;
  delete (spreadScrapeOptions as any).maxConcurrency;
  // v2 scrapeOptions schema is strict and does not include `agent`. We carry it via internalOptions below.
  delete (spreadScrapeOptions as any).agent;
  
  delete spreadScrapeOptions.__experimental_cache;
  delete spreadScrapeOptions.jsonOptions;
  delete spreadScrapeOptions.changeTrackingOptions;
  delete spreadScrapeOptions.extract;
  delete spreadScrapeOptions.geolocation;
  delete (spreadScrapeOptions as any).parsePDF;
  
  // Track the original format for v1 backward compatibility
  // Check json first since when user specifies "json", both "json" and "extract" are present
  // When user specifies "extract", only "extract" is present
  let v1OriginalFormat: "extract" | "json" | undefined;
  if (v1ScrapeOptions.formats.includes("json")) {
    v1OriginalFormat = "json";
  } else if (v1ScrapeOptions.formats.includes("extract")) {
    v1OriginalFormat = "extract";
  }
  
  return {
    scrapeOptions: scrapeOptions.parse({
      ...spreadScrapeOptions,

      ...(v1ScrapeOptions.__experimental_cache ? {
        maxAge: v1ScrapeOptions.maxAge ?? 4 * 60 * 60 * 1000, // 4 hours
      } : {}),
      location: v1ScrapeOptions.location ?? v1ScrapeOptions.geolocation,
      formats: v1ScrapeOptions.formats.map(x => {
        // json and extract is standardized down to extract fmt in v1 -- fine to take one and dismiss the other
        if (x === "extract") {
          const opts = v1ScrapeOptions.jsonOptions || v1ScrapeOptions.extract;
          const fmt: JsonFormatWithOptions = {
            type: "json",
            schema: opts?.schema,
            prompt: opts?.prompt,
          };
          return fmt;
        } else if (x === "json") {
          // If jsonOptions are provided with json format, create JsonFormatWithOptions
          const opts = v1ScrapeOptions.jsonOptions;
          if (opts) {
            const fmt: JsonFormatWithOptions = {
              type: "json",
              schema: opts.schema,
              prompt: opts.prompt,
            };
            return v1ScrapeOptions.formats.includes("extract") ? null : fmt;
          }
          return null;
        } else if (x === "changeTracking") {
          const opts = v1ScrapeOptions.changeTrackingOptions;
          const fmt: ChangeTrackingFormatWithOptions = {
            type: "changeTracking",
            modes: opts?.modes ?? [],
            tag: opts?.tag ?? null,
            schema: opts?.schema,
            prompt: opts?.prompt,
          };
          return fmt;
        } else if (x === "screenshot@fullPage") {
          return { type: "screenshot" as const, fullPage: true };
        } else {
          return x;
        }
      }).filter(x => x !== null),
      parsers: v1ScrapeOptions.parsePDF !== undefined ? (v1ScrapeOptions.parsePDF ? ["pdf"] : []) : undefined,
    }),
    internalOptions: {
      teamId,
      v1Agent: v1ScrapeOptions.agent,
      v1JSONSystemPrompt: (v1ScrapeOptions.jsonOptions || v1ScrapeOptions.extract)?.systemPrompt,
      v1JSONAgent: (v1ScrapeOptions.jsonOptions || v1ScrapeOptions.extract)?.agent,
      v1OriginalFormat,
    },
  };
}

export function fromV0Combo(
  pageOptions: PageOptions,
  extractorOptions: ExtractorOptions | undefined,
  timeout: number | undefined,
  crawlerOptions: any,
  teamId: string,
): { scrapeOptions: ScrapeOptions; internalOptions: InternalOptions } {
  const { scrapeOptions, internalOptions: i1 } = fromV0ScrapeOptions(
    pageOptions,
    extractorOptions,
    timeout,
    teamId,
  );
  const { internalOptions: i2 } = fromV0CrawlerOptions(crawlerOptions, teamId);
  return { scrapeOptions, internalOptions: Object.assign(i1, i2) };
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

// Search source type definitions
// These allow fine-grained control over each search source type
// Similar to how scrape formats work with jsonFormatWithOptions, etc.

export const webSearchSourceOptions = z.object({
  type: z.literal("web"),
  tbs: z.string().optional(), // Time-based search (e.g., "qdr:d" for past day)
  filter: z.string().optional(), // Search filter
  lang: z.string().optional(), // Language override for this source
  country: z.string().optional(), // Country override for this source
  location: z.string().optional(), // Location override for this source
}).strict();

export const imagesSearchSourceOptions = z.object({
  type: z.literal("images"),
}).strict();

export const newsSearchSourceOptions = z.object({
  type: z.literal("news"),
}).strict();

export type WebSearchSourceOptions = z.infer<typeof webSearchSourceOptions>;
export type ImagesSearchSourceOptions = z.infer<typeof imagesSearchSourceOptions>;
export type NewsSearchSourceOptions = z.infer<typeof newsSearchSourceOptions>;

// Category source type definitions
export const githubCategoryOptions = z.object({
  type: z.literal("github"),
}).strict();

export const researchCategoryOptions = z.object({
  type: z.literal("research"),
}).strict();

export type GithubCategoryOptions = z.infer<typeof githubCategoryOptions>;
export type ResearchCategoryOptions = z.infer<typeof researchCategoryOptions>;

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
    sources: z
      .union([
        // Array of strings (simple format)
        z.array(z.enum(["web", "images", "news"])),
        // Array of objects (advanced format)
        z.array(
          z.union([
            webSearchSourceOptions,
            imagesSearchSourceOptions,
            newsSearchSourceOptions,
          ])
        ),
      ])
      .optional()
      .default(["web"]),
    categories: z
      .union([
        // Array of strings (simple format)
        z.array(z.enum(["github", "research"])),
        // Array of objects (advanced format)
        z.array(
          z.union([
            githubCategoryOptions,
            researchCategoryOptions,
          ])
        ),
      ])
      .optional(),
    lang: z.string().optional().default("en"),
    country: z.string().optional().default("us"),
    location: z.string().optional(),
    origin: z.string().optional().default("api"),
    integration: z.nativeEnum(IntegrationEnum).optional().transform(val => val || null),
    timeout: z.number().int().positive().finite().safe().default(60000),
    ignoreInvalidURLs: z.boolean().optional().default(false),
    __searchPreviewToken: z.string().optional(),
    scrapeOptions: baseScrapeOptions
      .extend({
        formats: z.preprocess(
          (val) => {
            if (!Array.isArray(val)) return val;
            return val.map(format => {
              if (typeof format === 'string') {
                return { type: format };
              }
              return format;
            });
          },
          z
            .union([
              z.object({ type: z.literal("markdown") }),
              z.object({ type: z.literal("html") }),
              z.object({ type: z.literal("rawHtml") }),
              z.object({ type: z.literal("links") }),
              z.object({ type: z.literal("summary") }),
              jsonFormatWithOptions,
              screenshotFormatWithOptions,
            ])
            .array()
            .optional()
            .default([])
        )
          .refine(
            (x) => {
              return x.filter(f => f.type === "screenshot").length <= 1;
            },
            "You may only specify one screenshot format",
          ),
      })
      .default({}),
  })
  .strict(
    "Unrecognized key in body -- please review the v1 API documentation for request body changes",
  )
  .refine((x) => waitForRefine(x.scrapeOptions), waitForRefineOpts)
  .transform((x) => {
    // Transform string array sources to object format
    let sources = x.sources;
    if (sources && Array.isArray(sources) && sources.length > 0) {
      // Check if it's a string array by checking the first element
      if (typeof sources[0] === 'string') {
        // It's a string array, transform to object array
        sources = (sources as string[]).map((s) => {
          switch (s) {
            case 'web':
              return {
                type: 'web' as const,
                tbs: x.tbs,
                filter: x.filter,
                lang: x.lang,
                country: x.country,
                location: x.location,
              };
            case 'images':
              return {
                type: 'images' as const,
                // Images don't inherit global params in the simple format
              };
            case 'news':
              return {
                type: 'news' as const,
                tbs: x.tbs,
                lang: x.lang,
                country: x.country,
                location: x.location,
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
      if (typeof categories[0] === 'string') {
        // It's a string array, transform to object array
        categories = (categories as string[]).map((c) => {
          switch (c) {
            case 'github':
              return {
                type: 'github' as const
              };
            case 'research':
              return {
                type: 'research' as const,
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
      sources,
      categories,
      scrapeOptions: extractTransform(x.scrapeOptions),
    };
  });

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchRequestInput = z.input<typeof searchRequestSchema>;

export type SearchResponse =
  | ErrorResponse
  | {
    success: true;
    warning?: string;
    data: Document[];
    creditsUsed: number;
  }
  | {
    success: true;
    warning?: string;
    data: import("../../lib/entities").SearchV2Response;
    creditsUsed: number;
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
