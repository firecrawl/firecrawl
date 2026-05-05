import { HttpClient } from "./utils/httpClient";
import {
  scrape,
  interact as interactMethod,
  stopInteraction as stopInteractionMethod,
} from "./methods/scrape";
import { parse as parseMethod } from "./methods/parse";
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
import { startAgent, getAgentStatus, cancelAgent, agent as agentWaiter } from "./methods/agent";
import {
  browser as browserMethod,
  browserExecute,
  deleteBrowser,
  listBrowsers,
} from "./methods/browser";
import { getConcurrency, getCreditUsage, getQueueStatus, getTokenUsage, getCreditUsageHistorical, getTokenUsageHistorical } from "./methods/usage";
import {
  createMonitor as createMonitorMethod,
  deleteMonitor as deleteMonitorMethod,
  getMonitor as getMonitorMethod,
  getMonitorCheck as getMonitorCheckMethod,
  listMonitorChecks as listMonitorChecksMethod,
  listMonitors as listMonitorsMethod,
  runMonitor as runMonitorMethod,
  updateMonitor as updateMonitorMethod,
} from "./methods/monitor";
import type {
  Document,
  ParseFile,
  ParseOptions,
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
  AgentResponse,
  AgentStatusResponse,
  CrawlOptions,
  BatchScrapeOptions,
  PaginationConfig,
  BrowserCreateResponse,
  BrowserExecuteResponse,
  BrowserDeleteResponse,
  BrowserListResponse,
  ScrapeExecuteRequest,
  ScrapeExecuteResponse,
  ScrapeBrowserDeleteResponse,
  CreateMonitorRequest,
  ListMonitorChecksOptions,
  ListMonitorsOptions,
  Monitor,
  MonitorCheck,
  MonitorCheckDetail,
  GetMonitorCheckOptions,
  UpdateMonitorRequest,
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
  /**
   * Interact with the browser session associated with a scrape job.
   * @param jobId Scrape job id.
   * @param args Code or prompt to execute, with language/timeout options.
   * @returns Execution result including output, stdout, stderr, exitCode, and killed status.
   */
  async interact(
    jobId: string,
    args: ScrapeExecuteRequest
  ): Promise<ScrapeExecuteResponse> {
    return interactMethod(this.http, jobId, args);
  }
  /**
   * Stop the interaction session associated with a scrape job.
   * @param jobId Scrape job id.
   */
  async stopInteraction(jobId: string): Promise<ScrapeBrowserDeleteResponse> {
    return stopInteractionMethod(this.http, jobId);
  }
  /**
   * @deprecated Use interact().
   */
  async scrapeExecute(
    jobId: string,
    args: ScrapeExecuteRequest
  ): Promise<ScrapeExecuteResponse> {
    return this.interact(jobId, args);
  }
  /**
   * @deprecated Use stopInteraction().
   */
  async stopInteractiveBrowser(jobId: string): Promise<ScrapeBrowserDeleteResponse> {
    return this.stopInteraction(jobId);
  }
  /**
   * @deprecated Use stopInteraction().
   */
  async deleteScrapeBrowser(jobId: string): Promise<ScrapeBrowserDeleteResponse> {
    return this.stopInteraction(jobId);
  }

  // Parse
  /**
   * Parse an uploaded file via the v2 parse endpoint.
   * @param file File payload (data, filename, optional contentType).
   * @param options Optional parse options (formats, parsers, etc.).
   *                Note: parse does not support changeTracking, screenshot, branding,
   *                actions, waitFor, location, or mobile options.
   * @returns Parsed document with requested formats.
   */
  async parse<Opts extends ParseOptions>(
    file: ParseFile,
    options: Opts
  ): Promise<Omit<Document, "json"> & { json?: InferredJsonFromOptions<Opts> }>;
  async parse(file: ParseFile, options?: ParseOptions): Promise<Document>;
  async parse(file: ParseFile, options?: ParseOptions): Promise<Document> {
    return parseMethod(this.http, file, options);
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

  // Monitor
  /**
   * Create a scheduled monitor.
   */
  async createMonitor(request: CreateMonitorRequest): Promise<Monitor> {
    return createMonitorMethod(this.http, request);
  }

  /**
   * List monitors for the authenticated team.
   */
  async listMonitors(options?: ListMonitorsOptions): Promise<Monitor[]> {
    return listMonitorsMethod(this.http, options);
  }

  /**
   * Get a monitor by id.
   */
  async getMonitor(monitorId: string): Promise<Monitor> {
    return getMonitorMethod(this.http, monitorId);
  }

  /**
   * Update a monitor.
   */
  async updateMonitor(
    monitorId: string,
    request: UpdateMonitorRequest,
  ): Promise<Monitor> {
    return updateMonitorMethod(this.http, monitorId, request);
  }

  /**
   * Delete a monitor.
   */
  async deleteMonitor(monitorId: string): Promise<boolean> {
    return deleteMonitorMethod(this.http, monitorId);
  }

  /**
   * Trigger a manual monitor check.
   */
  async runMonitor(monitorId: string): Promise<MonitorCheck> {
    return runMonitorMethod(this.http, monitorId);
  }

  /**
   * List checks for a monitor.
   */
  async listMonitorChecks(
    monitorId: string,
    options?: ListMonitorChecksOptions,
  ): Promise<MonitorCheck[]> {
    return listMonitorChecksMethod(this.http, monitorId, options);
  }

  /**
   * Get a monitor check with paginated page results and inline diffs.
   */
  async getMonitorCheck(
    monitorId: string,
    checkId: string,
    options?: GetMonitorCheckOptions,
  ): Promise<MonitorCheckDetail> {
    return getMonitorCheckMethod(this.http, monitorId, checkId, options);
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
   * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
   * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
   */
  async startExtract(args: Parameters<typeof startExtract>[1]): Promise<ExtractResponse> {
    return startExtract(this.http, args);
  }
  /**
   * Get extract job status/data.
   * @param jobId Extract job id.
   * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
   * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
   */
  async getExtractStatus(jobId: string): Promise<ExtractResponse> {
    return getExtractStatus(this.http, jobId);
  }
  /**
   * Convenience waiter: start an extract and poll until it finishes.
   * @param args Extraction request plus waiter controls (pollInterval, timeout seconds).
   * @returns Final extract response.
   * @deprecated The extract endpoint is in maintenance mode and its use is discouraged.
   * Review https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor to find a replacement.
   */
  async extract(args: Parameters<typeof startExtract>[1] & { pollInterval?: number; timeout?: number }): Promise<ExtractResponse> {
    return extractWaiter(this.http, args);
  }

  // Agent
  /**
   * Start an agent job (async).
   * @param args Agent request (urls, prompt, schema).
   * @returns Job id or processing state.
   */
  async startAgent(args: Parameters<typeof startAgent>[1]): Promise<AgentResponse> {
    return startAgent(this.http, args);
  }
  /**
   * Get agent job status/data.
   * @param jobId Agent job id.
   */
  async getAgentStatus(jobId: string): Promise<AgentStatusResponse> {
    return getAgentStatus(this.http, jobId);
  }
  /**
   * Convenience waiter: start an agent and poll until it finishes.
   * @param args Agent request plus waiter controls (pollInterval, timeout seconds).
   * @returns Final agent response.
   */
  async agent(args: Parameters<typeof startAgent>[1] & { pollInterval?: number; timeout?: number }): Promise<AgentStatusResponse> {
    return agentWaiter(this.http, args);
  }
  /**
   * Cancel an agent job.
   * @param jobId Agent job id.
   * @returns True if cancelled.
   */
  async cancelAgent(jobId: string): Promise<boolean> {
    return cancelAgent(this.http, jobId);
  }

  // Browser
  /**
   * Create a new browser session.
   * @param args Session options (ttl, activityTtl, streamWebView, profile).
   * @returns Session id, CDP URL, live view URL, and expiration time.
   */
  async browser(
    args: Parameters<typeof browserMethod>[1] = {}
  ): Promise<BrowserCreateResponse> {
    return browserMethod(this.http, args);
  }
  /**
   * Execute code in a browser session.
   * @param sessionId Browser session id.
   * @param args Code, language ("python" | "node" | "bash"), and optional timeout.
   * @returns Execution result including stdout, stderr, exitCode, and killed status.
   */
  async browserExecute(
    sessionId: string,
    args: Parameters<typeof browserExecute>[2]
  ): Promise<BrowserExecuteResponse> {
    return browserExecute(this.http, sessionId, args);
  }
  /**
   * Delete a browser session.
   * @param sessionId Browser session id.
   */
  async deleteBrowser(sessionId: string): Promise<BrowserDeleteResponse> {
    return deleteBrowser(this.http, sessionId);
  }
  /**
   * List browser sessions.
   * @param args Optional filter (status: "active" | "destroyed").
   * @returns List of browser sessions.
   */
  async listBrowsers(
    args: Parameters<typeof listBrowsers>[1] = {}
  ): Promise<BrowserListResponse> {
    return listBrowsers(this.http, args);
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

