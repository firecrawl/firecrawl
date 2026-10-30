import { autumnService } from "../../services/autumn/autumn.service";
import { logger } from "../../lib/logger";

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
 * A hosted MCP run counts the team's MCP credits on top of its balance, since
 * its charges spend them first: they can admit a run the balance alone would
 * refuse, and raise the cap, but never lower anything the balance allows.
 *
 * Fails open: whenever Autumn or firebill can't answer, the run starts as
 * requested.
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

  const check = (value: number, source: string) =>
    autumnService.checkCredits({
      teamId,
      orgId,
      value,
      properties: { source, path: "/agent", apiKeyId },
    });

  const requested = requestedMaxCredits ?? AGENT_DEFAULT_MAX_CREDITS;
  const mcpCredits = () =>
    hostedMcp && requested > 0
      ? autumnService.mcpCreditsAvailable({
          teamId,
          orgId,
          // Never below the minimum, which a smaller cap still has to clear.
          value: Math.max(requested, AGENT_MIN_CREDITS),
          properties: {
            source: "agentCreditGate:mcp",
            path: "/agent",
            apiKeyId,
          },
        })
      : Promise.resolve(0);
  // Capped at what the balance and the MCP credits can pay together, and
  // stopped mid-run once they can't cover it.
  const capped = (balance: number, mcp: number): AgentCreditGate => {
    const maxCredits = Math.min(requested, Math.max(balance, 0) + mcp);
    if (maxCredits < requested) {
      logger.info("Capping agent maxCredits at the team's balance", {
        teamId,
        requestedMaxCredits,
        maxCredits,
        mcpCredits: mcp,
      });
    }
    return { allowed: true, maxCredits, stopOnInsufficientCredits: true };
  };

  const minimum = await check(AGENT_MIN_CREDITS, "agentCreditGate");
  if (minimum === null) return asRequested;
  if (!minimum.allowed) {
    // What is left of the balance counts only when the balance is why the
    // check refused; a spend limit refuses with plenty left, and the MCP
    // credits alone may still pay for the run.
    const fromBalance =
      minimum.remaining < AGENT_MIN_CREDITS
        ? Math.max(Math.floor(minimum.remaining), 0)
        : 0;
    const mcp = await mcpCredits();
    if (fromBalance + mcp < AGENT_MIN_CREDITS)
      return { allowed: false, balance: minimum.remaining };
    return capped(fromBalance, mcp);
  }

  // An unlimited balance comes back as int64 max. Probing past it overflows
  // the billing service's integer, so treat it as unlimited and skip the probe.
  if (minimum.remaining >= Number.MAX_SAFE_INTEGER) return asRequested;
  const balance = Math.floor(minimum.remaining);
  if (!Number.isFinite(balance)) return asRequested;
  const pastBalance = await check(
    Math.max(balance, 0) + AGENT_MIN_CREDITS,
    "agentCreditGate:overage",
  );
  if (pastBalance === null || pastBalance.allowed) return asRequested;
  if (await autumnService.hasAutoTopUp(orgId)) return asRequested;
  const mcp = await mcpCredits();
  if (balance <= 0 && mcp <= 0) return { allowed: false, balance };
  return capped(balance, mcp);
}
