import type {
  RawVerdict,
  ThreatDecision,
  ThreatProtectionPolicy,
} from "./types";

// Pure policy evaluation for threat protection. No I/O in this file — the
// provider/cache orchestration lives in ./index.ts. Rule precedence (fixed):
// whitelist → blacklist → blocked-tld → risk-score → provider-failure →
// default-allow. The engine consumes the provider-agnostic RawVerdict shape
// only (normalized riskScore + categories) — it never knows which provider
// produced the verdict, so new providers slot in without touching it.

/**
 * Whether `domain` matches a single whitelist/blacklist entry.
 *
 * - Glob entries (containing `*`) match literally with `*` expanding to any
 *   run of characters, e.g. "*.example.com" matches "a.example.com" and
 *   "a.b.example.com" (but not the apex "example.com").
 * - Exact entries match the domain itself AND its subdomains — consistent with
 *   how the global blocklist treats domains (see
 *   src/scraper/WebScraper/utils/blocklist.ts), and what users expect from
 *   listing "example.com".
 */
function domainMatchesEntry(domain: string, entry: string): boolean {
  const normalized = entry.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;

  if (normalized.includes("*")) {
    const pattern = normalized
      .split("*")
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    try {
      return new RegExp(`^${pattern}$`).test(domain);
    } catch {
      return false;
    }
  }

  return domain === normalized || domain.endsWith(`.${normalized}`);
}

function domainMatchesList(domain: string, entries: string[]): boolean {
  return entries.some(entry => domainMatchesEntry(domain, entry));
}

/**
 * Whether the domain's suffix matches a blocked TLD entry. Entries are
 * lowercase without a leading dot ("zip"); multi-label suffixes ("co.uk")
 * also work since we do a label-boundary suffix match.
 */
function matchesBlockedTld(domain: string, blockedTlds: string[]): boolean {
  return blockedTlds.some(tld => {
    const normalized = tld.trim().toLowerCase().replace(/^\./, "");
    if (!normalized) return false;
    return domain === normalized || domain.endsWith(`.${normalized}`);
  });
}

/** Normalize a domain-ish input: lowercase, strip URL parts and trailing dot. */
export function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();
  if (domain.includes("://")) {
    try {
      domain = new URL(domain).hostname;
    } catch {
      // Not a parseable URL — fall through with the raw string.
    }
  }
  // Strip any path/port fragments and a trailing FQDN dot.
  domain = domain.split("/")[0].split(":")[0].replace(/\.$/, "");
  return domain;
}

/**
 * Resolve a decision using ONLY local policy rules (whitelist → blacklist →
 * blocked-tld), or null if a provider verdict is needed. Local decisions never
 * consult a provider, so they never set `providerConsulted` (no billing).
 */
export function localOnlyDecision(
  domain: string,
  policy: ThreatProtectionPolicy,
): ThreatDecision | null {
  const normalized = normalizeDomain(domain);
  const base = {
    providerConsulted: false,
    verdict: null,
    mode: policy.mode,
  } as const;

  if (domainMatchesList(normalized, policy.whitelist)) {
    return { allowed: true, rule: "whitelist", ...base };
  }
  if (domainMatchesList(normalized, policy.blacklist)) {
    return { allowed: false, rule: "blacklist", ...base };
  }
  if (matchesBlockedTld(normalized, policy.blockedTlds)) {
    return { allowed: false, rule: "blocked-tld", ...base };
  }
  return null;
}

/**
 * Evaluate the full policy against a provider verdict. `verdict` is null when
 * the provider failed (or was never called) — the org's failurePolicy then
 * decides. `providerConsulted` reflects whether a verdict (fresh or cached)
 * was used, which drives billing.
 */
export function evaluatePolicy(
  domain: string,
  verdict: RawVerdict | null,
  policy: ThreatProtectionPolicy,
): ThreatDecision {
  const base = {
    providerConsulted: verdict !== null,
    verdict,
    mode: policy.mode,
  };

  const local = localOnlyDecision(domain, policy);
  if (local !== null) {
    // Preserve the local rule but reflect any verdict we were given (billing
    // still applies if a provider was consulted before evaluation).
    return { allowed: local.allowed, rule: local.rule, ...base };
  }

  if (verdict !== null) {
    if (
      verdict.riskScore !== null &&
      verdict.riskScore >= policy.riskScoreThreshold
    ) {
      return { allowed: false, rule: "risk-score", ...base };
    }

    return { allowed: true, rule: "default-allow", ...base };
  }

  // No verdict: the provider failed or was unavailable (mode "off" never
  // reaches here via checkDomain). Fail open or closed per the org policy.
  if (policy.mode === "off") {
    return { allowed: true, rule: "default-allow", ...base };
  }
  return {
    allowed: policy.failurePolicy === "open",
    rule: "provider-failure",
    ...base,
  };
}
