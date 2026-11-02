import { autumnService } from "./autumn.service";
import type { TrackCreditsParams } from "./types";

type CheckResult = Awaited<ReturnType<typeof autumnService.checkCredits>>;

/**
 * Checks a hosted MCP charge on MCP credits, the balance it is billed to, and
 * when they refuse it, on the team's own `featureId` balance, where team-scoped
 * grants such as coupons live out of reach of the MCP credits check.
 * `onTeamCredits` means the charge must then be billed like an API-key call.
 * A null `result` means billing was unavailable for whichever check decided.
 */
export async function checkHostedMcpCredits(
  params: TrackCreditsParams & { featureId: string },
): Promise<{ result: CheckResult; featureId: string; onTeamCredits: boolean }> {
  const mcpFeatureId = await autumnService.hostedMcpFeatureId(
    params.teamId,
    params.featureId,
  );
  const onMcp = await autumnService.checkCredits({
    ...params,
    featureId: mcpFeatureId,
  });
  const onMcpCredits = {
    result: onMcp,
    featureId: mcpFeatureId,
    onTeamCredits: false,
  };
  if (mcpFeatureId === params.featureId || onMcp === null || onMcp.allowed)
    return onMcpCredits;

  const onTeam = await autumnService.checkCredits(params);
  if (onTeam === null) return { ...onMcpCredits, result: null };
  return onTeam.allowed
    ? { result: onTeam, featureId: params.featureId, onTeamCredits: true }
    : onMcpCredits;
}
