import {
  ConcurrencyCheckParams,
  ConcurrencyCheckResponse,
  RequestWithAuth,
} from "./types";
import { AuthCreditUsageChunkFromTeam } from "../v1/types";
import { Response } from "express";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";
import { getCombinedTeamActiveCount } from "../../services/worker/nuq-router";

// Basically just middleware and error wrapping
export async function concurrencyCheckController(
  req: RequestWithAuth<ConcurrencyCheckParams, undefined, undefined>,
  res: Response<ConcurrencyCheckResponse>,
) {
  if (!req.acuc) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  let otherACUC: AuthCreditUsageChunkFromTeam | null = null;
  if (!req.acuc.is_extract) {
    otherACUC = await getACUCTeam(
      req.auth.team_id,
      false,
      true,
      RateLimiterMode.Extract,
    );
  } else {
    otherACUC = await getACUCTeam(
      req.auth.team_id,
      false,
      true,
      RateLimiterMode.Crawl,
    );
  }

  const activeJobsOfTeam = await getCombinedTeamActiveCount(req.auth.team_id);

  return res.status(200).json({
    success: true,
    concurrency: activeJobsOfTeam,
    maxConcurrency: Math.max(req.acuc.concurrency, otherACUC?.concurrency ?? 0),
  });
}
