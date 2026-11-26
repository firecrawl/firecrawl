import express, { RequestHandler } from "express";
import { config } from "../config";
import { concurrencyQueueBackfillController } from "../controllers/admin/concurrency-queue-backfill";
import {
  metricsController,
  nuqFdbMetricsController,
  nuqMetricsController,
} from "../controllers/admin/metrics";
import { redisHealthController } from "../controllers/admin/redis-health";
import { adminAuth, adminPathKeyAuth } from "../lib/admin-auth";
import { wrap } from "./shared";

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
  {
    method: "post",
    path: "/concurrency-queue-backfill",
    handler: wrap(concurrencyQueueBackfillController),
  },
  { method: "get", path: "/metrics", handler: wrap(metricsController) },
  { method: "get", path: "/nuq-metrics", handler: wrap(nuqMetricsController) },
  {
    method: "get",
    path: "/nuq-fdb-metrics",
    handler: wrap(nuqFdbMetricsController),
  },
];

if (config.BULL_AUTH_KEY) {
  const opsRouter = express.Router();
  opsRouter.use(adminAuth);
  for (const route of keyedRoutes) {
    opsRouter[route.method](route.path, route.handler);
  }

  adminRouter.use("/admin/ops", opsRouter);
}

// Registered after every other /admin route, since /admin/:adminKey matches any
// first segment. Off with BULL_AUTH_KEY_PATH_ROUTES=false.
if (config.BULL_AUTH_KEY && config.BULL_AUTH_KEY_PATH_ROUTES) {
  const pathRouter = express.Router({ mergeParams: true });
  pathRouter.use(adminPathKeyAuth());
  for (const route of keyedRoutes) {
    pathRouter[route.method](route.path, route.handler);
  }

  adminRouter.use("/admin/:adminKey", pathRouter);
}

/** Served only by the ADMIN_INTERNAL_PORT listener, without a key. */
export const adminInternalRouter = express.Router();

adminInternalRouter.get("/admin/redis-health", redisHealthController);

adminInternalRouter.get("/admin/metrics", wrap(metricsController));

adminInternalRouter.get("/admin/nuq-metrics", wrap(nuqMetricsController));

adminInternalRouter.get(
  "/admin/nuq-fdb-metrics",
  wrap(nuqFdbMetricsController),
);
