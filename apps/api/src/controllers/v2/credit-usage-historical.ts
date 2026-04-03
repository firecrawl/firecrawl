import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { getTeamHistoricalUsage } from "../../services/autumn/usage";

interface CreditUsageHistoricalResponse {
  success: true;
  periods: {
    startDate: string | null;
    endDate: string | null;
    creditsUsed: number;
  }[];
}

export async function creditUsageHistoricalController(
  req: RequestWithAuth,
  res: Response<CreditUsageHistoricalResponse | ErrorResponse>,
): Promise<void> {
  const periods = await getTeamHistoricalUsage(req.auth.team_id);

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
