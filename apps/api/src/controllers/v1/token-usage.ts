import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getTeamBalance, TOKENS_PER_CREDIT } from "../../services/autumn/usage";

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
  const balance = await getTeamBalance(req.auth.team_id);

  if (!balance) {
    res.status(404).json({
      success: false,
      error: "Could not find token usage information",
    });
    return;
  }

  res.json({
    success: true,
    data: {
      remaining_tokens: balance.remaining * TOKENS_PER_CREDIT,
      plan_tokens: balance.planCredits * TOKENS_PER_CREDIT,
      billing_period_start: balance.periodStart,
      billing_period_end: balance.periodEnd,
    },
  });
}
