import { z } from "zod";
import { webhookSchema } from "./schema";
import { ExtractResult } from "../../lib/extract/extraction-service";
import { Document } from "../../controllers/v2/types";

export enum WebhookEvent {
  CRAWL_STARTED = "crawl.started",
  CRAWL_PAGE = "crawl.page",
  CRAWL_COMPLETED = "crawl.completed",
  BATCH_SCRAPE_STARTED = "batch_scrape.started",
  BATCH_SCRAPE_PAGE = "batch_scrape.page",
  BATCH_SCRAPE_COMPLETED = "batch_scrape.completed",
  EXTRACT_STARTED = "extract.started",
  EXTRACT_COMPLETED = "extract.completed",
  EXTRACT_FAILED = "extract.failed",
}

export type WebhookEventDataMap = {
  [WebhookEvent.CRAWL_STARTED]: CrawlStartedData;
  [WebhookEvent.CRAWL_PAGE]: CrawlPageData;
  [WebhookEvent.CRAWL_COMPLETED]: CrawlCompletedData;
  [WebhookEvent.BATCH_SCRAPE_STARTED]: BatchScrapeStartedData;
  [WebhookEvent.BATCH_SCRAPE_PAGE]: BatchScrapePageData;
  [WebhookEvent.BATCH_SCRAPE_COMPLETED]: BatchScrapeCompletedData;
  [WebhookEvent.EXTRACT_STARTED]: ExtractStartedData;
  [WebhookEvent.EXTRACT_COMPLETED]: ExtractCompletedData;
  [WebhookEvent.EXTRACT_FAILED]: ExtractFailedData;
};

export type WebhookConfig = z.infer<typeof webhookSchema>;

export type WebhookQueueMessage = {
  webhook_url: string;
  payload: {
    success: boolean;
    type: string;
    webhookId: string;
    id?: string;
    jobId?: string;
    data: any[];
    error?: string;
    metadata?: Record<string, string>;
  };
  headers: Record<string, string>;
  team_id: string;
  job_id: string;
  scrape_id: string | null;
  event: WebhookEvent;
  timeout_ms: number;
};

interface WebhookDocument {
  content?: string;
  markdown: string;
  metadata: Record<string, any>;
}

interface WebhookDocumentLink {
  content: WebhookDocument;
  source: string;
}

interface BaseWebhookData {
  success: boolean;
  awaitWebhook?: boolean;
}

// crawl
interface CrawlStartedData extends BaseWebhookData {
  success: true;
}

interface CrawlPageData extends BaseWebhookData {
  success: boolean;
  data: Document[] | WebhookDocumentLink[]; // links or documents (v0 compatible)
  scrapeId: string;
  error?: string;
}

interface CrawlCompletedData extends BaseWebhookData {
  success: true;
  data: Document[] | WebhookDocumentLink[]; // empty array or links (v0 compatible)
}

// batch scrape
interface BatchScrapeStartedData extends BaseWebhookData {
  success: true;
}

interface BatchScrapePageData extends BaseWebhookData {
  success: boolean;
  data: Document[];
  scrapeId: string;
  error?: string; // more v0 tomfoolery
}

interface BatchScrapeCompletedData extends BaseWebhookData {
  success: true;
  data: WebhookDocumentLink[];
}

// extract
interface ExtractStartedData extends BaseWebhookData {
  success: true;
}

interface ExtractCompletedData extends BaseWebhookData {
  success: true;
  data: ExtractResult[];
}

interface ExtractFailedData extends BaseWebhookData {
  success: false;
  error: string;
}
