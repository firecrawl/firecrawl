import express from "express";
import { config } from "../config";
import { redisHealthController } from "../controllers/v0/admin/redis-health";
import { autumnHealthController } from "../controllers/v0/admin/autumn-health";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";
import { acucCacheClearController } from "../controllers/v0/admin/acuc-cache-clear";
import { ipRestrictionCacheClearController } from "../controllers/v0/admin/ip-restriction-cache-clear";
import { keyRestrictionCacheClearController } from "../controllers/v0/admin/key-restriction-cache-clear";
import { checkFireEngine } from "../controllers/v0/admin/check-fire-engine";
import { indexQueuePrometheus } from "../controllers/v0/admin/index-queue-prometheus";
import { triggerPrecrawl } from "../controllers/v0/admin/precrawl";
import {
  metricsController,
  nuqFdbMetricsController,
  nuqMetricsController,
} from "../controllers/v0/admin/metrics";
import { realtimeSearchController } from "../controllers/v2/f-search";
import { concurrencyQueueBackfillController } from "../controllers/v0/admin/concurrency-queue-backfill";
import { crawlMonitorController } from "../controllers/v0/admin/crawl-monitor";
import {
  handleIntegrationAdminCreateUserProxy,
  handleIntegrationAdminRotateProxy,
  handleIntegrationAdminValidateProxy,
} from "../lib/admin-integration-integrations-proxy";
import { RateLimiterMode } from "../types";

export const adminRouter = express.Router();

if (config.BULL_AUTH_KEY) {
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
