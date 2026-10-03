import { Request, Response } from "express";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { getRedisConnection } from "../../services/queue-service";
import { redisEnded } from "./health-checks";

export async function livenessController(_req: Request, res: Response) {
  const clients: Array<[string, { status: string } | null]> = [
    [
      "rateLimitRedis",
      config.REDIS_RATE_LIMIT_URL ? redisRateLimitClient : null,
    ],
    ["queueRedis", config.REDIS_URL ? getRedisConnection() : null],
  ];
  for (const [check, client] of clients) {
    if (!redisEnded(client)) continue;
    logger.warn("Liveness check failed", {
      module: "health",
      check,
      status: client!.status,
    });
    return res.status(503).json({ status: "unhealthy" });
  }
  return res.status(200).json({ status: "ok" });
}
