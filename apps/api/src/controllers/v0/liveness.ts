import { Request, Response } from "express";
import { redisRateLimitClient } from "../../services/rate-limiter";

export async function livenessController(req: Request, res: Response) {
  if (redisRateLimitClient.status === 'end') {
     return res.status(503).json({ status: "error", message: "Redis connection has ended fatally" });
  }

  res.status(200).json({ status: "ok" });
}
