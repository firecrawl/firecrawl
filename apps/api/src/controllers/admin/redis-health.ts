import type { Request, Response } from "express";
import { logger } from "../../lib/logger";
import { redisRateLimitClient } from "../../services/redis";
import { getRedisConnection } from "../../services/queue-service";

async function retryOperation<T>(
  operation: () => Promise<T>,
  retries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt === retries) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Redis operation failed; retrying", {
        attempt,
        error: message,
      });
      await new Promise<void>(resolve => {
        setTimeout(resolve, 2000);
      });
    }
  }
  throw new Error("Retry operation exhausted without result");
}

export async function redisHealthController(req: Request, res: Response) {
  try {
    const queueRedis = getRedisConnection();

    const testKey = "test";
    const testValue = "test";

    // Test queueRedis
    let queueRedisHealth: string | null;
    try {
      await retryOperation(() => queueRedis.set(testKey, testValue));
      queueRedisHealth = await retryOperation(() => queueRedis.get(testKey));
      await retryOperation(() => queueRedis.del(testKey));
    } catch (error: unknown) {
      logger.error("queueRedis health check failed", { error });
      queueRedisHealth = null;
    }

    // Test redisRateLimitClient
    let redisRateLimitHealth: string | null;
    try {
      await retryOperation(() => redisRateLimitClient.set(testKey, testValue));
      redisRateLimitHealth = await retryOperation(() =>
        redisRateLimitClient.get(testKey),
      );
      await retryOperation(() => redisRateLimitClient.del(testKey));
    } catch (error: unknown) {
      logger.error("redisRateLimitClient health check failed", { error });
      redisRateLimitHealth = null;
    }

    const healthStatus = {
      queueRedis: queueRedisHealth === testValue ? "healthy" : "unhealthy",
      redisRateLimitClient:
        redisRateLimitHealth === testValue ? "healthy" : "unhealthy",
    };

    if (
      healthStatus.queueRedis === "healthy" &&
      healthStatus.redisRateLimitClient === "healthy"
    ) {
      logger.info("Both Redis instances are healthy");
      return res.status(200).json({ status: "healthy", details: healthStatus });
    } else {
      logger.warn("Redis instances health check", { details: healthStatus });
      return res
        .status(500)
        .json({ status: "unhealthy", details: healthStatus });
    }
  } catch (error: unknown) {
    logger.error("Redis health check failed", { error });
    return res.status(500).json({
      status: "unhealthy",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
