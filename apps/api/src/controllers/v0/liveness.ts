import { Request, Response } from "express";
import { config } from "../../config";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { getRedisConnection } from "../../services/queue-service";
import { redisEnded } from "./health-checks";

export async function livenessController(_req: Request, res: Response) {
  if (
    (config.REDIS_RATE_LIMIT_URL && redisEnded(redisRateLimitClient)) ||
    (config.REDIS_URL && redisEnded(getRedisConnection()))
  ) {
    return res.status(503).json({ status: "unhealthy" });
  }
  return res.status(200).json({ status: "ok" });
}
