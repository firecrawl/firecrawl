import type { Logger } from "winston";
import type { ExchangeSearchResult } from "../../lib/entities";
import { billTeam } from "../billing/credit_billing";
import type { BillingMetadata } from "../billing/types";

export function billExchangeResults(input: {
  apiKeyId: number | null;
  billing: BillingMetadata;
  logger: Logger;
  results: ExchangeSearchResult[];
  teamId: string;
}): number {
  const billableCredits = input.results.reduce(
    (total, result) => total + (result.error ? 0 : (result.creditsCost ?? 0)),
    0,
  );
  if (billableCredits <= 0) return 0;

  billTeam(input.teamId, billableCredits, input.apiKeyId, input.billing).catch(
    error => {
      input.logger.error("Failed to bill Exchange invocation", {
        error,
        credits: billableCredits,
      });
    },
  );
  return billableCredits;
}
