import { logger as rootLogger } from "../../lib/logger";
import { recordRequestCredits } from "../../lib/request-credits-store";
import type { BillingMetadata } from "./types";

/**
 * The request id a hosted MCP agent run tallies its calls' MCP credits under,
 * next to the run's own call-credits tally (see agentController).
 */
export function agentMcpCreditsRequestId(agentRequestId: string): string {
  return `${agentRequestId}:mcp`;
}

/**
 * Adds the MCP credits part of an agent call's charge to its run's tally.
 * `chargeKey` names the charge, so a retried charge counts once. Nothing is
 * recorded for a run that started no tally (any run not from the hosted MCP).
 */
export async function tallyAgentMcpCredits(
  billing: BillingMetadata,
  chargeKey: string,
  mcpCredits: number,
): Promise<void> {
  if (!billing.agentRequestId || !(mcpCredits > 0)) return;
  await recordRequestCredits({
    requestId: agentMcpCreditsRequestId(billing.agentRequestId),
    jobId: chargeKey,
    credits: mcpCredits,
  }).catch(error =>
    rootLogger.error("Failed to tally an agent call's MCP credits", {
      agentRequestId: billing.agentRequestId,
      chargeKey,
      mcpCredits,
      error,
    }),
  );
}
