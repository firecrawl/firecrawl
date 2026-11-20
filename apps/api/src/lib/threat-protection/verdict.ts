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

interface CompiledDomainList {
  exactDomains: Set<string>;
  wildcardSuffixes: Set<string>;
  complexGlobs: RegExp[];
}

const compiledDomainListCache = new WeakMap<
  readonly string[],
  CompiledDomainList
>();

const compiledTldSetCache = new WeakMap<readonly string[], Set<string>>();

/**
 * Pre-index a whitelist/blacklist array so repeated checks against the same
 * frozen policy list stay O(labels) per URL for exact and leading-wildcard
 * entries; inner-`*` globs fall back to a linear regex scan.
 *
 * Only frozen arrays are cached in the WeakMap so in-place mutations to a
 * caller-owned mutable array can never serve stale results.
 *
 * - Exact entries match the domain itself AND its subdomains — consistent with
 *   how the global blocklist treats domains (see
 *   src/scraper/WebScraper/utils/blocklist.ts), and what users expect from
 *   listing "example.com".
 * - Leading wildcard entries ("*.example.com") match any strict subdomain
 *   ("a.example.com", "a.b.example.com") but not the apex ("example.com").
 * - Any other glob containing "*" falls back to a pre-compiled RegExp.
 */
function compileDomainList(entries: readonly string[]): CompiledDomainList {
  const isFrozen = Object.isFrozen(entries);
  if (isFrozen) {
    const cached = compiledDomainListCache.get(entries);
    if (cached) return cached;
  }

  const exactDomains = new Set<string>();
  const wildcardSuffixes = new Set<string>();
  const complexGlobs: RegExp[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!trimmed) continue;

    if (trimmed.includes("*")) {
      if (trimmed.startsWith("*.") && trimmed.length > 2) {
        const suffix = trimmed.slice(2);
        if (!suffix.includes("*")) {
          wildcardSuffixes.add(suffix);
          continue;
        }
      }
      const pattern = trimmed
        .split("*")
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      try {
        complexGlobs.push(new RegExp(`^${pattern}$`));
      } catch {
        // Ignore invalid patterns.
      }
      continue;
    }

    // Canonicalize non-glob entries the same way as the looked-up domain, so an
    // entry written in a non-canonical IP form (e.g. "3279880203") still matches
    // its dotted-quad host and vice versa.
    const normalized = canonicalizeHost(trimmed);
    if (normalized) {
      exactDomains.add(normalized);
    }
  }

  const compiled: CompiledDomainList = {
    exactDomains,
    wildcardSuffixes,
    complexGlobs,
  };
  if (isFrozen) {
    compiledDomainListCache.set(entries, compiled);
  }
  return compiled;
}

export function domainMatchesList(
  domain: string,
  entries: readonly string[],
): boolean {
  if (entries.length === 0) return false;
  const { exactDomains, wildcardSuffixes, complexGlobs } =
    compileDomainList(entries);

  if (exactDomains.has(domain)) return true;

  if (exactDomains.size > 0 || wildcardSuffixes.size > 0) {
    for (
      let dot = domain.indexOf(".");
      dot !== -1;
      dot = domain.indexOf(".", dot + 1)
    ) {
      const parent = domain.slice(dot + 1);
      if (exactDomains.has(parent) || wildcardSuffixes.has(parent)) {
        return true;
      }
    }
  }

  for (const regex of complexGlobs) {
    if (regex.test(domain)) return true;
  }

  return false;
}

function compileTldSet(blockedTlds: readonly string[]): Set<string> {
  const isFrozen = Object.isFrozen(blockedTlds);
  if (isFrozen) {
    const cached = compiledTldSetCache.get(blockedTlds);
    if (cached) return cached;
  }

  const set = new Set<string>();
  for (const tld of blockedTlds) {
    const normalized = tld.trim().toLowerCase().replace(/^\./, "");
    if (normalized) set.add(normalized);
  }
  if (isFrozen) {
    compiledTldSetCache.set(blockedTlds, set);
  }
  return set;
}

/**
 * Whether the domain's suffix matches a blocked TLD entry. Entries are
 * lowercase without a leading dot ("zip"); multi-label suffixes ("co.uk")
 * also work since we do a label-boundary suffix match.
 */
function matchesBlockedTld(
  domain: string,
  blockedTlds: readonly string[],
): boolean {
  if (blockedTlds.length === 0) return false;
  const tldSet = compileTldSet(blockedTlds);
  if (tldSet.size === 0) return false;
  if (tldSet.has(domain)) return true;
  for (
    let dot = domain.indexOf(".");
    dot !== -1;
    dot = domain.indexOf(".", dot + 1)
  ) {
    if (tldSet.has(domain.slice(dot + 1))) return true;
  }
  return false;
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
    // Zscaler mode blocks on the org's denied-categories selection. The
    // verdict's categories are the normalized union of urlClassifications
    // and urlClassificationsWithSecurityAlert.
    if (policy.mode === "zscaler" && policy.zscaler) {
      const denied = verdict.categories.filter(category =>
        policy.zscaler!.deniedCategories.includes(category),
      );
      if (denied.length > 0) {
        return { allowed: false, rule: "denied-category", ...base };
      }
    }

    if (
      verdict.riskScore !== null &&
      verdict.riskScore >= policy.riskScoreThreshold
    ) {
      return { allowed: false, rule: "risk-score", ...base };
    }

    return { allowed: true, rule: "default-allow", ...base };
  }

  // No verdict: the provider failed or was unavailable (modes "off" and
  // "manual-only" never consult one, so they never fail). Otherwise fail open
  // or closed per the org policy.
  if (policy.mode === "off" || policy.mode === "manual-only") {
    return { allowed: true, rule: "default-allow", ...base };
  }
  return {
    allowed: policy.failurePolicy === "open",
    rule: "provider-failure",
    ...base,
  };
}
