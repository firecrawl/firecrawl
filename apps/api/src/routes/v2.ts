import express from "express";
import multer from "multer";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import { SEARCH_CREDITS_FEATURE_ID } from "../services/autumn/autumn.service";
import expressWs from "express-ws";
import { searchController } from "../controllers/v2/search";
import { feedbackController } from "../controllers/v2/feedback/controller";
import { searchFeedbackController } from "../controllers/v2/search-feedback";
import { scrapeController } from "../controllers/v2/scrape";
import { keylessEligibilityController } from "../controllers/v2/keyless-eligibility";
import {
  parseController,
  parseMultipartPayloadMiddleware,
} from "../controllers/v2/parse";
import {
  parseLocalUploadController,
  parseLocalUploadStorageGuard,
  parseUploadRefPayloadMiddleware,
  parseUploadUrlController,
} from "../controllers/v2/parse-upload";
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
  scrapeBlocklistMiddleware,
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
import {
  browserReplayController,
  browserReplayPageController,
} from "../controllers/v2/browser-replay";
import { activityController } from "../controllers/v1/activity";
import {
  getTeamThreatProtectionController,
  putTeamThreatProtectionController,
} from "../controllers/v2/team-threat-protection";
import { supportProxyController } from "../controllers/v2/support-proxy";
import { createResearchRouter } from "../controllers/v2/research-proxy";
import {
  scrapeInteractController,
  scrapeStopInteractiveBrowserController,
} from "../controllers/v2/scrape-browser";
import {
  confirmMonitorEmailController,
  createMonitorController,
  deleteMonitorController,
  getMonitorCheckController,
  getMonitorController,
  listMonitorChecksController,
  listMonitorsController,
  runMonitorController,
  unsubscribeMonitorEmailController,
  updateMonitorController,
} from "../controllers/v2/monitor";
import {
  slackChannelsController,
  slackCommandsController,
  slackDisconnectController,
  slackEventsController,
  slackOAuthCallbackController,
  slackOAuthStartController,
  slackStatusController,
} from "../controllers/v2/slack";

export const v2Router = express.Router();
expressWs(express()).applyTo(v2Router);

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

const parsePayloadMiddleware: express.RequestHandler = (req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (
    typeof contentType === "string" &&
    contentType.includes("multipart/form-data")
  ) {
    return parseUploadMiddleware(req, res, err => {
      if (err) return next(err);
      return parseMultipartPayloadMiddleware(req, res, next);
    });
  }

  if (req.body && typeof req.body === "object" && "uploadRef" in req.body) {
    return parseUploadRefPayloadMiddleware(req as any, res, next);
  }

  return res.status(400).json({
    success: false,
    code: "BAD_REQUEST",
    error:
      "Missing file upload. Send multipart/form-data with a 'file' field, or JSON with an 'uploadRef'.",
  });
};
// Add timing middleware to all v2 routes
v2Router.use(requestTimingMiddleware("v2"));

// Internal: trusted-proxy (hosted MCP) keyless eligibility probe. Secret-gated
// inside the controller; no auth middleware.
v2Router.get("/keyless/eligibility", wrap(keylessEligibilityController));

v2Router.post(
  "/search",
  authMiddleware(RateLimiterMode.Search, { allowKeyless: true }),
  countryCheck,
  checkCreditsMiddleware(undefined, SEARCH_CREDITS_FEATURE_ID),
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
  "/feedback",
  authMiddleware(RateLimiterMode.Account),
  wrap(feedbackController),
);

v2Router.post(
  "/parse/upload-url",
  authMiddleware(RateLimiterMode.Scrape, { allowKeyless: true }),
  countryCheck,
  wrap(parseUploadUrlController),
);

v2Router.put(
  "/parse/upload/:uploadId",
  parseLocalUploadStorageGuard,
  express.raw({ type: "*/*", limit: "50mb" }),
  wrap(parseLocalUploadController),
);

v2Router.post(
  "/parse",
  authMiddleware(RateLimiterMode.Scrape, { allowKeyless: true }),
  countryCheck,
  checkCreditsMiddleware(1),
  parsePayloadMiddleware,
  wrap(parseController),
);

v2Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape, { allowKeyless: true }),
  countryCheck,
  checkCreditsMiddleware(1),
  scrapeBlocklistMiddleware,
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
  authMiddleware(RateLimiterMode.BrowserExecute, { allowKeyless: true }),
  validateJobIdParam,
  wrap(scrapeInteractController),
);

v2Router.delete(
  "/scrape/:jobId/interact",
  authMiddleware(RateLimiterMode.BrowserExecute, { allowKeyless: true }),
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
  scrapeBlocklistMiddleware,
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
    const jobId = Array.isArray(req.params.jobId)
      ? undefined
      : req.params.jobId;

    if (!isValidJobId(jobId)) {
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

v2Router.get(
  "/team/threat-protection",
  authMiddleware(RateLimiterMode.Account),
  wrap(getTeamThreatProtectionController),
);

v2Router.put(
  "/team/threat-protection",
  authMiddleware(RateLimiterMode.Account),
  wrap(putTeamThreatProtectionController),
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

// Public, unauthenticated — token in body is the credential. Registered
// before /monitor/:monitorId so "email" isn't parsed as a monitor UUID.
v2Router.post("/monitor/email/confirm", wrap(confirmMonitorEmailController));
v2Router.post(
  "/monitor/email/unsubscribe",
  wrap(unsubscribeMonitorEmailController),
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

// Slack integration ("Add to Slack" + /monitor slash command).
// Public endpoints (OAuth callback, slash command, events) authenticate via the
// OAuth state nonce / Slack request signature rather than a Firecrawl API key.
v2Router.post(
  "/slack/oauth/start",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(slackOAuthStartController),
);
v2Router.get("/slack/oauth/callback", wrap(slackOAuthCallbackController));
v2Router.get(
  "/slack/status",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(slackStatusController),
);
v2Router.get(
  "/slack/channels",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(slackChannelsController),
);
v2Router.delete(
  "/slack/installation",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(slackDisconnectController),
);
v2Router.post("/slack/commands", wrap(slackCommandsController));
v2Router.post("/slack/events", wrap(slackEventsController));

v2Router.post(
  ["/browser", "/interact"],
  authMiddleware(RateLimiterMode.Browser),
  countryCheck,
  checkCreditsMiddleware(2),
  wrap(browserCreateController),
);

v2Router.get(
  ["/browser", "/interact"],
  authMiddleware(RateLimiterMode.BrowserExecute),
  wrap(browserListController),
);

v2Router.post(
  ["/browser/:sessionId/execute", "/interact/:sessionId/execute"],
  authMiddleware(RateLimiterMode.BrowserExecute),
  wrap(browserExecuteController),
);

v2Router.get(
  ["/browser/:sessionId/replay", "/interact/:sessionId/replay"],
  authMiddleware(RateLimiterMode.BrowserReplay),
  wrap(browserReplayController),
);

v2Router.get(
  ["/browser/:sessionId/replay/:pageId", "/interact/:sessionId/replay/:pageId"],
  authMiddleware(RateLimiterMode.BrowserReplay),
  wrap(browserReplayPageController),
);

v2Router.delete(
  ["/browser/:sessionId", "/interact/:sessionId"],
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

if (config.RESEARCH_PROXY_URL) {
  v2Router.use(
    "/search/research",
    authMiddleware(RateLimiterMode.Research, { allowKeyless: true }),
    createResearchRouter(),
  );

  v2Router.use(
    "/research",
    authMiddleware(RateLimiterMode.Research),
    createResearchRouter({ legacy: true }),
  );
}
