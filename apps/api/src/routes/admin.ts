import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { config } from "../config";
import { acucCacheClearController } from "../controllers/v0/admin/acuc-cache-clear";
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
  adminPathKeyAuth,
  bearerToken,
  secretsMatch,
} from "../lib/admin-auth";
import { logger } from "../lib/logger";
import { RateLimiterMode } from "../types";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";

export const adminRouter = express.Router();

// Routes that take the admin key. Each is served under /admin/ops with the key
// in the Authorization header and, while BULL_AUTH_KEY_PATH_ROUTES is on, under
// /admin/<key>. Both forms go through the same key check in lib/admin-auth.
const keyedRoutes: Array<{
  method: "get" | "post";
  path: string;
  handler: RequestHandler;
}> = [
  { method: "get", path: "/redis-health", handler: redisHealthController },
  { method: "get", path: "/feng-check", handler: wrap(checkFireEngine) },
  {
    method: "post",
    path: "/acuc-cache-clear",
    handler: wrap(acucCacheClearController),
  },
  {
    method: "post",
    path: "/ip-restriction-cache-clear",
    handler: wrap(ipRestrictionCacheClearController),
  },
  {
    method: "post",
    path: "/key-restriction-cache-clear",
    handler: wrap(keyRestrictionCacheClearController),
  },
  {
    method: "post",
    path: "/concurrency-queue-backfill",
    handler: wrap(concurrencyQueueBackfillController),
  },
  {
    method: "get",
    path: "/index-queue-prometheus",
    handler: wrap(indexQueuePrometheus),
  },
  { method: "get", path: "/precrawl", handler: wrap(triggerPrecrawl) },
  { method: "get", path: "/metrics", handler: wrap(metricsController) },
  { method: "get", path: "/nuq-metrics", handler: wrap(nuqMetricsController) },
  {
    method: "get",
    path: "/nuq-fdb-metrics",
    handler: wrap(nuqFdbMetricsController),
  },
  { method: "post", path: "/fsearch", handler: wrap(realtimeSearchController) },
];

const crawlMonitorHandlers = [
  authMiddleware(RateLimiterMode.Crawl),
  checkCreditsMiddleware(2),
  wrap(crawlMonitorController),
];

if (config.BULL_AUTH_KEY) {
  const opsRouter = express.Router();
  opsRouter.use(adminAuth);
  for (const route of keyedRoutes) {
    opsRouter[route.method](route.path, route.handler);
  }

  adminRouter.post(
    "/admin/ops/crawl-monitor",
    adminKeyHeaderAuth,
    ...crawlMonitorHandlers,
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

// Registered after every other /admin route, since /admin/:adminKey matches any
// first segment. Off with BULL_AUTH_KEY_PATH_ROUTES=false.
if (config.BULL_AUTH_KEY && config.BULL_AUTH_KEY_PATH_ROUTES) {
  const pathRouter = express.Router({ mergeParams: true });
  pathRouter.use(adminPathKeyAuth());
  for (const route of keyedRoutes) {
    pathRouter[route.method](route.path, route.handler);
  }
  pathRouter.post("/crawl-monitor", ...crawlMonitorHandlers);

  adminRouter.use("/admin/:adminKey", pathRouter);
}

/** Served only by the ADMIN_INTERNAL_PORT listener, without a key. */
export const adminInternalRouter = express.Router();

adminInternalRouter.get("/admin/redis-health", redisHealthController);

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
