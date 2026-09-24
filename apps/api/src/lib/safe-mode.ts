import {
  LOCKDOWN_DEFAULT_MAX_AGE_MS,
  TeamFlags,
} from "../controllers/v2/types";
import type { ErrorCodes } from "./error";
import { getSearchForcedKind } from "./zdr-helpers";
import {
  domainMatchesList,
  normalizeDomain,
} from "./threat-protection/verdict";

const SUPPORT_EMAIL = "support@firecrawl.com";

// v0 content endpoints can't enforce Safe Mode's per-request surface, so a
// Safe Mode org is rejected there outright (mirrors the threat-protection v0 gate).
export const SAFE_MODE_V0_UNSUPPORTED_MESSAGE =
  "Safe Mode is enabled for your organization, which is not supported on the v0 API. Please update your code to use the v1 or v2 API.";

// Interactive browser sessions (browser, scrape interact) run arbitrary code
// against live sites and can't enforce Safe Mode's controls, so a Safe Mode
// org is rejected there outright (mirrors the v0 gate).
export const SAFE_MODE_BROWSER_UNSUPPORTED_MESSAGE =
  "Safe Mode is enabled for your organization, which does not support interactive browser sessions.";

// Credential-bearing request headers rejected at request time and stripped at
// the worker under Safe Mode's disableAuthentication (case-insensitive match).
export const SAFE_MODE_CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];

// Actions that can enter credentials / run scripts; rejected at request time
// and stripped at the worker under Safe Mode's disableAuthentication.
export const SAFE_MODE_LOGIN_ACTIONS = ["write", "press", "executeJavascript"];

// Remove Basic Auth embedded in a URL (user:pass@host). Returns the URL
// unchanged if it has no userinfo or can't be parsed.
export function stripUrlUserinfo(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    // leave non-parseable URLs as-is
  }
  return url;
}

// Remove credential-bearing headers. Used by the fire-engine builders so
// inherited scrape options (crawl children, sub-scrapes) can't carry credentials
// even when no request-time gate ran.
export function stripCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([k]) => !SAFE_MODE_CREDENTIAL_HEADERS.includes(k.toLowerCase()),
    ),
  );
}

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

  // Force a non-stealth proxy. Request-time enforcement rejects an *explicit*
  // stealth/enhanced proxy with a 403, but inherited scrape options (crawl
  // children, search/extract sub-scrapes) reach the worker without that gate —
  // downgrade any escalated tier to basic here so the worker never uses stealth.
  if (
    !safeMode.lockdown &&
    safeMode.disableStealthProxy &&
    (scrapeOptions.proxy === "auto" ||
      scrapeOptions.proxy === "stealth" ||
      scrapeOptions.proxy === "enhanced")
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

// Lockdown is cache-only and implies zero data retention. Resolved from the
// org flags alone (lockdown never depends on the request param) and dropped
// only when a per-request bypass is actually HONORED — a rejected/invalid
// safeMode:false must still record as ZDR for a lockdown org. Safe to call
// before schema validation (a non-boolean request value is treated as unset).
export function isLockdownZeroDataRetention(
  flags: TeamFlags | null | undefined,
  requestSafeMode: boolean | undefined,
): boolean {
  if (resolveSafeMode(flags, requestSafeMode).bypassed === true) return false;
  return resolveSafeMode(flags, undefined).safeMode?.lockdown === true;
}

// Search's forced enterprise kind, with Safe Mode lockdown folded in: lockdown
// forces the "zdr" kind exactly like the searchZDR flag does (zero-retention
// upstream routing, the ZDR credit rate, ZDR recording). The flag still wins
// when set (it may force "anon" instead).
export function getEffectiveSearchForcedKind(
  flags: TeamFlags | null | undefined,
  requestSafeMode: boolean | undefined,
): ReturnType<typeof getSearchForcedKind> {
  return (
    getSearchForcedKind(flags ?? undefined) ??
    (isLockdownZeroDataRetention(flags, requestSafeMode) ? "zdr" : null)
  );
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
