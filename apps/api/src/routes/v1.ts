import express from "express";
import { crawlController } from "../controllers/v1/crawl";
// import { crawlStatusController } from "../../src/controllers/v1/crawl-status";
import { scrapeController } from "../../src/controllers/v1/scrape";
import { crawlStatusController } from "../controllers/v1/crawl-status";
import { mapController } from "../controllers/v1/map";
import { RateLimiterMode } from "../types";
import { SEARCH_CREDITS_FEATURE_ID } from "../services/autumn/autumn.service";
import expressWs from "express-ws";
import { crawlStatusWSController } from "../controllers/v1/crawl-status-ws";
import { crawlCancelController } from "../controllers/v1/crawl-cancel";
import { scrapeStatusController } from "../controllers/v1/scrape-status";
import { concurrencyCheckController } from "../controllers/v1/concurrency-check";
import { batchScrapeController } from "../controllers/v1/batch-scrape";
import { extractController } from "../controllers/v1/extract";
import { extractStatusController } from "../controllers/v1/extract-status";
import { creditUsageController } from "../controllers/v1/credit-usage";
import { searchController } from "../controllers/v1/search";
import { crawlErrorsController } from "../controllers/v1/crawl-errors";
import { generateLLMsTextController } from "../controllers/v1/generate-llmstxt";
import { generateLLMsTextStatusController } from "../controllers/v1/generate-llmstxt-status";
import { deepResearchController } from "../controllers/v1/deep-research";
import { deepResearchStatusController } from "../controllers/v1/deep-research-status";
import { tokenUsageController } from "../controllers/v1/token-usage";
import { ongoingCrawlsController } from "../controllers/v1/crawl-ongoing";
import { fireclawController } from "../controllers/v1/fireclaw";
import {
  authMiddleware,
  checkCreditsMiddleware,
  blocklistMiddleware,
  scrapeBlocklistMiddleware,
  countryCheck,
  idempotencyMiddleware,
  requestTimingMiddleware,
  validateJobIdParam,
  wrap,
} from "./shared";
import { queueStatusController } from "../controllers/v1/queue-status";
import { creditUsageHistoricalController } from "../controllers/v1/credit-usage-historical";

import { tokenUsageHistoricalController } from "../controllers/v1/token-usage-historical";
import { deprecationMiddleware } from "../lib/deprecations";

export const v1Router = express.Router();
expressWs(express()).applyTo(v1Router);

// Add timing middleware to all v1 routes
v1Router.use(requestTimingMiddleware("v1"));

v1Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape, { allowKeyless: true }),
  countryCheck,
  checkCreditsMiddleware(1),
  scrapeBlocklistMiddleware,
  wrap(scrapeController),
);

v1Router.post(
  "/crawl",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(),
  scrapeBlocklistMiddleware,
  idempotencyMiddleware,
  wrap(crawlController),
);

v1Router.post(
  "/batch/scrape",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
  idempotencyMiddleware,
  wrap(batchScrapeController),
);

v1Router.post(
  "/search",
  authMiddleware(RateLimiterMode.Search, { allowKeyless: true }),
  countryCheck,
  checkCreditsMiddleware(undefined, SEARCH_CREDITS_FEATURE_ID),
  wrap(searchController),
);

v1Router.post(
  "/map",
  authMiddleware(RateLimiterMode.Map),
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(mapController),
);

v1Router.get(
  "/crawl/ongoing",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(ongoingCrawlsController),
);

// Public facing, same as ongoing
v1Router.get(
  "/crawl/active",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(ongoingCrawlsController),
);

v1Router.get(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(crawlStatusController),
);

v1Router.get(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  // Yes, it uses the same controller as the normal crawl status controller
  wrap((req: any, res): any => crawlStatusController(req, res, true)),
);

v1Router.get(
  "/crawl/:jobId/errors",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(crawlErrorsController),
);

v1Router.get(
  "/batch/scrape/:jobId/errors",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(crawlErrorsController),
);

v1Router.get(
  "/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(scrapeStatusController),
);

v1Router.get(
  "/concurrency-check",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(concurrencyCheckController),
);

v1Router.ws("/crawl/:jobId", crawlStatusWSController);

v1Router.post(
  "/extract",
  authMiddleware(RateLimiterMode.Extract),
  deprecationMiddleware("v1_extract"),
  countryCheck,
  checkCreditsMiddleware(20),
  wrap(extractController),
);

v1Router.get(
  "/extract/:jobId",
  authMiddleware(RateLimiterMode.ExtractStatus),
  deprecationMiddleware("v1_extract_status"),
  wrap(extractStatusController),
);

v1Router.post(
  "/llmstxt",
  authMiddleware(RateLimiterMode.Scrape),
  deprecationMiddleware("v1_llmstxt"),
  countryCheck,
  blocklistMiddleware,
  wrap(generateLLMsTextController),
);

v1Router.get(
  "/llmstxt/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  deprecationMiddleware("v1_llmstxt_status"),
  wrap(generateLLMsTextStatusController),
);

v1Router.post(
  "/deep-research",
  authMiddleware(RateLimiterMode.Crawl),
  deprecationMiddleware("v1_deep_research"),
  countryCheck,
  checkCreditsMiddleware(1),
  wrap(deepResearchController),
);

v1Router.get(
  "/deep-research/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  deprecationMiddleware("v1_deep_research_status"),
  wrap(deepResearchStatusController),
);

// v1Router.post("/crawlWebsitePreview", crawlPreviewController);

v1Router.delete(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  crawlCancelController,
);

v1Router.delete(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  crawlCancelController,
);
// v1Router.get("/checkJobStatus/:jobId", crawlJobStatusPreviewController);

// // Auth route for key based authentication
// v1Router.get("/keyAuth", keyAuthController);

// // Search routes
// v0Router.post("/search", searchController);

// Health/Probe routes
// v1Router.get("/health/liveness", livenessController);
// v1Router.get("/health/readiness", readinessController);

v1Router.post(
  "/fireclaw",
  authMiddleware(RateLimiterMode.Scrape),
  checkCreditsMiddleware(100),
  wrap(fireclawController),
);

v1Router.get(
  "/team/credit-usage",
  authMiddleware(RateLimiterMode.Account),
  wrap(creditUsageController),
);

v1Router.get(
  "/team/credit-usage/historical",
  authMiddleware(RateLimiterMode.Account),
  wrap(creditUsageHistoricalController),
);

v1Router.get(
  "/team/token-usage",
  authMiddleware(RateLimiterMode.Account),
  wrap(tokenUsageController),
);

v1Router.get(
  "/team/token-usage/historical",
  authMiddleware(RateLimiterMode.Account),
  wrap(tokenUsageHistoricalController),
);

v1Router.get(
  "/team/queue-status",
  authMiddleware(RateLimiterMode.Account),
  wrap(queueStatusController),
);
