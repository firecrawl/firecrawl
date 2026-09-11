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
  domainControls: boolean;
  enforceRobots: boolean;
  disableStealthProxy: boolean;
  disableAuthentication: boolean;
  disableSiteHandling: boolean;
  exposeWebdriver: boolean;
  useHeadlessUserAgent: boolean;
  disablePlatformSelection: boolean;
  disableCountrySelection: boolean;
  disableAutomaticReferrer: boolean;
};

const SAFE_MODE_DEFAULTS: ResolvedSafeMode = {
  lockdown: false,
  domainControls: true,
  enforceRobots: true,
  disableStealthProxy: true,
  disableAuthentication: true,
  disableSiteHandling: true,
  exposeWebdriver: true,
  useHeadlessUserAgent: true,
  disablePlatformSelection: true,
  disableCountrySelection: true,
  disableAutomaticReferrer: true,
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
    safeMode.disableStealthProxy &&
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
    domainControls: config?.domainControls ?? SAFE_MODE_DEFAULTS.domainControls,
    enforceRobots: config?.enforceRobots ?? SAFE_MODE_DEFAULTS.enforceRobots,
    disableStealthProxy:
      config?.disableStealthProxy ?? SAFE_MODE_DEFAULTS.disableStealthProxy,
    disableAuthentication:
      config?.disableAuthentication ?? SAFE_MODE_DEFAULTS.disableAuthentication,
    disableSiteHandling:
      config?.disableSiteHandling ?? SAFE_MODE_DEFAULTS.disableSiteHandling,
    exposeWebdriver:
      config?.exposeWebdriver ?? SAFE_MODE_DEFAULTS.exposeWebdriver,
    useHeadlessUserAgent:
      config?.useHeadlessUserAgent ?? SAFE_MODE_DEFAULTS.useHeadlessUserAgent,
    disablePlatformSelection:
      config?.disablePlatformSelection ??
      SAFE_MODE_DEFAULTS.disablePlatformSelection,
    disableCountrySelection:
      config?.disableCountrySelection ??
      SAFE_MODE_DEFAULTS.disableCountrySelection,
    disableAutomaticReferrer:
      config?.disableAutomaticReferrer ??
      SAFE_MODE_DEFAULTS.disableAutomaticReferrer,
  };

  if (url && isSafeModeAllowlisted(url, config?.allowlist)) {
    return {
      allowlisted: true,
      safeMode: {
        ...resolved,
        enforceRobots: false,
        disableStealthProxy: false,
        disableAuthentication: false,
        disableSiteHandling: false,
        exposeWebdriver: false,
        useHeadlessUserAgent: false,
        disablePlatformSelection: false,
        disableCountrySelection: false,
        disableAutomaticReferrer: false,
      },
    };
  }

  return { safeMode: resolved };
}
