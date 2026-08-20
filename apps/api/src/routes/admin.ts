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

export const adminRouter = express.Router();

if (config.BULL_AUTH_KEY) {
  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/redis-health`, redisHealthController);

  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/autumn-health`, autumnHealthController);

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

  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/feng-check`, wrap(checkFireEngine));

  adminRouter.get(
    `/admin/${config.BULL_AUTH_KEY}/index-queue-prometheus`,
    wrap(indexQueuePrometheus),
  );

  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/precrawl`, wrap(triggerPrecrawl));

  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/metrics`, wrap(metricsController));

  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/nuq-metrics`, wrap(nuqMetricsController));

  adminRouter.get(`/admin/${config.BULL_AUTH_KEY}/nuq-fdb-metrics`, wrap(nuqFdbMetricsController));

  adminRouter.post(`/admin/${config.BULL_AUTH_KEY}/fsearch`, wrap(realtimeSearchController));

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

  function firecrawlIntegrationsMiddleware(req: Request, res: Response, next: NextFunction) {
    if (
      !secretsMatch(
        bearerToken(req.headers.authorization),
        config.S2S_FIRECRAWL_INTEGRATIONS_TO_FIRECRAWL_API_KEY,
      )
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    logger.info(`firecrawl-integrations service calling ${req.method} ${req.path}`);
    next();
  }

  adminRouter.post(
    "/admin/acuc-cache-clear",
    firecrawlIntegrationsMiddleware,
    wrap(acucCacheClearController),
  );
}

adminRouter.post(`/admin/integration/create-user`, wrap(handleIntegrationAdminCreateUserProxy));

adminRouter.post(`/admin/integration/validate-api-key`, wrap(handleIntegrationAdminValidateProxy));

adminRouter.post(`/admin/integration/rotate-api-key`, wrap(handleIntegrationAdminRotateProxy));
