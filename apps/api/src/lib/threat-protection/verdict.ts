import type {
  RawVerdict,
  ThreatDecision,
  ThreatProtectionPolicy,
} from "./types";
// Shared host canonicalization (lowercase, dot handling, and inet_aton-style
// IP normalization). The Web Risk provider already canonicalizes hosts this
// way; local blacklist/whitelist rules MUST use the exact same function so
// the two paths can never disagree on what host they're evaluating — e.g. so
// a blacklist entry for "195.127.0.11" is not bypassed by "http://3279880203/".
import { canonicalizeHost, splitUrl } from "./providers/web-risk/canonicalize";

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
  const trimmed = entry.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return false;

  if (trimmed.includes("*")) {
    const pattern = trimmed
      .split("*")
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    try {
      return new RegExp(`^${pattern}$`).test(domain);
    } catch {
      return false;
    }
  }

  // Canonicalize non-glob entries the same way as the looked-up domain, so an
  // entry written in a non-canonical IP form (e.g. "3279880203") still matches
  // its dotted-quad host and vice versa.
  const normalized = canonicalizeHost(trimmed);
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

/**
 * Normalize a domain-ish input: strip URL parts/port, then apply the shared
 * host canonicalization (lowercase, dot handling, inet_aton-style IP
 * normalization) so local rule matching sees the same canonical host as the
 * Web Risk provider — closing IP-form blacklist bypasses.
 */
export function normalizeDomain(input: string): string {
  let domain = input.trim();
  if (domain.includes("://")) {
    try {
      domain = new URL(domain).hostname;
    } catch {
      // WHATWG URL rejects hosts the Safe Browsing spec still handles (e.g.
      // percent-escaped spaces or control bytes). Fall back to the same
      // lenient splitter the canonicalizer uses — the naive string handling
      // below would otherwise extract "http:" as the "host" and local rules
      // would silently never match. Mirror canonicalizeUrl's pre-split
      // cleanup (embedded tab/CR/LF, fragment) so a fragment directly after
      // the host can't ride along into it.
      let cleaned = domain.replace(/[\t\r\n]/g, "");
      const hash = cleaned.indexOf("#");
      if (hash !== -1) cleaned = cleaned.slice(0, hash);
      domain = splitUrl(cleaned).host;
    }
  }
  // Strip a path fragment, then the port — carefully, because IPv6 literals
  // contain colons. A bracketed literal ("[2001:db8::1]") keeps everything
  // through the closing bracket (dropping any ":port" after it); a plain
  // host:port has exactly one colon; a bare IPv6 (multiple colons, no
  // brackets) is left intact rather than truncated.
  domain = domain.split("/")[0];
  if (domain.startsWith("[")) {
    const end = domain.indexOf("]");
    if (end !== -1) domain = domain.slice(0, end + 1);
  } else if (domain.split(":").length === 2) {
    domain = domain.split(":")[0];
  }
  return canonicalizeHost(domain);
}

/**
 * Resolve a decision using ONLY local policy rules (whitelist → blacklist →
 * blocked-tld), or null if a provider verdict is needed. Local rules are
 * domain-level (the lists hold domains/globs), so `target` may be a full URL —
 * only its canonicalized host is evaluated. Local decisions never consult a
 * provider, so they never set `providerConsulted` (no billing).
 */
export function localOnlyDecision(
  target: string,
  policy: ThreatProtectionPolicy,
): ThreatDecision | null {
  const normalized = normalizeDomain(target);
  const base = {
    url: target,
    domain: normalized,
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
  target: string,
  verdict: RawVerdict | null,
  policy: ThreatProtectionPolicy,
): ThreatDecision {
  const base = {
    url: target,
    domain: normalizeDomain(target),
    providerConsulted: verdict !== null,
    verdict,
    mode: policy.mode,
  };

  const local = localOnlyDecision(target, policy);
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
  // reaches here via checkUrl). Fail open or closed per the org policy.
  if (policy.mode === "off") {
    return { allowed: true, rule: "default-allow", ...base };
  }
  return {
    allowed: policy.failurePolicy === "open",
    rule: "provider-failure",
    ...base,
  };
}
