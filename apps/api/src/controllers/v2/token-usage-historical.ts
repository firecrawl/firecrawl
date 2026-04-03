import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import {
  getTeamHistoricalUsage,
  toTokenPeriods,
} from "../../services/autumn/usage";

interface TokenUsageHistoricalResponse {
  success: true;
  periods: {
    startDate: string | null;
    endDate: string | null;
    tokensUsed: number;
  }[];
}

export async function tokenUsageHistoricalController(
  req: RequestWithAuth,
  res: Response<TokenUsageHistoricalResponse | ErrorResponse>,
): Promise<void> {
  const creditPeriods = await getTeamHistoricalUsage(req.auth.team_id);
  const periods = toTokenPeriods(creditPeriods);

  periods.sort(
    (a, b) =>
      new Date(a.startDate ?? 0).getTime() -
      new Date(b.startDate ?? 0).getTime(),
  );

  res.json({
    success: true,
    periods,
  });
}
