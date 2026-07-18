import { Request, Response } from "express";
import type Redis from "ioredis";
import { logger } from "../../lib/logger";
import { getRedisConnection } from "../../services/queue-service";
import { redisRateLimitClient } from "../../services/rate-limiter";

export const READINESS_CHECK_TIMEOUT_MS = 1000;

type RedisDependency = "queueRedis" | "redisRateLimitClient";

const redisClients: Record<RedisDependency, Redis> = {
  queueRedis: getRedisConnection(),
  redisRateLimitClient,
};

function createProbeClient(client: Redis): Redis {
  return client.duplicate({
    commandTimeout: READINESS_CHECK_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
}

const probeClients: Record<RedisDependency, Redis> = {
  queueRedis: createProbeClient(redisClients.queueRedis),
  redisRateLimitClient: createProbeClient(redisClients.redisRateLimitClient),
};

function resetProbeClient(dependency: RedisDependency) {
  probeClients[dependency].disconnect();
  probeClients[dependency] = createProbeClient(redisClients[dependency]);
}

async function checkRedis(dependency: RedisDependency): Promise<boolean> {
  try {
    const client = redisClients[dependency];
    const probeClient = probeClients[dependency];

    if (client.status !== "ready" || probeClient.status !== "ready") {
      logger.warn("Readiness Redis dependency is not ready", {
        dependency,
        status: client.status,
        probeStatus: probeClient.status,
      });
      return false;
    }

    if ((await probeClient.ping()) !== "PONG") {
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
    // A timed-out ioredis command remains queued internally. Closing this
    // dedicated connection discards it without affecting application clients.
    resetProbeClient(dependency);
    logger.warn("Readiness Redis dependency check failed", {
      dependency,
      error,
    });
    return false;
  }
}

export async function readinessController(req: Request, res: Response) {
  const [queueRedisHealthy, redisRateLimitClientHealthy] = await Promise.all([
    checkRedis("queueRedis"),
    checkRedis("redisRateLimitClient"),
  ]);

  if (!queueRedisHealthy || !redisRateLimitClientHealthy) {
    return res.status(503).json({ status: "unhealthy" });
  }

  return res.status(200).json({ status: "ok" });
}
