import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";

interface CreditUsageResponse {
  success: true;
  data: {
    remainingCredits: number;
    planCredits: number;
    billingPeriodStart: string | null;
    billingPeriodEnd: string | null;
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
      remainingCredits: chunk.remaining_credits,
      planCredits: chunk.price_credits,
      billingPeriodStart: chunk.sub_current_period_start,
      billingPeriodEnd: chunk.sub_current_period_end,
    },
  });
}
