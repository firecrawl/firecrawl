import { Response } from "express";
import { ErrorResponse, RequestWithAuth } from "./types";
import { supabase_rr_service } from "../../services/supabase";

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

  const { data, error } = await supabase_rr_service.rpc(
    "get_historical_credit_usage_by_api_key_1",
    {
      v_team_id: req.auth.team_id,
      v_is_extract: false,
    },
    { get: true },
  );

  if (error || !data) {
    throw error ?? new Error("Failed to get historical credit usage");
  }

  let periods = data.map(period => ({
    startDate: period.start_ts,
    endDate: period.end_ts,
    apiKey: period.api_key_name,
    creditsUsed: period.amount,
  }));

  if (!byApiKey) {
    periods = periods.reduce((acc, period) => {
      let preexisting = acc.find(
        p => p.startDate === period.startDate && p.endDate === period.endDate,
      );
      if (preexisting) {
        preexisting.creditsUsed += period.creditsUsed;
      } else {
        let newPeriod = { ...period };
        delete newPeriod.apiKey;
        acc.push(newPeriod);
      }
      return acc;
    }, []);
  }

  periods.sort((a, b) => {
    const aTime = a.startDate ? Date.parse(a.startDate) : NaN;
    const bTime = b.startDate ? Date.parse(b.startDate) : NaN;
    const aNaN = Number.isNaN(aTime);
    const bNaN = Number.isNaN(bTime);
    if (aNaN && bNaN) return 0; // both invalid/null -> keep relative order
    if (aNaN) return 1; // invalid/null goes last
    if (bNaN) return -1; // invalid/null goes last
    return aTime - bTime; // ascending by valid timestamps
  });

  res.json({
    success: true,
    periods,
  });
}
