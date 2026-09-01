import {
  LOCKDOWN_DEFAULT_MAX_AGE_MS,
  TeamFlags,
} from "../controllers/v2/types";
import type { ErrorCodes } from "./error";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  type ThreatProtectionPolicy,
} from "./threat-protection/types";

const SUPPORT_EMAIL = "support@firecrawl.com";

// Org-configurable sub-controls, stored as a partial under
// organizations.flags.safeModeConfig. Absent keys mean the default.
export type SafeModeConfig = NonNullable<
  NonNullable<TeamFlags>["safeModeConfig"]
>;

// The fully-resolved bundle that rides job payloads. All live-scrape
// enforcement reads this shape, never the raw flags.
export type ResolvedSafeMode = {
  lockdown: boolean;
  checkRobots: boolean;
  domainControls: boolean;
  proxyLimit: "basic" | "stealth";
  noCaptchaBypass: boolean;
  blockAuthPaths: boolean;
};

const SAFE_MODE_DEFAULTS: ResolvedSafeMode = {
  // Strictest setting everywhere, except lockdown: the default posture is
  // compliant live scraping, not cache-only.
  lockdown: false,
  checkRobots: true,
  domainControls: true,
  proxyLimit: "basic",
  noCaptchaBypass: true,
  blockAuthPaths: true,
};

export function getSafeMode(flags: TeamFlags | null | undefined): boolean {
  return flags?.safeMode === true;
}

/**
 * Pins `proxy: "auto"` to `"basic"` under a basic proxy limit, so the
 * stealth-escalation paths (all gated on `proxy === "auto"`) never fire and
 * the reported proxyUsed stays truthful. Explicit stealth/enhanced requests
 * are rejected in checkPermissions instead. Mutates the passed options.
 */
export function applySafeModeProxyLimit(
  safeMode: ResolvedSafeMode | undefined,
  scrapeOptions: { proxy?: "basic" | "stealth" | "enhanced" | "auto" },
): void {
  if (
    safeMode &&
    !safeMode.lockdown &&
    safeMode.proxyLimit === "basic" &&
    scrapeOptions.proxy === "auto"
  ) {
    scrapeOptions.proxy = "basic";
  }
}

/**
 * Applies effective lockdown to parsed scrape options: forces the lockdown
 * flag and mirrors the parse-time maxAge auto-set (2 years) so the index
 * lookup can actually hit — the schema transform only runs for request-sent
 * lockdown, not for org-forced lockdown. Mutates the passed options.
 */
export function applySafeModeLockdown(
  safeMode: ResolvedSafeMode | undefined,
  scrapeOptions: { lockdown?: boolean; maxAge?: number },
): void {
  if (!safeMode?.lockdown || scrapeOptions.lockdown) return;
  scrapeOptions.lockdown = true;
  if (scrapeOptions.maxAge === undefined) {
    scrapeOptions.maxAge = LOCKDOWN_DEFAULT_MAX_AGE_MS;
  }
}

/**
 * Guarantees an enforcing threat-protection policy under domainControls.
 * The resolver nulls the policy when the effective mode is "off" (including
 * unconfigured orgs); Safe Mode still wants real protection there, so the
 * org's saved policy (or the policy defaults) is forced into "normal" mode.
 * A policy that already enforces is returned untouched.
 */
export function forceSafeModeThreatProtection(
  resolvedPolicy: ThreatProtectionPolicy | null,
  orgPolicy: ThreatProtectionPolicy | null | undefined,
): ThreatProtectionPolicy {
  if (resolvedPolicy) return resolvedPolicy;
  const base = orgPolicy ?? {
    mode: "off" as const,
    ...THREAT_PROTECTION_POLICY_DEFAULTS,
  };
  return { ...base, mode: base.mode === "off" ? "normal" : base.mode };
}

/**
 * Team flags as threat-protection resolution should see them under Safe
 * Mode: domainControls forces the TP flag to "forced", which makes the
 * existing machinery reject per-request `mode: "off"` overrides and blocks
 * v0-style disablement without any new rules.
 */
export function safeModeEffectiveFlags(
  flags: TeamFlags | null | undefined,
  safeMode: ResolvedSafeMode | undefined,
): TeamFlags {
  if (!safeMode?.domainControls) return flags ?? null;
  return { ...(flags ?? {}), threatProtection: "forced" };
}

export function resolveSafeMode(
  flags: TeamFlags | null | undefined,
  requestSafeMode: boolean | undefined,
): {
  safeMode?: ResolvedSafeMode;
  bypassed?: boolean;
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
    // safeMode: false without the org flag asks for what it already has.
    return {};
  }

  const config = flags?.safeModeConfig;

  if (requestSafeMode === false) {
    if (config?.allowBypass !== true) {
      return {
        error:
          "Requests are not allowed to disable Safe Mode for your organization. An organization admin can allow per-request opt-outs from the Safe Mode settings.",
        code: "SAFE_MODE_BLOCKED",
      };
    }
    return { bypassed: true };
  }

  return {
    safeMode: {
      lockdown: config?.lockdown ?? SAFE_MODE_DEFAULTS.lockdown,
      checkRobots: config?.checkRobots ?? SAFE_MODE_DEFAULTS.checkRobots,
      domainControls:
        config?.domainControls ?? SAFE_MODE_DEFAULTS.domainControls,
      proxyLimit: config?.proxyLimit ?? SAFE_MODE_DEFAULTS.proxyLimit,
      noCaptchaBypass:
        config?.noCaptchaBypass ?? SAFE_MODE_DEFAULTS.noCaptchaBypass,
      blockAuthPaths:
        config?.blockAuthPaths ?? SAFE_MODE_DEFAULTS.blockAuthPaths,
    },
  };
}
