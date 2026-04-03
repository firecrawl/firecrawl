import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getHistoricalUsage } from "../../services/autumn/usage";

interface CreditUsageHistoricalResponse {
  success: true;
  periods: {
    startDate: string | null;
    endDate: string | null;
    apiKey?: string;
    creditsUsed: number;
  }[];
}

export async function creditUsageHistoricalController(
  req: RequestWithAuth,
  res: Response<CreditUsageHistoricalResponse | ErrorResponse>,
): Promise<void> {
  const byApiKey = req.query.byApiKey === "true";

  const periods = await getHistoricalUsage(req.auth.team_id, byApiKey);

  if (!periods) {
    throw new Error("Failed to get historical credit usage");
  }

  res.json({
    success: true,
    periods: periods.map(p => ({
      startDate: p.startDate,
      endDate: p.endDate,
      ...(p.apiKeyName ? { apiKey: p.apiKeyName } : {}),
      creditsUsed: p.creditsUsed,
    })),
  });
}
