import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";

interface TokenUsageResponse {
  success: true;
  data: {
    remaining_tokens: number;
    plan_tokens: number;
    billing_period_start: string | null;
    billing_period_end: string | null;
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
      remaining_tokens: chunk.remaining_credits,
      plan_tokens: chunk.price_credits,
      billing_period_start: chunk.sub_current_period_start,
      billing_period_end: chunk.sub_current_period_end,
    },
  });
}
