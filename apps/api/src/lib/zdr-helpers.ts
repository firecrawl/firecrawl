import type { TeamFlags } from "../controllers/v2/types";

type ZDRMode = "disabled" | "allowed" | "forced";

/**
 * Resolves the effective ZDR mode for scrape endpoints from team flags.
 */
export function getScrapeZDR(flags: TeamFlags | undefined): ZDRMode {
  if (flags?.scrapeZDR === "forced") return "forced";
  if (flags?.scrapeZDR === "allowed") return "allowed";
  return "disabled";
}

/**
 * Resolves the effective ZDR mode for search endpoints from team flags.
 */
export function getSearchZDR(flags: TeamFlags | undefined): ZDRMode {
  if (flags?.searchZDR === "forced") return "forced";
  if (flags?.searchZDR === "allowed") return "allowed";
  return "disabled";
}
