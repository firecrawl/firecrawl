import { HttpClient } from "./utils/httpClient";
import { scrape } from "./methods/scrape";
import { search } from "./methods/search";
import { map as mapMethod } from "./methods/map";
import {
  startCrawl,
  getCrawlStatus,
  cancelCrawl,
  crawl as crawlWaiter,
  getCrawlErrors,
  getActiveCrawls,
  crawlParamsPreview,
} from "./methods/crawl";
import {
  startBatchScrape,
  getBatchScrapeStatus,
  getBatchScrapeErrors,
  cancelBatchScrape,
  batchScrape as batchWaiter,
} from "./methods/batch";
import { startExtract, getExtractStatus, extract as extractWaiter } from "./methods/extract";
import { getConcurrency, getCreditUsage, getQueueStatus, getTokenUsage, getCreditUsageHistorical, getTokenUsageHistorical } from "./methods/usage";
import type {
  Document,
  ScrapeOptions,
  SearchData,
  SearchRequest,
  MapData,
  MapOptions,
  CrawlResponse,
  CrawlJob,
  CrawlErrorsResponse,
  ActiveCrawlsResponse,
  BatchScrapeResponse,
  BatchScrapeJob,
  ExtractResponse,
  CrawlOptions,
  BatchScrapeOptions,
  PaginationConfig,
} from "./types";
import { Watcher } from "./watcher";
import type { WatcherOptions } from "./watcher";
import * as zt from "zod";

// Helper types to infer the `json` field from a Zod schema included in `formats`
type ExtractJsonSchemaFromFormats<Formats> = Formats extends readonly any[]
  ? Extract<Formats[number], { type: "json"; schema?: unknown }>["schema"]
  : never;

type InferredJsonFromOptions<Opts> = Opts extends { formats?: infer Fmts }
  ? ExtractJsonSchemaFromFormats<Fmts> extends zt.ZodTypeAny
    ? zt.infer<ExtractJsonSchemaFromFormats<Fmts>>
    : unknown
  : unknown;

/**
 * Configuration for the v2 client transport.
 */
export interface FirecrawlClientOptions {
  /** API key (falls back to FIRECRAWL_API_KEY). */
  apiKey?: string | null;
  /** API base URL (falls back to FIRECRAWL_API_URL or https://api.firecrawl.dev). */
  apiUrl?: string | null;
  /** Per-request timeout in milliseconds (optional). */
  timeoutMs?: number;
  /** Max automatic retries for transient failures (optional). */
  maxRetries?: number;
  /** Exponential backoff factor for retries (optional). */
  backoffFactor?: number;
}

/**
 * Firecrawl v2 client. Provides typed access to all v2 endpoints and utilities.
 */

export class FirecrawlClient {
  private readonly http: HttpClient;

  private isCloudService(url: string): boolean {
    return url.includes('api.firecrawl.dev');
  }

  /**
   * Create a v2 client.
   * @param options Transport configuration (API key, base URL, timeouts, retries).
   */
  constructor(options: FirecrawlClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY ?? "";
    const apiUrl = (options.apiUrl ?? process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/$/, "");

    if (this.isCloudService(apiUrl) && !apiKey) {
      throw new Error("API key is required for the cloud API. Set FIRECRAWL_API_KEY env or pass apiKey.");
    }

    this.http = new HttpClient({
      apiKey,
      apiUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      backoffFactor: options.backoffFactor,
    });
  }

  // Scrape
  /**
   * Scrape a single URL.
   * @param url Target URL.
   * @param options Optional scrape options (formats, headers, etc.).
   * @returns Resolved document with requested formats.
   */
  async scrape<Opts extends ScrapeOptions>(
    url: string,
    options: Opts
  ): Promise<Omit<Document, "json"> & { json?: InferredJsonFromOptions<Opts> }>;
  async scrape(url: string, options?: ScrapeOptions): Promise<Document>;
  async scrape(url: string, options?: ScrapeOptions): Promise<Document> {
    return scrape(this.http, url, options);
  }

  // Search
  /**
   * Search the web and optionally scrape each result.
   * @param query Search query string.
   * @param req Additional search options (sources, limit, scrapeOptions, etc.).
   * @returns Structured search results.
   */
  async search(query: string, req: Omit<SearchRequest, "query"> = {}): Promise<SearchData> {
    return search(this.http, { query, ...req });
  }

  // Map
  /**
   * Map a site to discover URLs (sitemap-aware).
   * @param url Root URL to map.
   * @param options Mapping options (sitemap mode, includeSubdomains, limit, timeout).
   * @returns Discovered links.
   */
  async map(url: string, options?: MapOptions): Promise<MapData> {
    return mapMethod(this.http, url, options);
  }

  // Crawl
  /**
   * Start a crawl job (async).
   * @param url Root URL to crawl.
   * @param req Crawl configuration (paths, limits, scrapeOptions, webhook, etc.).
   * @returns Job id and url.
   */
  async startCrawl(url: string, req: CrawlOptions = {}): Promise<CrawlResponse> {
    return startCrawl(this.http, { url, ...req });
  }
  /**
   * Get the status and partial data of a crawl job.
   * @param jobId Crawl job id.
   */
  async getCrawlStatus(jobId: string, pagination?: PaginationConfig): Promise<CrawlJob> {
    return getCrawlStatus(this.http, jobId, pagination);
  }
  /**
   * Cancel a crawl job.
   * @param jobId Crawl job id.
   * @returns True if cancelled.
   */
  async cancelCrawl(jobId: string): Promise<boolean> {
    return cancelCrawl(this.http, jobId);
  }
  /**
   * Convenience waiter: start a crawl and poll until it finishes.
   * @param url Root URL to crawl.
   * @param req Crawl configuration plus waiter controls (pollInterval, timeout seconds).
   * @returns Final job snapshot.
   */
  async crawl(url: string, req: CrawlOptions & { pollInterval?: number; timeout?: number } = {}): Promise<CrawlJob> {
    return crawlWaiter(this.http, { url, ...req }, req.pollInterval, req.timeout);
  }
  /**
   * Retrieve crawl errors and robots.txt blocks.
   * @param crawlId Crawl job id.
   */
  async getCrawlErrors(crawlId: string): Promise<CrawlErrorsResponse> {
    return getCrawlErrors(this.http, crawlId);
  }
  /**
   * List active crawls for the authenticated team.
   */
  async getActiveCrawls(): Promise<ActiveCrawlsResponse> {
    return getActiveCrawls(this.http);
  }
  /**
   * Preview normalized crawl parameters produced by a natural-language prompt.
   * @param url Root URL.
   * @param prompt Natural-language instruction.
   */
  async crawlParamsPreview(url: string, prompt: string): Promise<Record<string, unknown>> {
    return crawlParamsPreview(this.http, url, prompt);
  }

  // Batch
  /**
   * Start a batch scrape job for multiple URLs (async).
   * @param urls URLs to scrape.
   * @param opts Batch options (scrape options, webhook, concurrency, idempotency key, etc.).
   * @returns Job id and url.
   */
  async startBatchScrape(urls: string[], opts?: BatchScrapeOptions): Promise<BatchScrapeResponse> {
    return startBatchScrape(this.http, urls, opts);
  }
  /**
   * Get the status and partial data of a batch scrape job.
   * @param jobId Batch job id.
   */
  async getBatchScrapeStatus(jobId: string, pagination?: PaginationConfig): Promise<BatchScrapeJob> {
    return getBatchScrapeStatus(this.http, jobId, pagination);
  }
  /**
   * Retrieve batch scrape errors and robots.txt blocks.
   * @param jobId Batch job id.
   */
  async getBatchScrapeErrors(jobId: string): Promise<CrawlErrorsResponse> {
    return getBatchScrapeErrors(this.http, jobId);
  }
  /**
   * Cancel a batch scrape job.
   * @param jobId Batch job id.
   * @returns True if cancelled.
   */
  async cancelBatchScrape(jobId: string): Promise<boolean> {
    return cancelBatchScrape(this.http, jobId);
  }
  /**
   * Convenience waiter: start a batch scrape and poll until it finishes.
   * @param urls URLs to scrape.
   * @param opts Batch options plus waiter controls (pollInterval, timeout seconds).
   * @returns Final job snapshot.
   */
  async batchScrape(urls: string[], opts?: BatchScrapeOptions & { pollInterval?: number; timeout?: number }): Promise<BatchScrapeJob> {
    return batchWaiter(this.http, urls, opts);
  }

  // Extract
  /**
   * Start an extract job (async).
   * @param args Extraction request (urls, schema or prompt, flags).
   * @returns Job id or processing state.
   */
  async startExtract(args: Parameters<typeof startExtract>[1]): Promise<ExtractResponse> {
    return startExtract(this.http, args);
  }
  /**
   * Get extract job status/data.
   * @param jobId Extract job id.
   */
  async getExtractStatus(jobId: string): Promise<ExtractResponse> {
    return getExtractStatus(this.http, jobId);
  }
  /**
   * Convenience waiter: start an extract and poll until it finishes.
   * @param args Extraction request plus waiter controls (pollInterval, timeout seconds).
   * @returns Final extract response.
   */
  async extract(args: Parameters<typeof startExtract>[1] & { pollInterval?: number; timeout?: number }): Promise<ExtractResponse> {
    return extractWaiter(this.http, args);
  }

  // Usage
  /** Current concurrency usage. */
  async getConcurrency() {
    return getConcurrency(this.http);
  }
  /** Current credit usage. */
  async getCreditUsage() {
    return getCreditUsage(this.http);
  }
  /** Recent token usage. */
  async getTokenUsage() {
    return getTokenUsage(this.http);
  }

  /** Historical credit usage by month; set byApiKey to true to break down by API key. */
  async getCreditUsageHistorical(byApiKey?: boolean) {
    return getCreditUsageHistorical(this.http, byApiKey);
  }

  /** Historical token usage by month; set byApiKey to true to break down by API key. */
  async getTokenUsageHistorical(byApiKey?: boolean) {
    return getTokenUsageHistorical(this.http, byApiKey);
  }

  /** Metrics about the team's scrape queue. */
  async getQueueStatus() {
    return getQueueStatus(this.http);
  }

  // Watcher
  /**
   * Create a watcher for a crawl or batch job. Emits: `document`, `snapshot`, `done`, `error`.
   * @param jobId Job id.
   * @param opts Watcher options (kind, pollInterval, timeout seconds).
   */
  watcher(jobId: string, opts: WatcherOptions = {}): Watcher {
    return new Watcher(this.http, jobId, opts);
  }
}

export default FirecrawlClient;

