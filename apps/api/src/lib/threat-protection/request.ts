import type { TeamFlags } from "../../controllers/v2/types";
import { getThreatProtection } from "../zdr-helpers";
import { checkUrl, type ThreatCheckContext } from "./index";
import {
  getOrgIdForTeam,
  getOrgThreatProtectionConfig,
  resolveEffectivePolicy,
  type OrgThreatProtectionConfig,
} from "./store";
import type { ThreatDecision, ThreatProtectionPolicy } from "./types";

// Controller-layer glue for threat protection enforcement. One helper
// (resolveThreatProtection) is shared by every endpoint: it turns
// (team flags + org config + per-request override) into an effective
// ThreatProtectionPolicy — or null, meaning the feature is off for this
// request (the enforcement hot path then does zero extra work).

const SUPPORT_EMAIL = "support@firecrawl.com";

export const THREAT_PROTECTION_NOT_ENABLED_MESSAGE = `Threat protection is an enterprise feature and is not enabled for your team. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`;

export const THREAT_PROTECTION_OVERRIDES_DISABLED_MESSAGE =
  "Per-request threat protection overrides are disabled by your organization's threat protection configuration.";

export const THREAT_PROTECTION_CANNOT_DISABLE_MESSAGE =
  'Threat protection is enforced for your team and cannot be disabled per-request (threatProtection.mode may not be "off"). Remove the mode field or contact your organization administrator.';

interface ResolvedThreatProtection {
  /** Set when the request must be rejected with a 403. */
  error?: string;
  /** Effective policy, or null when the feature is off for this request. */
  policy: ThreatProtectionPolicy | null;
  /** Loaded org config — pass to checkPermissions' third parameter. */
  orgConfig: OrgThreatProtectionConfig | null;
}

/**
 * Resolves the effective threat protection policy for an API request.
 *
 * - Team flag "disabled"/absent: any per-request override → 403; otherwise the
 *   feature is entirely off (`policy: null`) with zero I/O.
 * - Flag "allowed"/"forced": the org config (60s-cached) is loaded; a request
 *   override does field-level replacement IF the org allows overrides,
 *   otherwise → 403.
 * - Flag "forced": an override may never set `mode: "off"` → 403.
 * - Effective mode "off" resolves to `policy: null` so callers can skip all
 *   enforcement work.
 */
export async function resolveThreatProtection(args: {
  teamId: string;
  orgId?: string | null;
  flags: TeamFlags;
  override?: Partial<ThreatProtectionPolicy>;
}): Promise<ResolvedThreatProtection> {
  const flagMode = getThreatProtection(args.flags);

  if (flagMode !== "allowed" && flagMode !== "forced") {
    if (args.override !== undefined) {
      return {
        error: THREAT_PROTECTION_NOT_ENABLED_MESSAGE,
        policy: null,
        orgConfig: null,
      };
    }
    return { policy: null, orgConfig: null };
  }

  const orgId = args.orgId ?? (await getOrgIdForTeam(args.teamId));
  const orgConfig = orgId ? await getOrgThreatProtectionConfig(orgId) : null;

  if (args.override !== undefined) {
    if (orgConfig && !orgConfig.allowRequestOverrides) {
      return {
        error: THREAT_PROTECTION_OVERRIDES_DISABLED_MESSAGE,
        policy: null,
        orgConfig,
      };
    }
    if (flagMode === "forced" && args.override.mode === "off") {
      return {
        error: THREAT_PROTECTION_CANNOT_DISABLE_MESSAGE,
        policy: null,
        orgConfig,
      };
    }
  }

  const policy = resolveEffectivePolicy(orgConfig, args.override);
  return {
    policy: policy.mode === "off" ? null : policy,
    orgConfig,
  };
}

interface BlockedUrl {
  url: string;
  domain: string;
  decision: ThreatDecision;
}

interface UrlPolicyCheckResult {
  allowedUrls: string[];
  blocked: BlockedUrl[];
  /** One decision per input URL, keyed by the URL as given by the caller. */
  decisionsByUrl: Map<string, ThreatDecision>;
}

// Checks are URL-level and run concurrently (bounded). Repeats of the same
// canonical URL share one in-flight decision via the dedup handle, which is
// strictly scoped to this one batch (an in-memory map) unless the caller
// widens it — there is no cross-request or persisted verdict reuse (ZDR).
// Clean URLs resolve against the local hash-prefix lists (no network I/O),
// so many URLs stay cheap on the check side; billing is +2 per unique
// scanned canonical URL (see calculateThreatScanCredits).
const URL_CHECK_CONCURRENCY = 16;

/**
 * Checks a list of URLs against a policy. Never throws — `checkUrl` resolves
 * provider failures via the policy's failurePolicy. Each call scans a given
 * canonical URL at most once (per-batch in-memory dedup; callers may pass
 * their own `ctx.dedup` to widen the scope to a whole request/job).
 */
export async function checkUrlsAgainstThreatPolicy(
  urls: string[],
  policy: ThreatProtectionPolicy,
  ctx: ThreatCheckContext,
): Promise<UrlPolicyCheckResult> {
  const uniqueUrls = [...new Set(urls)];
  const dedupCtx: ThreatCheckContext = {
    ...ctx,
    dedup: ctx.dedup ?? new Map(),
  };

  const decisionsByUrl = new Map<string, ThreatDecision>();
  for (let i = 0; i < uniqueUrls.length; i += URL_CHECK_CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + URL_CHECK_CONCURRENCY);
    const decisions = await Promise.all(
      batch.map(url => checkUrl(url, policy, dedupCtx)),
    );
    batch.forEach((url, index) => decisionsByUrl.set(url, decisions[index]));
  }

  const allowedUrls: string[] = [];
  const blocked: BlockedUrl[] = [];
  for (const url of urls) {
    const decision = decisionsByUrl.get(url);
    if (decision && !decision.allowed) {
      blocked.push({ url, domain: decision.domain, decision });
    } else {
      allowedUrls.push(url);
    }
  }

  return { allowedUrls, blocked, decisionsByUrl };
}
