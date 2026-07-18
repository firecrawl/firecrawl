import { Request, Response } from "express";
import type Redis from "ioredis";
import { logger } from "../../lib/logger";
import { getRedisConnection } from "../../services/queue-service";
import { redisRateLimitClient } from "../../services/rate-limiter";

export const READINESS_CHECK_TIMEOUT_MS = 1000;

type RedisDependency = "queueRedis" | "redisRateLimitClient";
type RedisPingClient = Pick<Redis, "ping" | "status">;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Redis readiness check timed out")),
          READINESS_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkRedis(
  dependency: RedisDependency,
  getClient: () => RedisPingClient,
): Promise<boolean> {
  try {
    const client = getClient();

    // The queue client has an unbounded offline queue. Do not add a PING while
    // it is already reconnecting; the timeout covers a command that stalls
    // after the client was observed in the ready state.
    if (client.status !== "ready") {
      logger.warn("Readiness Redis dependency is not ready", {
        dependency,
        status: client.status,
      });
      return false;
    }

    if ((await withTimeout(client.ping())) !== "PONG") {
      logger.warn(
        "Readiness Redis dependency returned an unexpected response",
        {
          dependency,
        },
      );
      return false;
    }

    return true;
  } catch (error) {
    logger.warn("Readiness Redis dependency check failed", {
      dependency,
      error,
    });
    return false;
  }
}

export async function readinessController(req: Request, res: Response) {
  const [queueRedisHealthy, redisRateLimitClientHealthy] = await Promise.all([
    checkRedis("queueRedis", getRedisConnection),
    checkRedis("redisRateLimitClient", () => redisRateLimitClient),
  ]);

  if (!queueRedisHealthy || !redisRateLimitClientHealthy) {
    return res.status(503).json({ status: "unhealthy" });
  }

  return res.status(200).json({ status: "ok" });
}
