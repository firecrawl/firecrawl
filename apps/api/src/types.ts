import { z } from "zod";
import {
  BaseScrapeOptions,
  ScrapeOptions,
  Document as V2Document,
  TeamFlags,
} from "./controllers/v2/types";
import { AuthCreditUsageChunk } from "./controllers/v1/types";
import { ExtractorOptions, Document } from "./lib/entities";
import { InternalOptions } from "./scraper/scrapeURL";
import type { CostTracking } from "./lib/cost-tracking";
import { webhookSchema } from "./services/webhook/schema";
import { SerializedTraceContext } from "./lib/otel-tracer";

type ScrapeJobCommon = {
  concurrencyLimited?: boolean;
  team_id: string;
  zeroDataRetention: boolean;
  traceContext?: SerializedTraceContext;
  skipNuq?: boolean;
};

export type ScrapeJobData = ScrapeJobCommon &
  (
    | ScrapeJobSingleUrlsUnique
    | ScrapeJobKickoffUnique
    | ScrapeJobKickoffSitemapUnique
  );

type ScrapeJobSingleUrlsUnique = {
  mode: "single_urls";

  url: string;
  crawlerOptions?: any;
  scrapeOptions: BaseScrapeOptions;
  internalOptions?: InternalOptions;
  origin: string;
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

  sentry?: any;
  is_extract?: boolean;
  apiKeyId: number | null;
};

export type ScrapeJobSingleUrls = ScrapeJobCommon & ScrapeJobSingleUrlsUnique;

type ScrapeJobKickoffUnique = {
  mode: "kickoff";

  url: string;
  crawlerOptions?: any;
  scrapeOptions: BaseScrapeOptions;
  internalOptions?: InternalOptions;
  origin: string;
  integration?: string | null;
  crawl_id: string;
  webhook?: z.infer<typeof webhookSchema>;
  v1: boolean;
  apiKeyId: number | null;
};

export type ScrapeJobKickoff = ScrapeJobCommon & ScrapeJobKickoffUnique;

type ScrapeJobKickoffSitemapUnique = {
  mode: "kickoff_sitemap";

  crawl_id: string;
  sitemapUrl: string;
  location?: ScrapeOptions["location"];
  origin: string;
  integration?: string | null;
  webhook?: z.infer<typeof webhookSchema>;
  v1: boolean;
  apiKeyId: number | null;
};

export type ScrapeJobKickoffSitemap = ScrapeJobCommon &
  ScrapeJobKickoffSitemapUnique;

export interface RunWebScraperParams {
  url: string;
  scrapeOptions: ScrapeOptions;
  internalOptions?: InternalOptions;
  team_id: string;
  bull_job_id: string;
  priority?: number;
  is_crawl?: boolean;
  urlInvisibleInCurrentCrawl?: boolean;
  costTracking: CostTracking;
}

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
