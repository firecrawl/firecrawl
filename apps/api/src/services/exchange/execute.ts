import { randomUUID } from "node:crypto";
import type { Logger } from "winston";
import type { ExchangeSearchResult } from "../../lib/entities";
import type { BillingMetadata } from "../billing/types";
import { billExchangeResults } from "./billing";
import {
  invokeExchangeCalls,
  quoteExchangeCalls,
  type ExchangeCall,
  type ResolvedExchangeCall,
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

  // A caller that does not care about exactly-once gets a fresh key per call, so
  // a repeated request re-executes exactly like a repeated /v2/search does.
  const calls: ResolvedExchangeCall[] = input.calls.map(call => ({
    ...call,
    idempotencyKey: call.idempotencyKey ?? randomUUID(),
  }));

  const policyError = validateExecutionPolicy({ ...input, calls });
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
  const keys = new Set(input.calls.map(call => call.idempotencyKey));
  if (keys.size !== input.calls.length) {
    return {
      code: "exchange_duplicate_idempotency_key",
      message:
        "Each Exchange call in a batch must use a distinct idempotency key.",
      retryable: false,
      status: 400,
    };
  }
  return null;
}
