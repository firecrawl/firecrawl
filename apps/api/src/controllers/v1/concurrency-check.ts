import {
  ConcurrencyCheckParams,
  ConcurrencyCheckResponse,
  RequestWithAuth,
} from "./types";
import { Response } from "express";
import { getCombinedTeamActiveCount } from "../../services/worker/nuq-router";

// Basically just middleware and error wrapping
export async function concurrencyCheckController(
  req: RequestWithAuth<ConcurrencyCheckParams, undefined, undefined>,
  res: Response<ConcurrencyCheckResponse>,
) {
  const activeJobsOfTeam = await getCombinedTeamActiveCount(req.auth.team_id);

  return res.status(200).json({
    success: true,
    concurrency: activeJobsOfTeam,
    maxConcurrency: req.acuc?.concurrency ?? 0,
  });
}
