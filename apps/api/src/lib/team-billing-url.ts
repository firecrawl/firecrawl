import { isValidUuid } from "./owner-id";

/** Public pricing page for callers that are not an authenticated team. */
const GENERIC_PRICING_URL = "https://firecrawl.dev/pricing";

/**
 * Billing settings for one team. The dashboard accepts the team's UUID and
 * redirects to its slug.
 */
export function teamBillingUrl(teamId: string): string {
  return `https://www.firecrawl.dev/app/t/${teamId}/settings?tab=billing`;
}

/** A real team id. Preview, keyless, and the self-hosted bypass id are not. */
export function isAuthenticatedTeamId(
  teamId: string | null | undefined,
): teamId is string {
  return typeof teamId === "string" && isValidUuid(teamId);
}

/**
 * Where an upgrade link should send this caller: that team's billing page, or
 * the public pricing page when there is no team to bill.
 */
export function upgradeUrlForTeam(teamId: string | null | undefined): string {
  return isAuthenticatedTeamId(teamId)
    ? teamBillingUrl(teamId)
    : GENERIC_PRICING_URL;
}
