import express from "express";
import multer from "multer";
import { ZodError } from "zod";
import { RateLimiterMode } from "../types";
import expressWs from "express-ws";
import { searchController } from "../controllers/v2/search";
import { scrapeController } from "../controllers/v2/scrape";
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
  restrictedOptionsCountryCheck,
  idempotencyMiddleware,
  requestTimingMiddleware,
  wrap,
  isValidJobId,
  validateJobIdParam,
} from "./shared";
import { queueStatusController } from "../controllers/v2/queue-status";
import { openRequest, resolveRequestContext, service } from "../service";

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

v2Router.post(
  "/search",
  authMiddleware(RateLimiterMode.Search, {
    allowKeyless: true,
    allowAgentManagedKey: true,
  }),
  restrictedOptionsCountryCheck,
  openRequest("search", {
    authorizeState: { mcpCredits: true },
    parse: rawBody => {
      if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
        const {
          objective: _objective,
          clientModel: _clientModel,
          ...rest
        } = rawBody as Record<string, unknown>;
        return service.schemas.search.parse(rest);
      }
      return service.schemas.search.parse(rawBody);
    },
    onParseError: (error, _req, res) => {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: "Invalid request body",
          details: error.issues,
        });
        return true;
      }
    },
  }),
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
  resolveRequestContext("parse-upload-url"),
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
  restrictedOptionsCountryCheck,
  parsePayloadMiddleware,
  openRequest("parse", {
    units: 1,
    authorizeState: { mcpCredits: true },
    blocklist: "none",
  }),
  wrap(parseController),
);

v2Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape, {
    allowKeyless: true,
    allowAgentManagedKey: true,
  }),
  restrictedOptionsCountryCheck,
  openRequest("scrape", {
    units: 1,
    authorizeState: { mcpCredits: true },
  }),
  wrap(scrapeController),
);

v2Router.get(
  "/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  resolveRequestContext("scrape-status"),
  validateJobIdParam,
  wrap(scrapeStatusController),
);

v2Router.post(
  "/batch/scrape",
  authMiddleware(RateLimiterMode.Scrape, { allowAgentManagedKey: true }),
  restrictedOptionsCountryCheck,
  openRequest("batchScrape", {
    authorizeState: { mcpCredits: true },
    blocklist: "none",
  }),
  wrap(batchScrapeController),
);

v2Router.post(
  "/map",
  authMiddleware(RateLimiterMode.Map),
  openRequest("map", {
    units: 1,
    authorizeState: { mcpCredits: true },
  }),
  wrap(mapController),
);

v2Router.post(
  "/crawl",
  authMiddleware(RateLimiterMode.Crawl),
  restrictedOptionsCountryCheck,
  openRequest("crawl", {
    authorizeState: { mcpCredits: true },
  }),
  idempotencyMiddleware,
  wrap(crawlController),
);

v2Router.post(
  "/crawl/params-preview",
  authMiddleware(RateLimiterMode.Crawl),
  resolveRequestContext("crawl-params-preview"),
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
