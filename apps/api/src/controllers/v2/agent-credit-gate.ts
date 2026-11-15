import {
  autumnService,
  CREDITS_FEATURE_ID,
} from "../../services/autumn/autumn.service";
import { logger } from "../../lib/logger";
import { checkHostedMcpCredits } from "../../services/autumn/hosted-mcp-gate";

export const AGENT_DEFAULT_MAX_CREDITS = 2500;
const AGENT_MIN_CREDITS = 20;
export const CREDIT_CHECK_EXEMPT_TEAM_ID =
  "8c528896-7882-4587-a4b6-768b721b0b53";

export type AgentCreditGate =
  | { allowed: false; balance: number }
  | {
      allowed: true;
      maxCredits: number | undefined;
      stopOnInsufficientCredits: boolean;
      /** A hosted MCP run MCP credits can't cover, billed on the team's credits. */
      onTeamCredits?: true;
    };

/**
 * Decides whether a paid agent run may start and how far it may spend.
 *
 * Autumn's `check` already applies each team's overage setting and spend
 * limit, so the gate learns whether a team can spend past its balance by
 * asking for a little more than that balance:
 *
 * - below the minimum: refused, as before.
 * - unlimited balance: runs as requested, without probing past it.
 * - can spend past the balance (overage): runs as requested.
 * - cannot, but has an auto top-up: runs as requested, as before.
 * - otherwise: `maxCredits` is capped at the balance, and the agent service
 *   is told to stop the run if the balance runs out mid-flight.
 *
 * A hosted MCP run is gated on MCP credits, which its charges are tracked on,
 * or on the team's own credits when MCP credits can't cover it.
 *
 * Fails open: whenever Autumn or firebill can't answer, the run starts as
 * requested, except a hosted run MCP credits refuse, which stays refused when
 * the team check can't answer.
 */
export async function gateAgentCredits({
  teamId,
  orgId,
  apiKeyId,
  requestedMaxCredits,
  hostedMcp = false,
}: {
  teamId: string;
  orgId: string | null | undefined;
  apiKeyId: number | null;
  requestedMaxCredits: number | undefined;
  hostedMcp?: boolean;
}): Promise<AgentCreditGate> {
  const asRequested: AgentCreditGate = {
    allowed: true,
    maxCredits: requestedMaxCredits,
    stopOnInsufficientCredits: false,
  };
  if (!orgId || teamId === CREDIT_CHECK_EXEMPT_TEAM_ID) return asRequested;

  const params = (value: number, source: string) => ({
    teamId,
    orgId,
    value,
    properties: { source, path: "/agent", apiKeyId },
  });
  const hosted = hostedMcp
    ? await checkHostedMcpCredits({
        ...params(AGENT_MIN_CREDITS, "agentCreditGate"),
        featureId: CREDITS_FEATURE_ID,
      })
    : null;
  const feature = hosted ? { featureId: hosted.featureId } : {};
  const onTeamCredits = hosted?.onTeamCredits
    ? { onTeamCredits: true as const }
    : {};
  const runs: AgentCreditGate = { ...asRequested, ...onTeamCredits };
  const check = (value: number, source: string) =>
    autumnService.checkCredits({ ...params(value, source), ...feature });

  const minimum = hosted
    ? hosted.result
    : await check(AGENT_MIN_CREDITS, "agentCreditGate");
  if (minimum === null) return runs;
  if (!minimum.allowed)
    return {
      allowed: false,
      balance: (hosted?.teamRefusal ?? minimum).remaining,
    };

  // An unlimited balance comes back as int64 max. Probing past it overflows
  // the billing service's integer, so treat it as unlimited and skip the probe.
  if (minimum.remaining >= Number.MAX_SAFE_INTEGER) return runs;
  const balance = Math.floor(minimum.remaining);
  if (!Number.isFinite(balance)) return runs;
  const pastBalance = await check(
    Math.max(balance, 0) + AGENT_MIN_CREDITS,
    "agentCreditGate:overage",
  );
  if (pastBalance === null || pastBalance.allowed) return runs;
  if (await autumnService.hasAutoTopUp(orgId)) return runs;
  if (balance <= 0) return { allowed: false, balance };

  const requested = requestedMaxCredits ?? AGENT_DEFAULT_MAX_CREDITS;
  const maxCredits = Math.min(requested, balance);
  if (maxCredits < requested) {
    logger.info("Capping agent maxCredits at the team's balance", {
      teamId,
      requestedMaxCredits,
      maxCredits,
    });
  }
  return {
    allowed: true,
    maxCredits,
    stopOnInsufficientCredits: true,
    ...onTeamCredits,
  };
}
