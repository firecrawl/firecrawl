import express from "express";
import multer from "multer";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import expressWs from "express-ws";
import { searchController } from "../controllers/v2/search";
import { searchFeedbackController } from "../controllers/v2/search-feedback";
import { x402SearchController } from "../controllers/v2/x402-search";
import { scrapeController } from "../controllers/v2/scrape";
import {
  parseController,
  parseMultipartPayloadMiddleware,
} from "../controllers/v2/parse";
import { batchScrapeController } from "../controllers/v2/batch-scrape";
import { crawlController } from "../controllers/v2/crawl";
import { crawlParamsPreviewController } from "../controllers/v2/crawl-params-preview";
import { crawlStatusController } from "../controllers/v2/crawl-status";
import { mapController } from "../controllers/v2/map";
import { crawlErrorsController } from "../controllers/v2/crawl-errors";
import { ongoingCrawlsController } from "../controllers/v2/crawl-ongoing";
import { scrapeStatusController } from "../controllers/v2/scrape-status";
import { creditUsageController } from "../controllers/v2/credit-usage";
import { tokenUsageController } from "../controllers/v2/token-usage";
import { crawlCancelController } from "../controllers/v2/crawl-cancel";
import { concurrencyCheckController } from "../controllers/v2/concurrency-check";
import { crawlStatusWSController } from "../controllers/v2/crawl-status-ws";
import { extractController } from "../controllers/v2/extract";
import { extractStatusController } from "../controllers/v2/extract-status";
import {
  authMiddleware,
  checkCreditsMiddleware,
  blocklistMiddleware,
  countryCheck,
  idempotencyMiddleware,
  requestTimingMiddleware,
  wrap,
  isValidJobId,
  validateJobIdParam,
} from "./shared";
import { queueStatusController } from "../controllers/v2/queue-status";
import { creditUsageHistoricalController } from "../controllers/v2/credit-usage-historical";
import { tokenUsageHistoricalController } from "../controllers/v2/token-usage-historical";
import {
  paymentMiddleware,
  getX402ResourceServer,
  createX402RouteConfig,
  isX402Enabled,
} from "../lib/x402";
import { deprecationMiddleware } from "../lib/deprecations";
import { agentController } from "../controllers/v2/agent";
import { agentStatusController } from "../controllers/v2/agent-status";
import { agentCancelController } from "../controllers/v2/agent-cancel";
import {
  browserCreateController,
  browserExecuteController,
  browserDeleteController,
  browserListController,
  browserWebhookDestroyedController,
} from "../controllers/v2/browser";
import { activityController } from "../controllers/v1/activity";
import { supportProxyController } from "../controllers/v2/support-proxy";
import {
  scrapeInteractController,
  scrapeStopInteractiveBrowserController,
} from "../controllers/v2/scrape-browser";
import {
  createMonitorController,
  deleteMonitorController,
  getMonitorCheckController,
  getMonitorController,
  listMonitorChecksController,
  listMonitorsController,
  runMonitorController,
  updateMonitorController,
} from "../controllers/v2/monitor";

expressWs(express());

export const v2Router = express.Router();

const parseUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
  },
});

const parseUploadMiddleware: express.RequestHandler = (req, res, next) => {
  const upload = parseUpload.single("file");

  upload(req, res, err => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: "Uploaded file exceeds maximum size of 50MB.",
      });
    }

    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error: err.message || "Invalid multipart form-data request.",
    });
  });
};

// Add timing middleware to all v2 routes
v2Router.use(requestTimingMiddleware("v2"));

// Configure payment middleware to enable micropayment-protected endpoints
// This middleware handles payment verification and processing for premium API features
// x402 payments protocol - https://github.com/coinbase/x402
// v2Router.use(
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
//               sources: {
//                 type: "array",
//                 description: "Sources to search (web, news, images)",
//                 required: false,
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
//               asyncScraping: {
//                 type: "boolean",
//                 description: "Whether to return job IDs for async scraping",
//                 required: false,
//               },
//             },
//           },
//           outputSchema: {
//             type: "object",
//             properties: {
//               success: { type: "boolean" },
//               data: {
//                 type: "object",
//                 properties: {
//                   web: {
//                     type: "array",
//                     items: {
//                       type: "object",
//                       properties: {
//                         url: { type: "string" },
//                         title: { type: "string" },
//                         description: { type: "string" },
//                         markdown: { type: "string" },
//                       },
//                     },
//                   },
//                   news: {
//                     type: "array",
//                     items: {
//                       type: "object",
//                       properties: {
//                         url: { type: "string" },
//                         title: { type: "string" },
//                         snippet: { type: "string" },
//                         markdown: { type: "string" },
//                       },
//                     },
//                   },
//                   images: {
//                     type: "array",
//                     items: {
//                       type: "object",
//                       properties: {
//                         url: { type: "string" },
//                         title: { type: "string" },
//                         markdown: { type: "string" },
//                       },
//                     },
//                   },
//                 },
//               },
//               scrapeIds: {
//                 type: "object",
//                 description:
//                   "Job IDs for async scraping (if asyncScraping is true)",
//                 properties: {
//                   web: { type: "array", items: { type: "string" } },
//                   news: { type: "array", items: { type: "string" } },
//                   images: { type: "array", items: { type: "string" } },
//                 },
//               },
//               creditsUsed: { type: "number" },
//             },
//           },
//         },
//       },
//     },
//     facilitator,
//   ),
// );

v2Router.post(
  "/search",
  authMiddleware(RateLimiterMode.Search),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
  wrap(searchController),
);

v2Router.post(
  "/search/:jobId/feedback",
  authMiddleware(RateLimiterMode.Account),
  validateJobIdParam,
  wrap(searchFeedbackController),
);

v2Router.post(
  "/parse",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  parseUploadMiddleware,
  parseMultipartPayloadMiddleware,
  checkCreditsMiddleware(1),
  wrap(parseController),
);

v2Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(scrapeController),
);

v2Router.get(
  "/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(scrapeStatusController),
);

v2Router.post(
  "/scrape/:jobId/interact",
  authMiddleware(RateLimiterMode.BrowserExecute),
  validateJobIdParam,
  wrap(scrapeInteractController),
);

v2Router.delete(
  "/scrape/:jobId/interact",
  authMiddleware(RateLimiterMode.BrowserExecute),
  validateJobIdParam,
  wrap(scrapeStopInteractiveBrowserController),
);

v2Router.post(
  "/batch/scrape",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
  wrap(batchScrapeController),
);

v2Router.post(
  "/map",
  authMiddleware(RateLimiterMode.Map),
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(mapController),
);

v2Router.post(
  "/crawl",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
  idempotencyMiddleware,
  wrap(crawlController),
);

v2Router.post(
  "/crawl/params-preview",
  authMiddleware(RateLimiterMode.Crawl),
  checkCreditsMiddleware(),
  wrap(crawlParamsPreviewController),
);

v2Router.get(
  "/crawl/ongoing",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(ongoingCrawlsController),
);

v2Router.get(
  "/crawl/active",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(ongoingCrawlsController),
);

v2Router.get(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(crawlStatusController),
);

v2Router.delete(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(crawlCancelController),
);

v2Router.ws(
  "/crawl/:jobId",
  ((ws: any, req: express.Request, next: (err?: unknown) => void) => {
    if (!isValidJobId(req.params.jobId)) {
      ws.close(1008, "Invalid job ID");
      return;
    }
    next();
  }) as any,
  crawlStatusWSController,
);

v2Router.get(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap((req: any, res: any) => crawlStatusController(req, res, true)),
);

v2Router.delete(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(crawlCancelController),
);

v2Router.get(
  "/batch/scrape/:jobId/errors",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(crawlErrorsController),
);

v2Router.get(
  "/crawl/:jobId/errors",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(crawlErrorsController),
);

v2Router.post(
  "/extract",
  authMiddleware(RateLimiterMode.Extract),
  deprecationMiddleware("v2_extract"),
  countryCheck,
  checkCreditsMiddleware(20),
  blocklistMiddleware,
  wrap(extractController),
);

v2Router.get(
  "/extract/:jobId",
  authMiddleware(RateLimiterMode.ExtractStatus),
  deprecationMiddleware("v2_extract_status"),
  validateJobIdParam,
  wrap(extractStatusController),
);

v2Router.post(
  "/agent",
  authMiddleware(RateLimiterMode.Extract),
  countryCheck,
  checkCreditsMiddleware(20),
  blocklistMiddleware,
  wrap(agentController),
);

v2Router.get(
  "/agent/:jobId",
  authMiddleware(RateLimiterMode.ExtractStatus),
  validateJobIdParam,
  wrap(agentStatusController),
);

v2Router.delete(
  "/agent/:jobId",
  authMiddleware(RateLimiterMode.ExtractStatus),
  validateJobIdParam,
  wrap(agentCancelController),
);

v2Router.get(
  "/team/credit-usage",
  authMiddleware(RateLimiterMode.Account),
  wrap(creditUsageController),
);

v2Router.get(
  "/team/credit-usage/historical",
  authMiddleware(RateLimiterMode.Account),
  wrap(creditUsageHistoricalController),
);

v2Router.get(
  "/team/token-usage",
  authMiddleware(RateLimiterMode.Account),
  wrap(tokenUsageController),
);

v2Router.get(
  "/team/token-usage/historical",
  authMiddleware(RateLimiterMode.Account),
  wrap(tokenUsageHistoricalController),
);

v2Router.get(
  "/concurrency-check",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(concurrencyCheckController),
);

v2Router.get(
  "/team/queue-status",
  authMiddleware(RateLimiterMode.Account),
  wrap(queueStatusController),
);

v2Router.get(
  "/team/activity",
  authMiddleware(RateLimiterMode.Account),
  wrap(activityController),
);

v2Router.post(
  "/monitor",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(createMonitorController),
);

v2Router.get(
  "/monitor",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(listMonitorsController),
);

v2Router.get(
  "/monitor/:monitorId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(getMonitorController),
);

v2Router.patch(
  "/monitor/:monitorId",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(updateMonitorController),
);

v2Router.delete(
  "/monitor/:monitorId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(deleteMonitorController),
);

v2Router.post(
  "/monitor/:monitorId/run",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(runMonitorController),
);

v2Router.get(
  "/monitor/:monitorId/checks",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(listMonitorChecksController),
);

v2Router.get(
  "/monitor/:monitorId/checks/:checkId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(getMonitorCheckController),
);

v2Router.post(
  "/browser",
  authMiddleware(RateLimiterMode.Browser),
  countryCheck,
  checkCreditsMiddleware(2),
  wrap(browserCreateController),
);

v2Router.get(
  "/browser",
  authMiddleware(RateLimiterMode.BrowserExecute),
  wrap(browserListController),
);

v2Router.post(
  "/browser/:sessionId/execute",
  authMiddleware(RateLimiterMode.BrowserExecute),
  wrap(browserExecuteController),
);

v2Router.delete(
  "/browser/:sessionId",
  authMiddleware(RateLimiterMode.BrowserExecute),
  wrap(browserDeleteController),
);

v2Router.post(
  "/browser/webhook/destroyed",
  wrap(browserWebhookDestroyedController),
);

// Support agent proxy — forwards to the support-agent service.
v2Router.post(
  "/support/ask",
  authMiddleware(RateLimiterMode.SupportAsk),
  wrap(supportProxyController),
);
v2Router.post(
  "/support/docs-search",
  authMiddleware(RateLimiterMode.SupportDocsSearch),
  wrap(supportProxyController),
);

// Only register x402 routes if X402_PAY_TO_ADDRESS is configured
if (isX402Enabled()) {
  v2Router.post(
    "/x402/search",
    authMiddleware(RateLimiterMode.Search),
    countryCheck,
    blocklistMiddleware,
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
