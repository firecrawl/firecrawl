import express from "express";
import { config } from "../config";
import { redisHealthController } from "../controllers/v0/admin/redis-health";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";
import { acucCacheClearController } from "../controllers/v0/admin/acuc-cache-clear";
import { checkFireEngine } from "../controllers/v0/admin/check-fire-engine";
import { cclogController } from "../controllers/v0/admin/cclog";
import { indexQueuePrometheus } from "../controllers/v0/admin/index-queue-prometheus";
import { zdrcleanerController } from "../controllers/v0/admin/zdrcleaner";
import { triggerPrecrawl } from "../controllers/v0/admin/precrawl";
import {
  metricsController,
  nuqMetricsController,
} from "../controllers/v0/admin/metrics";
import { realtimeSearchController } from "../controllers/v2/f-search";
import { concurrencyQueueBackfillController } from "../controllers/v0/admin/concurrency-queue-backfill";
import { integCreateUserController } from "../controllers/v0/admin/create-user";
import { integValidateApiKeyController } from "../controllers/v0/admin/validate-api-key";
import { integRotateApiKeyController } from "../controllers/v0/admin/rotate-api-key";
import { crawlMonitorController } from "../controllers/v0/admin/crawl-monitor";
import { RateLimiterMode } from "../types";

export const adminRouter = express.Router();

// Escape special path-to-regexp metacharacters so that BULL_AUTH_KEY values
// containing characters like ) ( [ ] . * + ? are treated as literals in
// Express route paths (which are internally compiled to regular expressions).
function escapeRouteSegment(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const authKey = escapeRouteSegment(config.BULL_AUTH_KEY);

adminRouter.get(
  `/admin/${authKey}/redis-health`,
  redisHealthController,
);

adminRouter.post(
  `/admin/${authKey}/acuc-cache-clear`,
  wrap(acucCacheClearController),
);

adminRouter.get(
  `/admin/${authKey}/feng-check`,
  wrap(checkFireEngine),
);

adminRouter.get(`/admin/${authKey}/cclog`, wrap(cclogController));

adminRouter.get(
  `/admin/${authKey}/zdrcleaner`,
  wrap(zdrcleanerController),
);

adminRouter.get(
  `/admin/${authKey}/index-queue-prometheus`,
  wrap(indexQueuePrometheus),
);

adminRouter.get(
  `/admin/${authKey}/precrawl`,
  wrap(triggerPrecrawl),
);

adminRouter.get(
  `/admin/${authKey}/metrics`,
  wrap(metricsController),
);

adminRouter.get(
  `/admin/${authKey}/nuq-metrics`,
  wrap(nuqMetricsController),
);

adminRouter.post(
  `/admin/${authKey}/fsearch`,
  wrap(realtimeSearchController),
);

adminRouter.post(
  `/admin/${authKey}/concurrency-queue-backfill`,
  wrap(concurrencyQueueBackfillController),
);

adminRouter.post(
  `/admin/${authKey}/crawl-monitor`,
  authMiddleware(RateLimiterMode.Crawl),
  checkCreditsMiddleware(2),
  wrap(crawlMonitorController),
);

adminRouter.post(
  `/admin/integration/create-user`,
  wrap(integCreateUserController),
);

adminRouter.post(
  `/admin/integration/validate-api-key`,
  wrap(integValidateApiKeyController),
);

adminRouter.post(
  `/admin/integration/rotate-api-key`,
  wrap(integRotateApiKeyController),
);
