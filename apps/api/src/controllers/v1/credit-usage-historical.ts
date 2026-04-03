import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import {
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
} from "../../services/autumn/usage";

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

  const periods: CreditUsageHistoricalResponse["periods"] = byApiKey
    ? await getTeamHistoricalUsageByApiKey(req.auth.team_id)
    : await getTeamHistoricalUsage(req.auth.team_id);

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
