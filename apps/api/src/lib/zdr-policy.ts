import type { TeamFlags } from "../controllers/v2/types";
import { getScrapeZDR, getSearchForcedKind, getSearchZDR } from "./zdr-helpers";

/**
 * A team's ZDR modes, resolved once per request from its flags. Scrape and
 * search are independent: one being forced says nothing about the other.
 */
export type ZDRPolicy = Readonly<{
  scrape: ReturnType<typeof getScrapeZDR>;
  search: ReturnType<typeof getSearchZDR>;
  searchForcedKind: ReturnType<typeof getSearchForcedKind>;
}>;

export function resolveZDRPolicy(flags: TeamFlags | undefined): ZDRPolicy {
  return Object.freeze({
    scrape: getScrapeZDR(flags),
    search: getSearchZDR(flags),
    searchForcedKind: getSearchForcedKind(flags),
  });
}

/**
 * Whether a scrape-side request runs under ZDR: always when forced, and only
 * on an explicit opt-in when allowed.
 */
export function isScrapeZDR(
  policy: ZDRPolicy,
  requested: boolean | undefined,
): boolean {
  return (
    policy.scrape === "forced" ||
    (policy.scrape === "allowed" && requested === true)
  );
}
