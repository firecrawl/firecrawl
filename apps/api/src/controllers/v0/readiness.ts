import { sql } from "drizzle-orm";
import { Request, Response } from "express";
import { config } from "../../config";
import { db, dbRr } from "../../db/connection";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { getRedisConnection } from "../../services/queue-service";
import { nuqHealthCheck } from "../../services/worker/nuq";
import { collectUnhealthy, pingIfReady } from "./health-checks";

export async function readinessController(_req: Request, res: Response) {
  const replica =
    config.USE_DB_AUTHENTICATION &&
    config.DATABASE_REPLICA_URL &&
    config.DATABASE_REPLICA_URL !== config.DATABASE_URL;
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
    ["postgresReplica", replica ? () => dbRr.execute(sql`SELECT 1`) : null],
    [
      "nuqPostgres",
      config.NUQ_DATABASE_URL
        ? async () => {
            if (!(await nuqHealthCheck())) {
              throw new Error("nuq SELECT 1 returned no rows");
            }
          }
        : null,
    ],
  ]);
  if (failed.length > 0) {
    return res.status(503).json({ status: "unhealthy", failed });
  }
  return res.status(200).json({ status: "ok" });
}
