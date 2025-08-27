import express from "express";
import { redisHealthController } from "../controllers/v0/admin/redis-health";
import {
  autoscalerController,
  checkQueuesController,
  cleanBefore24hCompleteJobsController,
  queuesController,
} from "../controllers/v0/admin/queue";
import { wrap } from "./shared";
import { acucCacheClearController } from "../controllers/v0/admin/acuc-cache-clear";
import { checkFireEngine } from "../controllers/v0/admin/check-fire-engine";
import { cclogController } from "../controllers/v0/admin/cclog";
import { indexQueuePrometheus } from "../controllers/v0/admin/index-queue-prometheus";
import { zdrcleanerController } from "../controllers/v0/admin/zdrcleaner";
import { triggerPrecrawl } from "../controllers/v0/admin/precrawl";
import { metricsController } from "../controllers/v0/admin/metrics";

export const adminRouter = express.Router();

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/redis-health`,
  redisHealthController,
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/clean-before-24h-complete-jobs`,
  cleanBefore24hCompleteJobsController,
);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/check-queues`,
  checkQueuesController,
);

adminRouter.get(`/admin/${process.env.BULL_AUTH_KEY}/queues`, queuesController);

adminRouter.get(
  `/admin/${process.env.BULL_AUTH_KEY}/autoscaler`,
  autoscalerController,
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