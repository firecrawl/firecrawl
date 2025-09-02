import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getACUC, getACUCTeam } from "../auth";
import { logger } from "../../lib/logger";
import { RateLimiterMode } from "../../types";

interface TokenUsageResponse {
  success: true;
  data: {
    remainingTokens: number;
    planTokens: number;
    billingPeriodStart: string | null;
    billingPeriodEnd: string | null;
  };
}

export async function tokenUsageController(
  req: RequestWithAuth,
  res: Response<TokenUsageResponse | ErrorResponse>,
): Promise<void> {
  const chunk =
    req.acuc ??
    (await getACUCTeam(
      req.auth.team_id,
      false,
      false,
      RateLimiterMode.Extract,
    ));

  if (!chunk) {
    res.status(404).json({
      success: false,
      error: "Could not find token usage information",
    });
    return;
  }

  res.json({
    success: true,
    data: {
      remainingTokens: chunk.remaining_credits,
      planTokens: chunk.price_credits,
      billingPeriodStart: chunk.sub_current_period_start,
      billingPeriodEnd: chunk.sub_current_period_end,
    },
  });
}
