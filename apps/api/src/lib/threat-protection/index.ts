import { logger } from "../logger";
import { fetchGoogleWebRiskVerdict } from "./providers/google-web-risk";
import { canonicalizeUrl } from "./providers/web-risk/canonicalize";
import type {
  RawVerdict,
  ThreatCheckDedup,
  ThreatDecision,
  ThreatProtectionMode,
  ThreatProtectionPolicy,
} from "./types";
import { evaluatePolicy, localOnlyDecision, normalizeDomain } from "./verdict";

/**
 * Request context threaded into {@link checkUrl}. Enforcement-only: the
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
   * checkUrl() reuses the in-flight decision for a URL already checked
   * within this request instead of re-scanning it. Strictly in-memory and
   * request-scoped — never persisted, never shared across requests (ZDR).
   */
  dedup?: ThreatCheckDedup;
}

// Public entry point for the threat protection core library (enterprise
// URL risk blocking). Flow per URL:
//   1. mode "off" → allow, no provider, no billing
//   2. request-scoped dedup (ctx.dedup) → a URL already checked within
//      this request/job reuses the same in-flight decision
//   3. local-only rules (whitelist/blacklist/blocked-tld, evaluated against
//      the URL's host) → decide without a provider call (no billing)
//   4. provider ("normal" = Google Web Risk local hash-prefix database),
//      with a per-attempt timeout and one retry. Lookups are URL-level:
//      host-suffix × path-prefix expressions per the Safe Browsing spec, so
//      a listing that flags only a specific page is caught even when its
//      domain is otherwise clean.
//   5. evaluate the policy against the verdict; provider failure → the org's
//      failurePolicy decides (fail-open allows, fail-closed blocks)
// Any decision backed by a verdict sets providerConsulted, which drives
// billing in the enforcement layer (+2 credits per unique scanned URL per
// billing scope — see calculateThreatScanCredits). This module performs no
// billing or pipeline integration itself.
//
// ZDR boundary: verdicts are NEVER persisted — there is no cross-request
// verdict cache (scrape-target URLs must not be stored at rest). The only
// reuse of a decision is via the caller-provided, request-scoped in-memory
// dedup map. The org-config cache in ./store.ts is unaffected: it caches the
// org's own settings, not scrape-derived data.
//
// This feature is enforcement-only: it emits and exports NO security events.
// (There is no built-in audit trail — both the ClickHouse security log and
// the SIEM push that once consumed decisions have been removed.)

// Policy evaluation helpers (evaluatePolicy, localOnlyDecision) are exported
// from ./verdict, and the shared contract types from ./types — import those
// directly; index.ts only re-exports what checkUrl callers need.
export { UnsafeDomainBlockedError } from "./error";
export * from "./types";

const PROVIDER_TIMEOUT_MS = 5000;
const PROVIDER_ATTEMPTS = 2; // 1 initial + 1 retry

/**
 * Single mode→provider dispatch point. Every provider is a separate module
 * under ./providers exporting `fetch<X>Verdict(url) → RawVerdict`; this
 * switch is the only place that knows which mode maps to which classifier.
 * Deliberately kept as a dispatch even with one live branch — future partner
 * classifiers add a mode + a case here and nothing else changes.
 */
async function fetchProviderVerdict(
  url: string,
  mode: Exclude<ThreatProtectionMode, "off">,
): Promise<RawVerdict> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt++) {
    try {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      switch (mode) {
        case "normal":
          return await fetchGoogleWebRiskVerdict(url, { signal });
      }
    } catch (error) {
      lastError = error;
      logger.warn("Threat protection provider lookup failed", {
        canonicalLog: "threat-protection/provider",
        url,
        mode,
        attempt,
        error,
      });
    }
  }
  throw lastError;
}

async function checkUrlFresh(
  canonicalUrl: string,
  policy: ThreatProtectionPolicy,
  ctx: ThreatCheckContext,
): Promise<ThreatDecision> {
  // Local rules first: when whitelist/blacklist/blocked-tld are decisive
  // (they match on the URL's host) we skip the paid provider scan entirely.
  const local = localOnlyDecision(canonicalUrl, policy);
  if (local !== null) {
    return local;
  }

  let verdict: RawVerdict | null = null;
  try {
    verdict = await fetchProviderVerdict(
      canonicalUrl,
      policy.mode as Exclude<ThreatProtectionMode, "off">,
    );
  } catch {
    // Already logged per-attempt; a null verdict routes the decision
    // through the org's failurePolicy below.
    verdict = null;
  }

  const decision = evaluatePolicy(canonicalUrl, verdict, policy);
  if (!decision.allowed || decision.rule === "provider-failure") {
    logger.info("Threat protection decision", {
      canonicalLog: "threat-protection/check",
      teamId: ctx.teamId,
      url: canonicalUrl,
      domain: decision.domain,
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
 * Classify a URL against an org's threat protection policy. Accepts full URLs
 * or bare domains (a bare domain is checked as its root URL). Never throws:
 * provider failures resolve through the policy's failurePolicy
 * ("provider-failure" rule). Callers bill scan fees for decisions with
 * `providerConsulted` set — +2 per unique scanned canonical URL, see
 * calculateThreatScanCredits.
 *
 * When `ctx.dedup` is provided (a request/job-scoped map created by the call
 * site), repeated checks of the same URL within that scope share one
 * in-flight decision: one scan, one consulted verdict. There is deliberately
 * no cross-request or persisted verdict reuse (ZDR: scrape-target URLs are
 * never stored at rest).
 *
 * Enforcement-only: no security event is emitted or exported for a scan
 * (neither to a ClickHouse log nor to a SIEM destination — both were
 * removed). There is no built-in audit trail.
 */
export async function checkUrl(
  url: string,
  policy: ThreatProtectionPolicy,
  ctx: ThreatCheckContext,
): Promise<ThreatDecision> {
  const canonicalUrl = canonicalizeUrl(url);

  if (policy.mode === "off") {
    return {
      allowed: true,
      rule: "default-allow",
      url: canonicalUrl,
      domain: normalizeDomain(canonicalUrl),
      providerConsulted: false,
      verdict: null,
      mode: "off",
    };
  }

  if (ctx.dedup) {
    const existing = ctx.dedup.get(canonicalUrl);
    if (existing !== undefined) {
      return existing;
    }
    const pending = checkUrlFresh(canonicalUrl, policy, ctx);
    ctx.dedup.set(canonicalUrl, pending);
    return pending;
  }

  return checkUrlFresh(canonicalUrl, policy, ctx);
}
