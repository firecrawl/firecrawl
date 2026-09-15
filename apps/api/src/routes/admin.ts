import express, { NextFunction, Request, Response } from "express";
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
import { logger } from "../lib/logger";
import { RateLimiterMode } from "../types";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";
import {
  bullAuthRoute,
  createRequireBullAuth,
  secretsMatch,
} from "../lib/bull-auth";

export const adminRouter = express.Router();

if (config.BULL_AUTH_KEY) {
  const key = config.BULL_AUTH_KEY;
  const requireBullAuth = createRequireBullAuth(key);
  const bull = (rest: string) => bullAuthRoute(key, rest);

  adminRouter.get(
    bull("/redis-health"),
    requireBullAuth,
    redisHealthController,
  );

  adminRouter.get(
    bull("/autumn-health"),
    requireBullAuth,
    autumnHealthController,
  );

  adminRouter.post(
    bull("/acuc-cache-clear"),
    requireBullAuth,
    wrap(acucCacheClearController),
  );

  adminRouter.post(
    bull("/ip-restriction-cache-clear"),
    requireBullAuth,
    wrap(ipRestrictionCacheClearController),
  );

  adminRouter.post(
    bull("/key-restriction-cache-clear"),
    requireBullAuth,
    wrap(keyRestrictionCacheClearController),
  );

  adminRouter.get(bull("/feng-check"), requireBullAuth, wrap(checkFireEngine));

  adminRouter.get(
    bull("/index-queue-prometheus"),
    requireBullAuth,
    wrap(indexQueuePrometheus),
  );

  adminRouter.get(bull("/precrawl"), requireBullAuth, wrap(triggerPrecrawl));

  adminRouter.get(bull("/metrics"), requireBullAuth, wrap(metricsController));

  adminRouter.get(
    bull("/nuq-metrics"),
    requireBullAuth,
    wrap(nuqMetricsController),
  );

  adminRouter.get(
    bull("/nuq-fdb-metrics"),
    requireBullAuth,
    wrap(nuqFdbMetricsController),
  );

  adminRouter.post(
    bull("/fsearch"),
    requireBullAuth,
    wrap(realtimeSearchController),
  );

  adminRouter.post(
    bull("/concurrency-queue-backfill"),
    requireBullAuth,
    wrap(concurrencyQueueBackfillController),
  );

  adminRouter.post(
    bull("/crawl-monitor"),
    requireBullAuth,
    authMiddleware(RateLimiterMode.Crawl),
    checkCreditsMiddleware(2),
    wrap(crawlMonitorController),
  );
}

if (config.S2S_FIRECRAWL_INTEGRATIONS_TO_FIRECRAWL_API_KEY) {
  function bearerToken(value: string | string[] | undefined): string | null {
    const header = Array.isArray(value) ? value[0] : value;
    return header?.startsWith("Bearer ") ? header.slice(7) : null;
  }

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
