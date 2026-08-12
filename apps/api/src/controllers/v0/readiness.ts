import { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db, dbRr } from "../../db/connection";
import { getRedisConnection } from "../../services/queue-service";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { logger } from "../../lib/logger";

export async function readinessController(req: Request, res: Response) {
  try {
    // 1. Check Redis Rate Limiter Connection
    if (redisRateLimitClient.status !== 'ready') {
       throw new Error("Redis rate limiter client is not ready");
    }
    await redisRateLimitClient.ping();

    // 2. Check Redis Queue Connection
    const queueRedis = getRedisConnection();
    if (queueRedis.status !== 'ready') {
       throw new Error("Redis queue client is not ready");
    }
    await queueRedis.ping();

    // 3. Check Postgres Connections (Main and Replica)
    if (db) {
      await db.execute(sql`SELECT 1`);
    }
    if (dbRr) {
      await dbRr.execute(sql`SELECT 1`);
    }

    res.status(200).json({ status: "ok", message: "Application is ready to serve traffic" });
  } catch (error) {
    logger.error("Readiness probe failed", { error: error instanceof Error ? error.message : error });
    res.status(503).json({ 
      status: "error", 
      message: "Service is not ready",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
