import { Counter, Histogram } from "prom-client";

// Fixed labels only: never team ids or anything from the page.

export const brandingRoutedTotal = new Counter({
  name: "firecrawl_branding_routed_total",
  help: "Each branding request once, by the model it was finally sent to and why: jev, or llm when BRANDING_JEV is off or Jev was unavailable (failed or breaker open); every Jev attempt is in firecrawl_branding_jev_calls_total",
  labelNames: ["model", "reason"],
});

export const brandingJevCallsTotal = new Counter({
  name: "firecrawl_branding_jev_calls_total",
  help: "Jev branding call outcomes",
  labelNames: ["outcome"],
});

export const brandingJevBreakerOpensTotal = new Counter({
  name: "firecrawl_branding_jev_breaker_opens_total",
  help: "Times the Jev breaker opened and sent branding to the LLM for its cooldown",
});

export const brandingJevDurationSeconds = new Histogram({
  name: "firecrawl_branding_jev_duration_seconds",
  help: "Jev branding call time, for calls that reached TypeSafe",
  // Up to the default timeout with its one retry.
  buckets: [0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10],
});

export type JevCallOutcome =
  | "ok"
  | "timeout"
  | "rate_limited"
  | "error"
  | "unusable"
  | "breaker_open";

// Export quiet series before their first event, so rates read 0, not missing.
for (const [model, reason] of [
  ["jev", "jev"],
  ["llm", "jev_off"],
  ["llm", "jev_unavailable"],
]) {
  brandingRoutedTotal.inc({ model, reason }, 0);
}
for (const outcome of [
  "ok",
  "timeout",
  "rate_limited",
  "error",
  "unusable",
  "breaker_open",
] satisfies JevCallOutcome[]) {
  brandingJevCallsTotal.inc({ outcome }, 0);
}
brandingJevBreakerOpensTotal.inc(0);
