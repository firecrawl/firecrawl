import express, { NextFunction, Request, Response } from "express";
import { Counter } from "prom-client";
import { config } from "../config";
import { acucCacheClearController } from "../controllers/v0/admin/acuc-cache-clear";
import { autumnHealthController } from "../controllers/v0/admin/autumn-health";
import { checkFireEngine } from "../controllers/v0/admin/check-fire-engine";
import { concurrencyQueueBackfillController } from "../controllers/v0/admin/concurrency-queue-backfill";
import { crawlMonitorController } from "../controllers/v0/admin/crawl-monitor";
import { indexQueuePrometheus } from "../controllers/v0/admin/index-queue-prometheus";
import { ipRestrictionCacheClearController } from "../controllers/v0/admin/ip-restriction-cache-clear";
import { keyRestrictionCacheClearController } from "../controllers/v0/admin/key-restriction-cache-clear";
import {
  metricsController,
  nuqFdbMetricsController,
  nuqMetricsController,
} from "../controllers/v0/admin/metrics";
import { triggerPrecrawl } from "../controllers/v0/admin/precrawl";
import { redisHealthController } from "../controllers/v0/admin/redis-health";
import { realtimeSearchController } from "../controllers/v2/f-search";
import {
  handleIntegrationAdminCreateUserProxy,
  handleIntegrationAdminRotateProxy,
  handleIntegrationAdminValidateProxy,
} from "../lib/admin-integration-integrations-proxy";
import {
  adminAuth,
  adminKeyHeaderAuth,
  bearerToken,
  secretsMatch,
} from "../lib/admin-auth";
import { logger } from "../lib/logger";
import { RateLimiterMode } from "../types";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";

export const adminRouter = express.Router();

// Fixed labels only: never the request path, which carries the key.
const adminPathRouteRequests = new Counter({
  name: "firecrawl_admin_path_route_requests_total",
  help: "Requests to admin routes that take the key as a path segment",
  labelNames: ["surface"],
});

export function countAdminPathRoute(surface: "queues" | "routes") {
  return (_req: Request, _res: Response, next: NextFunction) => {
    adminPathRouteRequests.inc({ surface });
    next();
  };
}

if (config.BULL_AUTH_KEY && config.BULL_AUTH_KEY_PATH_ROUTES) {
  adminRouter.use(
    `/admin/${config.BULL_AUTH_KEY}`,
    countAdminPathRoute("routes"),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/redis-health`,
    redisHealthController,
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/autumn-health`,
    autumnHealthController,
  );

  adminRouter.post(
    `/admin/${config.BULL_AUTH_KEY}/acuc-cache-clear`,
    wrap(acucCacheClearController),
  );

  adminRouter.post(
    `/admin/${config.BULL_AUTH_KEY}/ip-restriction-cache-clear`,
    wrap(ipRestrictionCacheClearController),
  );

  adminRouter.post(
    `/admin/${config.BULL_AUTH_KEY}/key-restriction-cache-clear`,
    wrap(keyRestrictionCacheClearController),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/feng-check`,
    wrap(checkFireEngine),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/index-queue-prometheus`,
    wrap(indexQueuePrometheus),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/precrawl`,
    wrap(triggerPrecrawl),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/metrics`,
    wrap(metricsController),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/nuq-metrics`,
    wrap(nuqMetricsController),
  );

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/nuq-fdb-metrics`,
    wrap(nuqFdbMetricsController),
  );

  adminRouter.post(
    `/admin/${config.BULL_AUTH_KEY}/fsearch`,
    wrap(realtimeSearchController),
  );

  adminRouter.post(
    `/admin/${config.BULL_AUTH_KEY}/concurrency-queue-backfill`,
    wrap(concurrencyQueueBackfillController),
  );

  adminRouter.post(
    `/admin/${config.BULL_AUTH_KEY}/crawl-monitor`,
    authMiddleware(RateLimiterMode.Crawl),
    checkCreditsMiddleware(2),
    wrap(crawlMonitorController),
  );
}

if (config.BULL_AUTH_KEY) {
  const opsRouter = express.Router();
  opsRouter.use(adminAuth);

  opsRouter.get("/redis-health", redisHealthController);

  opsRouter.get("/autumn-health", autumnHealthController);

  opsRouter.get("/feng-check", wrap(checkFireEngine));

  opsRouter.post("/acuc-cache-clear", wrap(acucCacheClearController));

  opsRouter.post(
    "/ip-restriction-cache-clear",
    wrap(ipRestrictionCacheClearController),
  );

  opsRouter.post(
    "/key-restriction-cache-clear",
    wrap(keyRestrictionCacheClearController),
  );

  opsRouter.post(
    "/concurrency-queue-backfill",
    wrap(concurrencyQueueBackfillController),
  );

  adminRouter.post(
    "/admin/ops/crawl-monitor",
    adminKeyHeaderAuth,
    authMiddleware(RateLimiterMode.Crawl),
    checkCreditsMiddleware(2),
    wrap(crawlMonitorController),
  );

  adminRouter.use("/admin/ops", opsRouter);
}

if (config.S2S_FIRECRAWL_INTEGRATIONS_TO_FIRECRAWL_API_KEY) {
  function firecrawlIntegrationsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (
      !secretsMatch(
        bearerToken(req.headers.authorization),
        config.S2S_FIRECRAWL_INTEGRATIONS_TO_FIRECRAWL_API_KEY,
      )
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    logger.info(
      `firecrawl-integrations service calling ${req.method} ${req.path}`,
    );
    next();
  }

  adminRouter.post(
    "/admin/acuc-cache-clear",
    firecrawlIntegrationsMiddleware,
    wrap(acucCacheClearController),
  );
}

adminRouter.post(
  `/admin/integration/create-user`,
  wrap(handleIntegrationAdminCreateUserProxy),
);

adminRouter.post(
  `/admin/integration/validate-api-key`,
  wrap(handleIntegrationAdminValidateProxy),
);

adminRouter.post(
  `/admin/integration/rotate-api-key`,
  wrap(handleIntegrationAdminRotateProxy),
);

/** Served only by the ADMIN_INTERNAL_PORT listener, without a key. */
export const adminInternalRouter = express.Router();

adminInternalRouter.get("/admin/redis-health", redisHealthController);

adminInternalRouter.get("/admin/autumn-health", autumnHealthController);

adminInternalRouter.get("/admin/feng-check", wrap(checkFireEngine));

adminInternalRouter.get(
  "/admin/index-queue-prometheus",
  wrap(indexQueuePrometheus),
);

adminInternalRouter.get("/admin/precrawl", wrap(triggerPrecrawl));

adminInternalRouter.get("/admin/metrics", wrap(metricsController));

adminInternalRouter.get("/admin/nuq-metrics", wrap(nuqMetricsController));

adminInternalRouter.get(
  "/admin/nuq-fdb-metrics",
  wrap(nuqFdbMetricsController),
);

adminInternalRouter.post("/admin/fsearch", wrap(realtimeSearchController));

adminInternalRouter.post(
  "/admin/crawl-monitor",
  authMiddleware(RateLimiterMode.Crawl),
  checkCreditsMiddleware(2),
  wrap(crawlMonitorController),
);
