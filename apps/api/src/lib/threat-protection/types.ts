// Shared type contract for the threat protection feature.
// NOTE: concurrent in-flight branches create this exact file — do not modify without coordinating.

export type ThreatProtectionMode = "off" | "normal";

export interface ThreatProtectionPolicy {
  mode: ThreatProtectionMode;
  /** Normalized 0-100; verdicts at or above this score are blocked. */
  riskScoreThreshold: number;
  /** Exact domains or globs like "*.example.com". Blocks without a provider call. */
  blacklist: string[];
  /** Exact domains or globs. Allows without a provider call; wins over everything. */
  whitelist: string[];
  /** Lowercase TLDs without leading dot, e.g. "zip". Blocks without a provider call. */
  blockedTlds: string[];
  /** Behavior when the provider is unavailable: "closed" blocks, "open" allows. */
  failurePolicy: "open" | "closed";
}

export const THREAT_PROTECTION_POLICY_DEFAULTS: Omit<
  ThreatProtectionPolicy,
  "mode"
> = {
  riskScoreThreshold: 75,
  blacklist: [],
  whitelist: [],
  blockedTlds: [],
  failurePolicy: "closed",
};

// Only Google Web Risk today. The union (and the provider seam around it —
// separate provider modules under ./providers, the mode→provider dispatch in
// ./index.ts, and the provider-agnostic verdict engine in ./verdict.ts) is
// deliberately kept so future partner classifiers slot in as new members.
export type ThreatProvider = "google-web-risk";

export interface RawVerdict {
  provider: ThreatProvider;
  /** Normalized 0-100, higher = riskier; null if the provider gave no score. */
  riskScore: number | null;
  /** Provider threat categories (Web Risk threat types map through here). */
  categories: string[];
  /**
   * Always false: verdicts are never persisted (ZDR) — repeated checks within
   * one request share the same in-flight decision via the request-scoped
   * dedup handle instead of a cache. Kept for contract stability.
   */
  fromCache: boolean;
  /** Raw provider payload, surfaced only in server logs. */
  raw: unknown;
}

/**
 * Request/job-scoped dedup handle for {@link import("./index").checkDomain}.
 * Call sites create one per request or job (never shared across requests, and
 * never persisted) so that repeated checks of the same domain within that
 * scope — e.g. a scrape plus its redirect re-check, or one crawl-discovery
 * batch — share a single in-flight decision instead of re-scanning. Keyed by
 * normalized domain only: within one request the effective policy is
 * constant, so the domain fully identifies the decision.
 */
export type ThreatCheckDedup = Map<string, Promise<ThreatDecision>>;

export type ThreatDecisionRule =
  | "whitelist"
  | "blacklist"
  | "blocked-tld"
  | "risk-score"
  | "provider-failure"
  | "default-allow";

export interface ThreatDecision {
  allowed: boolean;
  rule: ThreatDecisionRule;
  /** True if a provider verdict (fresh OR cached) was consulted — this drives billing (+2 per scanned domain). */
  providerConsulted: boolean;
  verdict: RawVerdict | null;
  mode: ThreatProtectionMode;
}
