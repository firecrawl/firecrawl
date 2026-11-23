import express from "express";
import expressWs from "express-ws";
import { RateLimiterMode } from "../types";
import { extractController } from "../controllers/v1/extract";
import { extractStatusController } from "../controllers/v1/extract-status";
import { generateLLMsTextController } from "../controllers/v1/generate-llmstxt";
import { generateLLMsTextStatusController } from "../controllers/v1/generate-llmstxt-status";
import { deepResearchController } from "../controllers/v1/deep-research";
import { deepResearchStatusController } from "../controllers/v1/deep-research-status";
import {
  authMiddleware,
  checkCreditsMiddleware,
  blocklistMiddleware,
  restrictedOptionsCountryCheck,
  requestTimingMiddleware,
  wrap,
  inferIntegrationMiddleware,
} from "./shared";
import {
  deprecationMiddleware,
  logRemovedCall,
  removedEndpointHandler,
} from "../lib/deprecations";

export const v1Router = express.Router();
expressWs(express()).applyTo(v1Router);

// Add timing middleware to all v1 routes
v1Router.use(requestTimingMiddleware("v1"));

v1Router.post("/scrape", removedEndpointHandler("v1_scrape"));
v1Router.post("/crawl", removedEndpointHandler("v1_crawl"));
v1Router.post("/batch/scrape", removedEndpointHandler("v1_batch_scrape"));
v1Router.post("/search", removedEndpointHandler("v1_search"));
v1Router.post("/map", removedEndpointHandler("v1_map"));
v1Router.get("/crawl/ongoing", removedEndpointHandler("v1_crawl_ongoing"));
v1Router.get("/crawl/active", removedEndpointHandler("v1_crawl_active"));
v1Router.get("/crawl/:jobId", removedEndpointHandler("v1_crawl_status"));
v1Router.ws("/crawl/:jobId", (ws, req) => {
  logRemovedCall(req, "v1_crawl_status");
  ws.close(
    1008,
    JSON.stringify({
      type: "error",
      error:
        "/v1/crawl/:jobId was removed. See https://docs.firecrawl.dev/migrate-to-v2",
    }),
  );
});
v1Router.get(
  "/batch/scrape/:jobId",
  removedEndpointHandler("v1_batch_scrape_status"),
);
v1Router.get("/crawl/:jobId/errors", removedEndpointHandler("v1_crawl_errors"));
v1Router.get(
  "/batch/scrape/:jobId/errors",
  removedEndpointHandler("v1_batch_scrape_errors"),
);
v1Router.get("/scrape/:jobId", removedEndpointHandler("v1_scrape_status"));
v1Router.get(
  "/concurrency-check",
  removedEndpointHandler("v1_concurrency_check"),
);
v1Router.delete("/crawl/:jobId", removedEndpointHandler("v1_crawl_cancel"));
v1Router.delete(
  "/batch/scrape/:jobId",
  removedEndpointHandler("v1_batch_scrape_cancel"),
);
v1Router.get(
  "/team/credit-usage",
  removedEndpointHandler("v1_team_credit_usage"),
);
v1Router.get(
  "/team/credit-usage/historical",
  removedEndpointHandler("v1_team_credit_usage_historical"),
);
v1Router.get(
  "/team/token-usage",
  removedEndpointHandler("v1_team_token_usage"),
);
v1Router.get(
  "/team/token-usage/historical",
  removedEndpointHandler("v1_team_token_usage_historical"),
);
v1Router.get(
  "/team/queue-status",
  removedEndpointHandler("v1_team_queue_status"),
);

v1Router.post(
  "/extract",
  authMiddleware(RateLimiterMode.Extract),
  inferIntegrationMiddleware,
  deprecationMiddleware("v1_extract"),
  restrictedOptionsCountryCheck,
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
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(1),
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
  restrictedOptionsCountryCheck,
  checkCreditsMiddleware(1),
  wrap(deepResearchController),
);

v1Router.get(
  "/deep-research/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  deprecationMiddleware("v1_deep_research_status"),
  wrap(deepResearchStatusController),
);
