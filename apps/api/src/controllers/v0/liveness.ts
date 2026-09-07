import { Request, Response } from "express";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { getRedisConnection } from "../../services/queue-service";
import { redisEnded } from "./health-checks";

export async function livenessController(_req: Request, res: Response) {
  if (config.REDIS_RATE_LIMIT_URL && redisEnded(redisRateLimitClient)) {
    logger.warn("Liveness check failed", {
      module: "health",
      check: "rateLimitRedis",
      status: redisRateLimitClient.status,
    });
    return res.status(503).json({ status: "unhealthy" });
  }
  if (config.REDIS_URL && redisEnded(getRedisConnection())) {
    logger.warn("Liveness check failed", {
      module: "health",
      check: "queueRedis",
      status: "end",
    });
    return res.status(503).json({ status: "unhealthy" });
  }
  return res.status(200).json({ status: "ok" });
}
