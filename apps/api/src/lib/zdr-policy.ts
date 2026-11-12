import type { TeamFlags } from "../controllers/v2/types";
import { getScrapeZDR, getSearchForcedKind, getSearchZDR } from "./zdr-helpers";

/**
 * A request's zero data retention policy, resolved once from the team flags.
 * Scrape and search are independent: search surfaces follow `search` only.
 */
export type ZdrPolicy = Readonly<{
  scrape: ReturnType<typeof getScrapeZDR>;
  search: ReturnType<typeof getSearchZDR>;
  searchForcedKind: ReturnType<typeof getSearchForcedKind>;
  /**
   * Whether scrape-side work runs as ZDR: the team is forced, or the request
   * opted in. The opt-in entitlement is still checked by checkPermissions.
   */
  scrapeZDR: (requestOptIn: unknown) => boolean;
}>;

export function resolveZdrPolicy(flags: TeamFlags | undefined): ZdrPolicy {
  const scrape = getScrapeZDR(flags);
  return Object.freeze({
    scrape,
    search: getSearchZDR(flags),
    searchForcedKind: getSearchForcedKind(flags),
    scrapeZDR: (requestOptIn: unknown) =>
      scrape === "forced" || requestOptIn === true,
  });
}

/**
 * The policy authMiddleware attached to the request. Requests that never went
 * through authMiddleware resolve it from the same flags.
 */
export function getZdrPolicy(req: {
  zdrPolicy?: ZdrPolicy;
  acuc?: { flags?: TeamFlags } | null;
}): ZdrPolicy {
  return req.zdrPolicy ?? resolveZdrPolicy(req.acuc?.flags ?? undefined);
}
