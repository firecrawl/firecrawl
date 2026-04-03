import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getHistoricalUsage } from "../../services/autumn/usage";

const TOKENS_PER_CREDIT = 15;

interface TokenUsageHistoricalResponse {
  success: true;
  periods: {
    startDate: string | null;
    endDate: string | null;
    apiKey?: string;
    tokensUsed: number;
  }[];
}

export async function tokenUsageHistoricalController(
  req: RequestWithAuth,
  res: Response<TokenUsageHistoricalResponse | ErrorResponse>,
): Promise<void> {
  const byApiKey = req.query.byApiKey === "true";

  const periods = await getHistoricalUsage(req.auth.team_id, byApiKey);

  if (!periods) {
    throw new Error("Failed to get historical token usage");
  }

  res.json({
    success: true,
    periods: periods.map(p => ({
      startDate: p.startDate,
      endDate: p.endDate,
      ...(p.apiKeyName ? { apiKey: p.apiKeyName } : {}),
      tokensUsed: p.creditsUsed * TOKENS_PER_CREDIT,
    })),
  });
}
