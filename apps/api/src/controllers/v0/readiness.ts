import { sql } from "drizzle-orm";
import { Request, Response } from "express";
import { config } from "../../config";
import { db, dbRr } from "../../db/connection";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { getRedisConnection } from "../../services/queue-service";
import { nuqSelect1 } from "../../services/worker/nuq";
import { collectUnhealthy, pingIfReady } from "./health-checks";

export async function readinessController(_req: Request, res: Response) {
  const failed = await collectUnhealthy([
    ["queueRedis", config.REDIS_URL ? pingIfReady(getRedisConnection()) : null],
    [
      "rateLimitRedis",
      config.REDIS_RATE_LIMIT_URL ? pingIfReady(redisRateLimitClient) : null,
    ],
    [
      "postgres",
      config.USE_DB_AUTHENTICATION ? () => db.execute(sql`SELECT 1`) : null,
    ],
    [
      "postgresReplica",
      config.USE_DB_AUTHENTICATION ? () => dbRr.execute(sql`SELECT 1`) : null,
    ],
    ["nuqPostgres", config.NUQ_DATABASE_URL ? nuqSelect1 : null],
  ]);
  if (failed.length > 0) {
    return res.status(503).json({ status: "unhealthy", failed });
  }
  return res.status(200).json({ status: "ok" });
}
