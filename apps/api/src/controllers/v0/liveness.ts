import { Request, Response } from "express";
import { redisRateLimitClient } from "../../services/rate-limiter";

export async function livenessController(req: Request, res: Response) {
  try {
    if (redisRateLimitClient.status !== 'ready') {
      return res.status(503).json({ status: "error", message: "Redis connection is not ready" });
    }
    // Set a short timeout to prevent the ping from hanging indefinitely
    await Promise.race([
      redisRateLimitClient.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis ping timed out")), 2000))
    ]);
  } catch (error) {
    return res.status(503).json({ status: "error", message: "Redis connection check failed" });
  }

  res.status(200).json({ status: "ok" });
}
