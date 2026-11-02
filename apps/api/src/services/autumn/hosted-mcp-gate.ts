import { autumnService } from "./autumn.service";
import type { TrackCreditsParams } from "./types";

type CheckResult = Awaited<ReturnType<typeof autumnService.checkCredits>>;

/**
 * Checks a hosted MCP charge on MCP credits, the balance it is billed to, and
 * when they refuse it, on the team's own `featureId` balance, where team-scoped
 * grants such as coupons live out of reach of the MCP credits check.
 * `onTeamCredits` means the charge must then be billed like an API-key call.
 * A team check that can't answer leaves the MCP refusal standing; one that
 * refuses too comes back as `teamRefusal`.
 */
export async function checkHostedMcpCredits(
  params: TrackCreditsParams & { featureId: string },
): Promise<{
  result: CheckResult;
  featureId: string;
  onTeamCredits: boolean;
  teamRefusal?: NonNullable<CheckResult>;
}> {
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
  if (onTeam === null) return onMcpCredits;
  return onTeam.allowed
    ? { result: onTeam, featureId: params.featureId, onTeamCredits: true }
    : { ...onMcpCredits, teamRefusal: onTeam };
}
