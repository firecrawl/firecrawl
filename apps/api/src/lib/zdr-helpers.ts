import type { TeamFlags } from "../controllers/v2/types";

type OrgFlagMode = "disabled" | "allowed" | "forced";

type ScrapeZDRMode = OrgFlagMode;
type SearchZDRMode = "disabled" | "allowed" | "forced-zdr" | "forced-anon";
type SearchForcedKind = "zdr" | "anon";

/**
 * Resolves the effective ZDR mode for scrape endpoints from team flags.
 *
 * Handles both the new enum format (scrapeZDR) and the legacy boolean
 * format (forceZDR/allowZDR) for backward compatibility during the
 * cache migration window.
 */
export function getScrapeZDR(flags: TeamFlags | undefined): ScrapeZDRMode {
  if (flags?.scrapeZDR === "forced" || flags?.forceZDR) return "forced";
  if (flags?.scrapeZDR === "allowed" || flags?.allowZDR) return "allowed";
  return "disabled";
}

/**
 * Resolves the effective ZDR mode for search endpoints from team flags.
 *
 * Search has two distinct forced modes that differ in pricing and upstream
 * behavior:
 *  - "forced-zdr"  — ZDR enterprise mode (10 credits per 10 results)
 *  - "forced-anon" — anonymous routing (default credit rate, no attribution)
 *
 * The bare "forced" value is treated as a deprecated alias for "forced-zdr"
 * for existing orgs that haven't been migrated to the explicit variant.
 *
 * Handles both the new enum format (searchZDR) and the legacy boolean
 * format (forceZDR/allowZDR) for backward compatibility during the
 * cache migration window.
 */
export function getSearchZDR(flags: TeamFlags | undefined): SearchZDRMode {
  if (
    flags?.searchZDR === "forced-zdr" ||
    flags?.searchZDR === "forced" ||
    flags?.forceZDR
  ) {
    return "forced-zdr";
  }
  if (flags?.searchZDR === "forced-anon") return "forced-anon";
  if (flags?.searchZDR === "allowed" || flags?.allowZDR) return "allowed";
  return "disabled";
}

/**
 * Returns which enterprise mode the team is forced into, or null if not forced.
 */
export function getSearchForcedKind(
  flags: TeamFlags | undefined,
): SearchForcedKind | null {
  const mode = getSearchZDR(flags);
  if (mode === "forced-zdr") return "zdr";
  if (mode === "forced-anon") return "anon";
  return null;
}

/**
 * Resolves the effective ignoreRobots mode from team flags.
 */
export function getIgnoreRobots(flags: TeamFlags | undefined): OrgFlagMode {
  if (flags?.ignoreRobots === "forced") return "forced";
  if (flags?.ignoreRobots === "allowed") return "allowed";
  return "disabled";
}

/**
 * Resolves the effective threat protection mode from team flags.
 */
export function getThreatProtection(flags: TeamFlags | undefined): OrgFlagMode {
  if (flags?.threatProtection === "forced") return "forced";
  if (flags?.threatProtection === "allowed") return "allowed";
  return "disabled";
}

/**
 * Resolves the effective customRobotsAgent mode from team flags.
 * Only supports "disabled" (default) and "allowed" — no "forced" mode.
 */
export function getCustomRobotsAgent(
  flags: TeamFlags | undefined,
): "disabled" | "allowed" {
  if (flags?.customRobotsAgent === "allowed") return "allowed";
  return "disabled";
}

/**
 * Whether the org's DPA (or partner amendment) restricts how its data may be
 * handled. Absent or any non-`true` value reads as unrestricted.
 */
export function isDpaRestricted(flags: TeamFlags | undefined): boolean {
  return flags?.dpaRestricted === true;
}
