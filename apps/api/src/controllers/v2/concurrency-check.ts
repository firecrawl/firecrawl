import type {
  ConcurrencyCheckParams,
  ConcurrencyCheckResponse,
  RequestWithAuth,
} from "./types";
import type { Response } from "express";
import { getCombinedTeamActiveCount } from "../../services/worker/nuq-router";
import { currentLimits } from "../../lib/limits";
import { requestContext } from "../../lib/request-context";

// Basically just middleware and error wrapping
export async function concurrencyCheckController(
  req: RequestWithAuth<ConcurrencyCheckParams, undefined, undefined>,
  res: Response<ConcurrencyCheckResponse>,
) {
  const ctx = requestContext({
    teamId: req.auth.team_id,
    zeroDataRetention: false,
    flags: req.acuc?.flags ?? null,
    orgId: req.acuc?.org_id ?? null,
    apiKeyId: req.acuc?.api_key_id ?? null,
    concurrencyLimit: req.acuc?.concurrency_limit,
    rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
  });

  const activeJobsOfTeam = await getCombinedTeamActiveCount(
    req.auth.team_id,
    ctx,
  );
  const maxConcurrency = await currentLimits().concurrency(ctx);

  return res.status(200).json({
    success: true,
    concurrency: activeJobsOfTeam,
    maxConcurrency,
  });
}
