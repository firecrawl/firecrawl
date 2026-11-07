import { config } from "../config";
import { isValidUuid } from "./owner-id";

/** Public pricing page for callers that are not an authenticated team. */
const GENERIC_PRICING_URL = "https://firecrawl.dev/pricing";

/** Hosted dashboard, used when a deployment leaves the base unset. */
const DEFAULT_DASHBOARD_URL = "https://www.firecrawl.dev";

/**
 * Dashboard origin for this deployment. `FIRECRAWL_DASHBOARD_URL` may carry a
 * trailing slash; the billing path is appended to the stripped base.
 */
function dashboardBase(): string {
  const configured = config.FIRECRAWL_DASHBOARD_URL?.replace(/\/+$/, "");
  return configured || DEFAULT_DASHBOARD_URL;
}

/**
 * Billing settings for one team. The dashboard accepts the team's UUID and
 * redirects to its slug.
 */
export function teamBillingUrl(teamId: string): string {
  return `${dashboardBase()}/app/t/${teamId}/settings?tab=billing`;
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
