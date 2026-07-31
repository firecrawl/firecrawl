import type { Logger } from "winston";
import type { ExchangeSearchResult } from "../../lib/entities";
import type { BillingMetadata } from "../billing/types";
import { billExchangeResults } from "./billing";
import {
  invokeExchangeCalls,
  quoteExchangeCalls,
  type ExchangeCall,
} from "./invoke";

interface ExchangeExecutionInput {
  agentIndexOnly: boolean;
  apiKeyId: number | null;
  billing: BillingMetadata;
  calls: ExchangeCall[];
  logger: Logger;
  shouldBill: boolean;
  teamId: string;
  timeoutMs: number;
  zeroDataRetention: boolean;
}

interface ExchangeExecutionResult {
  billedCredits: number;
  results: ExchangeSearchResult[];
}

export async function executeExchangeCalls(
  input: ExchangeExecutionInput,
): Promise<ExchangeExecutionResult> {
  if (input.calls.length === 0) {
    return { billedCredits: 0, results: [] };
  }

  const calls = input.calls;

  const policyError = validateExecutionPolicy(input);
  if (policyError) {
    return {
      billedCredits: 0,
      results: calls.map(call => ({
        provider: call.provider,
        capability: call.capability,
        error: policyError,
      })),
    };
  }

  const quotes = await quoteExchangeCalls(calls);
  const results = await invokeExchangeCalls({
    calls,
    quotes,
    teamId: input.teamId,
    timeoutMs: input.timeoutMs,
    zeroDataRetention: input.zeroDataRetention,
  });

  const billedCredits = input.shouldBill
    ? billExchangeResults({
        apiKeyId: input.apiKeyId,
        billing: input.billing,
        logger: input.logger,
        results,
        teamId: input.teamId,
      })
    : 0;

  return { billedCredits, results };
}

function validateExecutionPolicy(
  input: ExchangeExecutionInput,
): ExchangeSearchResult["error"] | null {
  if (
    input.teamId === "preview" ||
    input.teamId.startsWith("preview_") ||
    input.teamId.startsWith("preview_keyless_")
  ) {
    return {
      code: "exchange_authentication_required",
      message: "Exchange requires a verified Firecrawl API key.",
      retryable: false,
      status: 401,
    };
  }
  if (input.agentIndexOnly) {
    return {
      code: "exchange_sponsor_verification_required",
      message:
        "Exchange is unavailable until this agent API key is verified by its sponsor.",
      retryable: false,
      status: 403,
    };
  }
  if (!input.shouldBill) {
    return {
      code: "exchange_billing_required",
      message: "Exchange cannot be invoked with billing disabled.",
      retryable: false,
      status: 403,
    };
  }
  return null;
}
