import axios, { type AxiosResponse, type AxiosRequestHeaders, AxiosError } from "axios";
import * as zt from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TypedEventTarget } from "typescript-event-target";

/**
 * Configuration interface for FirecrawlApp.
 * @param apiKey - Optional API key for authentication.
 * @param apiUrl - Optional base URL of the API; defaults to 'https://api.firecrawl.dev'.
 */
export interface FirecrawlAppConfig {
  apiKey?: string | null;
  apiUrl?: string | null;
}

/**
 * Metadata for a Firecrawl document.
 * Includes various optional properties for document metadata.
 */
export interface FirecrawlDocumentMetadata {
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
  dctermsCreated?: string;
  dcDateCreated?: string;
  dcDate?: string;
  dctermsType?: string;
  dcType?: string;
  dctermsAudience?: string;
  dctermsSubject?: string;
  dcSubject?: string;
  dcDescription?: string;
  dctermsKeywords?: string;
  modifiedTime?: string;
  publishedTime?: string;
  articleTag?: string;
  articleSection?: string;
  sourceURL?: string;
  statusCode?: number;
  error?: string;
  proxyUsed?: "basic" | "stealth";
  cacheState?: "miss" | "hit";
  cachedAt?: string;
  [key: string]: any; // Allows for additional metadata properties not explicitly defined.
}

/**
 * Document interface for Firecrawl.
 * Represents a document retrieved or processed by Firecrawl.
 */
export interface FirecrawlDocument<T = any, ActionsSchema extends (ActionsResult | never) = never> {
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  extract?: T;
  json?: T;
  screenshot?: string;
  metadata?: FirecrawlDocumentMetadata;
  actions: ActionsSchema;
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
  // v1 search only
  title?: string;
  description?: string;
}

/**
 * Location configuration for proxy location
 */
export interface LocationConfig {
  country?: string;
  languages?: string[];
}

/**
 * Parameters for scraping operations.
 * Defines the options and configurations available for scraping web content.
 */
export interface CrawlScrapeOptions {
  formats?: ("markdown" | "html" | "rawHtml" | "content" | "links" | "screenshot" | "screenshot@fullPage" | "extract" | "json" | "changeTracking")[];
  headers?: Record<string, string>;
  includeTags?: string[];
  excludeTags?: string[];
  onlyMainContent?: boolean;
  waitFor?: number;
  timeout?: number;
  location?: LocationConfig;
  mobile?: boolean;
  skipTlsVerification?: boolean;
  removeBase64Images?: boolean;
  blockAds?: boolean;
  proxy?: "basic" | "stealth" | "auto";
  storeInCache?: boolean;
  maxAge?: number;
  parsePDF?: boolean;
}

export type Action = {
  type: "wait",
  milliseconds?: number,
  selector?: string,
} | {
  type: "click",
  selector: string,
  all?: boolean,
} | {
  type: "screenshot",
  fullPage?: boolean,
  quality?: number,
} | {
  type: "write",
  text: string,
} | {
  type: "press",
  key: string,
} | {
  type: "scroll",
  direction?: "up" | "down",
  selector?: string,
} | {
  type: "scrape",
} | {
  type: "executeJavascript",
  script: string,
};

export interface ScrapeParams<LLMSchema extends zt.ZodSchema = any, ActionsSchema extends (Action[] | undefined) = undefined> extends CrawlScrapeOptions {
  extract?: {
    prompt?: string;
    schema?: LLMSchema;
    systemPrompt?: string;
  };
  jsonOptions?:{
    prompt?: string;
    schema?: LLMSchema;
    systemPrompt?: string;
  }
  changeTrackingOptions?: {
    prompt?: string;
    schema?: any;
    modes?: ("json" | "git-diff")[];
    tag?: string | null;
  }
  actions?: ActionsSchema;
  agent?: AgentOptions;
  zeroDataRetention?: boolean;
}

export interface ActionsResult {
  screenshots: string[];
  scrapes: ({
    url: string;
    html: string;
  })[];
  javascriptReturns: {
    type: string;
    value: unknown
  }[];
}

/**
 * Response interface for scraping operations.
 * Defines the structure of the response received after a scraping operation.
 */
export interface ScrapeResponse<LLMResult = any, ActionsSchema extends (ActionsResult | never) = never> extends FirecrawlDocument<LLMResult, ActionsSchema> {
  success: true;
  warning?: string;
  error?: string;
}

/**
 * Parameters for crawling operations.
 * Includes options for both scraping and mapping during a crawl.
 */
export interface CrawlParams {
  includePaths?: string[];
  excludePaths?: string[];
  maxDepth?: number;
  maxDiscoveryDepth?: number;
  limit?: number;
  allowBackwardLinks?: boolean;
  crawlEntireDomain?: boolean;
  allowExternalLinks?: boolean;
  ignoreSitemap?: boolean;
  scrapeOptions?: CrawlScrapeOptions;
  webhook?: string | {
    url: string;
    headers?: Record<string, string>;
    metadata?: Record<string, string>;
    events?: ["completed", "failed", "page", "started"][number][];
  };
  deduplicateSimilarURLs?: boolean;
  ignoreQueryParameters?: boolean;
  regexOnFullURL?: boolean;
  /**
   * Delay in seconds between scrapes. This helps respect website rate limits.
   * If not provided, the crawler may use the robots.txt crawl delay if available.
   */
  delay?: number;
  allowSubdomains?: boolean;
  maxConcurrency?: number;
  zeroDataRetention?: boolean;
}

/**
 * Response interface for crawling operations.
 * Defines the structure of the response received after initiating a crawl.
 */
export interface CrawlResponse {
  id?: string;
  url?: string;
  success: true;
  error?: string;
}

/**
 * Response interface for batch scrape operations.
 * Defines the structure of the response received after initiating a crawl.
 */
export interface BatchScrapeResponse {
  id?: string;
  url?: string;
  success: true;
  error?: string;
  invalidURLs?: string[];
}

/**
 * Response interface for job status checks.
 * Provides detailed status of a crawl job including progress and results.
 */
export interface CrawlStatusResponse {
  success: true;
  status: "scraping" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  creditsUsed: number;
  expiresAt: Date;
  next?: string;
  data: FirecrawlDocument<undefined>[];
};

/**
 * Response interface for batch scrape job status checks.
 * Provides detailed status of a batch scrape job including progress and results.
 */
export interface BatchScrapeStatusResponse {
  success: true;
  status: "scraping" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  creditsUsed: number;
  expiresAt: Date;
  next?: string;
  data: FirecrawlDocument<undefined>[];
};

/**
 * Parameters for mapping operations.
 * Defines options for mapping URLs during a crawl.
 */
export interface MapParams {
  search?: string;
  ignoreSitemap?: boolean;
  includeSubdomains?: boolean;
  sitemapOnly?: boolean;
  limit?: number;
  timeout?: number;
  useIndex?: boolean;
  location?: LocationConfig;
}

/**
 * Response interface for mapping operations.
 * Defines the structure of the response received after a mapping operation.
 */
export interface MapResponse {
  success: true;
  links?: string[];
  error?: string;
}

/**
 * Parameters for extracting information from URLs.
 * Defines options for extracting information from URLs.
 */
export interface AgentOptions {
  model?: string;
  prompt?: string;
  sessionId?: string;
}

/**
 * Parameters for extracting information from URLs.
 * Defines options for extracting information from URLs.
 */
export interface AgentOptionsExtract {
  model?: string;
  sessionId?: string;
}

export interface ExtractParams<LLMSchema extends zt.ZodSchema = any> {
  prompt?: string;
  schema?: LLMSchema | object;
  systemPrompt?: string;
  allowExternalLinks?: boolean;
  enableWebSearch?: boolean;
  includeSubdomains?: boolean;
  origin?: string;
  showSources?: boolean;
  scrapeOptions?: CrawlScrapeOptions;
  agent?: AgentOptionsExtract;
}

/**
 * Response interface for extracting information from URLs.
 * Defines the structure of the response received after extracting information from URLs.
 */
export interface ExtractResponse<LLMSchema extends zt.ZodSchema = any> {
  success: boolean;
  data: LLMSchema;
  error?: string;
  warning?: string;
  sources?: string[];
}

/**
 * Error response interface.
 * Defines the structure of the response received when an error occurs.
 */
export interface ErrorResponse {
  success: false;
  error: string;
}

/**
 * Custom error class for Firecrawl.
 * Extends the built-in Error class to include a status code.
 */
export class FirecrawlError extends Error {
  statusCode: number;
  details?: any;
  constructor(message: string, statusCode: number, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Parameters for search operations.
 * Defines options for searching and scraping search results.
 */
export interface SearchParams {
  limit?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  origin?: string;
  timeout?: number;
  scrapeOptions?: ScrapeParams;
}

/**
 * Response interface for search operations.
 * Defines the structure of the response received after a search operation.
 */
export interface SearchResponse {
  success: boolean;
  data: FirecrawlDocument<undefined>[];
  warning?: string;
  error?: string;
}

/**
 * Response interface for crawl/batch scrape error monitoring.
 */
export interface CrawlErrorsResponse {
  /**
   * Scrapes that errored out + error details
   */
  errors: {
    id: string,
    timestamp?: string,
    url: string,
    code?: string,
    error: string,
  }[];

  /**
   * URLs blocked by robots.txt
   */
  robotsBlocked: string[];
};

/**
 * Parameters for deep research operations.
 * Defines options for conducting deep research on a query.
 */
export interface DeepResearchParams<LLMSchema extends zt.ZodSchema = any>  {
  /**
   * Maximum depth of research iterations (1-10)
   * @default 7
   */
  maxDepth?: number;
  /**
   * Time limit in seconds (30-300)
   * @default 270
   */
  timeLimit?: number;
  /**
   * Maximum number of URLs to analyze (1-1000)
   * @default 20
   */
  maxUrls?: number;
  /**
   * The prompt to use for the final analysis
   */
  analysisPrompt?: string;
  /**
   * The system prompt to use for the research agent
   */
  systemPrompt?: string;
  /**
   * The formats to use for the final analysis
   */
  formats?: ("markdown" | "json")[];
  /**
   * The JSON options to use for the final analysis
   */
  jsonOptions?:{
    prompt?: string;
    schema?: LLMSchema;
    systemPrompt?: string;
  };
  /** 
   * Experimental flag for streaming steps
   */
  // __experimental_streamSteps?: boolean;
}

/**
 * Response interface for deep research operations.
 */
export interface DeepResearchResponse {
  success: boolean;
  id: string;
}

/**
 * Status response interface for deep research operations.
 */
export interface DeepResearchStatusResponse {
  success: boolean;
  data: {
    finalAnalysis: string;
    activities: Array<{
      type: string;
      status: string;
      message: string;
      timestamp: string;
      depth: number;
    }>;
    sources: Array<{
      url: string;
      title: string;
      description: string;
    }>;
  };
  status: "processing" | "completed" | "failed";
  error?: string;
  expiresAt: string;
  currentDepth: number;
  maxDepth: number;
  activities: Array<{
    type: string;
    status: string;
    message: string;
    timestamp: string;
    depth: number;
  }>;
  sources: Array<{
    url: string;
    title: string;
    description: string;
  }>;
  summaries: string[];
}

/**
 * Parameters for LLMs.txt generation operations.
 */
export interface GenerateLLMsTextParams {
  /**
   * Maximum number of URLs to process (1-100)
   * @default 10
   */
  maxUrls?: number;
  /**
   * Whether to show the full LLMs-full.txt in the response
   * @default false
   */
  showFullText?: boolean;
  /**
   * Whether to use cached content if available
   * @default true
   */
  cache?: boolean;
  /**
   * Experimental flag for streaming
   */
  __experimental_stream?: boolean;
}

/**
 * Response interface for LLMs.txt generation operations.
 */
export interface GenerateLLMsTextResponse {
  success: boolean;
  id: string;
}

/**
 * Status response interface for LLMs.txt generation operations.
 */
export interface GenerateLLMsTextStatusResponse {
  success: boolean;
  data: {
    llmstxt: string;
    llmsfulltxt?: string;
  };
  status: "processing" | "completed" | "failed";
  error?: string;
  expiresAt: string;
}

/**
 * Response interface for queue status operations.
 */
export interface QueueStatusResponse {
  success: boolean;
  jobsInQueue: number;
  activeJobsInQueue: number;
  waitingJobsInQueue: number;
  maxConcurrency: number;

  /**
   * ISO timestamp of the most recent successful scrape in the past 24 hours. Will be null if no successful scrape has occurred in the past 24 hours.
   */
  mostRecentSuccess: string | null;
}

/** Credit usage for v1 API (snake_case fields as returned by API). */
export interface CreditUsageResponseV1 {
  success: boolean;
  data: {
    remaining_credits: number;
    plan_credits: number;
    billing_period_start: string | null;
    billing_period_end: string | null;
  };
}

/** Token usage for v1 API (snake_case fields as returned by API). */
export interface TokenUsageResponseV1 {
  success: boolean;
  data: {
    remaining_tokens: number;
    plan_tokens: number;
    billing_period_start: string | null;
    billing_period_end: string | null;
  };
}

export interface CreditUsageHistoricalResponseV1 {
  success: boolean;
  periods: {
    startDate: string | null;
    endDate: string | null;
    apiKey?: string;
    creditsUsed: number;
  }[];
}

export interface TokenUsageHistoricalResponseV1 {
  success: boolean;
  periods: {
    startDate: string | null;
    endDate: string | null;
    apiKey?: string;
    tokensUsed: number;
  }[];
}

/**
 * Main class for interacting with the Firecrawl API.
 * Provides methods for scraping, searching, crawling, and mapping web content.
 */
export default class FirecrawlApp {
  public apiKey: string;
  public apiUrl: string;
  public version: string =  "1.25.1";
  
  private isCloudService(url: string): boolean {
    return url.includes('api.firecrawl.dev');
  }

  private async getVersion(): Promise<string> {
    try {
      // Prefer env-provided version when available (works well in test runners)
      if (typeof process !== 'undefined' && process.env && process.env.npm_package_version) {
        return process.env.npm_package_version as string;
      }
      const packageJson = await import('../../package.json', { assert: { type: 'json' } });
      return packageJson.default.version;
    } catch (error) {
      // Suppress noisy logs under test environments
      const isTest = typeof process !== 'undefined' && (
        process.env.JEST_WORKER_ID != null || process.env.NODE_ENV === 'test'
      );
      if (!isTest) {
        // eslint-disable-next-line no-console
        console.error("Error getting version:", error);
      }
      return  "1.25.1";
    }
  }

  private async init() {
    this.version = await this.getVersion();
  }

  /**
   * Initializes a new instance of the FirecrawlApp class.
   * @param config - Configuration options for the FirecrawlApp instance.
   */
  constructor({ apiKey = null, apiUrl = null }: FirecrawlAppConfig) {
    const baseUrl = apiUrl || "https://api.firecrawl.dev";
    
    if (this.isCloudService(baseUrl) && typeof apiKey !== "string") {
      throw new FirecrawlError("No API key provided", 401);
    }

    this.apiKey = apiKey || '';
    this.apiUrl = baseUrl;
    this.init();
  }

  /**
   * Scrapes a URL using the Firecrawl API.
   * @param url - The URL to scrape.
   * @param params - Additional parameters for the scrape request.
   * @returns The response from the scrape operation.
   */
  async scrapeUrl<T extends zt.ZodSchema, ActionsSchema extends (Action[] | undefined) = undefined>(
    url: string,
    params?: ScrapeParams<T, ActionsSchema>
  ): Promise<ScrapeResponse<zt.infer<T>, ActionsSchema extends Action[] ? ActionsResult : never> | ErrorResponse> {
    const headers: AxiosRequestHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    } as AxiosRequestHeaders;
    let jsonData: any = { url, ...params, origin: `js-sdk@${this.version}` };
    if (jsonData?.extract?.schema) {
      let schema = jsonData.extract.schema;

      // Try parsing the schema as a Zod schema
      try {
        schema = zodToJsonSchema(schema);
      } catch (error) {
        
      }
      jsonData = {
        ...jsonData,
        extract: {
          ...jsonData.extract,
          schema: schema,
        },
      };
    }

    if (jsonData?.jsonOptions?.schema) {
      let schema = jsonData.jsonOptions.schema;
      // Try parsing the schema as a Zod schema
      try {
        schema = zodToJsonSchema(schema);
      } catch (error) {
        
      }
      jsonData = {
        ...jsonData,
        jsonOptions: {
          ...jsonData.jsonOptions,
          schema: schema,
        },
      };
    }
    try {
      const response: AxiosResponse = await axios.post(
        this.apiUrl + `/v1/scrape`,
        jsonData,
        { headers, timeout: params?.timeout !== undefined ? (params.timeout + 5000) : undefined },
      );
      if (response.status === 200) {
        const responseData = response.data;
        if (responseData.success) {
          return {
            success: true,
            warning: responseData.warning,
            error: responseData.error,
            ...responseData.data
          };
        } else {
          throw new FirecrawlError(`Failed to scrape URL. Error: ${responseData.error}`, response.status);
        }
      } else {
        this.handleError(response, "scrape URL");
      }
    } catch (error: any) {
      this.handleError(error.response, "scrape URL");
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Searches using the Firecrawl API and optionally scrapes the results.
   * @param query - The search query string.
   * @param params - Optional parameters for the search request.
   * @returns The response from the search operation.
   */
  async search(query: string, params?: SearchParams | Record<string, any>): Promise<SearchResponse> {
    const headers: AxiosRequestHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    } as AxiosRequestHeaders;

    let jsonData: any = {
      query,
      limit: params?.limit ?? 5,
      tbs: params?.tbs,
      filter: params?.filter,
      lang: params?.lang ?? "en",
      country: params?.country ?? "us",
      location: params?.location,
      origin: `js-sdk@${this.version}`,
      timeout: params?.timeout ?? 60000,
      scrapeOptions: params?.scrapeOptions ?? { formats: [] },
    };

    if (jsonData?.scrapeOptions?.extract?.schema) {
      let schema = jsonData.scrapeOptions.extract.schema;

      // Try parsing the schema as a Zod schema
      try {
        schema = zodToJsonSchema(schema);
      } catch (error) {
        
      }
      jsonData = {
        ...jsonData,
        scrapeOptions: {
          ...jsonData.scrapeOptions,
          extract: {
            ...jsonData.scrapeOptions.extract,
            schema: schema,
          },
        },
      };
    }

    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/search`,
        jsonData,
        headers
      );

      if (response.status === 200) {
        const responseData = response.data;
        if (responseData.success) {
          return {
            success: true,
            data: responseData.data as FirecrawlDocument<any>[],
            warning: responseData.warning,
          };
        } else {
          throw new FirecrawlError(`Failed to search. Error: ${responseData.error}`, response.status);
        }
      } else {
        this.handleError(response, "search");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error.", data: [] };
  }

  /**
   * Initiates a crawl job for a URL using the Firecrawl API.
   * @param url - The URL to crawl.
   * @param params - Additional parameters for the crawl request.
   * @param pollInterval - Time in seconds for job status checks.
   * @param idempotencyKey - Optional idempotency key for the request.
   * @returns The response from the crawl operation.
   */
  async crawlUrl(
    url: string,
    params?: CrawlParams,
    pollInterval: number = 2,
    idempotencyKey?: string
  ): Promise<CrawlStatusResponse | ErrorResponse> {
    const headers = this.prepareHeaders(idempotencyKey);
    let jsonData: any = { url, ...params, origin: `js-sdk@${this.version}` };
    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/crawl`,
        jsonData,
        headers
      );
      if (response.status === 200) {
        const id: string = response.data.id;
        return this.monitorJobStatus(id, headers, pollInterval);
      } else {
        this.handleError(response, "start crawl job");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  async asyncCrawlUrl(
    url: string,
    params?: CrawlParams,
    idempotencyKey?: string
  ): Promise<CrawlResponse | ErrorResponse> {
    const headers = this.prepareHeaders(idempotencyKey);
    let jsonData: any = { url, ...params, origin: `js-sdk@${this.version}` };
    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/crawl`,
        jsonData,
        headers
      );
      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "start crawl job");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Checks the status of a crawl job using the Firecrawl API.
   * @param id - The ID of the crawl operation.
   * @param getAllData - Paginate through all the pages of documents, returning the full list of all documents. (default: `false`)
   * @param nextURL - The `next` URL from the previous crawl status. Only required if you're not manually increasing `skip`. Only used when `getAllData = false`.
   * @param skip - How many entries to skip to paginate. Only required if you're not providing `nextURL`. Only used when `getAllData = false`.
   * @param limit - How many entries to return. Only used when `getAllData = false`.
   * @returns The response containing the job status.
   */
  async checkCrawlStatus(id?: string, getAllData = false, nextURL?: string, skip?: number, limit?: number): Promise<CrawlStatusResponse | ErrorResponse> {
    if (!id) {
      throw new FirecrawlError("No crawl ID provided", 400);
    }

    const headers: AxiosRequestHeaders = this.prepareHeaders();
    const targetURL = new URL(nextURL ?? `${this.apiUrl}/v1/crawl/${id}`);
    if (skip !== undefined) {
      targetURL.searchParams.set("skip", skip.toString());
    }
    if (limit !== undefined) {
      targetURL.searchParams.set("limit", limit.toString());
    }

    try {
      const response: AxiosResponse = await this.getRequest(
        targetURL.href,
        headers
      );
      if (response.status === 200) {
        let allData = response.data.data;
        if (getAllData && response.data.status === "completed") {
          let statusData = response.data
          if ("data" in statusData) {
            let data = statusData.data;
            while (typeof statusData === 'object' && 'next' in statusData) {
              if (data.length === 0) {
                break
              }
              statusData = (await this.getRequest(statusData.next, headers)).data;
              data = data.concat(statusData.data);
            }
            allData = data;
          }
        }

        let resp: CrawlStatusResponse | ErrorResponse = {
          success: response.data.success,
          status: response.data.status,
          total: response.data.total,
          completed: response.data.completed,
          creditsUsed: response.data.creditsUsed,
          next: getAllData ? undefined : response.data.next,
          expiresAt: new Date(response.data.expiresAt),
          data: allData
        }

        if (!response.data.success && response.data.error) {
          resp = {
            ...resp,
            success: false,
            error: response.data.error
          } as ErrorResponse;
        }

        if (response.data.next) {
          (resp as CrawlStatusResponse).next = response.data.next;
        }
        
        return resp;
      } else {
        this.handleError(response, "check crawl status");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Returns information about crawl errors.
   * @param id - The ID of the crawl operation.
   * @returns Information about crawl errors.
   */
  async checkCrawlErrors(id: string): Promise<CrawlErrorsResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.deleteRequest(
        `${this.apiUrl}/v1/crawl/${id}/errors`,
        headers
      );
      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "check crawl errors");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Cancels a crawl job using the Firecrawl API.
   * @param id - The ID of the crawl operation.
   * @returns The response from the cancel crawl operation.
   */
  async cancelCrawl(id: string): Promise<ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.deleteRequest(
        `${this.apiUrl}/v1/crawl/${id}`,
        headers
      );
      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "cancel crawl job");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Initiates a crawl job and returns a CrawlWatcher to monitor the job via WebSocket.
   * @param url - The URL to crawl.
   * @param params - Additional parameters for the crawl request.
   * @param idempotencyKey - Optional idempotency key for the request.
   * @returns A CrawlWatcher instance to monitor the crawl job.
   */
  async crawlUrlAndWatch(
    url: string,
    params?: CrawlParams,
    idempotencyKey?: string,
  ) {
    const crawl = await this.asyncCrawlUrl(url, params, idempotencyKey);

    if (crawl.success && crawl.id) {
      const id = crawl.id;
      return new CrawlWatcher(id, this);
    }

    throw new FirecrawlError("Crawl job failed to start", 400);
  }

  /**
   * Maps a URL using the Firecrawl API.
   * @param url - The URL to map.
   * @param params - Additional parameters for the map request.
   * @returns The response from the map operation.
   */
  async mapUrl(url: string, params?: MapParams): Promise<MapResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    let jsonData: any = { url, ...params, origin: `js-sdk@${this.version}` };

    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/map`,
        jsonData,
        headers
      );
      if (response.status === 200) {
        return response.data as MapResponse;
      } else {
        this.handleError(response, "map");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Initiates a batch scrape job for multiple URLs using the Firecrawl API.
   * @param url - The URLs to scrape.
   * @param params - Additional parameters for the scrape request.
   * @param pollInterval - Time in seconds for job status checks.
   * @param idempotencyKey - Optional idempotency key for the request.
   * @param webhook - Optional webhook for the batch scrape.
   * @param ignoreInvalidURLs - Optional flag to ignore invalid URLs.
   * @returns The response from the crawl operation.
   */
  async batchScrapeUrls(
    urls: string[],
    params?: ScrapeParams,
    pollInterval: number = 2,
    idempotencyKey?: string,
    webhook?: CrawlParams["webhook"],
    ignoreInvalidURLs?: boolean,
    maxConcurrency?: number,
  ): Promise<BatchScrapeStatusResponse | ErrorResponse> {
    const headers = this.prepareHeaders(idempotencyKey);
    let jsonData: any = { urls, webhook, ignoreInvalidURLs, maxConcurrency, ...params, origin: `js-sdk@${this.version}` };
    if (jsonData?.extract?.schema) {
      let schema = jsonData.extract.schema;

      // Try parsing the schema as a Zod schema
      try {
        schema = zodToJsonSchema(schema);
      } catch (error) {
        
      }
      jsonData = {
        ...jsonData,
        extract: {
          ...jsonData.extract,
          schema: schema,
        },
      };
    }
    if (jsonData?.jsonOptions?.schema) {
      let schema = jsonData.jsonOptions.schema;

      // Try parsing the schema as a Zod schema
      try {
        schema = zodToJsonSchema(schema);
      } catch (error) {
        
      }
      jsonData = {
        ...jsonData,
        jsonOptions: {
          ...jsonData.jsonOptions,
          schema: schema,
        },
      };
    }
    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/batch/scrape`,
        jsonData,
        headers
      );
      if (response.status === 200) {
        const id: string = response.data.id;
        return this.monitorJobStatus(id, headers, pollInterval);
      } else {
        this.handleError(response, "start batch scrape job");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  async asyncBatchScrapeUrls(
    urls: string[],
    params?: ScrapeParams,
    idempotencyKey?: string,
    webhook?: CrawlParams["webhook"],
    ignoreInvalidURLs?: boolean,
  ): Promise<BatchScrapeResponse | ErrorResponse> {
    const headers = this.prepareHeaders(idempotencyKey);
    let jsonData: any = { urls, webhook, ignoreInvalidURLs, ...params, origin: `js-sdk@${this.version}` };
    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/batch/scrape`,
        jsonData,
        headers
      );
      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "start batch scrape job");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Initiates a batch scrape job and returns a CrawlWatcher to monitor the job via WebSocket.
   * @param urls - The URL to scrape.
   * @param params - Additional parameters for the scrape request.
   * @param idempotencyKey - Optional idempotency key for the request.
   * @returns A CrawlWatcher instance to monitor the crawl job.
   */
  async batchScrapeUrlsAndWatch(
    urls: string[],
    params?: ScrapeParams,
    idempotencyKey?: string,
    webhook?: CrawlParams["webhook"],
    ignoreInvalidURLs?: boolean,
  ) {
    const crawl = await this.asyncBatchScrapeUrls(urls, params, idempotencyKey, webhook, ignoreInvalidURLs);

    if (crawl.success && crawl.id) {
      const id = crawl.id;
      return new CrawlWatcher(id, this);
    }

    throw new FirecrawlError("Batch scrape job failed to start", 400);
  }

  /**
   * Checks the status of a batch scrape job using the Firecrawl API.
   * @param id - The ID of the batch scrape operation.
   * @param getAllData - Paginate through all the pages of documents, returning the full list of all documents. (default: `false`)
   * @param nextURL - The `next` URL from the previous batch scrape status. Only required if you're not manually increasing `skip`. Only used when `getAllData = false`.
   * @param skip - How many entries to skip to paginate. Only used when `getAllData = false`.
   * @param limit - How many entries to return. Only used when `getAllData = false`.
   * @returns The response containing the job status.
   */
  async checkBatchScrapeStatus(id?: string, getAllData = false, nextURL?: string, skip?: number, limit?: number): Promise<BatchScrapeStatusResponse | ErrorResponse> {
    if (!id) {
      throw new FirecrawlError("No batch scrape ID provided", 400);
    }

    const headers: AxiosRequestHeaders = this.prepareHeaders();
    const targetURL = new URL(nextURL ?? `${this.apiUrl}/v1/batch/scrape/${id}`);
    if (skip !== undefined) {
      targetURL.searchParams.set("skip", skip.toString());
    }
    if (limit !== undefined) {
      targetURL.searchParams.set("limit", limit.toString());
    }

    try {
      const response: AxiosResponse = await this.getRequest(
        targetURL.href,
        headers
      );
      if (response.status === 200) {
        let allData = response.data.data;
        if (getAllData && response.data.status === "completed") {
          let statusData = response.data
          if ("data" in statusData) {
            let data = statusData.data;
            while (typeof statusData === 'object' && 'next' in statusData) {
              if (data.length === 0) {
                break
              }
              statusData = (await this.getRequest(statusData.next, headers)).data;
              data = data.concat(statusData.data);
            }
            allData = data;
          }
        }

        let resp: BatchScrapeStatusResponse | ErrorResponse = {
          success: response.data.success,
          status: response.data.status,
          total: response.data.total,
          completed: response.data.completed,
          creditsUsed: response.data.creditsUsed,
          next: getAllData ? undefined : response.data.next,
          expiresAt: new Date(response.data.expiresAt),
          data: allData
        }

        if (!response.data.success && response.data.error) {
          resp = {
            ...resp,
            success: false,
            error: response.data.error
          } as ErrorResponse;
        }

        if (response.data.next) {
          (resp as BatchScrapeStatusResponse).next = response.data.next;
        }
        
        return resp;
      } else {
        this.handleError(response, "check batch scrape status");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Returns information about batch scrape errors.
   * @param id - The ID of the batch scrape operation.
   * @returns Information about batch scrape errors.
   */
  async checkBatchScrapeErrors(id: string): Promise<CrawlErrorsResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.deleteRequest(
        `${this.apiUrl}/v1/batch/scrape/${id}/errors`,
        headers
      );
      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "check batch scrape errors");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Extracts information from URLs using the Firecrawl API.
   * Currently in Beta. Expect breaking changes on future minor versions.
   * @param urls - The URLs to extract information from. Optional if using other methods for data extraction.
   * @param params - Additional parameters for the extract request.
   * @returns The response from the extract operation.
   */
  async extract<T extends zt.ZodSchema = any>(urls?: string[], params?: ExtractParams<T>): Promise<ExtractResponse<zt.infer<T>> | ErrorResponse> {
    const headers = this.prepareHeaders();

    let jsonData: { urls?: string[] } & ExtractParams<T> = { urls: urls,  ...params };
    let jsonSchema: any;
    try {
      if (!params?.schema) {
        jsonSchema = undefined;
      } else {
        try {
          jsonSchema = zodToJsonSchema(params.schema as zt.ZodType);
        } catch (_) {
          jsonSchema = params.schema;
        }
      }
    } catch (error: any) {
      throw new FirecrawlError("Invalid schema. Schema must be either a valid Zod schema or JSON schema object.", 400);
    }
    
    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/extract`,
        { ...jsonData, schema: jsonSchema, origin: `js-sdk@${this.version}` },
        headers
      );

      if (response.status === 200) {
        const jobId = response.data.id;
        let extractStatus;
        do {
          const statusResponse: AxiosResponse = await this.getRequest(
            `${this.apiUrl}/v1/extract/${jobId}`,
            headers
          );
          extractStatus = statusResponse.data;
          if (extractStatus.status === "completed") {
            if (extractStatus.success) {
              return {
                success: true,
                data: extractStatus.data,
                warning: extractStatus.warning,
                error: extractStatus.error,
                sources: extractStatus?.sources || undefined,
              };
            } else {
              throw new FirecrawlError(`Failed to extract data. Error: ${extractStatus.error}`, statusResponse.status);
            }
          } else if (extractStatus.status === "failed" || extractStatus.status === "cancelled") {
            throw new FirecrawlError(`Extract job ${extractStatus.status}. Error: ${extractStatus.error}`, statusResponse.status);
          }
          await new Promise(resolve => setTimeout(resolve, 1000)); // Polling interval
        } while (extractStatus.status !== "completed");
      } else {
        this.handleError(response, "extract");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500, error.response?.data?.details);
    }
    return { success: false, error: "Internal server error."};
  }

  /**
   * Initiates an asynchronous extract job for a URL using the Firecrawl API.
   * @param url - The URL to extract data from.
   * @param params - Additional parameters for the extract request.
   * @param idempotencyKey - Optional idempotency key for the request.
   * @returns The response from the extract operation.
   */
  async asyncExtract(
    urls: string[],
    params?: ExtractParams,
    idempotencyKey?: string
  ): Promise<ExtractResponse | ErrorResponse> {
    const headers = this.prepareHeaders(idempotencyKey);
    let jsonData: any = { urls, ...params };
    let jsonSchema: any;

    try {
      if (!params?.schema) {
        jsonSchema = undefined;
      } else {
        try {
          jsonSchema = zodToJsonSchema(params.schema as zt.ZodType);
        } catch (_) {
          jsonSchema = params.schema;
        }
      }
    } catch (error: any) {
      throw new FirecrawlError("Invalid schema. Schema must be either a valid Zod schema or JSON schema object.", 400);
    }

    try {
      const response: AxiosResponse = await this.postRequest(
        this.apiUrl + `/v1/extract`,
        { ...jsonData, schema: jsonSchema, origin: `js-sdk@${this.version}` },
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "start extract job");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500, error.response?.data?.details);
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Retrieves the status of an extract job.
   * @param jobId - The ID of the extract job.
   * @returns The status of the extract job.
   */
  async getExtractStatus(jobId: string): Promise<any> {
    try {
      const response: AxiosResponse = await this.getRequest(
        `${this.apiUrl}/v1/extract/${jobId}`,
        this.prepareHeaders()
      );

      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "get extract status");
      }
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500);
    }
  }

  /**
   * Prepares the headers for an API request.
   * @param idempotencyKey - Optional key to ensure idempotency.
   * @returns The prepared headers.
   */
  prepareHeaders(idempotencyKey?: string): AxiosRequestHeaders {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
    } as AxiosRequestHeaders & { "x-idempotency-key"?: string };
  }

  /**
   * Sends a POST request to the specified URL.
   * @param url - The URL to send the request to.
   * @param data - The data to send in the request.
   * @param headers - The headers for the request.
   * @returns The response from the POST request.
   */
  postRequest(
    url: string,
    data: any,
    headers: AxiosRequestHeaders
  ): Promise<AxiosResponse> {
    return axios.post(url, data, { headers, timeout: (data?.timeout ? (data.timeout + 5000) : undefined) });
  }

  /**
   * Sends a GET request to the specified URL.
   * @param url - The URL to send the request to.
   * @param headers - The headers for the request.
   * @returns The response from the GET request.
   */
  async getRequest(
    url: string,
    headers: AxiosRequestHeaders
  ): Promise<AxiosResponse> {
    try {
      return await axios.get(url, { headers });
    } catch (error) {
      if (error instanceof AxiosError && error.response) {
        return error.response as AxiosResponse;
      } else {
        throw error;
      }
    }
  }

  /**
   * Sends a DELETE request to the specified URL.
   * @param url - The URL to send the request to.
   * @param headers - The headers for the request.
   * @returns The response from the DELETE request.
   */
  async deleteRequest(
    url: string,
    headers: AxiosRequestHeaders
  ): Promise<AxiosResponse> {
    try {
        return await axios.delete(url, { headers });
    } catch (error) {
      if (error instanceof AxiosError && error.response) {
        return error.response as AxiosResponse;
      } else {
        throw error;
      }
    }
  }

  /**
   * Monitors the status of a crawl job until completion or failure.
   * @param id - The ID of the crawl operation.
   * @param headers - The headers for the request.
   * @param checkInterval - Interval in seconds for job status checks.
   * @param checkUrl - Optional URL to check the status (used for v1 API)
   * @returns The final job status or data.
   */
  async monitorJobStatus(
    id: string,
    headers: AxiosRequestHeaders,
    checkInterval: number
  ): Promise<CrawlStatusResponse | ErrorResponse> {
    let failedTries = 0;
    let networkRetries = 0;
    const maxNetworkRetries = 3;
    
    while (true) {
      try {
        let statusResponse: AxiosResponse = await this.getRequest(
          `${this.apiUrl}/v1/crawl/${id}`,
          headers
        );
        
        if (statusResponse.status === 200) {
          failedTries = 0;
          networkRetries = 0;
          let statusData = statusResponse.data;
          
          if (statusData.status === "completed") {
            if ("data" in statusData) {
              let data = statusData.data;
              while (typeof statusData === 'object' && 'next' in statusData) {
                if (data.length === 0) {
                  break
                }
                statusResponse = await this.getRequest(statusData.next, headers);
                statusData = statusResponse.data;
                data = data.concat(statusData.data);
              }
              statusData.data = data;
              return statusData;
            } else {
              throw new FirecrawlError("Crawl job completed but no data was returned", 500);
            }
          } else if (
            ["active", "paused", "pending", "queued", "waiting", "scraping"].includes(statusData.status)
          ) {
            checkInterval = Math.max(checkInterval, 2);
            await new Promise((resolve) =>
              setTimeout(resolve, checkInterval * 1000)
            );
          } else {
            throw new FirecrawlError(
              `Crawl job failed or was stopped. Status: ${statusData.status}`,
              500
            );
          }
        } else {
          failedTries++;
          if (failedTries >= 3) {
            this.handleError(statusResponse, "check crawl status");
          }
        }
      } catch (error: any) {
        if (this.isRetryableError(error) && networkRetries < maxNetworkRetries) {
          networkRetries++;
          const backoffDelay = Math.min(1000 * Math.pow(2, networkRetries - 1), 10000);
          
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }
        
        throw new FirecrawlError(error, 500);
      }
    }
  }

  /**
   * Determines if an error is retryable (transient network error)
   * @param error - The error to check
   * @returns True if the error should be retried
   */
  private isRetryableError(error: any): boolean {
    if (error instanceof AxiosError) {
      if (!error.response) {
        const code = error.code;
        const message = error.message?.toLowerCase() || '';
        
        return (
          code === 'ECONNRESET' ||
          code === 'ETIMEDOUT' ||
          code === 'ENOTFOUND' ||
          code === 'ECONNREFUSED' ||
          message.includes('socket hang up') ||
          message.includes('network error') ||
          message.includes('timeout')
        );
      }
      
      if (error.response?.status === 408 || error.response?.status === 504) {
        return true;
      }
    }
    
    if (error && typeof error === 'object') {
      const code = error.code;
      const message = error.message?.toLowerCase() || '';
      
      if (code === 'ECONNRESET' ||
          code === 'ETIMEDOUT' ||
          code === 'ENOTFOUND' ||
          code === 'ECONNREFUSED' ||
          message.includes('socket hang up') ||
          message.includes('network error') ||
          message.includes('timeout')) {
        return true;
      }
      
      if (error.response?.status === 408 || error.response?.status === 504) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Handles errors from API responses.
   * @param {AxiosResponse} response - The response from the API.
   * @param {string} action - The action being performed when the error occurred.
   */
  handleError(response: AxiosResponse, action: string): never {
    if (!response) {
      throw new FirecrawlError(
        `No response received while trying to ${action}. This may be a network error or the server is unreachable.`,
        0
      );
    }

    if ([400, 402, 403, 408, 409, 500].includes(response.status)) {
      const errorMessage: string =
        response.data.error || "Unknown error occurred";
      const details = response.data.details ? ` - ${JSON.stringify(response.data.details)}` : '';
      throw new FirecrawlError(
        `Failed to ${action}. Status code: ${response.status}. Error: ${errorMessage}${details}`,
        response.status,
        response?.data?.details
      );
    } else {
      throw new FirecrawlError(
        `Unexpected error occurred while trying to ${action}. Status code: ${response.status}`,
        response.status
      );
    }
  }

  /**
   * Initiates a deep research operation on a given query and polls until completion.
   * @param query - The query to research.
   * @param params - Parameters for the deep research operation.
   * @param onActivity - Optional callback to receive activity updates in real-time.
   * @param onSource - Optional callback to receive source updates in real-time.
   * @returns The final research results.
   */
  async deepResearch(
    query: string, 
    params: DeepResearchParams<zt.ZodSchema>,
    onActivity?: (activity: {
      type: string;
      status: string;
      message: string;
      timestamp: string;
      depth: number;
    }) => void,
    onSource?: (source: {
      url: string;
      title?: string;
      description?: string;
      icon?: string;
    }) => void
  ): Promise<DeepResearchStatusResponse | ErrorResponse> {
    try {
      const response = await this.asyncDeepResearch(query, params);
      
      if (!response.success || 'error' in response) {
        return { success: false, error: 'error' in response ? response.error : 'Unknown error' };
      }

      if (!response.id) {
        throw new FirecrawlError(`Failed to start research. No job ID returned.`, 500);
      }

      const jobId = response.id;
      let researchStatus;
      let lastActivityCount = 0;
      let lastSourceCount = 0;

      while (true) {
        researchStatus = await this.checkDeepResearchStatus(jobId);
        
        if ('error' in researchStatus && !researchStatus.success) {
          return researchStatus;
        }

        // Stream new activities through the callback if provided
        if (onActivity && researchStatus.activities) {
          const newActivities = researchStatus.activities.slice(lastActivityCount);
          for (const activity of newActivities) {
            onActivity(activity);
          }
          lastActivityCount = researchStatus.activities.length;
        }

        // Stream new sources through the callback if provided
        if (onSource && researchStatus.sources) {
          const newSources = researchStatus.sources.slice(lastSourceCount);
          for (const source of newSources) {
            onSource(source);
          }
          lastSourceCount = researchStatus.sources.length;
        }

        if (researchStatus.status === "completed") {
          return researchStatus;
        }

        if (researchStatus.status === "failed") {
          throw new FirecrawlError(
            `Research job ${researchStatus.status}. Error: ${researchStatus.error}`, 
            500
          );
        }

        if (researchStatus.status !== "processing") {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      return { success: false, error: "Research job terminated unexpectedly" };
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500, error.response?.data?.details);
    }
  }

  /**
   * Initiates a deep research operation on a given query without polling.
   * @param params - Parameters for the deep research operation.
   * @returns The response containing the research job ID.
   */
  async asyncDeepResearch(query: string, params: DeepResearchParams<zt.ZodSchema>): Promise<DeepResearchResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    let jsonData: any = { query, ...params, origin: `js-sdk@${this.version}` };

    if (jsonData?.jsonOptions?.schema) {
      let schema = jsonData.jsonOptions.schema;
      // Try parsing the schema as a Zod schema
      try {
        schema = zodToJsonSchema(schema);
      } catch (error) {
        // Ignore error if schema can't be parsed as Zod
      }
      jsonData = {
        ...jsonData,
        jsonOptions: {
          ...jsonData.jsonOptions,
          schema: schema,
        },
      };
    }

    try {
      const response: AxiosResponse = await this.postRequest(
        `${this.apiUrl}/v1/deep-research`,
        jsonData,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "start deep research");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Checks the status of a deep research operation.
   * @param id - The ID of the deep research operation.
   * @returns The current status and results of the research operation.
   */
  async checkDeepResearchStatus(id: string): Promise<DeepResearchStatusResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.getRequest(
        `${this.apiUrl}/v1/deep-research/${id}`,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else if (response.status === 404) {
        throw new FirecrawlError("Deep research job not found", 404);
      } else {
        this.handleError(response, "check deep research status");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * @deprecated Use deepResearch() instead
   * Initiates a deep research operation on a given topic and polls until completion.
   * @param topic - The topic to research.
   * @param params - Parameters for the deep research operation.
   * @param onActivity - Optional callback to receive activity updates in real-time.
   * @returns The final research results.
   */
  async __deepResearch(
    topic: string, 
    params: DeepResearchParams,
    onActivity?: (activity: {
      type: string;
      status: string;
      message: string;
      timestamp: string;
      depth: number;
    }) => void
  ): Promise<DeepResearchStatusResponse | ErrorResponse> {
    try {
      const response = await this.__asyncDeepResearch(topic, params);
      
      if (!response.success || 'error' in response) {
        return { success: false, error: 'error' in response ? response.error : 'Unknown error' };
      }

      if (!response.id) {
        throw new FirecrawlError(`Failed to start research. No job ID returned.`, 500);
      }

      const jobId = response.id;
      let researchStatus;
      let lastActivityCount = 0;

      while (true) {
        researchStatus = await this.__checkDeepResearchStatus(jobId);
        
        if ('error' in researchStatus && !researchStatus.success) {
          return researchStatus;
        }

        // Stream new activities through the callback if provided
        if (onActivity && researchStatus.activities) {
          const newActivities = researchStatus.activities.slice(lastActivityCount);
          for (const activity of newActivities) {
            onActivity(activity);
          }
          lastActivityCount = researchStatus.activities.length;
        }

        if (researchStatus.status === "completed") {
          return researchStatus;
        }

        if (researchStatus.status === "failed") {
          throw new FirecrawlError(
            `Research job ${researchStatus.status}. Error: ${researchStatus.error}`, 
            500
          );
        }

        if (researchStatus.status !== "processing") {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      return { success: false, error: "Research job terminated unexpectedly" };
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500, error.response?.data?.details);
    }
  }

  /**
   * @deprecated Use asyncDeepResearch() instead
   * Initiates a deep research operation on a given topic without polling.
   * @param params - Parameters for the deep research operation.
   * @returns The response containing the research job ID.
   */
  async __asyncDeepResearch(topic: string, params: DeepResearchParams): Promise<DeepResearchResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      let jsonData: any = { topic, ...params, origin: `js-sdk@${this.version}` };
      const response: AxiosResponse = await this.postRequest(
        `${this.apiUrl}/v1/deep-research`,
        jsonData,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "start deep research");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * @deprecated Use checkDeepResearchStatus() instead
   * Checks the status of a deep research operation.
   * @param id - The ID of the deep research operation.
   * @returns The current status and results of the research operation.
   */
  async __checkDeepResearchStatus(id: string): Promise<DeepResearchStatusResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.getRequest(
        `${this.apiUrl}/v1/deep-research/${id}`,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else if (response.status === 404) {
        throw new FirecrawlError("Deep research job not found", 404);
      } else {
        this.handleError(response, "check deep research status");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Generates LLMs.txt for a given URL and polls until completion.
   * @param url - The URL to generate LLMs.txt from.
   * @param params - Parameters for the LLMs.txt generation operation.
   * @returns The final generation results.
   */
  async generateLLMsText(url: string, params?: GenerateLLMsTextParams): Promise<GenerateLLMsTextStatusResponse | ErrorResponse> {
    try {
      const response = await this.asyncGenerateLLMsText(url, params);
      
      if (!response.success || 'error' in response) {
        return { success: false, error: 'error' in response ? response.error : 'Unknown error' };
      }

      if (!response.id) {
        throw new FirecrawlError(`Failed to start LLMs.txt generation. No job ID returned.`, 500);
      }

      const jobId = response.id;
      let generationStatus;

      while (true) {
        generationStatus = await this.checkGenerateLLMsTextStatus(jobId);
        
        if ('error' in generationStatus && !generationStatus.success) {
          return generationStatus;
        }

        if (generationStatus.status === "completed") {
          return generationStatus;
        }

        if (generationStatus.status === "failed") {
          throw new FirecrawlError(
            `LLMs.txt generation job ${generationStatus.status}. Error: ${generationStatus.error}`, 
            500
          );
        }

        if (generationStatus.status !== "processing") {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      return { success: false, error: "LLMs.txt generation job terminated unexpectedly" };
    } catch (error: any) {
      throw new FirecrawlError(error.message, 500, error.response?.data?.details);
    }
  }

  /**
   * Initiates a LLMs.txt generation operation without polling.
   * @param url - The URL to generate LLMs.txt from.
   * @param params - Parameters for the LLMs.txt generation operation.
   * @returns The response containing the generation job ID.
   */
  async asyncGenerateLLMsText(url: string, params?: GenerateLLMsTextParams): Promise<GenerateLLMsTextResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    let jsonData: any = { url, ...params, origin: `js-sdk@${this.version}` };
    try {
      const response: AxiosResponse = await this.postRequest(
        `${this.apiUrl}/v1/llmstxt`,
        jsonData,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "start LLMs.txt generation");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Checks the status of a LLMs.txt generation operation.
   * @param id - The ID of the LLMs.txt generation operation.
   * @returns The current status and results of the generation operation.
   */
  async checkGenerateLLMsTextStatus(id: string): Promise<GenerateLLMsTextStatusResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.getRequest(
        `${this.apiUrl}/v1/llmstxt/${id}`,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else if (response.status === 404) {
        throw new FirecrawlError("LLMs.txt generation job not found", 404);
      } else {
        this.handleError(response, "check LLMs.txt generation status");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Gets metrics about the team's scrape queue.
   * @returns The current queue status.
   */
  async getQueueStatus(): Promise<QueueStatusResponse | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.getRequest(
      `${this.apiUrl}/v1/team/queue-status`,
        headers
      );

      if (response.status === 200) {
        return response.data;
      } else {
        this.handleError(response, "get queue status");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Gets current credit usage and billing period for the team (v1).
   */
  async getCreditUsage(): Promise<CreditUsageResponseV1 | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.getRequest(
        `${this.apiUrl}/v1/team/credit-usage`,
        headers
      );
      if (response.status === 200) {
        return response.data as CreditUsageResponseV1;
      } else {
        this.handleError(response, "get credit usage");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Gets current token usage and billing period for the team (v1).
   */
  async getTokenUsage(): Promise<TokenUsageResponseV1 | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const response: AxiosResponse = await this.getRequest(
        `${this.apiUrl}/v1/team/token-usage`,
        headers
      );
      if (response.status === 200) {
        return response.data as TokenUsageResponseV1;
      } else {
        this.handleError(response, "get token usage");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Gets historical credit usage. Pass byApiKey=true to break down by API key.
   */
  async getCreditUsageHistorical(byApiKey?: boolean): Promise<CreditUsageHistoricalResponseV1 | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const url = `${this.apiUrl}/v1/team/credit-usage/historical${byApiKey ? "?byApiKey=true" : ""}`;
      const response: AxiosResponse = await this.getRequest(url, headers);
      if (response.status === 200) {
        return response.data as CreditUsageHistoricalResponseV1;
      } else {
        this.handleError(response, "get credit usage historical");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }

  /**
   * Gets historical token usage. Pass byApiKey=true to break down by API key.
   */
  async getTokenUsageHistorical(byApiKey?: boolean): Promise<TokenUsageHistoricalResponseV1 | ErrorResponse> {
    const headers = this.prepareHeaders();
    try {
      const url = `${this.apiUrl}/v1/team/token-usage/historical${byApiKey ? "?byApiKey=true" : ""}`;
      const response: AxiosResponse = await this.getRequest(url, headers);
      if (response.status === 200) {
        return response.data as TokenUsageHistoricalResponseV1;
      } else {
        this.handleError(response, "get token usage historical");
      }
    } catch (error: any) {
      if (error.response?.data?.error) {
        throw new FirecrawlError(`Request failed with status code ${error.response.status}. Error: ${error.response.data.error} ${error.response.data.details ? ` - ${JSON.stringify(error.response.data.details)}` : ''}`, error.response.status);
      } else {
        throw new FirecrawlError(error.message, 500);
      }
    }
    return { success: false, error: "Internal server error." };
  }
}

interface CrawlWatcherEvents {
  document: CustomEvent<FirecrawlDocument<undefined>>,
  done: CustomEvent<{
    status: CrawlStatusResponse["status"];
    data: FirecrawlDocument<undefined>[];
  }>,
  error: CustomEvent<{
    status: CrawlStatusResponse["status"],
    data: FirecrawlDocument<undefined>[],
    error: string,
  }>,
}

export class CrawlWatcher extends TypedEventTarget<CrawlWatcherEvents> {
  private ws: WebSocket;
  public data: FirecrawlDocument<undefined>[];
  public status: CrawlStatusResponse["status"];
  public id: string;

  constructor(id: string, app: FirecrawlApp) {
    super();
    this.id = id;
    // replace `http` with `ws` (`http://` -> `ws://` and `https://` -> `wss://`)
    const wsUrl = app.apiUrl.replace(/^http/, "ws");
    this.ws = new WebSocket(`${wsUrl}/v1/crawl/${id}`, app.apiKey);
    this.status = "scraping";
    this.data = [];

    type ErrorMessage = {
      type: "error",
      error: string,
    }
    
    type CatchupMessage = {
      type: "catchup",
      data: CrawlStatusResponse,
    }
    
    type DocumentMessage = {
      type: "document",
      data: FirecrawlDocument<undefined>,
    }
    
    type DoneMessage = { type: "done" }
    
    type Message = ErrorMessage | CatchupMessage | DoneMessage | DocumentMessage;

    const messageHandler = (msg: Message) => {
      if (msg.type === "done") {
        this.status = "completed";
        this.dispatchTypedEvent("done", new CustomEvent("done", {
          detail: {
            status: this.status,
            data: this.data,
            id: this.id,
          },
        }));
      } else if (msg.type === "error") {
        this.status = "failed";
        this.dispatchTypedEvent("error", new CustomEvent("error", {
          detail: {
            status: this.status,
            data: this.data,
            error: msg.error,
            id: this.id,
          },
        }));
      } else if (msg.type === "catchup") {
        this.status = msg.data.status;
        this.data.push(...(msg.data.data ?? []));
        for (const doc of this.data) {
          this.dispatchTypedEvent("document", new CustomEvent("document", {
            detail: {
              ...doc,
              id: this.id,
            },
          }));
        }
      } else if (msg.type === "document") {
        this.dispatchTypedEvent("document", new CustomEvent("document", {
          detail: {
            ...msg.data,
            id: this.id,
          },
        }));
      }
    }

    this.ws.onmessage = ((ev: MessageEvent) => {
      if (typeof ev.data !== "string") {
        this.ws.close();
        return;
      }
      try {
        const msg = JSON.parse(ev.data) as Message;
        messageHandler(msg);
      } catch (error) {
        console.error("Error on message", error);
      }
    }).bind(this);

    this.ws.onclose = ((ev: CloseEvent) => {
      try {
        const msg = JSON.parse(ev.reason) as Message;
        messageHandler(msg);
      } catch (error) {
        console.error("Error on close", error);
      }
    }).bind(this);

    this.ws.onerror = ((_: Event) => {
      this.status = "failed"
      this.dispatchTypedEvent("error", new CustomEvent("error", {
        detail: {
          status: this.status,
          data: this.data,
          error: "WebSocket error",
          id: this.id,
        },
      }));
    }).bind(this);
  }

  close() {
    this.ws.close();
  }
}
