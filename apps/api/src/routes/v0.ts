import express from "express";
import { crawlController } from "../../src/controllers/v0/crawl";
import { crawlStatusController } from "../../src/controllers/v0/crawl-status";
import { scrapeController } from "../../src/controllers/v0/scrape";
import { searchController } from "../../src/controllers/v0/search";
import { crawlCancelController } from "../../src/controllers/v0/crawl-cancel";
import { keyAuthController } from "../../src/controllers/v0/keyAuth";
import { livenessController, readinessController } from "../controllers/health";
import { deprecationMiddleware } from "../lib/deprecations";

export const v0Router = express.Router();

v0Router.post(
  "/v0/scrape",
  deprecationMiddleware("v0_scrape"),
  scrapeController,
);
v0Router.post("/v0/crawl", deprecationMiddleware("v0_crawl"), crawlController);
v0Router.get(
  "/v0/crawl/status/:jobId",
  deprecationMiddleware("v0_crawl_status"),
  crawlStatusController,
);
v0Router.delete(
  "/v0/crawl/cancel/:jobId",
  deprecationMiddleware("v0_crawl_cancel"),
  crawlCancelController,
);

// Auth route for key based authentication
v0Router.get("/v0/keyAuth", keyAuthController);

// Search routes
v0Router.post(
  "/v0/search",
  deprecationMiddleware("v0_search"),
  searchController,
);

// Health/Probe routes, kept as aliases of /health/* in index.ts
v0Router.get("/v0/health/liveness", livenessController);
v0Router.get("/v0/health/readiness", readinessController);
