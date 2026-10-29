import { Counter, Histogram } from "prom-client";

// Fixed labels only: never team ids or anything from the page.

export const brandingRoutedTotal = new Counter({
  name: "firecrawl_branding_routed_total",
  help: "Each branding request once, by the model it was finally sent to and why: jev, or llm when BRANDING_JEV=false (jev_off), no TYPESAFE_API_KEY is set (jev_no_key), or Jev was unavailable (failed or breaker open); every Jev attempt is in firecrawl_branding_jev_calls_total",
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
  help: "Jev branding call time, for calls that reached TypeSafe, by whether the first screen was attached (screenshot=yes|no)",
  labelNames: ["screenshot"],
  // Up to the default timeout with its one retry.
  buckets: [0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10],
});

export const brandingScreenshotCapturesTotal = new Counter({
  name: "firecrawl_branding_screenshot_captures_total",
  help: "Branding scrapes that asked fire-engine for the page's first screen, by why (via=flag for __experimental_screenshot, rollout for BRANDING_JEV_SCREENSHOT_PERCENT) and whether it came back (captured), the scrape succeeded without it (missing), or the scrape failed (scrape_failed)",
  labelNames: ["outcome", "via"],
});

export const brandingJevScreenshotTotal = new Counter({
  name: "firecrawl_branding_jev_screenshot_total",
  help: "The first screen on each Jev branding call: attached, blank (too small to be a real page, e.g. a black frame), too_large, unreadable (download failed or not an image), or none (no screenshot for this call)",
  labelNames: ["outcome"],
});

export const brandingScreenshotBytes = new Histogram({
  name: "firecrawl_branding_screenshot_bytes",
  help: "Size of the first screens read for Jev, blank ones included (a black 1280x720 JPEG is ~6 KB)",
  buckets: [
    2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000,
    1_280_000,
  ],
});

export const brandingScreenshotLoadSeconds = new Histogram({
  name: "firecrawl_branding_screenshot_load_seconds",
  help: "Time to read the first screen for Jev (download, or decode a data URL), from the start of the read",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 3],
});

export type JevScreenshotOutcome =
  | "attached"
  | "blank"
  | "too_large"
  | "unreadable"
  | "none";

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
  ["llm", "jev_no_key"],
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
for (const via of ["flag", "rollout"]) {
  for (const outcome of ["captured", "missing", "scrape_failed"]) {
    brandingScreenshotCapturesTotal.inc({ outcome, via }, 0);
  }
}
for (const outcome of [
  "attached",
  "blank",
  "too_large",
  "unreadable",
  "none",
] satisfies JevScreenshotOutcome[]) {
  brandingJevScreenshotTotal.inc({ outcome }, 0);
}
