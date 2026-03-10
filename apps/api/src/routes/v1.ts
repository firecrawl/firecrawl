import express from "express";
import { config } from "../config";
import { crawlController } from "../controllers/v1/crawl";
// import { crawlStatusController } from "../../src/controllers/v1/crawl-status";
import { scrapeController } from "../../src/controllers/v1/scrape";
import { crawlStatusController } from "../controllers/v1/crawl-status";
import { mapController } from "../controllers/v1/map";
import { RequestWithAuth } from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
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
import { x402SearchController } from "../controllers/v1/x402-search";
import { crawlErrorsController } from "../controllers/v1/crawl-errors";
import { generateLLMsTextController } from "../controllers/v1/generate-llmstxt";
import { generateLLMsTextStatusController } from "../controllers/v1/generate-llmstxt-status";
import { deepResearchController } from "../controllers/v1/deep-research";
import { deepResearchStatusController } from "../controllers/v1/deep-research-status";
import { tokenUsageController } from "../controllers/v1/token-usage";
import { ongoingCrawlsController } from "../controllers/v1/crawl-ongoing";
import {
  authMiddleware,
  checkCreditsMiddleware,
  blocklistMiddleware,
  countryCheck,
  idempotencyMiddleware,
  requestTimingMiddleware,
  wrap,
} from "./shared";
import { queueStatusController } from "../controllers/v1/queue-status";
import { creditUsageHistoricalController } from "../controllers/v1/credit-usage-historical";
import { tokenUsageHistoricalController } from "../controllers/v1/token-usage-historical";
import {
  paymentMiddleware,
  getX402ResourceServer,
  createX402RouteConfig,
  isX402Enabled,
} from "../lib/x402";

expressWs(express());

export const v1Router = express.Router();

// Add timing middleware to all v1 routes
v1Router.use(requestTimingMiddleware("v1"));

// Configure payment middleware to enable micropayment-protected endpoints
// This middleware handles payment verification and processing for premium API features
// x402 payments protocol - https://github.com/coinbase/x402
// v1Router.use(
//   paymentMiddleware(
//     (config.X402_PAY_TO_ADDRESS as `0x${string}`) ||
//       "0x0000000000000000000000000000000000000000",
//     {
//       "POST /x402/search": {
//         price: config.X402_ENDPOINT_PRICE_USD as string,
//         network: config.X402_NETWORK as
//           | "base-sepolia"
//           | "base"
//           | "avalanche-fuji"
//           | "avalanche"
//           | "iotex",
//         config: {
//           discoverable: true,
//           description:
//             "The search endpoint combines web search (SERP) with Firecrawl's scraping capabilities to return full page content for any query. Requires micropayment via X402 protocol",
//           mimeType: "application/json",
//           maxTimeoutSeconds: 120,
//           inputSchema: {
//             body: {
//               query: {
//                 type: "string",
//                 description: "Search query to find relevant web pages",
//                 required: true,
//               },
//               limit: {
//                 type: "number",
//                 description: "Maximum number of results to return (max 10)",
//                 required: false,
//               },
//               scrapeOptions: {
//                 type: "object",
//                 description: "Options for scraping the found pages",
//                 required: false,
//               },
//             },
//           },
//           outputSchema: {
//             type: "object",
//             properties: {
//               success: { type: "boolean" },
//               data: {
//                 type: "array",
//                 items: {
//                   type: "object",
//                   properties: {
//                     url: { type: "string" },
//                     title: { type: "string" },
//                     description: { type: "string" },
//                     markdown: { type: "string" },
//                   },
//                 },
//               },
//             },
//           },
//         },
//       },
//     },
//     facilitator,
//   ),
// );

v1Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(scrapeController),
);

v1Router.post(
  "/crawl",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
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
  authMiddleware(RateLimiterMode.Search),
  countryCheck,
  checkCreditsMiddleware(),
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
  wrap(crawlStatusController),
);

v1Router.get(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
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
  countryCheck,
  checkCreditsMiddleware(20),
  wrap(extractController),
);

v1Router.get(
  "/extract/:jobId",
  authMiddleware(RateLimiterMode.ExtractStatus),
  wrap(extractStatusController),
);

v1Router.post(
  "/llmstxt",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  blocklistMiddleware,
  wrap(generateLLMsTextController),
);

v1Router.get(
  "/llmstxt/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(generateLLMsTextStatusController),
);

v1Router.post(
  "/deep-research",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(1),
  wrap(deepResearchController),
);

v1Router.get(
  "/deep-research/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
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

v1Router.get(
  "/team/credit-usage",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(creditUsageController),
);

v1Router.get(
  "/team/credit-usage/historical",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(creditUsageHistoricalController),
);

v1Router.get(
  "/team/token-usage",
  authMiddleware(RateLimiterMode.ExtractStatus),
  wrap(tokenUsageController),
);

v1Router.get(
  "/team/token-usage/historical",
  authMiddleware(RateLimiterMode.ExtractStatus),
  wrap(tokenUsageHistoricalController),
);

v1Router.get(
  "/team/queue-status",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(queueStatusController),
);

// Only register x402 routes if X402_PAY_TO_ADDRESS is configured
if (isX402Enabled()) {
  v1Router.post(
    "/x402/search",
    authMiddleware(RateLimiterMode.Search),
    countryCheck,
    paymentMiddleware(
      createX402RouteConfig(
        "POST /x402/search",
        "The search endpoint combines web search (SERP) with Firecrawl's scraping capabilities to return full page content for any query. Requires micropayment via X402 protocol",
        {},
        {},
      ),
      getX402ResourceServer(),
    ),
    wrap(x402SearchController),
  );
}
