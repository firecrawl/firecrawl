import { logger } from "../logger";
import { fetchGoogleWebRiskVerdict } from "./providers/google-web-risk";
import type {
  RawVerdict,
  ThreatCheckDedup,
  ThreatDecision,
  ThreatProtectionMode,
  ThreatProtectionPolicy,
} from "./types";
import { evaluatePolicy, localOnlyDecision, normalizeDomain } from "./verdict";

/**
 * Request context threaded into {@link checkDomain}. Enforcement-only: the
 * feature no longer emits or exports security events (both the ClickHouse
 * security log and the SIEM push were removed), so this carries just the
 * request/job-scoped dedup handle plus the team id used for server-side
 * logging. Everything is optional — call sites pass whatever is cheaply
 * available.
 */
export interface ThreatCheckContext {
  teamId?: string;
  /**
   * Request/job-scoped dedup handle (see {@link ThreatCheckDedup}). When set,
   * checkDomain() reuses the in-flight decision for a domain already checked
   * within this request instead of re-scanning it. Strictly in-memory and
   * request-scoped — never persisted, never shared across requests (ZDR).
   */
  dedup?: ThreatCheckDedup;
}

// Public entry point for the threat protection core library (enterprise
// domain risk blocking). Flow per domain:
//   1. mode "off" → allow, no provider, no billing
//   2. request-scoped dedup (ctx.dedup) → a domain already checked within
//      this request/job reuses the same in-flight decision
//   3. local-only rules (whitelist/blacklist/blocked-tld) → decide without a
//      provider call (no billing)
//   4. provider ("normal" = Google Web Risk local hash-prefix database),
//      with a per-attempt timeout and one retry
//   5. evaluate the policy against the verdict; provider failure → the org's
//      failurePolicy decides (fail-open allows, fail-closed blocks)
// Any decision backed by a verdict sets providerConsulted, which drives
// billing (+2 credits per scanned domain) in the enforcement layer. This
// module performs no billing or pipeline integration itself.
//
// ZDR boundary: verdicts are NEVER persisted — there is no cross-request
// verdict cache (scrape-target domains must not be stored at rest). The only
// reuse of a decision is via the caller-provided, request-scoped in-memory
// dedup map. The org-config cache in ./store.ts is unaffected: it caches the
// org's own settings, not scrape-derived data.
//
// This feature is enforcement-only: it emits and exports NO security events.
// (There is no built-in audit trail — both the ClickHouse security log and
// the SIEM push that once consumed decisions have been removed.)

// Policy evaluation helpers (evaluatePolicy, localOnlyDecision) are exported
// from ./verdict, and the shared contract types from ./types — import those
// directly; index.ts only re-exports what checkDomain callers need.
export { UnsafeDomainBlockedError } from "./error";
export * from "./types";

const PROVIDER_TIMEOUT_MS = 5000;
const PROVIDER_ATTEMPTS = 2; // 1 initial + 1 retry

/**
 * Single mode→provider dispatch point. Every provider is a separate module
 * under ./providers exporting `fetch<X>Verdict(domain) → RawVerdict`; this
 * switch is the only place that knows which mode maps to which classifier.
 * Deliberately kept as a dispatch even with one live branch — future partner
 * classifiers add a mode + a case here and nothing else changes.
 */
async function fetchProviderVerdict(
  domain: string,
  mode: Exclude<ThreatProtectionMode, "off">,
): Promise<RawVerdict> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt++) {
    try {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      switch (mode) {
        case "normal":
          return await fetchGoogleWebRiskVerdict(domain, { signal });
      }
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

async function checkDomainFresh(
  normalized: string,
  policy: ThreatProtectionPolicy,
  ctx: ThreatCheckContext,
): Promise<ThreatDecision> {
  // Local rules first: when whitelist/blacklist/blocked-tld are decisive we
  // skip the paid provider scan entirely.
  const local = localOnlyDecision(normalized, policy);
  if (local !== null) {
    return local;
  }

  let verdict: RawVerdict | null = null;
  try {
    verdict = await fetchProviderVerdict(
      normalized,
      policy.mode as Exclude<ThreatProtectionMode, "off">,
    );
  } catch {
    // Already logged per-attempt; a null verdict routes the decision
    // through the org's failurePolicy below.
    verdict = null;
  }

  const decision = evaluatePolicy(normalized, verdict, policy);
  if (!decision.allowed || decision.rule === "provider-failure") {
    logger.info("Threat protection decision", {
      canonicalLog: "threat-protection/check",
      teamId: ctx.teamId,
      domain: normalized,
      mode: policy.mode,
      allowed: decision.allowed,
      rule: decision.rule,
      providerConsulted: decision.providerConsulted,
      riskScore: verdict?.riskScore ?? null,
      categories: verdict?.categories ?? [],
      rawVerdict: verdict?.raw,
    });
  }
  return decision;
}

/**
 * Classify a domain against an org's threat protection policy. Never throws:
 * provider failures resolve through the policy's failurePolicy
 * ("provider-failure" rule). Callers bill +2 credits per scanned domain when
 * the returned decision has `providerConsulted` set.
 *
 * When `ctx.dedup` is provided (a request/job-scoped map created by the call
 * site), repeated checks of the same domain within that scope share one
 * in-flight decision: one scan, one billable consulted verdict. There is
 * deliberately no cross-request or persisted verdict reuse (ZDR:
 * scrape-target domains are never stored at rest).
 *
 * Enforcement-only: no security event is emitted or exported for a scan
 * (neither to a ClickHouse log nor to a SIEM destination — both were
 * removed). There is no built-in audit trail.
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

  if (ctx.dedup) {
    const existing = ctx.dedup.get(normalized);
    if (existing !== undefined) {
      return existing;
    }
    const pending = checkDomainFresh(normalized, policy, ctx);
    ctx.dedup.set(normalized, pending);
    return pending;
  }

  return checkDomainFresh(normalized, policy, ctx);
}
