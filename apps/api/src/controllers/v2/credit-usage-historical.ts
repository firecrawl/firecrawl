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
