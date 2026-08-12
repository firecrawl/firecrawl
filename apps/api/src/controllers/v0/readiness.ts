import { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db, dbRr } from "../../db/connection";
import { getRedisConnection } from "../../services/queue-service";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { logger } from "../../lib/logger";
import { config } from "../../config";

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)), timeoutMs))
  ]);
};

export async function readinessController(req: Request, res: Response) {
  try {
    const TIMEOUT_MS = 3000;

    // 1. Check Redis Rate Limiter Connection
    if (redisRateLimitClient.status !== 'ready') {
       throw new Error("Redis rate limiter client is not ready");
    }
    await withTimeout(redisRateLimitClient.ping(), TIMEOUT_MS, "Redis rate limiter");

    // 2. Check Redis Queue Connection
    const queueRedis = getRedisConnection();
    if (queueRedis.status !== 'ready') {
       throw new Error("Redis queue client is not ready");
    }
    await withTimeout(queueRedis.ping(), TIMEOUT_MS, "Redis queue");

    // 3. Check Postgres Connections (Main and Replica) if configured
    if (config.USE_DB_AUTHENTICATION) {
      await withTimeout(db.execute(sql`SELECT 1`), TIMEOUT_MS, "Main DB");
      await withTimeout(dbRr.execute(sql`SELECT 1`), TIMEOUT_MS, "Replica DB");
    }

    res.status(200).json({ status: "ok", message: "Application is ready to serve traffic" });
  } catch (error) {
    logger.error("Readiness probe failed", { error: error instanceof Error ? error.message : error });
    res.status(503).json({ 
      status: "error", 
      message: "Service is not ready"
    });
  }
}
