import { z } from "zod";
import {
  BaseScrapeOptions,
  ScrapeOptions,
  Document as V2Document,
  webhookSchema,
  TeamFlags,
} from "./controllers/v2/types";
import { AuthCreditUsageChunk } from "./controllers/v1/types";
import { ExtractorOptions, Document } from "./lib/entities";
import { InternalOptions } from "./scraper/scrapeURL";
import type { CostTracking } from "./lib/cost-tracking";

type Mode = "crawl" | "single_urls" | "sitemap" | "kickoff";

export { Mode };

export interface CrawlResult {
  source: string;
  content: string;
  options?: {
    summarize?: boolean;
    summarize_max_chars?: number;
  };
  metadata?: any;
  raw_context_id?: number | string;
  permissions?: any[];
}

export interface IngestResult {
  success: boolean;
  error: string;
  data: CrawlResult[];
}

export interface WebScraperOptions {
  url: string;
  mode: Mode;
  crawlerOptions?: any;
  scrapeOptions: BaseScrapeOptions;
  internalOptions?: InternalOptions;
  team_id: string;
  origin?: string;
  crawl_id?: string;
  sitemapped?: boolean;
  webhook?: z.infer<typeof webhookSchema>;
  v1?: boolean;
  integration?: string | null;

  /**
   * Disables billing on the worker side.
   */
  is_scrape?: boolean;

  isCrawlSourceScrape?: boolean;
  from_extract?: boolean;
  startTime?: number;

  zeroDataRetention: boolean;
  sentry?: any;
  is_extract?: boolean;
  concurrencyLimited?: boolean;
  apiKeyId: number | null;
}

export interface RunWebScraperParams {
  url: string;
  mode: Mode;
  scrapeOptions: ScrapeOptions;
  internalOptions?: InternalOptions;
  team_id: string;
  bull_job_id: string;
  priority?: number;
  is_scrape?: boolean;
  is_crawl?: boolean;
  urlInvisibleInCurrentCrawl?: boolean;
  costTracking: CostTracking;
}

export type RunWebScraperResult =
  | {
      success: false;
      error: Error;
    }
  | {
      success: true;
      document: V2Document;
    };

export interface FirecrawlJob {
  job_id?: string;
  success: boolean;
  message?: string;
  num_docs: number;
  docs: any[];
  time_taken: number;
  team_id: string;
  mode: string;
  url: string;
  crawlerOptions?: any;
  scrapeOptions?: any;
  origin: string;
  integration?: string | null;
  num_tokens?: number;
  retry?: boolean;
  crawl_id?: string;
  tokens_billed?: number;
  sources?: Record<string, string[]>;
  cost_tracking?: CostTracking;
  pdf_num_pages?: number;
  credits_billed?: number | null;
  change_tracking_tag?: string | null;
  dr_clean_by?: string | null;

  zeroDataRetention: boolean;
}

export interface FirecrawlScrapeResponse {
  statusCode: number;
  body: {
    status: string;
    data: Document;
  };
  error?: string;
}

export interface FirecrawlCrawlResponse {
  statusCode: number;
  body: {
    status: string;
    jobId: string;
  };
  error?: string;
}

export interface FirecrawlCrawlStatusResponse {
  statusCode: number;
  body: {
    status: string;
    data: Document[];
  };
  error?: string;
}

export interface FirecrawlExtractResponse {
  statusCode: number;
  body: {
    success: boolean;
    data: any[];
  };
  error?: string;
}

export enum RateLimiterMode {
  Crawl = "crawl",
  CrawlStatus = "crawlStatus",
  Scrape = "scrape",
  ScrapeAgentPreview = "scrapeAgentPreview",
  Preview = "preview",
  Search = "search",
  Map = "map",
  Extract = "extract",
  ExtractStatus = "extractStatus",
  ExtractAgentPreview = "extractAgentPreview",
}

export type AuthResponse =
  | {
      success: true;
      team_id: string;
      api_key?: string;
      chunk: AuthCreditUsageChunk | null;
    }
  | {
      success: false;
      error: string;
      status: number;
    };

export enum NotificationType {
  APPROACHING_LIMIT = "approachingLimit",
  LIMIT_REACHED = "limitReached",
  RATE_LIMIT_REACHED = "rateLimitReached",
  AUTO_RECHARGE_SUCCESS = "autoRechargeSuccess",
  AUTO_RECHARGE_FAILED = "autoRechargeFailed",
  CONCURRENCY_LIMIT_REACHED = "concurrencyLimitReached",
  AUTO_RECHARGE_FREQUENT = "autoRechargeFrequent",
}

export type ScrapeLog = {
  url: string;
  scraper: string;
  success?: boolean;
  response_code?: number;
  time_taken_seconds?: number;
  proxy?: string;
  retried?: boolean;
  error_message?: string;
  date_added?: string; // ISO 8601 format
  html?: string;
  ipv4_support?: boolean | null;
  ipv6_support?: boolean | null;
};

export type WebhookEventType =
  | "crawl.page"
  | "batch_scrape.page"
  | "crawl.started"
  | "batch_scrape.started"
  | "crawl.completed"
  | "batch_scrape.completed"
  | "crawl.failed";
