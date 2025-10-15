import express from "express";
import { redisHealthController } from "../controllers/v0/admin/redis-health";
import { authMiddleware, blocklistMiddleware, wrap } from "./shared";
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
import { crawlCheckController } from "../controllers/v0/admin/crawl-check";
import { realtimeSearchController } from "../controllers/v2/f-search";

export const adminRouter = express.Router();

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/redis-health`,
  redisHealthController,
);

adminRouter.post(
  `/admin/${process.env.BULL_AUTH_KEY}/acuc-cache-clear`,
  wrap(acucCacheClearController),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/feng-check`,
  wrap(checkFireEngine),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/cclog`,
  wrap(cclogController),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/zdrcleaner`,
  wrap(zdrcleanerController),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/index-queue-prometheus`,
  wrap(indexQueuePrometheus),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/precrawl`,
  wrap(triggerPrecrawl),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/metrics`,
  wrap(metricsController),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/nuq-metrics`,
  wrap(nuqMetricsController),
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/crawl-check`,
  wrap(crawlCheckController),
);

adminRouter.post(
  `/admin/${process.env.BULL_AUTH_KEY}/fsearch`,
  wrap(realtimeSearchController),
);
