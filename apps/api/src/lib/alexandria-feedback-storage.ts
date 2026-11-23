import { config } from "../config";
import type { TeamFlags } from "../controllers/v2/types";
import { getSearchForcedKind, isAlexandriaZDRForced } from "./zdr-helpers";

export type AlexandriaFeedbackStorage =
  | "allowed"
  | "opted_out"
  | "zero_data_retention"
  | "preview_team"
  | "unavailable";

/**
 * Whether Alexandria feedback from this team may be stored, and the reason when it may not.
 * Decided from the configuration and the team flags already loaded with the request.
 */
export function alexandriaFeedbackStorage(
  teamId: string,
  flags: (TeamFlags & { searchFeedbackOptOut?: boolean }) | null | undefined,
): AlexandriaFeedbackStorage {
  if (!config.USE_DB_AUTHENTICATION) return "unavailable";
  if (teamId === "preview" || teamId.startsWith("preview_"))
    return "preview_team";
  if (flags?.searchFeedbackOptOut === true) return "opted_out";
  // A session can contain both search and scrape data, so either forced
  // retention policy applies.
  if (
    isAlexandriaZDRForced(flags ?? undefined) ||
    getSearchForcedKind(flags ?? undefined) !== null
  )
    return "zero_data_retention";
  return "allowed";
}
