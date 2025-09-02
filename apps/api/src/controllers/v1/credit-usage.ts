import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";

interface CreditUsageResponse {
  success: true;
  data: {
    remaining_credits: number;
    plan_credits: number;
    billing_period_start: string | null;
    billing_period_end: string | null;
  };
}

export async function creditUsageController(
  req: RequestWithAuth,
  res: Response<CreditUsageResponse | ErrorResponse>,
): Promise<void> {
  const chunk =
    req.acuc ??
    (await getACUCTeam(req.auth.team_id, false, false, RateLimiterMode.Scrape));
  if (!chunk) {
    res.status(404).json({
      success: false,
      error: "Could not find credit usage information",
    });
    return;
  }

  res.json({
    success: true,
    data: {
      remaining_credits: chunk.remaining_credits,
      plan_credits: chunk.price_credits,
      billing_period_start: chunk.sub_current_period_start,
      billing_period_end: chunk.sub_current_period_end,
    },
  });
}
