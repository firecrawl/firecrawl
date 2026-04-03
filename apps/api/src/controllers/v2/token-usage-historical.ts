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

  periods.sort((a, b) => {
    const aTime = a.startDate ? Date.parse(a.startDate) : NaN;
    const bTime = b.startDate ? Date.parse(b.startDate) : NaN;
    const aNaN = Number.isNaN(aTime);
    const bNaN = Number.isNaN(bTime);
    if (aNaN && bNaN) return 0;
    if (aNaN) return 1;
    if (bNaN) return -1;
    return aTime - bTime;
  });

  res.json({
    success: true,
    periods,
  });
}
