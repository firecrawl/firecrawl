import { TeamFlags } from "../controllers/v2/types";
import type { ErrorCodes } from "./error";
import type { ResolvedSafeMode } from "./safe-mode";
import {
  getScrapeZDR,
  getIgnoreRobots,
  getCustomRobotsAgent,
  getThreatProtection,
} from "./zdr-helpers";
import {
  THREAT_PROTECTION_CANNOT_DISABLE_MESSAGE,
  THREAT_PROTECTION_NOT_ENABLED_MESSAGE,
  THREAT_PROTECTION_OVERRIDES_DISABLED_MESSAGE,
} from "./threat-protection/request";

type LocationOptions = { country?: string };
type ThreatProtectionOption = { mode?: string };

interface APIRequest {
  zeroDataRetention?: boolean;
  location?: LocationOptions;
  scrapeOptions?: {
    location?: LocationOptions;
    threatProtection?: ThreatProtectionOption;
  };
  crawlerOptions?: {
    ignoreRobotsTxt?: boolean;
    robotsUserAgent?: string;
  };
  // Per-request threat protection policy override (field-level override of
  // the org config). Presence of any value gates on the team flag.
  threatProtection?: ThreatProtectionOption;
  proxy?: string;
  profile?: unknown;
  actions?: { type: string }[];
  headers?: Record<string, string>;
}

interface PermissionOptions {
  /**
   * Org-level threat protection config (or the relevant slice of it), if
   * already loaded. When the org disables request overrides, any per-request
   * threatProtection option is rejected.
   */
  threatProtectionOrgConfig?: { allowRequestOverrides: boolean } | null;
  safeMode?: ResolvedSafeMode | null;
}

const SAFE_MODE_CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];
const SAFE_MODE_LOGIN_ACTIONS = ["write", "press", "executeJavascript"];

const SUPPORT_EMAIL = "support@firecrawl.com";

export function checkPermissions(
  request: APIRequest,
  flags?: TeamFlags,
  options?: PermissionOptions,
): { error?: string; code?: ErrorCodes } {
  // zdr perms — scrapeZDR must be 'allowed' or 'forced' for request-scoped ZDR
  const scrapeMode = getScrapeZDR(flags);
  if (
    request.zeroDataRetention &&
    scrapeMode !== "allowed" &&
    scrapeMode !== "forced"
  ) {
    return {
      error: `Zero Data Retention (ZDR) is not enabled for your team. Contact ${SUPPORT_EMAIL} to enable this feature.`,
    };
  }

  // robots perms — ignoreRobots must be 'allowed' or 'forced'
  const robotsMode = getIgnoreRobots(flags);
  if (
    request.crawlerOptions?.ignoreRobotsTxt &&
    robotsMode !== "allowed" &&
    robotsMode !== "forced"
  ) {
    return {
      error: `The ignoreRobotsTxt parameter is an enterprise feature. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
    };
  }
  // customRobotsAgent perms — separate flag for robotsUserAgent
  const customAgentMode = getCustomRobotsAgent(flags);
  if (
    request.crawlerOptions?.robotsUserAgent &&
    customAgentMode !== "allowed"
  ) {
    return {
      error: `The robotsUserAgent parameter is an enterprise feature. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
    };
  }

  // threat protection perms — the flag must be 'allowed' or 'forced' for any
  // per-request threatProtection option, the org must not have locked down
  // request-level overrides, and a 'forced' team may never disable the
  // feature per-request.
  const threatProtectionOption =
    request.threatProtection ?? request.scrapeOptions?.threatProtection;
  if (threatProtectionOption !== undefined) {
    const effectiveThreatMode =
      options?.safeMode?.domainControls === true
        ? "forced"
        : getThreatProtection(flags);
    if (effectiveThreatMode !== "allowed" && effectiveThreatMode !== "forced") {
      return { error: THREAT_PROTECTION_NOT_ENABLED_MESSAGE };
    }
    if (options?.threatProtectionOrgConfig?.allowRequestOverrides === false) {
      return { error: THREAT_PROTECTION_OVERRIDES_DISABLED_MESSAGE };
    }
    if (
      effectiveThreatMode === "forced" &&
      threatProtectionOption.mode === "off"
    ) {
      return { error: THREAT_PROTECTION_CANNOT_DISABLE_MESSAGE };
    }
  }

  const safeMode = options?.safeMode;
  if (safeMode && !safeMode.lockdown) {
    if (
      safeMode.noStealthProxy &&
      (request.proxy === "stealth" || request.proxy === "enhanced")
    ) {
      return {
        error:
          'Safe Mode: stealth and enhanced proxies are not allowed for your organization. Remove the proxy option or use proxy: "basic".',
        code: "SAFE_MODE_BLOCKED",
      };
    }
    if (safeMode.checkRobots && request.crawlerOptions?.ignoreRobotsTxt) {
      return {
        error:
          "Safe Mode: robots.txt is always honored for your organization; the ignoreRobotsTxt parameter is not allowed.",
        code: "SAFE_MODE_BLOCKED",
      };
    }
    if (safeMode.blockAuthPaths) {
      if (request.profile !== undefined) {
        return {
          error:
            "Safe Mode: browser profiles are not allowed for your organization (nothing behind a login).",
          code: "SAFE_MODE_BLOCKED",
        };
      }
      const loginAction = (request.actions ?? []).find(a =>
        SAFE_MODE_LOGIN_ACTIONS.includes(a.type),
      );
      if (loginAction) {
        return {
          error: `Safe Mode: the ${loginAction.type} action is not allowed for your organization (nothing behind a login).`,
          code: "SAFE_MODE_BLOCKED",
        };
      }
      const credentialHeader = Object.keys(request.headers ?? {}).find(h =>
        SAFE_MODE_CREDENTIAL_HEADERS.includes(h.toLowerCase()),
      );
      if (credentialHeader) {
        return {
          error: `Safe Mode: the ${credentialHeader} header is not allowed for your organization (nothing behind a login).`,
          code: "SAFE_MODE_BLOCKED",
        };
      }
    }
  }

  // ip whitelist perms
  const needsWhitelist =
    request.location?.country === "us-whitelist" ||
    request.scrapeOptions?.location?.country === "us-whitelist";

  if (needsWhitelist && !flags?.ipWhitelist) {
    return {
      error: `Static IP addresses are not enabled for your team. Contact ${SUPPORT_EMAIL} to get a dedicated set of IP addresses you can whitelist.`,
    };
  }

  return {};
}
