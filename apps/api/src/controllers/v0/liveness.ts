import { Request, Response } from "express";
import { redisRateLimitClient } from "../../services/rate-limiter";

export async function livenessController(req: Request, res: Response) {
  try {
    if (redisRateLimitClient.status !== 'ready') {
      return res.status(503).json({ status: "error", message: "Redis connection is not ready" });
    }
    
    let timer: NodeJS.Timeout;
    await Promise.race([
      redisRateLimitClient.ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis ping timed out")), 2000);
      })
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    return res.status(503).json({ status: "error", message: "Redis connection check failed" });
  }

  res.status(200).json({ status: "ok" });
}
