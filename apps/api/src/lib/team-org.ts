import { config } from "../config";
import { getACUCTeam } from "../controllers/auth";
import { logger } from "./logger";

// mockPreviewACUC's org. A real org is a uuid, so this cannot collide.
const PREVIEW_ORG_SENTINEL = "preview";

/**
 * The org out of an ACUC the caller already holds — same rule as
 * orgIdForTeam, for the callers that fetch the ACUC for its flags anyway.
 */
export function orgIdFromAcuc(
  acuc: { org_id?: string | null } | null | undefined,
): string | null {
  // Without DB auth every ACUC is mockACUC, whose org is the sentinel
  // "bypass" rather than a customer.
  if (config.USE_DB_AUTHENTICATION !== true) return null;
  const orgId = acuc?.org_id ?? null;
  return orgId === PREVIEW_ORG_SENTINEL ? null : orgId;
}

/** The org a team bills against, from its ACUC. Null when DB auth is off (the
 *  mock ACUC's org is a sentinel, not a customer) or the team has no org. */
export async function orgIdForTeam(teamId: string): Promise<string | null> {
  // Neither mock's ACUC is worth fetching: the DB lookup this replaced threw
  // for both, and every caller reads null as "no billable identity" and fails
  // open, which is the answer that throw produced.
  if (config.USE_DB_AUTHENTICATION !== true) return null;
  if (teamId === "preview" || teamId.startsWith("preview_")) return null;

  try {
    return orgIdFromAcuc(await getACUCTeam(teamId));
  } catch (error) {
    logger.warn("Failed to resolve the team's org from its ACUC", {
      teamId,
      error,
    });
    return null;
  }
}
