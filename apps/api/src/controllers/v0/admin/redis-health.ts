import { Request, Response } from "express";
import Redis from "ioredis";
import { logger } from "../../../lib/logger";
import { redisRateLimitClient } from "../../../services/rate-limiter";

export async function redisHealthController(req: Request, res: Response) {
  const retryOperation = async (operation, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === retries) throw error;
        logger.warn(`Attempt ${attempt} failed: ${error.message}. Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
      }
    }
  };

  try {
    const queueRedis = new Redis(process.env.REDIS_URL!);

    const testKey = "test";
    const testValue = "test";

    // Test queueRedis
    let queueRedisHealth;
    try {
      await retryOperation(() => queueRedis.set(testKey, testValue));
      queueRedisHealth = await retryOperation(() => queueRedis.get(testKey));
      await retryOperation(() => queueRedis.del(testKey));
    } catch (error) {
      logger.error(`queueRedis health check failed: ${error}`);
      queueRedisHealth = null;
    }

    // Test redisRateLimitClient
    let redisRateLimitHealth;
    try {
      await retryOperation(() => redisRateLimitClient.set(testKey, testValue));
      redisRateLimitHealth = await retryOperation(() =>
        redisRateLimitClient.get(testKey),
      );
      await retryOperation(() => redisRateLimitClient.del(testKey));
    } catch (error) {
      logger.error(`redisRateLimitClient health check failed: ${error}`);
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
      logger.info(
        `Redis instances health check: ${JSON.stringify(healthStatus)}`,
      );
      // await sendSlackWebhook(
      //   `[REDIS DOWN] Redis instances health check: ${JSON.stringify(
      //     healthStatus
      //   )}`,
      //   true
      // );
      return res
        .status(500)
        .json({ status: "unhealthy", details: healthStatus });
    }
  } catch (error) {
    logger.error(`Redis health check failed: ${error}`);
    // await sendSlackWebhook(
    //   `[REDIS DOWN] Redis instances health check: ${error.message}`,
    //   true
    // );
    return res
      .status(500)
      .json({ status: "unhealthy", message: error.message });
  }
}
