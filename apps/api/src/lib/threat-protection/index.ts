import { logger } from "../logger";
import { getCachedVerdict, setCachedVerdict } from "./cache";
import { emitThreatCheck, type ThreatCheckContext } from "./logging";
import { fetchAlphaMountainVerdict } from "./providers/alphamountain";
import { fetchGoogleWebRiskVerdict } from "./providers/google-web-risk";
import type {
  RawVerdict,
  ThreatDecision,
  ThreatProtectionPolicy,
} from "./types";
import { evaluatePolicy, localOnlyDecision, normalizeDomain } from "./verdict";

// Public entry point for the threat protection core library (enterprise
// domain risk blocking). Flow per domain:
//   1. mode "off" → allow, no provider, no billing
//   2. local-only rules (whitelist/blacklist/blocked-tld) → decide without a
//      provider call (no billing)
//   3. cache → provider ("normal" = Google Web Risk, "enhanced" =
//      alphaMountain), with a per-attempt timeout and one retry
//   4. evaluate the policy against the verdict; provider failure → the org's
//      failurePolicy decides (fail-open allows, fail-closed blocks)
// Any decision backed by a verdict (fresh OR cached) sets providerConsulted,
// which drives billing (+2 credits normal / +3 enhanced) in the enforcement
// layer. This module performs no billing or pipeline integration itself.

// Policy evaluation helpers (evaluatePolicy, localOnlyDecision) are exported
// from ./verdict, and the shared contract types from ./types — import those
// directly; index.ts only re-exports what checkDomain callers need.
export { UnsafeDomainBlockedError } from "./error";
export type { ThreatCheckContext } from "./logging";
export * from "./types";

const PROVIDER_TIMEOUT_MS = 5000;
const PROVIDER_ATTEMPTS = 2; // 1 initial + 1 retry

async function fetchProviderVerdict(
  domain: string,
  mode: "normal" | "enhanced",
): Promise<RawVerdict> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt++) {
    try {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      return mode === "normal"
        ? await fetchGoogleWebRiskVerdict(domain, { signal })
        : await fetchAlphaMountainVerdict(domain, { signal });
    } catch (error) {
      lastError = error;
      logger.warn("Threat protection provider lookup failed", {
        canonicalLog: "threat-protection/provider",
        domain,
        mode,
        attempt,
        error,
      });
    }
  }
  throw lastError;
}

/**
 * Classify a domain against an org's threat protection policy. Never throws:
 * provider failures resolve through the policy's failurePolicy
 * ("provider-failure" rule). Callers bill +2 (normal) / +3 (enhanced) credits
 * when the returned decision has `providerConsulted` set.
 *
 * Every decision (allowed and blocked, local-only and provider-based,
 * including provider-failure resolutions) is emitted as a security event —
 * to the ClickHouse security log and, when the org has a SIEM destination
 * configured, to the SIEM push buffer. Pass as much of `ctx` as is cheaply
 * available at the call site; it enriches the emitted event.
 */
export async function checkDomain(
  domain: string,
  policy: ThreatProtectionPolicy,
  ctx: ThreatCheckContext,
): Promise<ThreatDecision> {
  const normalized = normalizeDomain(domain);

  if (policy.mode === "off") {
    return {
      allowed: true,
      rule: "default-allow",
      providerConsulted: false,
      verdict: null,
      mode: "off",
    };
  }

  // Local rules first: when whitelist/blacklist/blocked-tld are decisive we
  // skip the paid provider call entirely.
  const local = localOnlyDecision(normalized, policy);
  if (local !== null) {
    emitThreatCheck(normalized, local, ctx);
    return local;
  }

  let verdict: RawVerdict | null = await getCachedVerdict(
    normalized,
    policy.mode,
  );
  if (verdict === null) {
    try {
      verdict = await fetchProviderVerdict(normalized, policy.mode);
      await setCachedVerdict(normalized, policy.mode, verdict);
    } catch {
      // Already logged per-attempt; a null verdict routes the decision
      // through the org's failurePolicy below.
      verdict = null;
    }
  }

  const decision = evaluatePolicy(normalized, verdict, policy);
  emitThreatCheck(normalized, decision, ctx);
  if (!decision.allowed || decision.rule === "provider-failure") {
    logger.info("Threat protection decision", {
      canonicalLog: "threat-protection/check",
      teamId: ctx.teamId,
      domain: normalized,
      mode: policy.mode,
      allowed: decision.allowed,
      rule: decision.rule,
      providerConsulted: decision.providerConsulted,
      fromCache: verdict?.fromCache ?? false,
      riskScore: verdict?.riskScore ?? null,
      categories: verdict?.categories ?? [],
      rawVerdict: verdict?.raw,
    });
  }
  return decision;
}
