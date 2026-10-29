import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import {
  getTeamHistoricalUsage,
  getTeamHistoricalUsageByApiKey,
  getTeamHistoricalUsageByEndpoint,
  HistoricalBin,
} from "../../services/autumn/usage";

interface CreditUsageHistoricalResponse {
  success: true;
  bin?: HistoricalBin;
  periods: {
    startDate: string | null;
    endDate: string | null;
    apiKey?: string;
    endpoint?: string;
    creditsUsed: number;
  }[];
}

export async function creditUsageHistoricalController(
  req: RequestWithAuth,
  res: Response<CreditUsageHistoricalResponse | ErrorResponse>,
): Promise<void> {
  const byApiKey = req.query.byApiKey === "true";
  const byEndpoint = req.query.byEndpoint === "true";
  const requestedBin = req.query.bin;

  if (
    requestedBin !== undefined &&
    requestedBin !== "month" &&
    requestedBin !== "day"
  ) {
    res.status(400).json({
      success: false,
      error: 'bin must be "month" or "day".',
    });
    return;
  }

  if (byApiKey && byEndpoint) {
    res.status(400).json({
      success: false,
      error: "byApiKey and byEndpoint cannot be combined.",
    });
    return;
  }

  const bin: HistoricalBin = requestedBin ?? "month";
  const periods: CreditUsageHistoricalResponse["periods"] = byEndpoint
    ? await getTeamHistoricalUsageByEndpoint(req.auth.team_id, bin)
    : byApiKey
      ? await getTeamHistoricalUsageByApiKey(req.auth.team_id, bin)
      : await getTeamHistoricalUsage(req.auth.team_id, bin);

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

  // `bin` is echoed only when it was asked for, so a caller can tell that this
  // API honoured it and the response without it stays as it was.
  res.json(
    requestedBin === undefined
      ? { success: true, periods }
      : { success: true, bin, periods },
  );
}
