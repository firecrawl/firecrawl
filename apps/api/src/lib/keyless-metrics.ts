import { Counter, Gauge } from "prom-client";
import { config, type ResearchPaperOperation } from "../config";

const KEYLESS_MODES = [
  "scrape",
  "search",
  "research",
  "developer",
  "interact",
] as const;
const KEYLESS_OUTCOMES = [
  "accepted",
  "exhausted",
  "suspicious",
  "error",
] as const;
const KEYLESS_REASONS = [
  "none",
  "requests",
  "credits",
  "suspicious",
  "limiter",
] as const;
const SPUR_OUTCOMES = ["clean", "suspicious", "failed_open"] as const;
const RESEARCH_OPERATIONS: ResearchPaperOperation[] = [
  "search",
  "inspect",
  "read",
  "similar",
];

type KeylessMode = (typeof KEYLESS_MODES)[number];
type KeylessOutcome = (typeof KEYLESS_OUTCOMES)[number];
type KeylessReason = (typeof KEYLESS_REASONS)[number];
type SpurOutcome = (typeof SPUR_OUTCOMES)[number];

export const keylessRequestsTotal = new Counter({
  name: "firecrawl_keyless_requests_total",
  help: "Keyless authentication decisions by mode, outcome, and reason",
  labelNames: ["mode", "outcome", "reason"] as const,
});

export const spurLookupsTotal = new Counter({
  name: "firecrawl_spur_lookups_total",
  help: "Keyless Spur reputation checks by caller-visible outcome",
  labelNames: ["outcome"] as const,
});

export const researchKeylessDisabled = new Gauge({
  name: "firecrawl_research_keyless_disabled",
  help: "1 when keyless access to the named Research Index operation is disabled",
  labelNames: ["operation"] as const,
});

// Publish stable zero-valued children before launch traffic. Alerts then read a
// real zero instead of silently going absent on healthy, unused paths.
for (const mode of KEYLESS_MODES) {
  for (const outcome of KEYLESS_OUTCOMES) {
    for (const reason of KEYLESS_REASONS) {
      keylessRequestsTotal.labels(mode, outcome, reason);
    }
  }
}
for (const outcome of SPUR_OUTCOMES) spurLookupsTotal.labels(outcome);
for (const operation of RESEARCH_OPERATIONS) {
  researchKeylessDisabled
    .labels(operation)
    .set((config.RESEARCH_KEYLESS_DISABLED ?? []).includes(operation) ? 1 : 0);
}

export function normalizeKeylessMode(mode: string): KeylessMode {
  if (mode.includes("research")) return "research";
  if (mode.includes("search")) return "search";
  if (mode.includes("developer")) return "developer";
  if (mode.includes("browser") || mode.includes("interact")) return "interact";
  return "scrape";
}

export function recordKeylessRequest(
  mode: KeylessMode,
  outcome: KeylessOutcome,
  reason: KeylessReason = "none",
): void {
  keylessRequestsTotal.labels(mode, outcome, reason).inc();
}

export function recordSpurLookup(outcome: SpurOutcome): void {
  spurLookupsTotal.labels(outcome).inc();
}
