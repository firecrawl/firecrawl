import { Request, Response } from "express";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { logger } from "../../lib/logger";

const REDIS_PING_TIMEOUT_MS = 2000;

export async function livenessController(req: Request, res: Response) {
  try {
    // Verify the application can reach Redis by issuing a PING.
    // Fail fast if Redis does not respond in time, rather than waiting for
    // ioredis to reconnect.
    const pong = await Promise.race([
      redisRateLimitClient.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Redis PING timed out")),
          REDIS_PING_TIMEOUT_MS,
        ),
      ),
    ]);
    if (pong !== "PONG") {
      throw new Error(`Unexpected Redis PING response: ${pong}`);
    }
    res.status(200).json({ status: "ok" });
  } catch (error) {
    logger.error("Liveness check failed: Redis is unreachable", { error });
    res.status(503).json({ status: "error", error: "Redis is unreachable" });
  }
}
