import express, { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
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
import { createRequireBullAuth } from "../lib/bull-auth";

export const adminRouter = express.Router();

if (config.BULL_AUTH_KEY) {
  const requireBullAuth = createRequireBullAuth(config.BULL_AUTH_KEY);

  adminRouter.get(
    `/admin/*bullAuthKey/redis-health`,
    requireBullAuth,
    redisHealthController,
  );

  adminRouter.get(
    `/admin/*bullAuthKey/autumn-health`,
    requireBullAuth,
    autumnHealthController,
  );

  adminRouter.post(
    `/admin/*bullAuthKey/acuc-cache-clear`,
    requireBullAuth,
    wrap(acucCacheClearController),
  );

  adminRouter.post(
    `/admin/*bullAuthKey/ip-restriction-cache-clear`,
    requireBullAuth,
    wrap(ipRestrictionCacheClearController),
  );

  adminRouter.post(
    `/admin/*bullAuthKey/key-restriction-cache-clear`,
    requireBullAuth,
    wrap(keyRestrictionCacheClearController),
  );

  adminRouter.get(
    `/admin/*bullAuthKey/feng-check`,
    requireBullAuth,
    wrap(checkFireEngine),
  );

  adminRouter.get(
    `/admin/*bullAuthKey/index-queue-prometheus`,
    requireBullAuth,
    wrap(indexQueuePrometheus),
  );

  adminRouter.get(
    `/admin/*bullAuthKey/precrawl`,
    requireBullAuth,
    wrap(triggerPrecrawl),
  );

  adminRouter.get(
    `/admin/*bullAuthKey/metrics`,
    requireBullAuth,
    wrap(metricsController),
  );

  adminRouter.get(
    `/admin/*bullAuthKey/nuq-metrics`,
    requireBullAuth,
    wrap(nuqMetricsController),
  );

  adminRouter.get(
    `/admin/*bullAuthKey/nuq-fdb-metrics`,
    requireBullAuth,
    wrap(nuqFdbMetricsController),
  );

  adminRouter.post(
    `/admin/*bullAuthKey/fsearch`,
    requireBullAuth,
    wrap(realtimeSearchController),
  );

  adminRouter.post(
    `/admin/*bullAuthKey/concurrency-queue-backfill`,
    requireBullAuth,
    wrap(concurrencyQueueBackfillController),
  );

  adminRouter.post(
    `/admin/*bullAuthKey/crawl-monitor`,
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

  function secretsMatch(provided: string | null, expected?: string): boolean {
    if (!provided || !expected) return false;
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
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
