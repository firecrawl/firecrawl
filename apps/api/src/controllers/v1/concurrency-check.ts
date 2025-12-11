import {
  ConcurrencyCheckParams,
  ConcurrencyCheckResponse,
  RequestWithAuth,
} from "./types";
import { Response } from "express";
import { getRedisConnection } from "../../../src/services/queue-service";

// Basically just middleware and error wrapping
export async function concurrencyCheckController(
  req: RequestWithAuth<ConcurrencyCheckParams, undefined, undefined>,
  res: Response<ConcurrencyCheckResponse>,
) {
  const concurrencyLimiterKey = "concurrency-limiter:" + req.auth.team_id;
  const now = Date.now();
  const activeJobsOfTeam = await getRedisConnection().zrangebyscore(
    concurrencyLimiterKey,
    now,
    Infinity,
  );

  return res.status(200).json({
    success: true,
    concurrency: activeJobsOfTeam.length,
    maxConcurrency: req.acuc?.concurrency ?? 0,
  });
}
