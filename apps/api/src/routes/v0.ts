import express from "express";
import { livenessController, readinessController } from "../controllers/health";
import { removedEndpointHandler } from "../lib/deprecations";

export const v0Router = express.Router();

v0Router.post("/v0/scrape", removedEndpointHandler("v0_scrape"));
v0Router.post("/v0/crawl", removedEndpointHandler("v0_crawl"));
v0Router.get(
  "/v0/crawl/status/:jobId",
  removedEndpointHandler("v0_crawl_status"),
);
v0Router.delete(
  "/v0/crawl/cancel/:jobId",
  removedEndpointHandler("v0_crawl_cancel"),
);
v0Router.get("/v0/keyAuth", removedEndpointHandler("v0_key_auth"));
v0Router.post("/v0/search", removedEndpointHandler("v0_search"));

// Health/Probe routes, kept as aliases of /health/* in index.ts
v0Router.get("/v0/health/liveness", livenessController);
v0Router.get("/v0/health/readiness", readinessController);
