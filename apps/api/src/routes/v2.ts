import express from "express";
import multer from "multer";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import { registerMcpActionLogReadRoute } from "./mcp-action-logs";
import { createFreshFeedRouter } from "./fresh-feed";
import {
  getFreshFeedUpstreams,
  hasFreshFeedUpstreams,
} from "../lib/fresh-feed";
import { SEARCH_CREDITS_FEATURE_ID } from "../services/autumn/autumn.service";
import expressWs from "express-ws";
import { searchController } from "../controllers/v2/search";
import { scrapeController } from "../controllers/v2/scrape";
import {
  alexandriaQueryBody,
  providerScrapeController,
} from "../controllers/v2/scrape-alexandria";
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
import { parseFormatsController } from "../controllers/v2/parse-formats";
import { configuredComputerSessionFiles } from "../controllers/v2/computer-session-files";
import { batchScrapeController } from "../controllers/v2/batch-scrape";
import { crawlController } from "../controllers/v2/crawl";
import { crawlParamsPreviewController } from "../controllers/v2/crawl-params-preview";
import { crawlStatusController } from "../controllers/v2/crawl-status";
import { mapController } from "../controllers/v2/map";
import { crawlErrorsController } from "../controllers/v2/crawl-errors";
import { ongoingCrawlsController } from "../controllers/v2/crawl-ongoing";
import { scrapeStatusController } from "../controllers/v2/scrape-status";
import { crawlCancelController } from "../controllers/v2/crawl-cancel";
import { concurrencyCheckController } from "../controllers/v2/concurrency-check";
import { crawlStatusWSController } from "../controllers/v2/crawl-status-ws";
import {
  authMiddleware as sharedAuthMiddleware,
  checkCreditsMiddleware,
  blocklistMiddleware,
  scrapeBlocklistMiddleware,
  restrictedOptionsCountryCheck,
  idempotencyMiddleware,
  requestTimingMiddleware,
  wrap,
  isValidJobId,
  validateJobIdParam,
  inferIntegrationMiddleware,
} from "./shared";
import { queueStatusController } from "../controllers/v2/queue-status";
import { removedEndpointHandler } from "../lib/deprecations";
import { isResearchKeylessDisabled } from "../lib/research-keyless";
import { supportProxyController } from "../controllers/v2/support-proxy";
import {
  createDeveloperRouter,
  createGovRouter,
  createResearchRouter,
} from "../controllers/v2/research-proxy";

// Every v2 route opts in to hosted MCP rate-limit minimums; /v1 routes do not.
const authMiddleware: typeof sharedAuthMiddleware = (mode, options = {}) =>
  sharedAuthMiddleware(mode, { ...options, hostedMcpRateLimit: true });

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

registerMcpActionLogReadRoute(
  v2Router,
  authMiddleware(RateLimiterMode.Account),
);

v2Router.post(
  "/search",
  authMiddleware(RateLimiterMode.Search, {
    allowKeyless: true,
    allowAgentManagedKey: true,
  }),
  inferIntegrationMiddleware,
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(undefined, SEARCH_CREDITS_FEATURE_ID, {
    mcpCredits: true,
  }),
  blocklistMiddleware,
  wrap(searchController),
);

v2Router.get(
  "/parse/formats",
  authMiddleware(RateLimiterMode.Account),
  wrap(parseFormatsController),
);

v2Router.post(
  "/parse/upload-url",
  authMiddleware(RateLimiterMode.Scrape, { allowKeyless: true }),
  restrictedOptionsCountryCheck,
  wrap(parseUploadUrlController),
);

v2Router.put(
  "/parse/upload/:uploadId",
  parseLocalUploadStorageGuard,
  express.raw({ type: "*/*", limit: "50mb" }),
  wrap(parseLocalUploadController),
);

// Files of hosted MCP shell sessions. Registered only on a deployment that
// configures them, so the paths otherwise answer like an unknown route.
const computerSessionFiles = configuredComputerSessionFiles();
if (computerSessionFiles) {
  v2Router.post(
    "/computer/sessions",
    authMiddleware(RateLimiterMode.Account),
    wrap(computerSessionFiles.createSession),
  );
  v2Router.put(
    "/computer/sessions/:sessionId/workspace",
    authMiddleware(RateLimiterMode.Account),
    wrap(computerSessionFiles.saveWorkspace),
  );
  v2Router.get(
    "/computer/sessions/:sessionId/workspace",
    authMiddleware(RateLimiterMode.Account),
    wrap(computerSessionFiles.readWorkspace),
  );
  v2Router.post(
    "/computer/sessions/:sessionId/links",
    authMiddleware(RateLimiterMode.Account),
    wrap(computerSessionFiles.createLink),
  );
  v2Router.get("/computer/links/:token", wrap(computerSessionFiles.openLink));
}

v2Router.post(
  "/parse",
  authMiddleware(RateLimiterMode.Scrape, { allowKeyless: true }),
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(1, undefined, { mcpCredits: true }),
  parsePayloadMiddleware,
  inferIntegrationMiddleware,
  wrap(parseController),
);

v2Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape, {
    allowKeyless: true,
    allowAgentManagedKey: true,
  }),
  inferIntegrationMiddleware,
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(1, undefined, { mcpCredits: true }),
  scrapeBlocklistMiddleware,
  wrap(scrapeController),
);

// The provider call as the body: { provider, capability, options }.
v2Router.post(
  "/alexandria",
  authMiddleware(RateLimiterMode.Exchange, { allowAgentManagedKey: true }),
  inferIntegrationMiddleware,
  wrap((req, res) => providerScrapeController(req as any, res, true)),
);

// The whole call in the URL: the capability in the path, its options in the query string.
v2Router.get(
  "/alexandria/:provider/*capability",
  authMiddleware(RateLimiterMode.Exchange, { allowAgentManagedKey: true }),
  (req, res, next) => {
    alexandriaQueryBody(req, res, next).catch(next);
  },
  inferIntegrationMiddleware,
  wrap((req, res) => providerScrapeController(req as any, res, true)),
);

v2Router.get(
  "/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(scrapeStatusController),
);

v2Router.post(
  "/batch/scrape",
  authMiddleware(RateLimiterMode.Scrape, { allowAgentManagedKey: true }),
  inferIntegrationMiddleware,
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(undefined, undefined, { mcpCredits: true }),
  blocklistMiddleware,
  wrap(batchScrapeController),
);

v2Router.post(
  "/map",
  authMiddleware(RateLimiterMode.Map),
  inferIntegrationMiddleware,
  checkCreditsMiddleware(1, undefined, { mcpCredits: true }),
  blocklistMiddleware,
  wrap(mapController),
);

v2Router.post(
  "/crawl",
  authMiddleware(RateLimiterMode.Crawl),
  inferIntegrationMiddleware,
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(undefined, undefined, { mcpCredits: true }),
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
  authMiddleware(RateLimiterMode.CrawlStatus, { allowAgentManagedKey: true }),
  validateJobIdParam,
  wrap((req: any, res: any) => crawlStatusController(req, res, true)),
);

v2Router.delete(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus, { allowAgentManagedKey: true }),
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

// Support agent proxy — forwards to the support-agent service.
v2Router.post(
  "/support/ask",
  authMiddleware(RateLimiterMode.SupportAsk),
  wrap(supportProxyController),
);
v2Router.post(
  "/support/docs-search",
  authMiddleware(RateLimiterMode.SupportAsk),
  wrap(supportProxyController),
);

// Outside the research proxy check so the 410 outlives the backend, and ahead of the research mounts' auth.
v2Router.get(
  ["/search/research/github", "/research/github"],
  removedEndpointHandler("v2_research_github_search"),
);

if (config.RESEARCH_PROXY_URL) {
  v2Router.use(
    "/search/research",
    authMiddleware(RateLimiterMode.Research, {
      allowKeyless: req => !isResearchKeylessDisabled(req),
    }),
    createResearchRouter(),
  );

  v2Router.use(
    "/research",
    authMiddleware(RateLimiterMode.Research),
    createResearchRouter({ legacy: true }),
  );

  // Canonical: developer search is a subset of search, so it lives under it.
  v2Router.use(
    "/search/developer",
    authMiddleware(RateLimiterMode.DeveloperSearch, { allowKeyless: true }),
    createDeveloperRouter({ root: true }),
  );

  // Compatibility only: the pre-GA path. Published CLI and MCP builds still
  // call it. Delete once those ship on /search/developer. Not documented.
  v2Router.use(
    "/developer",
    authMiddleware(RateLimiterMode.DeveloperSearch),
    createDeveloperRouter(),
  );

  v2Router.use(
    "/search/gov",
    authMiddleware(RateLimiterMode.GovSearch, {
      allowKeyless: true,
    }),
    createGovRouter(),
  );
}

const freshFeedUpstreams = getFreshFeedUpstreams(config);
if (hasFreshFeedUpstreams(freshFeedUpstreams)) {
  v2Router.use(
    "/fresh-vertical-feed",
    authMiddleware(RateLimiterMode.FreshFeed),
    createFreshFeedRouter(freshFeedUpstreams),
  );
}
