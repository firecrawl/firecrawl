import type { TeamFlags } from "../controllers/v2/types";
import { isLockdownZeroDataRetention } from "./safe-mode";
import {
  getAlexandriaZDR,
  getScrapeZDR,
  getSearchForcedKind,
  getSearchZDR,
} from "./zdr-helpers";

/**
 * A team's ZDR modes, resolved once per request from its flags. Scrape and
 * search are independent: one being forced says nothing about the other.
 * Safe Mode lockdown implies ZDR for both unless the request bypasses it.
 * Alexandria follows its own flag and is forced whenever the scrape flag is;
 * Safe Mode lockdown does not reach it, matching getAlexandriaZDR.
 */
export type ZDRPolicy = Readonly<{
  scrape: ReturnType<typeof getScrapeZDR>;
  search: ReturnType<typeof getSearchZDR>;
  searchForcedKind: ReturnType<typeof getSearchForcedKind>;
  alexandria: ReturnType<typeof getAlexandriaZDR>;
  lockdown: boolean;
  lockdownBypassable: boolean;
}>;

type ZDRRequest = { zeroDataRetention?: boolean; safeMode?: boolean };

export function resolveZDRPolicy(flags: TeamFlags | undefined): ZDRPolicy {
  const lockdown = isLockdownZeroDataRetention(flags, undefined);
  return Object.freeze({
    scrape: getScrapeZDR(flags),
    search: getSearchZDR(flags),
    searchForcedKind: getSearchForcedKind(flags),
    alexandria: getAlexandriaZDR(flags),
    lockdown,
    lockdownBypassable: lockdown && !isLockdownZeroDataRetention(flags, false),
  });
}

function lockdownApplies(policy: ZDRPolicy, request: ZDRRequest): boolean {
  return (
    policy.lockdown &&
    !(request.safeMode === false && policy.lockdownBypassable)
  );
}

/**
 * Whether a scrape-side request runs under ZDR: when forced or under
 * lockdown, and on an explicit opt-in when allowed.
 */
export function isScrapeZDR(policy: ZDRPolicy, request: ZDRRequest): boolean {
  return (
    policy.scrape === "forced" ||
    (policy.scrape === "allowed" && request.zeroDataRetention === true) ||
    lockdownApplies(policy, request)
  );
}

/** The search kind a request is forced into, with lockdown forcing "zdr". */
export function getPolicySearchForcedKind(
  policy: ZDRPolicy,
  request: ZDRRequest,
): ZDRPolicy["searchForcedKind"] {
  return (
    policy.searchForcedKind ?? (lockdownApplies(policy, request) ? "zdr" : null)
  );
}
