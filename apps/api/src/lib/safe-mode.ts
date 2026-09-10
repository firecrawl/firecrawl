import {
  LOCKDOWN_DEFAULT_MAX_AGE_MS,
  TeamFlags,
} from "../controllers/v2/types";
import type { ErrorCodes } from "./error";
import {
  domainMatchesList,
  normalizeDomain,
} from "./threat-protection/verdict";

const SUPPORT_EMAIL = "support@firecrawl.com";

function isSafeModeAllowlisted(
  url: string,
  allowlist: string[] | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  return domainMatchesList(normalizeDomain(url), allowlist);
}

export type SafeModeConfig = NonNullable<
  NonNullable<TeamFlags>["safeModeConfig"]
>;

export type ResolvedSafeMode = {
  lockdown: boolean;
  checkRobots: boolean;
  domainControls: boolean;
  noStealthProxy: boolean;
  blockOnSiteRestriction: boolean;
  blockAuthPaths: boolean;
};

const SAFE_MODE_DEFAULTS: ResolvedSafeMode = {
  lockdown: false,
  checkRobots: true,
  domainControls: true,
  noStealthProxy: true,
  blockOnSiteRestriction: true,
  blockAuthPaths: true,
};

export function getSafeMode(flags: TeamFlags | null | undefined): boolean {
  return flags?.safeMode === true;
}

export function applySafeMode(
  safeMode: ResolvedSafeMode | undefined,
  scrapeOptions: {
    proxy?: "basic" | "stealth" | "enhanced" | "auto";
    lockdown?: boolean;
    maxAge?: number;
  },
): void {
  if (!safeMode) return;

  if (
    !safeMode.lockdown &&
    safeMode.noStealthProxy &&
    scrapeOptions.proxy === "auto"
  ) {
    scrapeOptions.proxy = "basic";
  }

  if (safeMode.lockdown && !scrapeOptions.lockdown) {
    scrapeOptions.lockdown = true;
    if (scrapeOptions.maxAge === undefined) {
      scrapeOptions.maxAge = LOCKDOWN_DEFAULT_MAX_AGE_MS;
    }
  }
}

export function resolveSafeMode(
  flags: TeamFlags | null | undefined,
  requestSafeMode: boolean | undefined,
  url?: string,
): {
  safeMode?: ResolvedSafeMode;
  bypassed?: boolean;
  allowlisted?: boolean;
  error?: string;
  code?: ErrorCodes;
} {
  if (!getSafeMode(flags)) {
    if (requestSafeMode === true) {
      return {
        error: `Safe Mode is not enabled for your organization. Contact ${SUPPORT_EMAIL} to enable this feature.`,
        code: "SAFE_MODE_BLOCKED",
      };
    }
    return {};
  }

  const config = flags?.safeModeConfig;

  if (requestSafeMode === false) {
    if (config?.allowBypassSafeMode !== true) {
      return {
        error:
          "Requests are not allowed to disable Safe Mode for your organization. An organization admin can allow per-request opt-outs from the Safe Mode settings.",
        code: "SAFE_MODE_BLOCKED",
      };
    }
    return { bypassed: true };
  }

  const resolved: ResolvedSafeMode = {
    lockdown: config?.lockdown ?? SAFE_MODE_DEFAULTS.lockdown,
    checkRobots: config?.checkRobots ?? SAFE_MODE_DEFAULTS.checkRobots,
    domainControls: config?.domainControls ?? SAFE_MODE_DEFAULTS.domainControls,
    noStealthProxy: config?.noStealthProxy ?? SAFE_MODE_DEFAULTS.noStealthProxy,
    blockOnSiteRestriction:
      config?.blockOnSiteRestriction ??
      SAFE_MODE_DEFAULTS.blockOnSiteRestriction,
    blockAuthPaths: config?.blockAuthPaths ?? SAFE_MODE_DEFAULTS.blockAuthPaths,
  };

  if (url && isSafeModeAllowlisted(url, config?.allowlist)) {
    return {
      allowlisted: true,
      safeMode: {
        ...resolved,
        checkRobots: false,
        noStealthProxy: false,
        blockOnSiteRestriction: false,
        blockAuthPaths: false,
      },
    };
  }

  return { safeMode: resolved };
}
